import { randomUUID } from "node:crypto";
import {
	currentCursorIdentity,
	isOwnedSurfacePid,
	parseElementIndex,
	resolveAppPid,
	withCursorIdentity,
	withInputRegion,
} from "@opencua/core";
import type { CursorOwner, GuardedComputerInterface, InputObservation, Point } from "@opencua/core";
import type {
	GuardedSession,
	MutationOptions,
	ObservationOptions,
	RunControl,
	RunStepDriver,
	VerifyRequest,
} from "./guarded-session.js";
import { notificationsEnabled, postNotification } from "./notify.js";
import { createRunStepDriver } from "./step-actions.js";
import type { ToolResult } from "./tool-result.js";
import type { RunStep } from "./tool-schemas.js";
import {
	type SharedWorkerRun,
	WorkerLeaseRefusal,
	type WorkerRegistry,
	workerBusy,
	workerConflict,
	workerNotAssigned,
} from "./worker-registry.js";

export type WorkerAssignmentInput = {
	readonly worker_id: string;
	readonly task: string;
	readonly app: string;
	readonly agent_name?: string | undefined;
	readonly parent_agent_name?: string | undefined;
	/** Part of a shared window this worker's pointer is confined to, in screenshot-local window pixels. */
	readonly region?: WorkerRegion | undefined;
};

/** Same space as a step's click x/y and drag points: pixels of the observed window screenshot, origin top-left. */
export type WorkerRegion = {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
};

export type WorkerAssignment = WorkerAssignmentInput & {
	readonly session_id: string;
	readonly cursor_id: string;
	readonly cursor_owner: CursorOwner;
	readonly observation_token?: string;
	readonly observation?: ToolResult;
};

/** `paused` is a human Take Over: runs are refused until resume. `stopped` is terminal until release. */
export type WorkerControl = "running" | "paused" | "stopped";

export type WorkerStatus = Omit<WorkerAssignment, "observation"> & {
	readonly busy: boolean;
	readonly control: WorkerControl;
	readonly lastRun?: WorkerRunSummary;
};

export type WorkerRunSummary = {
	readonly startedAt: string;
	readonly endedAt: string;
	readonly ok: boolean;
	readonly stepCount: number;
	readonly errorSummary?: string;
	readonly appId?: string | number;
	readonly bundleId?: string;
	readonly text?: string;
};

export type WorkerObservationOptions = Omit<ObservationOptions, "includeAccessibilityTree" | "diffOnly"> & {
	readonly diffOnly?: boolean;
};

/** Coordinators sharing one server name their workers per session; omitted means this one. */
export const DEFAULT_WORKER_SESSION = "default";

/** How long a closing coordinator keeps its claims while in-flight calls finish. */
const CLOSE_DRAIN_MILLISECONDS = 30_000;

function delayMilliseconds(milliseconds: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, milliseconds).unref();
	});
}

/**
 * The default session keeps the bare worker id, so registry entries from other processes still match. A named session
 * joins with NUL, which neither part can contain (session ids are validated; worker ids name cursors, which refuse
 * control characters), so two different pairs never share a key.
 */
function workerKey(sessionId: string, workerId: string): string {
	return sessionId === DEFAULT_WORKER_SESSION ? workerId : `${sessionId}\u0000${workerId}`;
}

export type WorkerObservation = {
	readonly session_id: string;
	readonly worker_id: string;
	readonly task: string;
	readonly app: string;
	readonly cursor_id: string;
	readonly cursor_owner: CursorOwner;
	readonly observation_token?: string;
	readonly result: ToolResult;
};

export type WorkerRunResult = {
	readonly session_id: string;
	readonly worker_id: string;
	readonly task: string;
	readonly app: string;
	readonly cursor_id: string;
	readonly cursor_owner: CursorOwner;
	readonly observation_token?: string;
	readonly result: ToolResult;
};

type WorkerState = {
	assignment: WorkerAssignmentInput & {
		readonly cursor_id: string;
		readonly cursor_owner: CursorOwner;
		observation_token: string | undefined;
		observation: ToolResult | undefined;
	};
	readonly pid: number;
	readonly session: string;
	/** The registry lease this state stands for; undefined without a registry, or for an entry an older opencua wrote. */
	lease: string | undefined;
	busy: boolean;
	control: WorkerControl;
	activeRun: AbortController | undefined;
	lastRun: WorkerRunSummary | undefined;
};

function payload(result: ToolResult): Record<string, unknown> {
	const text = result.content.find((content) => content.type === "text");
	if (text === undefined || text.type !== "text") {
		throw new Error("guarded observation did not return JSON text");
	}
	const value: unknown = JSON.parse(text.text);
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("guarded observation payload must be an object");
	}
	return Object.fromEntries(Object.entries(value));
}

