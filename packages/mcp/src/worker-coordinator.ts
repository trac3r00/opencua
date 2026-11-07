import { randomUUID } from "node:crypto";
import {
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
import type { WorkerRegistry } from "./worker-registry.js";

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

export type WorkerObservationOptions = Omit<ObservationOptions, "includeAccessibilityTree">;

export type WorkerObservation = {
	readonly worker_id: string;
	readonly task: string;
	readonly app: string;
	readonly cursor_id: string;
	readonly cursor_owner: CursorOwner;
	readonly observation_token?: string;
	readonly result: ToolResult;
};

export type WorkerRunResult = {
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

	constructor(
		private readonly session: GuardedSession,
		private readonly computer: GuardedComputerInterface,
		private readonly registry?: WorkerRegistry,
		/** Apps several workers may share, each driving its own cursor: opencua-owned surfaces. */
		private readonly sharedApp: (pid: number) => boolean = isOwnedSurfacePid,
	) {
		// The shared session owns token validation and per-app mutation queues.
	}

	async assign(assignments: readonly WorkerAssignmentInput[]): Promise<readonly WorkerAssignment[]> {
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
			if (workerIds.has(assignment.worker_id) || this.workers.has(assignment.worker_id)) {
				throw new Error(`worker "${assignment.worker_id}" is already assigned`);
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
				throw new Error(`app "${assignment.app}" is already owned`);
			}
			workerIds.add(assignment.worker_id);
			pids.add(pid);
		}

		this.registry?.claim(
			resolved.map(({ assignment, pid }) => ({
				worker_id: assignment.worker_id,
				task: assignment.task,
				app: assignment.app,
				...(assignment.agent_name === undefined ? {} : { agent_name: assignment.agent_name }),
				...(assignment.parent_agent_name === undefined ? {} : { parent_agent_name: assignment.parent_agent_name }),
				appPid: pid,
				...(this.sharedApp(pid) ? { shared: true } : {}),
				...(assignment.region === undefined ? {} : { region: assignment.region }),
				ownerPid: process.pid,
			})),
		);
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
				busy: true,
				control: "running",
				activeRun: undefined,
				lastRun: undefined,
			};
			this.workers.set(assignment.worker_id, worker);
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
				this.workers.delete(worker.assignment.worker_id);
				this.registry?.release(worker.assignment.worker_id);
			}
			throw error;
		}
	}

	async observe(workerId: string, options: WorkerObservationOptions = {}): Promise<WorkerObservation> {
		this.assertOpen();
		const worker = this.lookup(workerId);
		if (worker === undefined) {
			throw new Error(`worker "${workerId}" is not assigned`);
		}
		if (worker.busy) {
			throw new Error(`worker "${workerId}" is busy`);
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

	status(): readonly WorkerStatus[] {
		return [...this.workers.values()].flatMap(({ assignment, busy, control, lastRun }) => {
			if (assignment.observation === undefined) {
				return [];
			}
			return [
				{
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

	release(workerId: string): void {
		this.assertOpen();
		const worker = this.lookup(workerId);
		if (worker === undefined) {
			throw new Error(`worker "${workerId}" is not assigned`);
		}
		if (worker.busy) {
			throw new Error(`worker "${workerId}" is busy`);
		}
		this.workers.delete(workerId);
		this.adopted.delete(workerId);
		this.registry?.release(workerId);
	}

	/** Take Over: cancel the worker's in-flight run between guarded steps and refuse new runs until resume. */
	pause(workerId: string): WorkerControl {
		const worker = this.controlled(workerId);
		if (worker.control === "stopped") {
			throw new WorkerControlRefusal(workerId, worker.control);
		}
		worker.control = "paused";
		worker.activeRun?.abort();
		return worker.control;
	}

	/** Stop: cancel the in-flight run and refuse every further run or observation until release. */
	stop(workerId: string): WorkerControl {
		const worker = this.controlled(workerId);
		worker.control = "stopped";
		worker.activeRun?.abort();
		return worker.control;
	}

	resume(workerId: string): WorkerControl {
		const worker = this.controlled(workerId);
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
	): Promise<WorkerRunResult> {
		this.assertOpen();
		const worker = this.lookup(workerId);
		if (worker === undefined) {
			throw new Error(`worker "${workerId}" is not assigned`);
		}
		if (worker.busy) {
			throw new Error(`worker "${workerId}" is busy`);
		}
		if (token !== worker.assignment.observation_token) {
			throw new Error(`observation token does not belong to worker "${workerId}"`);
		}
		if (worker.control !== "running") {
			throw new WorkerControlRefusal(workerId, worker.control);
		}
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
			const driver = createRunStepDriver(this.computer);
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
					worker.assignment.cursor_owner,
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
		}
	}

	async close(): Promise<void> {
		this.closed = true;
		for (const workerId of this.workers.keys()) {
			if (!this.adopted.has(workerId)) this.registry?.release(workerId);
		}
		this.workers.clear();
		await this.session.close();
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
	private lookup(workerId: string): WorkerState | undefined {
		const local = this.workers.get(workerId);
		const shared = local === undefined ? this.registry?.find(workerId) : undefined;
		if (shared === undefined) return local;
		const worker: WorkerState = {
			assignment: {
				worker_id: shared.worker_id,
				task: shared.task,
				app: shared.app,
				...(shared.agent_name === undefined ? {} : { agent_name: shared.agent_name }),
				...(shared.parent_agent_name === undefined ? {} : { parent_agent_name: shared.parent_agent_name }),
				...(shared.region === undefined ? {} : { region: shared.region }),
				cursor_id: randomUUID(),
				cursor_owner: {
					agentName: shared.agent_name ?? shared.worker_id,
					sessionId: this.sessionId,
					...(shared.parent_agent_name === undefined ? {} : { parentAgentName: shared.parent_agent_name }),
				},
				observation_token: undefined,
				observation: undefined,
			},
			pid: shared.appPid,
			busy: false,
			control: "running",
			activeRun: undefined,
			lastRun: undefined,
		};
		this.workers.set(workerId, worker);
		this.adopted.add(workerId);
		return worker;
	}

	private controlled(workerId: string): WorkerState {
		this.assertOpen();
		const worker = this.lookup(workerId);
		if (worker === undefined) {
			throw new Error(`worker "${workerId}" is not assigned`);
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
					diffOnly: false,
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