/**
 * A target outside the worker's region stopped the run before that step's input was sent. A step resolved mid-run can
 * be refused after earlier steps of the same run went out; `actionDispatched` says so.
 */
export class WorkerRegionRefusal extends Error {
	readonly reason = "outside-worker-region";

	constructor(
		workerId: string,
		step: number,
		region: WorkerRegion,
		detail: string,
		readonly actionDispatched = false,
	) {
		super(
			`worker "${workerId}" step ${step} ${detail}, outside its region ${describeRegion(region)}; ${
				actionDispatched
					? "it and the steps after it were not sent, but earlier steps of this run were: observe again"
					: "nothing was sent"
			}`,
		);
		this.name = "WorkerRegionRefusal";
	}
}

function describeRegion({ x, y, width, height }: WorkerRegion): string {
	return `{x: ${x}, y: ${y}, width: ${width}, height: ${height}}`;
}

function assertRegion(workerId: string, region: WorkerRegion): void {
	const finite = [region.x, region.y, region.width, region.height].every((value) => Number.isFinite(value));
	if (!finite || region.width <= 0 || region.height <= 0) {
		throw new Error(`worker "${workerId}" region must have finite x, y, width, height with width and height > 0`);
	}
}

/** A region in window screenshot pixels as global screen points, through the observed viewport. */
function regionOnScreen(region: WorkerRegion, observation: InputObservation | undefined): WorkerRegion | undefined {
	const viewport = observation?.screenshotViewport;
	if (viewport === undefined || !(viewport.width > 0 && viewport.height > 0)) return undefined;
	const { bounds } = viewport;
	const scaleX = bounds.width / viewport.width;
	const scaleY = bounds.height / viewport.height;
	return {
		x: bounds.x + region.x * scaleX,
		y: bounds.y + region.y * scaleY,
		width: region.width * scaleX,
		height: region.height * scaleY,
	};
}

/** Positive-area intersection; regions that only share an edge do not overlap. */
function regionsOverlap(a: WorkerRegion, b: WorkerRegion): boolean {
	return (
		Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) &&
		Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y)
	);
}

/** Half-open like the observed viewport: the right and bottom edges belong to the next region. */
function regionContains(region: WorkerRegion, point: Point): boolean {
	return (
		point.x >= region.x &&
		point.x < region.x + region.width &&
		point.y >= region.y &&
		point.y < region.y + region.height
	);
}

type PointerTarget =
	| { readonly point: Point; readonly what: string }
	| { readonly element: number; readonly what: string };

/**
 * Where a step's pointer would land, in screenshot-local window pixels. `undefined` means the step names its
 * element by description, which resolves only while the run executes. Keyboard and accessibility-only steps aim
 * at nothing.
 */
function pointerTargets(step: RunStep): readonly PointerTarget[] | undefined {
	switch (step.type) {
		case "click":
			if (step.target !== undefined) return undefined;
			return step.element_index === undefined
				? [{ point: { x: step.x ?? Number.NaN, y: step.y ?? Number.NaN }, what: "clicks" }]
				: [{ element: parseElementIndex(step.element_index), what: "clicks element" }];
		case "drag":
			return [
				{ point: { x: step.from_x, y: step.from_y }, what: "starts its drag" },
				...(step.waypoints ?? []).map((point, index) => ({ point, what: `drags through waypoint ${index}` })),
				{ point: { x: step.to_x, y: step.to_y }, what: "ends its drag" },
			];
		case "scroll":
			if (step.target !== undefined) return undefined;
			return step.element_index === undefined
				? []
				: [{ element: parseElementIndex(step.element_index), what: "scrolls element" }];
		// Accessibility edits move no pointer, but they still change the element: it must sit in the worker's region.
		case "set_value":
		case "perform_secondary_action":
		case "select_text":
			if (step.target !== undefined) return undefined;
			return step.element_index === undefined
				? []
				: [{ element: parseElementIndex(step.element_index), what: `runs ${step.type} on element` }];
		default:
			return [];
	}
}

/**
 * The worker's shared claim ended or changed hands while its run was in flight: this step and the steps after it were
 * not sent. `actionDispatched` says whether earlier steps of the same run were.
 */
export class WorkerLeaseLost extends Error {
	readonly reason = "worker-lease-lost";

	constructor(
		workerId: string,
		readonly actionDispatched: boolean,
	) {
		super(
			`worker "${workerId}" lost its lease mid-run: its assigning opencua session ended or its app changed hands; ${
				actionDispatched
					? "earlier steps of this run were sent, but this step and the steps after it were not"
					: "nothing was sent"
			}. Do not retry; report back`,
		);
		this.name = "WorkerLeaseLost";
	}
}

/** A user Take Over or Stop refused the call before any input was sent. */
export class WorkerControlRefusal extends Error {
	readonly reason: "worker-paused" | "worker-stopped";

	constructor(workerId: string, control: Exclude<WorkerControl, "running">) {
		super(
			control === "paused"
				? `the user took over worker "${workerId}"; wait for resume, then observe again before acting`
				: `the user stopped worker "${workerId}"; do not retry, report back`,
		);
		this.name = "WorkerControlRefusal";
		this.reason = control === "paused" ? "worker-paused" : "worker-stopped";
	}
}

export class WorkerCoordinator {
	private readonly sessionId = randomUUID();
	private readonly workers = new Map<string, WorkerState>();
	private readonly adopted = new Set<string>();
	private attendedTail: Promise<void> = Promise.resolve();
	private closed = false;
	private closePromise: Promise<void> | undefined;

	constructor(
		private readonly session: GuardedSession,
		private readonly computer: GuardedComputerInterface,
		private readonly registry?: WorkerRegistry,
		/** Apps several workers may share, each driving its own cursor: opencua-owned surfaces. */
		private readonly sharedApp: (pid: number) => boolean = isOwnedSurfacePid,
	) {
		// The shared session owns token validation and per-app mutation queues; this coordinator tells it which apps
		// its workers hold, so an unassigned call cannot drive a worker's app or retire the worker's token.
		session.setAppOwnership((pid) => this.ownershipRefusal(pid));
	}

	/**
	 * The refusal for a call on app `pid` that is not the owning worker's own, or undefined when the app is free, is
	 * a shared surface, or the call runs under the owning worker's cursor. A worker another opencua process assigned
	 * owns the app here too.
	 */
	private ownershipRefusal(pid: number): string | undefined {
		if (this.sharedApp(pid)) return undefined;
		const local = this.localHolder(pid);
		if (local !== undefined) {
			return local.assignment.cursor_id === currentCursorIdentity()
				? undefined
				: `app "${local.assignment.app}" is owned by worker "${local.assignment.worker_id}"; act through run_worker or manage_workers observe for that worker, or release it first`;
		}
		const remote = this.registry?.holder(pid);
		return remote === undefined
			? undefined
			: `app "${remote.app}" is owned by worker "${remote.worker_id}" in another opencua session; act through run_worker for that worker, or have that session release it first`;
	}

	/**
	 * The worker in this process that holds app `pid` right now. A worker adopted from another process is only as
	 * current as its lease, so it is looked up again first: one whose assigner released it is dropped here and holds
	 * nothing, and a reused worker id that now names another app does not hold this one.
	 */
	private localHolder(pid: number): WorkerState | undefined {
		const cached = [...this.workers.values()].find((worker) => worker.pid === pid);
		if (cached === undefined || !this.adopted.has(workerKey(cached.session, cached.assignment.worker_id))) {
			return cached;
		}
		const current = this.lookup(cached.assignment.worker_id, cached.session);
		return current?.pid === pid ? current : undefined;
	}

	async assign(
		assignments: readonly WorkerAssignmentInput[],
		sessionId = DEFAULT_WORKER_SESSION,
		options: WorkerObservationOptions = {},
	): Promise<readonly WorkerAssignment[]> {
		this.assertOpen();
		const workerIds = new Set<string>();
		const pids = new Set<number>();
		const resolved = await Promise.all(
			assignments.map(async (assignment) => ({
				assignment,
				pid: await resolveAppPid(this.computer, assignment.app),
			})),
		);
		this.assertOpen();
		const regions: { readonly worker_id: string; readonly pid: number; readonly region: WorkerRegion }[] = [
			...this.workers.values(),
		].flatMap(({ assignment, pid }) =>
			assignment.region === undefined ? [] : [{ worker_id: assignment.worker_id, pid, region: assignment.region }],
		);
		// A whole-window worker would reach into every region, so one surface has either confined workers or unconfined ones.
		const wholeWindow: { readonly worker_id: string; readonly pid: number }[] = [...this.workers.values()].flatMap(
			({ assignment, pid }) => (assignment.region === undefined ? [{ worker_id: assignment.worker_id, pid }] : []),
		);
		for (const { assignment, pid } of resolved) {
			if (workerIds.has(assignment.worker_id) || this.workers.has(workerKey(sessionId, assignment.worker_id))) {
				throw workerConflict(`worker "${assignment.worker_id}" is already assigned in session "${sessionId}"`);
			}
			const region = assignment.region;
			if (region !== undefined) {
				assertRegion(assignment.worker_id, region);
				if (!this.sharedApp(pid)) {
					throw new Error(
						`worker "${assignment.worker_id}" gives a region, but app "${assignment.app}" is not a shared opencua-owned surface; omit region to own the whole window`,
					);
				}
				const clash = regions.find((other) => other.pid === pid && regionsOverlap(other.region, region));
				if (clash !== undefined) {
					throw new Error(
						`worker "${assignment.worker_id}" region ${describeRegion(region)} overlaps worker "${clash.worker_id}" region ${describeRegion(clash.region)} in the same window`,
					);
				}
				const unconfined = wholeWindow.find((other) => other.pid === pid);
				if (unconfined !== undefined) {
					throw new Error(
						`worker "${assignment.worker_id}" gives a region, but worker "${unconfined.worker_id}" already owns the whole window; give every worker on this surface a region`,
					);
				}
				regions.push({ worker_id: assignment.worker_id, pid, region });
			} else if (this.sharedApp(pid)) {
				const confined = regions.find((other) => other.pid === pid);
				if (confined !== undefined) {
					throw new Error(
						`worker "${assignment.worker_id}" gives no region, but worker "${confined.worker_id}" is confined to ${describeRegion(confined.region)} in this window; give every worker on this surface a region`,
					);
				}
				wholeWindow.push({ worker_id: assignment.worker_id, pid });
			}
			if (
				!this.sharedApp(pid) &&
				(pids.has(pid) || [...this.workers.values()].some((worker) => worker.pid === pid))
			) {
				throw workerConflict(`app "${assignment.app}" is already owned`);
			}
			workerIds.add(assignment.worker_id);
			pids.add(pid);
		}

		const registry = this.registry;
		const leased =
			registry?.claim(
				resolved.map(({ assignment, pid }) => ({
					worker_id: workerKey(sessionId, assignment.worker_id),
					task: assignment.task,
					app: assignment.app,
					...(assignment.agent_name === undefined ? {} : { agent_name: assignment.agent_name }),
					...(assignment.parent_agent_name === undefined
						? {}
						: { parent_agent_name: assignment.parent_agent_name }),
					appPid: pid,
					...(this.sharedApp(pid) ? { shared: true } : {}),
					...(assignment.region === undefined ? {} : { region: assignment.region }),
					ownerPid: registry.ownerPid,
				})),
			) ?? [];
		const provisional = resolved.map(({ assignment, pid }) => {
			const worker: WorkerState = {
				assignment: {
					...assignment,
					cursor_id: randomUUID(),
					cursor_owner: {
						agentName: assignment.agent_name ?? assignment.worker_id,
						sessionId: this.sessionId,
						...(assignment.parent_agent_name === undefined
							? {}
							: { parentAgentName: assignment.parent_agent_name }),
					},
					observation_token: undefined,
					observation: undefined,
				},
				pid,
				session: sessionId,
				lease: leased.find((entry) => entry.worker_id === workerKey(sessionId, assignment.worker_id))?.lease,
				busy: true,
				control: "running",
				activeRun: undefined,
				lastRun: undefined,
			};
			this.workers.set(workerKey(sessionId, assignment.worker_id), worker);
			return worker;
		});
		try {
			const settled = await Promise.allSettled(
				provisional.map(async (worker) => ({
					worker,
					observed: await this.observeState(worker, {
						// A bounded table, not every worker's full tree: a worker that needs more observes again.
						maxElements: 250,
						elementFormat: "table",
						...options,
					}),
				})),
			);
			// Keep every app claimed until all sibling reads finish, even when one fails.
			const observations = settled.map((outcome) => {
				if (outcome.status === "rejected") {
					throw outcome.reason;
				}
				return outcome.value;
			});
			this.assertOpen();
			for (const { worker, observed } of observations) {
				if (observed.observation_token === undefined) {
					throw new Error(`worker "${worker.assignment.worker_id}" observation did not issue a token`);
				}
			}
			// Publish the batch only when every claimed app has usable context.
			return observations.map(({ worker, observed }) => {
				worker.assignment = {
					...worker.assignment,
					observation_token: observed.observation_token,
					observation: observed.result,
				};
				worker.busy = false;
				const { worker_id, task, app, cursor_id, cursor_owner, region } = worker.assignment;
				return {
					session_id: sessionId,
					worker_id,
					task,
					app,
					cursor_id,
					cursor_owner,
					...(region === undefined ? {} : { region }),
					...(observed.observation_token === undefined ? {} : { observation_token: observed.observation_token }),
					observation: observed.result,
				};
			});
		} catch (error: unknown) {
			for (const worker of provisional) {
				this.workers.delete(workerKey(sessionId, worker.assignment.worker_id));
				this.registry?.release(workerKey(sessionId, worker.assignment.worker_id));
			}
			throw error;
		}
	}

	async observe(
		workerId: string,
		options: WorkerObservationOptions = {},
		sessionId = DEFAULT_WORKER_SESSION,
	): Promise<WorkerObservation> {
		this.assertOpen();
		const worker = this.lookup(workerId, sessionId);
		if (worker === undefined) {
			throw workerNotAssigned(workerId);
		}
		if (worker.busy) {
			throw workerBusy(workerId);
		}
		if (worker.control === "stopped") {
			throw new WorkerControlRefusal(workerId, worker.control);
		}
		worker.busy = true;
		worker.assignment = { ...worker.assignment, observation_token: undefined };
		try {
			const result = await this.observeState(worker, {
				maxElements: 250,
				...options,
			});
			worker.assignment = {
				...worker.assignment,
				observation_token: result.observation_token,
				observation: result.result,
			};
			return result;
		} finally {
			worker.busy = false;
		}
	}

	status(sessionId = DEFAULT_WORKER_SESSION): readonly WorkerStatus[] {
		return [...this.workers.values()].flatMap(({ assignment, busy, control, lastRun, session }) => {
			if (assignment.observation === undefined || session !== sessionId) {
				return [];
			}
			return [
				{
					session_id: session,
					worker_id: assignment.worker_id,
					task: assignment.task,
					app: assignment.app,
					cursor_id: assignment.cursor_id,
					cursor_owner: assignment.cursor_owner,
					...(assignment.region === undefined ? {} : { region: assignment.region }),
					...(assignment.observation_token === undefined
						? {}
						: { observation_token: assignment.observation_token }),
					busy,
					control,
					...(lastRun === undefined ? {} : { lastRun }),
				},
			];
		});
	}

	release(workerId: string, sessionId = DEFAULT_WORKER_SESSION): void {
		this.assertOpen();
		const worker = this.lookup(workerId, sessionId);
		if (worker === undefined) {
			throw workerNotAssigned(workerId);
		}
		if (worker.busy) {
			throw workerBusy(workerId);
		}
		this.forget(worker);
	}

	/** Release every worker of one session; refused while any of them runs. */
	releaseSession(sessionId = DEFAULT_WORKER_SESSION): void {
		this.assertOpen();
		const workers = [...this.workers.values()].filter((worker) => worker.session === sessionId);
		const busy = workers.find((worker) => worker.busy);
		if (busy !== undefined) {
			throw new Error(`session "${sessionId}" has a busy worker "${busy.assignment.worker_id}"`);
		}
		for (const worker of workers) this.forget(worker);
	}

	/**
	 * Drops a worker and retires its token, so a released worker's context cannot act again. The shared claim goes
	 * first: when the registry refuses (another process assigned the worker, or is running it), nothing changes here
	 * and the refusal names that process.
	 */
	private forget(worker: WorkerState): void {
		const key = workerKey(worker.session, worker.assignment.worker_id);
		this.registry?.release(key);
		if (worker.assignment.observation_token !== undefined) {
			this.session.revokeToken(worker.assignment.observation_token);
		}
		this.workers.delete(key);
		this.adopted.delete(key);
	}

	/** Take Over: cancel the worker's in-flight run between guarded steps and refuse new runs until resume. */
	pause(workerId: string, sessionId = DEFAULT_WORKER_SESSION): WorkerControl {
		const worker = this.controlled(workerId, sessionId);
		if (worker.control === "stopped") {
			throw new WorkerControlRefusal(workerId, worker.control);
		}
		worker.control = "paused";
		worker.activeRun?.abort();
		return worker.control;
	}

	/** Stop: cancel the in-flight run and refuse every further run or observation until release. */
	stop(workerId: string, sessionId = DEFAULT_WORKER_SESSION): WorkerControl {
		const worker = this.controlled(workerId, sessionId);
		worker.control = "stopped";
		worker.activeRun?.abort();
		return worker.control;
	}

	resume(workerId: string, sessionId = DEFAULT_WORKER_SESSION): WorkerControl {
		const worker = this.controlled(workerId, sessionId);
		if (worker.control === "stopped") {
			throw new WorkerControlRefusal(workerId, "stopped");
		}
		worker.control = "running";
		return worker.control;
	}

	async run(
		workerId: string,
		token: string,
		steps: readonly RunStep[],
		expect: VerifyRequest | undefined,
		resultOptions: MutationOptions = {},
		executionOptions: RunControl = {},
		sessionId = DEFAULT_WORKER_SESSION,
	): Promise<WorkerRunResult> {
		this.assertOpen();
		const worker = this.lookup(workerId, sessionId);
		if (worker === undefined) {
			throw workerNotAssigned(workerId);
		}
		if (worker.busy) {
			throw workerBusy(workerId);
		}
		if (token !== worker.assignment.observation_token) {
			throw new Error(`observation token does not belong to worker "${workerId}"`);
		}
		if (worker.control !== "running") {
			throw new WorkerControlRefusal(workerId, worker.control);
		}
		// Every opencua process sees the run through the shared busy marker: a release or a second run elsewhere waits
		// for it, and one already in flight elsewhere refuses this one before anything changes here.
		const key = workerKey(worker.session, worker.assignment.worker_id);
		const sharedRun = this.registry?.beginRun(key);
		worker.busy = true;
		worker.assignment = { ...worker.assignment, observation_token: undefined };
		const startedAt = new Date().toISOString();
		const activeRun = new AbortController();
		worker.activeRun = activeRun;
		const signal =
			executionOptions.signal === undefined
				? activeRun.signal
				: AbortSignal.any([executionOptions.signal, activeRun.signal]);
		const region = worker.assignment.region;
		try {
			const bare = createRunStepDriver(this.computer);
			const driver = sharedRun === undefined ? bare : this.leasedDriver(bare, worker, sharedRun);
			const dispatch = () =>
				withCursorIdentity(
					worker.assignment.cursor_id,
					async () => {
						const runAll = () =>
							this.session.runSteps(
								token,
								String(worker.pid),
								steps,
								expect,
								region === undefined ? driver : this.confinedDriver(driver, worker, region, steps),
								resultOptions,
								{ ...executionOptions, signal },
							);
						if (region === undefined) return await runAll();
						// Every target known before the run is checked before any of its input goes out.
						const observation = this.computer.getInputObservation(worker.pid);
						for (const [index, step] of steps.entries()) {
							await this.assertInRegion(worker, region, index, pointerTargets(step) ?? [], observation);
						}
						const screenRegion = regionOnScreen(region, observation);
						if (screenRegion === undefined) {
							throw new WorkerRegionRefusal(
								worker.assignment.worker_id,
								0,
								region,
								"has no observed window to place its region on",
							);
						}
						// The input layer refuses any event or keystroke outside the region right before posting it.
						return await withInputRegion(screenRegion, runAll);
					},
					// The cursor shows what this worker is for next to its name.
					{ ...worker.assignment.cursor_owner, purpose: worker.assignment.task },
				);
			const pending = this.computer.delivery === "background" ? dispatch() : this.attendedTail.then(dispatch);
			if (this.computer.delivery !== "background") {
				this.attendedTail = pending.then(
					() => undefined,
					() => undefined,
				);
			}
			const result = await pending;
			const resultPayload = payload(result);
			const resultText = result.content.find((content) => content.type === "text");
			const nextToken = resultPayload["observation_token"];
			const resultError =
				result.isError === true
					? String(resultPayload["reason"] ?? resultPayload["error"] ?? "worker run failed").slice(0, 200)
					: undefined;
			if (typeof nextToken === "string") {
				worker.assignment = { ...worker.assignment, observation_token: nextToken, observation: result };
			}
			worker.lastRun = {
				startedAt,
				endedAt: new Date().toISOString(),
				ok: result.isError !== true,
				stepCount: steps.length,
				...(resultError === undefined ? {} : { errorSummary: resultError }),
				...(typeof resultPayload["appId"] === "string" || typeof resultPayload["appId"] === "number"
					? { appId: resultPayload["appId"] }
					: {}),
				...(typeof resultPayload["bundleId"] === "string" ? { bundleId: resultPayload["bundleId"] } : {}),
				...(resultText?.type === "text" ? { text: resultText.text.trim().slice(0, 2000) } : {}),
			};
			const { worker_id, task, app, cursor_id, cursor_owner } = worker.assignment;
			return {
				session_id: worker.session,
				worker_id,
				task,
				app,
				cursor_id,
				cursor_owner,
				...(typeof nextToken === "string" ? { observation_token: nextToken } : {}),
				result,
			};
		} catch (error: unknown) {
			if (error instanceof WorkerRegionRefusal && !error.actionDispatched) {
				// Nothing was sent and the session never consumed the token, so the worker may fix the step and retry.
				worker.assignment = { ...worker.assignment, observation_token: token };
			}
			const errorSummary = (error instanceof Error ? error.message : String(error)).slice(0, 200);
			worker.lastRun = {
				startedAt,
				endedAt: new Date().toISOString(),
				ok: false,
				stepCount: steps.length,
				errorSummary,
			};
			if (notificationsEnabled()) {
				postNotification("opencua", `worker ${workerId} task failed: ${errorSummary.slice(0, 120)}`);
			}
			throw error;
		} finally {
			worker.busy = false;
			worker.activeRun = undefined;
			if (sharedRun !== undefined) this.registry?.endRun(key, sharedRun);
		}
	}

	/**
	 * Refuses new work at once, lets the session drain the calls already in flight (for at most
	 * {@link CLOSE_DRAIN_MILLISECONDS}: a process on its way out cannot wait forever), and only then gives up this
	 * process's claims, so no other process can take an app this one is still sending input to. A claim another
	 * process is running stays with it; this process's exit frees it.
	 */
	close(): Promise<void> {
		this.closed = true;
		this.closePromise ??= (async () => {
			const drained = this.session.close();
			await Promise.race([drained, delayMilliseconds(CLOSE_DRAIN_MILLISECONDS)]);
			for (const workerId of this.workers.keys()) {
				if (this.adopted.has(workerId)) continue;
				try {
					this.registry?.release(workerId);
				} catch (error: unknown) {
					if (!(error instanceof WorkerLeaseRefusal)) throw error;
				}
			}
			this.workers.clear();
			await drained;
		})();
		return this.closePromise;
	}

	/**
	 * The driver for a worker another opencua process may take over: the shared claim is read right before each
	 * step's input goes out, and a step whose lease is gone (its assigning process exited and the app was claimed
	 * again, or the marker was cleared) is refused together with every step after it.
	 */
	private leasedDriver(driver: RunStepDriver, worker: WorkerState, run: SharedWorkerRun): RunStepDriver {
		const key = workerKey(worker.session, worker.assignment.worker_id);
		let dispatched = false;
		return {
			...driver,
			dispatch: async (step, targetPid, observation, actions, options) => {
				const entry = this.registry?.find(key);
				if (entry === undefined || entry.lease !== worker.lease || entry.busy?.run !== run.run) {
					throw new WorkerLeaseLost(worker.assignment.worker_id, dispatched);
				}
				const result = await driver.dispatch(step, targetPid, observation, actions, options);
				if (step.type !== "reveal" && step.type !== "wait_for") dispatched = true;
				return result;
			},
		};
	}

	/**
	 * The driver for a confined worker: a step whose target is named by description resolves mid-run, so its
	 * resolved point is checked right before that step's input goes out.
	 */
	private confinedDriver(
		driver: RunStepDriver,
		worker: WorkerState,
		region: WorkerRegion,
		steps: readonly RunStep[],
	): RunStepDriver {
		// A resolved step is a new object; remember which submitted step it came from so a refusal names its index.
		const origin = new Map<RunStep, number>(steps.map((step, index) => [step, index]));
		const remember = (step: RunStep, runnable: RunStep): RunStep => {
			origin.set(runnable, origin.get(step) ?? -1);
			return runnable;
		};
		let dispatched = false;
		return {
			...driver,
			resolve: (step, elementIndex) => remember(step, driver.resolve(step, elementIndex)),
			resolveAtPoint: (step, observation, point) => remember(step, driver.resolveAtPoint(step, observation, point)),
			dispatch: async (step, targetPid, observation, actions, options) => {
				const index = origin.get(step) ?? -1;
				await this.assertInRegion(worker, region, index, pointerTargets(step) ?? [], observation, dispatched);
				const result = await driver.dispatch(step, targetPid, observation, actions, options);
				// reveal and wait_for only read the screen: their dispatch sends no input.
				if (step.type !== "reveal" && step.type !== "wait_for") dispatched = true;
				return result;
			},
		};
	}

	private async assertInRegion(
		worker: WorkerState,
		region: WorkerRegion,
		step: number,
		targets: readonly PointerTarget[],
		observation: InputObservation | undefined,
		dispatchedBefore = false,
	): Promise<void> {
		for (const target of targets) {
			const point =
				"point" in target ? target.point : await this.elementPoint(worker.pid, target.element, observation);
			const label = "point" in target ? target.what : `${target.what} ${target.element}`;
			if (point === undefined) {
				throw new WorkerRegionRefusal(
					worker.assignment.worker_id,
					step,
					region,
					`${label}, which has no on-screen frame to prove it lies`,
					dispatchedBefore,
				);
			}
			if (!regionContains(region, point)) {
				throw new WorkerRegionRefusal(
					worker.assignment.worker_id,
					step,
					region,
					`${label} at (${point.x}, ${point.y})`,
					dispatchedBefore,
				);
			}
		}
	}

	/** An element's centre in screenshot-local window pixels: its on-screen frame mapped through the observed viewport. */
	private async elementPoint(
		pid: number,
		element: number,
		observation: InputObservation | undefined,
	): Promise<Point | undefined> {
		const frame = await this.computer.elementFrame?.(pid, element);
		const viewport = observation?.screenshotViewport;
		if (frame === undefined || viewport === undefined || !(frame.width > 0 && frame.height > 0)) {
			return undefined;
		}
		const { bounds } = viewport;
		return {
			x: ((frame.x + frame.width / 2 - bounds.x) / bounds.width) * viewport.width,
			y: ((frame.y + frame.height / 2 - bounds.y) / bounds.height) * viewport.height,
		};
	}

	/** A worker this process assigned, or one another opencua process assigned that this one now acts for. */
	private lookup(workerId: string, sessionId = DEFAULT_WORKER_SESSION): WorkerState | undefined {
		const key = workerKey(sessionId, workerId);
		const cached = this.workers.get(key);
		// An adopted worker lives only while the lease it was adopted under does: a release in the assigning process
		// ends it here too, together with any token this process issued for it. A later claim of the same worker id by
		// anyone is a different worker, adopted afresh below.
		if (cached !== undefined && this.adopted.has(key) && this.registry?.find(key)?.lease !== cached.lease) {
			if (cached.assignment.observation_token !== undefined) {
				this.session.revokeToken(cached.assignment.observation_token);
			}
			this.workers.delete(key);
			this.adopted.delete(key);
		}
		const local = this.workers.get(key);
		const shared = local === undefined ? this.registry?.find(key) : undefined;
		if (shared === undefined) return local;
		const worker: WorkerState = {
			assignment: {
				worker_id: workerId,
				task: shared.task,
				app: shared.app,
				...(shared.agent_name === undefined ? {} : { agent_name: shared.agent_name }),
				...(shared.parent_agent_name === undefined ? {} : { parent_agent_name: shared.parent_agent_name }),
				...(shared.region === undefined ? {} : { region: shared.region }),
				cursor_id: randomUUID(),
				cursor_owner: {
					agentName: shared.agent_name ?? workerId,
					sessionId: this.sessionId,
					...(shared.parent_agent_name === undefined ? {} : { parentAgentName: shared.parent_agent_name }),
				},
				observation_token: undefined,
				observation: undefined,
			},
			pid: shared.appPid,
			session: sessionId,
			lease: shared.lease,
			busy: false,
			control: "running",
			activeRun: undefined,
			lastRun: undefined,
		};
		this.workers.set(key, worker);
		this.adopted.add(key);
		return worker;
	}

	private controlled(workerId: string, sessionId = DEFAULT_WORKER_SESSION): WorkerState {
		this.assertOpen();
		const worker = this.lookup(workerId, sessionId);
		if (worker === undefined) {
			throw workerNotAssigned(workerId);
		}
		return worker;
	}

	private assertOpen(): void {
		if (this.closed) {
			this.workers.clear();
			throw new Error("worker coordinator is closed");
		}
	}

	private async observeState(worker: WorkerState, options: WorkerObservationOptions): Promise<WorkerObservation> {
		if (
			worker.assignment.observation !== undefined &&
			(await resolveAppPid(this.computer, worker.assignment.app)) !== worker.pid
		) {
			throw new Error(`worker "${worker.assignment.worker_id}" app process changed; release and reassign it`);
		}
		const result = await withCursorIdentity(
			worker.assignment.cursor_id,
			() =>
				this.session.observe({
					...options,
					app: String(worker.pid),
					diffOnly: options.diffOnly ?? false,
					includeAccessibilityTree: true,
					includeScreenshot: options.includeScreenshot ?? false,
				}),
			worker.assignment.cursor_owner,
		);
		const previous = worker.assignment.observation;
		if (previous !== undefined && payload(previous)["bundleId"] !== payload(result)["bundleId"]) {
			throw new Error(`worker "${worker.assignment.worker_id}" app identity changed; release and reassign it`);
		}
		const token = payload(result)["observation_token"];
		const { worker_id, task, app, cursor_id, cursor_owner } = worker.assignment;
		return {
			session_id: worker.session,
			worker_id,
			task,
			app,
			cursor_id,
			cursor_owner,
			...(typeof token === "string" ? { observation_token: token } : {}),
			result,
		};
	}
}
