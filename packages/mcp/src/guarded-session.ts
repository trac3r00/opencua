import { randomUUID } from "node:crypto";
import { DecisionAgent, type PlatformAdapter, createDecider, macosAdapter } from "@opencua/agent";
import {
	AX_PRESS_ACTION,
	HandsCoordinator,
	HotFrameSource,
	InputInterrupted,
	currentCursorIdentity,
	describeQuery,
	describeUserStop,
	isOwnedSurfacePid,
	matchElements,
	openApplication,
	parseElementIndex,
	resolveAppPid,
	runInInputScope,
	suggestNearMisses,
} from "@opencua/core";
import type {
	AXTreeElement,
	AppOpenLauncher,
	AppState,
	ElementMatch,
	ElementQuery,
	GuardedComputerInterface,
	HandResource,
	HandTask,
	HandsPolicy,
	HandsRunResult,
	InputObservation,
	Point,
	Rect,
	StopStatusSource,
	SystemPrompt,
	TopLevelWindow,
	WindowProbe,
} from "@opencua/core";
import { latestDecisionFrame } from "./decision-frame.js";
import { settleDeferredOutcome } from "./deferred-settle.js";
import type { ResolvedTargetClick } from "./mutation-actions.js";
import {
	type FindEvidence,
	type ScrollFindChain,
	type ScrollFindResult,
	type StepFind,
	findByScrolling,
} from "./scroll-find.js";
import {
	type ActionDispatch,
	type ElementFormat,
	type RunHandsLaneReport,
	type RunHandsReport,
	type RunHandsVisionReport,
	type RunStepReport,
	type RunStepsReport,
	SYSTEM_PROMPT_NOTE,
	type SetFieldStepReport,
	type SetFieldsReport,
	type StepDispatch,
	type ToolResult,
	type Verification,
	type VerificationCheck,
	type WindowEvent,
	appNotRunningResult,
	compactElement,
	compactElementMatch,
	deferredHandsResult,
	describeElement,
	describeSystemPrompt,
	lockRefusalResult,
	observedActionResult,
	observedHandsResult,
	observedRunStepsResult,
	observedSetFieldsResult,
	openAppResult,
	postActionErrorResult,
	refusalResult,
	stateResult,
	targetStateResult,
	textResult,
	verificationResult,
} from "./tool-result.js";
import type { RunStep } from "./tool-schemas.js";

const VERIFY_POLL_INTERVAL_MILLISECONDS = 150;
/** How long the vision lane waits for the refresher's next frame before a live capture. */
const HOT_FRAME_WAIT_BUDGET_MS = 250;
/** How long one targeting attempt waits before re-observing while it looks for its element. */
const TARGET_POLL_INTERVAL_MILLISECONDS = 200;
const DEFAULT_FIND_RESULTS = 5;
const MAX_NEAR_MISSES = 5;
const MAX_ALTERNATIVES = 3;

function timingEnabled(): boolean {
	return process.env["OPENCUA_TIMING"] === "1";
}
async function timed<T>(label: string, run: () => Promise<T>): Promise<T> {
	if (!timingEnabled()) {
		return await run();
	}
	const startedAt = performance.now();
	try {
		return await run();
	} finally {
		process.stderr.write(`[timing] ${label} ${(performance.now() - startedAt).toFixed(1)}\n`);
	}
}

function delayMilliseconds(milliseconds: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, milliseconds);
	});
}

const STRICT_STATE_OPTIONS = { requireWindow: true } as const;
const STRICT_DIFF_STATE_OPTIONS = { diffOnly: true, requireWindow: true } as const;
// A baseline read only needs element facts; capturing the window image here cost a screen grab
// per element step for pixels nothing looked at.
const FIELD_VERIFY_STATE_OPTIONS = { requireWindow: true, settleMs: 80, includeScreenshot: false } as const;
/** The outcome is only a token/diff, so cap the walk well below the full-tree budget. */
const FAST_OUTCOME_MAX_ELEMENTS = 250;

export interface MutationOptions {
	/** Read back a single field from the post-action tree, without another accessibility walk. */
	readonly valueCheck?: { readonly elementIndex: number; readonly value: string };
	/** Return the whole accessibility tree in the post-action observation instead of only the diff. */
	readonly fullState?: boolean;
	/**
	 * Attach the post-action window image. The default answer is text-only so a verified step costs
	 * about a kilobyte instead of a hundred, and callers ask for pixels only when pixels decide the
	 * next step.
	 */
	readonly includeScreenshot?: boolean;
	/**
	 * The action maps observed screenshot coordinates onto the screen, so the window must not have
	 * moved or resized since the observation. Element, keyboard and menu actions leave this unset.
	 */
	readonly screenPoints?: boolean;
	/**
	 * Read the whole tree after the action and keep it, so the next action on this app (a script's next
	 * step) can resolve its target against it instead of walking the UI again. The answer is still the
	 * diff-only state a plain read would have produced.
	 */
	readonly retainTree?: boolean;
}

export interface ObservationOptions {
	/** Omit the image: the cheapest way to re-index elements before an element action. */
	readonly includeScreenshot?: boolean;
	/**
	 * Skip the accessibility walk and the settle wait, and answer with the capture only: the
	 * cheapest observation, for previews and for callers that already hold the tree. No element
	 * ids are produced, so no observation token is issued for it.
	 */
	readonly includeAccessibilityTree?: boolean;
	/** Cap the settle wait before capture; 0 skips the wait for a UI the caller knows is still. */
	readonly settleMs?: number;
	/** Cap the accessibility elements returned for this observation. */
	readonly maxElements?: number;
	/** Return only elements fully visible in the observed window. */
	readonly visibleOnly?: boolean;
	/** Include the application menu bar, which is app chrome rather than window content. */
	readonly includeMenuBar?: boolean;
	/**
	 * Observe only the subtree rooted at this element id from the previous observation of the
	 * same app. Ids restart at 0 inside the subtree, which is how a capped or truncated tree is
	 * explored a branch at a time instead of raising max_elements.
	 */
	readonly subtreeOf?: number;
	/**
	 * Observe this WindowServer window id instead of the app's focused window. Use a candidate
	 * from `windowCandidates` when an app has several windows.
	 */
	readonly windowId?: number;
	readonly elementFormat?: ElementFormat;
}

export interface ObserveRequest extends ObservationOptions {
	readonly app: string;
	readonly diffOnly: boolean;
}

export interface VerifyCheckRequest {
	readonly element_index: string;
	readonly exists?: boolean | undefined;
	readonly value?: string | undefined;
	readonly label?: string | undefined;
}

export interface VerifyRequest {
	readonly checks?: readonly VerifyCheckRequest[] | undefined;
	readonly windowTitle?: string | undefined;
	readonly timeoutMs?: number | undefined;
}

export interface SetFieldUpdate {
	readonly element_index: string;
	readonly value: string;
}

/** Dispatches one click on a control the session resolved by description. */
export type ResolvedTargetDispatcher = (
	targetPid: number,
	observation: InputObservation,
	target: ResolvedTargetClick,
) => Promise<ActionDispatch>;

export interface FindElementsRequest {
	readonly app: string;
	readonly query: ElementQuery;
	readonly windowId?: number;
	readonly maxResults?: number;
	readonly maxElements?: number;
	readonly includeScreenshot?: boolean;
}

export interface ClickTargetRequest {
	readonly app: string;
	readonly query: ElementQuery;
	readonly index?: number;
	/** How long to keep looking for the element before giving up; 0 acts on what is there now. */
	readonly timeoutMs?: number;
	readonly press?: "auto" | "accessibility" | "pointer";
	readonly hoverFirst?: boolean;
	readonly clickCount?: number;
	readonly mouseButton?: "left" | "right" | "middle";
	readonly expect?: VerifyRequest;
	readonly fullState?: boolean;
	readonly includeScreenshot?: boolean;
	readonly windowId?: number;
}

export interface OpenAppRequest {
	readonly name: string;
	readonly timeoutMs?: number;
}

/**
 * Step-type knowledge the session needs to run a batch: which observed element a step
 * targets (if any), how to validate it against the token observation, and how to dispatch it.
 */
export interface StepTarget {
	readonly query: ElementQuery;
	/** Which match to use, best first. */
	readonly index: number;
	/** Look past the edge of the window for it: scroll the area a page at a time, and read the pixels too. */
	readonly find?: StepFind;
}

export interface StepWait {
	readonly query?: ElementQuery;
	/** Wait for the query to stop matching instead of to start matching. */
	readonly gone: boolean;
	readonly windowTitle?: string;
	readonly timeoutMs: number;
}

/** Lets the caller watch a batch progress and stop it between steps. */
export type RunPace = "verified" | "fast";

export interface RunControl {
	/**
	 * `verified` (default) reads the UI before every step that names an element. `fast` resolves the targets
	 * known up front against one read and runs only cheap guards between steps, for a person-like chain.
	 */
	readonly pace?: RunPace;
	readonly signal?: AbortSignal;
	readonly onProgress?: (completed: number, total: number, message: string) => void;
}

export interface RunHandsVisionOptions {
	readonly includeScreenshot?: boolean;
	readonly settleMs?: number;
	readonly maxElements?: number;
}

type HandsLaneValue = readonly RunStepReport[] | HandsVisionCapture;

/**
 * One guarded two-handed batch sharing a single observation token. Keyboard and pointer lanes
 * are explicit sequences; vision is an optional concurrent capture. The overlap policy is a
 * resource decision, not a promise: attended focus conflicts always serialize.
 */
export interface RunHandsRequest {
	readonly app: string;
	readonly token: string;
	readonly keyboard: readonly RunStep[];
	readonly pointer: readonly RunStep[];
	readonly vision?: RunHandsVisionOptions | undefined;
	readonly overlap: HandsPolicy;
	readonly expect?: VerifyRequest | undefined;
	/** Undefined takes the deferred outcome for eligible input-only calls; "live" always reads. */
	readonly outcomeMode?: "live" | "deferred" | undefined;
	readonly fullState: boolean;
	readonly includeScreenshot: boolean;
}

interface HandsVisionImage {
	readonly base64: string;
	readonly mimeType: "image/png" | "image/jpeg";
	readonly width: number;
	readonly height: number;
}

interface HandsVisionCapture {
	readonly image: HandsVisionImage | undefined;
	readonly unavailable?: string;
	readonly durationMs: number;
	readonly frameAgeMs?: number;
	readonly hot?: boolean;
}

export interface StepDispatchOptions {
	/** The final type_text is covered by the outcome read; earlier writes keep their fence. */
	readonly settleWrite?: boolean;
}

export interface RunStepDriver {
	readonly elementIndex: (step: RunStep) => number | undefined;
	/** The described element a step acts on, resolved against a fresh read right before it runs. */
	readonly target: (step: RunStep) => StepTarget | undefined;
	readonly wait: (step: RunStep) => StepWait | undefined;
	/** The same step naming the element its target resolved to. */
	readonly resolve: (step: RunStep, elementIndex: number) => RunStep;
	/** The same step aimed at a screen point (global logical points) where text was read from the window's pixels. */
	readonly resolveAtPoint: (step: RunStep, observation: InputObservation, point: Point) => RunStep;
	readonly validate: (step: RunStep, observation: InputObservation) => void;
	readonly dispatch: (
		step: RunStep,
		targetPid: number,
		observation: InputObservation,
		actions?: readonly string[],
		options?: StepDispatchOptions,
	) => Promise<StepDispatch>;
}

type Mutation = (
	targetPid: number,
	observation: InputObservation,
	elements: ObservedElementIdentity | undefined,
	// biome-ignore lint/suspicious/noConfusingVoidType: a mutation may report how it dispatched input, or report nothing when its route is not known to it
) => Promise<ActionDispatch | void>;
type Validation = (observation: InputObservation) => void;
type ObservedElementIdentity = ReadonlyMap<
	number,
	{ readonly role: string; readonly label: string | null; readonly y: number; readonly actions: readonly string[] }
>;

type TargetLookup<T> = { readonly found: T } | { readonly missing: string };
type ElementFinder<T> = (elements: ReadonlyMap<number, AXTreeElement>) => TargetLookup<T>;

/** What a run_steps chain resolves its element targets against, and whether to keep that read between steps. */
type ChainTree = ScrollFindChain;

function findQueryTarget(target: StepTarget): ElementFinder<ReturnType<typeof matchElements>[number]> {
	return (elements) => {
		const match = matchElements([...elements.values()], target.query)[target.index];
		return match === undefined
			? {
					missing: `no element in the current window matches ${describeQuery(target.query)}${target.index > 0 ? ` at position ${target.index}` : ""}`,
				}
			: { found: match };
	};
}

function findObservedElement(
	elementIndex: number,
	observedIdentity: ReturnType<ObservedElementIdentity["get"]>,
): ElementFinder<AXTreeElement> {
	return (elements) => {
		const element = elements.get(elementIndex);
		if (element === undefined) {
			return { missing: `element ${elementIndex} is not present in the latest observation` };
		}
		return observedIdentity !== undefined && !sameElementIdentity(observedIdentity, element)
			? {
					missing: `element ${elementIndex} is now ${element.role} "${element.label ?? ""}", not the observed control; re-observe`,
				}
			: { found: element };
	};
}

/** A refusal to dispatch input: nothing was sent, and the caller must be told why. */
class InputRefusal extends Error {
	constructor(
		readonly reason: string,
		detail?: string,
	) {
		super(detail ?? `input refused: ${reason}`);
	}
}

/**
 * How long the tree read after an action may stand in for the next action's pre-dispatch read. The
 * outcome read already waited for the UI to settle, so only a script's own glue code runs in between;
 * anything slower falls back to a fresh read.
 */
const READ_REUSE_MILLISECONDS = 300;

/** Steps that act on screen points, so a moved or resized window must stop a fast-paced chain. */
const POINTER_STEP_TYPES: ReadonlySet<string> = new Set(["click", "drag", "scroll"]);

const FAST_PACE_NOTE =
	"pace: fast - the steps ran back to back without reading the UI between them (the stop switch and the window were still checked before each step); intermediate states were not individually read, only the final outcome was.";

/** A settled, complete tree read that is still the app's latest observation. */
interface ReusableRead {
	readonly observation: InputObservation;
	readonly elements: ReadonlyMap<number, AXTreeElement>;
	readonly at: number;
}

/**
 * Where an app's token, reusable read and input queue live: the pid, or for an opencua-owned surface the pid plus the
 * acting cursor, so several workers can hold tokens for one shared window and act on it at the same time.
 */
type LaneKey = number | string;

interface LiveToken {
	readonly token: string;
	readonly key: LaneKey;
	readonly observation: InputObservation;
	readonly elements: ObservedElementIdentity | undefined;
	/** True when the token answers a deferred outcome: its element ids predate the action. */
	readonly deferred: boolean;
}

export interface DecisionRunRequest {
	readonly app: string;
	readonly goal: string;
	readonly maxSteps?: number;
	readonly approveRisk?: boolean;
	readonly timeoutMs?: number;
}

export class GuardedSession {
	private readonly tokens = new Map<string, LiveToken>();
	private readonly tokenByPid = new Map<LaneKey, string>();
	private readonly reusableReads = new Map<LaneKey, ReusableRead>();
	private readonly resolvedAppPids = new Map<string, number>();
	/** The window each app's latest observation named (window_id, a script's bound window), by pid. */
	private readonly boundWindows = new Map<number, number>();
	private readonly tails = new Map<LaneKey, Promise<void>>();
	private globalTail: Promise<void> = Promise.resolve();
	private closed = false;
	private closePromise: Promise<void> | undefined;

	constructor(
		private readonly computer: GuardedComputerInterface,
		private readonly windowProbe?: WindowProbe,
		private readonly appLauncher?: AppOpenLauncher,
		private readonly systemPromptProbe?: () => readonly SystemPrompt[],
		private readonly stopSwitch?: StopStatusSource,
		private readonly hotFrames: HotFrameSource = new HotFrameSource(),
	) {}

	listApps(): Promise<ToolResult> {
		return this.enqueue(undefined, async () => textResult(JSON.stringify(await this.computer.listApps(), null, 2)));
	}

	/**
	 * Every on-screen top-level window, or only `app`'s. Titles the WindowServer withholds (from a process
	 * without Screen Recording) are filled in from the apps themselves.
	 */
	listWindows(options: { readonly app?: string } = {}): Promise<ToolResult> {
		return this.enqueue(undefined, async () => {
			const pid = options.app === undefined ? undefined : await this.resolvePid(options.app);
			const windows =
				this.windowProbe === undefined
					? []
					: (await this.windowProbe({ titlesFor: pid === undefined ? "all" : [pid] })).filter(
							(window) => pid === undefined || window.ownerPid === pid,
						);
			const prompts = this.systemPromptProbe === undefined ? [] : this.systemPromptProbe();
			return textResult(
				JSON.stringify(
					{
						windows: windows.map((window) => ({
							window_id: window.id,
							pid: window.ownerPid,
							app: window.ownerName,
							title: window.title,
							bounds: window.bounds,
						})),
						...(prompts.length > 0
							? { system_prompts: prompts.map(describeSystemPrompt), system_prompt_note: SYSTEM_PROMPT_NOTE }
							: {}),
					},
					null,
					2,
				),
			);
		});
	}

	/** `app`'s open windows, titled, for binding a script handle to one of them by its title. */
	async windowsOf(app: string): Promise<{ readonly pid: number; readonly windows: readonly TopLevelWindow[] }> {
		this.assertOpen();
		const pid = await this.resolvePid(app);
		return { pid, windows: await this.windowsForPid(pid) };
	}

	async observe(request: ObserveRequest): Promise<ToolResult> {
		const targetPid = await this.resolvePid(request.app);
		return this.enqueue(targetPid, async () => {
			this.clearTokenFor(targetPid);
			this.bindWindow(targetPid, request.windowId);
			const startedAt = timingEnabled() ? performance.now() : undefined;
			const state = await this.computer.getAppState(targetPid, {
				...(request.diffOnly ? STRICT_DIFF_STATE_OPTIONS : STRICT_STATE_OPTIONS),
				...(request.includeScreenshot === undefined ? {} : { includeScreenshot: request.includeScreenshot }),
				...(request.includeAccessibilityTree === undefined
					? {}
					: { includeAccessibilityTree: request.includeAccessibilityTree }),
				...(request.settleMs === undefined ? {} : { settleMs: request.settleMs }),
				...(request.windowId === undefined ? {} : { windowId: request.windowId }),
				...(request.maxElements === undefined ? {} : { maxElements: request.maxElements }),
				...(request.visibleOnly === undefined ? {} : { visibleOnly: request.visibleOnly }),
				...(request.includeMenuBar === undefined ? {} : { includeMenuBar: request.includeMenuBar }),
				...(request.subtreeOf === undefined ? {} : { subtreeOf: request.subtreeOf }),
			});
			const timing = startedAt === undefined ? undefined : { capture: Math.round(performance.now() - startedAt) };
			this.assertOpen();
			const observation = this.computer.getInputObservation(targetPid);
			const token = this.issueForObservation(observation, state);
			// A read scoped to a named window is reusable too: the reads after it stay on that window (bindWindow).
			if (
				token !== undefined &&
				request.maxElements === undefined &&
				request.includeMenuBar === undefined &&
				request.subtreeOf === undefined
			) {
				this.rememberRead(targetPid, observation, state);
			}
			return stateResult(state, token, request.elementFormat, timing);
		});
	}

	/**
	 * Answer "what is this thing I am describing?" without spreading the whole tree: one
	 * accessibility walk (no pixels unless asked), the ranked matches with their ids, and the
	 * one-use token for those ids. A miss is an honest answer that names near misses.
	 */
	findElements(request: FindElementsRequest): Promise<ToolResult> {
		return this.lookupApp(request.app, async (targetPid) =>
			this.enqueue(targetPid, async () => {
				this.clearTokenFor(targetPid);
				this.bindWindow(targetPid, request.windowId);
				const observed = await this.observeApp(targetPid, {
					includeScreenshot: request.includeScreenshot === true,
					...(request.windowId === undefined ? {} : { windowId: request.windowId }),
					...(request.maxElements === undefined ? {} : { maxElements: request.maxElements }),
				});
				const query = describeQuery(request.query);
				const matches = matchElements(observed.state.elements, request.query);
				const found = matches.length > 0;
				return targetStateResult(
					observed.state,
					{
						found,
						query,
						matchCount: matches.length,
						matches: matches
							.slice(0, request.maxResults ?? DEFAULT_FIND_RESULTS)
							.map((match) => compactElementMatch(match)),
						...(found
							? {}
							: {
									nearMisses: suggestNearMisses(observed.state.elements, request.query, MAX_NEAR_MISSES).map(
										(element) => compactElement(element),
									),
									message: `no element matched ${query}; nothing was clicked or changed. The near misses name what this screen offers.`,
								}),
					},
					{
						token: this.issueForObservation(observed.observation, observed.state),
						includeScreenshot: request.includeScreenshot === true,
					},
				);
			}),
		);
	}

	/**
	 * Act on a described element in one call: resolve it, wait for it to appear when the caller
	 * gave patience, dispatch through the route the control supports, and answer with the fresh
	 * outcome. A miss dispatches nothing and names what the screen did offer.
	 */
	clickTarget(request: ClickTargetRequest, dispatchTarget: ResolvedTargetDispatcher): Promise<ToolResult> {
		return this.lookupApp(request.app, async (targetPid) =>
			this.enqueue(targetPid, async () => {
				this.clearTokenFor(targetPid);
				this.bindWindow(targetPid, request.windowId);
				const startedAt = Date.now();
				const deadline = startedAt + (request.timeoutMs ?? 0);
				const includeScreenshot = request.includeScreenshot === true;
				const observationOptions = {
					includeScreenshot,
					...(request.windowId === undefined ? {} : { windowId: request.windowId }),
				};
				const index = request.index ?? 0;
				let attempts = 1;
				let observed = await this.observeApp(targetPid, observationOptions);
				let matches = matchElements(observed.state.elements, request.query);
				let match: ElementMatch | undefined = matches[index];
				while (match === undefined && Date.now() < deadline) {
					await delayMilliseconds(Math.min(TARGET_POLL_INTERVAL_MILLISECONDS, Math.max(1, deadline - Date.now())));
					this.assertOpen();
					observed = await this.observeApp(targetPid, observationOptions);
					attempts += 1;
					matches = matchElements(observed.state.elements, request.query);
					match = matches[index];
				}
				const query = describeQuery(request.query);
				const waitedMs = Date.now() - startedAt;
				if (match === undefined) {
					return targetStateResult(
						observed.state,
						{
							found: false,
							actionDispatched: false,
							query,
							attempts,
							waitedMs,
							matchCount: matches.length,
							alternatives: matches
								.slice(0, MAX_ALTERNATIVES)
								.map((candidate) => compactElement(candidate.element)),
							nearMisses:
								matches.length > 0
									? []
									: suggestNearMisses(observed.state.elements, request.query, MAX_NEAR_MISSES).map((element) =>
											compactElement(element),
										),
							message:
								matches.length > 0
									? `no match at index ${index}; the alternatives are the matches that do exist. Nothing was dispatched.`
									: `no element matched ${query} after ${attempts} observation(s); nothing was dispatched. The near misses name what this screen offers.`,
						},
						{
							token: this.issueForObservation(observed.observation, observed.state),
							includeScreenshot,
							includeElements: request.fullState === true,
						},
					);
				}
				const target = match.element;
				const observation = observed.observation;
				if (observation === undefined) {
					return refusalResult(
						"no-observation",
						"the accessibility walk produced no observation to act on; retry",
					);
				}
				const stopped = this.userStopped();
				if (stopped !== undefined) {
					return refusalResult(stopped.reason, stopped.message);
				}
				const preflight = await this.computer.preflightInput(observation);
				if (!preflight.ok) {
					this.clearTokenFor(targetPid);
					return refusalResult(preflight.reason);
				}
				this.assertOpen();
				const beforeAction = await this.captureWindowBaseline();
				// Read again right before the input goes out: the preflight and the window baseline both awaited.
				const halted = this.inputHalt(undefined);
				if (halted !== undefined) {
					return refusalResult(halted.reason, halted.message);
				}
				let dispatch: ActionDispatch;
				try {
					dispatch = await this.inInputScope(targetPid, observation, undefined, () =>
						dispatchTarget(targetPid, observation, {
							elementIndex: target.id,
							actions: target.actions,
							frame: target.frame,
							...(request.press === undefined ? {} : { press: request.press }),
							...(request.hoverFirst === undefined ? {} : { hoverFirst: request.hoverFirst }),
							...(request.clickCount === undefined ? {} : { clickCount: request.clickCount }),
							...(request.mouseButton === undefined ? {} : { mouseButton: request.mouseButton }),
						}),
					);
				} catch (error: unknown) {
					const interrupted = this.interruptedResult(targetPid, error, {
						found: true,
						query,
						target: compactElementMatch(match),
					});
					if (interrupted !== undefined) {
						return interrupted;
					}
					throw error;
				}
				try {
					// Verify against a dedicated read (the same shape verify_state uses) instead of against the
					// outcome diff, which carries no tree: the answer then keeps the proof and the diff without
					// shipping the whole accessibility tree back.
					const verification =
						request.expect === undefined
							? undefined
							: (await this.pollVerification(targetPid, request.expect)).verification;
					const outcome = await this.readOutcome(targetPid, observation, {
						fullState: request.fullState === true,
						includeScreenshot,
					});
					const windowEvents = await this.describeWindowSideEffects(beforeAction, targetPid);
					return observedActionResult(
						outcome.state,
						outcome.contextUnchanged,
						outcome.nextToken,
						windowEvents,
						dispatch,
						{
							found: true,
							query,
							attempts,
							waitedMs,
							target: compactElementMatch(match),
							matchCount: matches.length,
							...(matches.length > 1
								? {
										alternatives: matches
											.filter((candidate) => candidate.element.id !== target.id)
											.slice(0, MAX_ALTERNATIVES)
											.map((candidate) => compactElement(candidate.element)),
									}
								: {}),
							...(verification === undefined ? {} : { verification }),
						},
						outcome.timing,
					);
				} catch (error: unknown) {
					this.clearTokenFor(targetPid);
					return postActionErrorResult(error, {
						found: true,
						query,
						attempts,
						target: compactElementMatch(match),
					});
				}
			}),
		);
	}

	/**
	 * Open an app using the configured launcher's delivery policy and wait until it is observable.
	 * Background launch does not bring it forward. Opening authorizes no observation or input.
	 */
	openApp(request: OpenAppRequest): Promise<ToolResult> {
		return this.enqueue(undefined, async () => {
			const launcher = this.appLauncher;
			if (launcher === undefined) {
				return openAppResult({ opened: false, name: request.name }, "this session has no app launcher");
			}
			try {
				const result = await openApplication(this.computer, request.name, {
					launcher,
					...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
				});
				return openAppResult({ opened: true, ...result }, undefined);
			} catch (error: unknown) {
				return openAppResult(
					{ opened: false, name: request.name },
					error instanceof Error ? error.message : String(error),
				);
			}
		});
	}

	/** Resolve an app name to a pid, or answer honestly that it is not running. */
	private async lookupApp(app: string, run: (targetPid: number) => Promise<ToolResult>): Promise<ToolResult> {
		let targetPid: number;
		try {
			targetPid = await this.resolvePid(app);
		} catch (error: unknown) {
			return appNotRunningResult(app, error instanceof Error ? error.message : String(error));
		}
		return await run(targetPid);
	}

	/**
	 * One accessibility walk for a targeting call, without taking the app's lane, so a caller that
	 * already holds it can poll with it. Pixels are captured only when the caller asked for them.
	 */
	private async observeApp(
		targetPid: number,
		options: { readonly includeScreenshot: boolean; readonly windowId?: number; readonly maxElements?: number },
	): Promise<{ readonly state: AppState; readonly observation: InputObservation | undefined }> {
		const state = await this.computer.getAppState(targetPid, {
			...STRICT_STATE_OPTIONS,
			includeScreenshot: options.includeScreenshot,
			...(options.windowId === undefined ? {} : { windowId: options.windowId }),
			...(options.maxElements === undefined ? {} : { maxElements: options.maxElements }),
		});
		this.assertOpen();
		return { state, observation: this.computer.getInputObservation(targetPid) };
	}

	/** The one-use token for an observation whose element ids are current, or nothing when they are not. */
	private issueForObservation(observation: InputObservation | undefined, state: AppState): string | undefined {
		return observation !== undefined && state.treeSkipped !== true && observationMatchesState(observation, state)
			? this.issue(observation, observedElementIdentity(state))
			: undefined;
	}

	mutate(
		token: string,
		app: string,
		validate: Validation,
		action: Mutation,
		options: MutationOptions = {},
	): Promise<ToolResult> {
		return this.enqueue(this.laneForRequestedToken(token), async () => {
			// This is read-only and independent of the token/preflight work; start it now so the
			// action never waits for a second listing after the safety gate has already passed.
			const beforeActionPromise = this.captureWindowBaseline();
			let expected: Awaited<ReturnType<typeof this.beginMutation>>;
			try {
				expected = await this.beginMutation(token, app, validate, options.screenPoints === true);
			} catch (error: unknown) {
				const refused = this.refusalFrom(error);
				if (refused !== undefined) {
					return refused;
				}
				throw error;
			}
			const beforeAction = await beforeActionPromise;
			this.forgetClosedBoundWindow(expected.pid, beforeAction);
			// Read again right before the input goes out: the preflight and the window baseline both awaited.
			const halted = this.inputHalt(undefined);
			if (halted !== undefined) {
				return refusalResult(halted.reason, halted.message);
			}
			let dispatch: Awaited<ReturnType<Mutation>>;
			try {
				dispatch = await this.inInputScope(expected.pid, expected.observation, undefined, () =>
					action(expected.pid, expected.observation, expected.elements),
				);
			} catch (error: unknown) {
				const interrupted = this.interruptedResult(expected.pid, error);
				if (interrupted !== undefined) {
					return interrupted;
				}
				throw error;
			}
			try {
				// The post-action listing and the AX outcome are independent; overlap them.
				const windowEventsPromise = this.describeWindowSideEffects(beforeAction, expected.pid);
				const outcome = await this.readOutcome(expected.pid, expected.observation, options, expected.elements);
				const windowEvents = await windowEventsPromise;
				return observedActionResult(
					outcome.state,
					outcome.contextUnchanged,
					outcome.nextToken,
					windowEvents,
					dispatch === undefined ? undefined : dispatch,
					outcome.setValue === undefined ? {} : { setValue: outcome.setValue },
					outcome.timing,
				);
			} catch (error: unknown) {
				this.clearTokenFor(expected.pid);
				return postActionErrorResult(error);
			}
		});
	}

	setFields(
		token: string,
		app: string,
		updates: readonly SetFieldUpdate[],
		options: MutationOptions = {},
	): Promise<ToolResult> {
		return this.enqueue(this.laneForRequestedToken(token), async () => {
			let expected: Awaited<ReturnType<typeof this.beginMutation>>;
			try {
				expected = await this.beginMutation(token, app, () => undefined, false);
			} catch (error: unknown) {
				const refused = this.refusalFrom(error);
				if (refused !== undefined) {
					return refused;
				}
				throw error;
			}
			const targets = updates.map((update) => ({ update, index: parseFieldIndex(update.element_index) }));
			for (const target of targets) {
				validateElement(expected.observation, target.index);
			}

			const steps: SetFieldStepReport[] = [];
			let baseline = await this.readFieldBaseline(expected.pid);
			let uiChanged = false;
			let stoppedEarly = false;
			let refused: string | undefined;

			for (const { update, index } of targets) {
				const stopped = this.userStopped();
				if (stopped !== undefined) {
					steps.push(skippedStep(index, update.value, stopped.message));
					stoppedEarly = true;
					refused = stopped.reason;
					break;
				}
				const element = baseline.elements.get(index);
				if (element === undefined) {
					steps.push(skippedStep(index, update.value, "element index is not present in the latest observation"));
					stoppedEarly = true;
					break;
				}
				const observedIdentity = expected.elements?.get(index);
				if (observedIdentity !== undefined && !sameElementIdentity(observedIdentity, element)) {
					steps.push(
						skippedStep(
							index,
							update.value,
							`element ${index} is now ${element.role} "${element.label ?? ""}", not the observed control; re-observe`,
						),
					);
					stoppedEarly = true;
					break;
				}

				try {
					await this.computer.setValue(expected.pid, index, update.value);
				} catch (error: unknown) {
					steps.push({
						element_index: index,
						requested_value: update.value,
						input_dispatched: false,
						status: "unverified",
						reason: error instanceof Error ? error.message : String(error),
					});
					stoppedEarly = true;
					break;
				}

				baseline = await this.readFieldBaseline(expected.pid);
				uiChanged = uiChanged || baseline.changed;
				const observedValue = baseline.elements.get(index)?.value ?? null;
				const verified = observedValue === update.value;
				steps.push({
					element_index: index,
					requested_value: update.value,
					input_dispatched: true,
					observed_value: observedValue,
					status: verified ? "verified" : "unverified",
					...(verified ? {} : { reason: "value read back from the app does not match the requested value" }),
				});
				if (!verified) {
					stoppedEarly = true;
					break;
				}
			}

			const report = {
				...summarize(steps, updates.length, stoppedEarly, uiChanged),
				...(refused === undefined ? {} : { refused }),
			};
			try {
				const outcome = await this.readOutcome(expected.pid, expected.observation, options);
				return observedSetFieldsResult(
					outcome.state,
					report,
					outcome.contextUnchanged,
					outcome.nextToken,
					outcome.timing,
				);
			} catch (error: unknown) {
				this.clearTokenFor(expected.pid);
				return postActionErrorResult(error, { setFields: report });
			}
		});
	}

	runSteps(
		token: string,
		app: string,
		steps: readonly RunStep[],
		expect: VerifyRequest | undefined,
		driver: RunStepDriver,
		options: MutationOptions = {},
		control: RunControl = {},
	): Promise<ToolResult> {
		return this.enqueue(this.laneForRequestedToken(token), async () => {
			const beforeActionPromise = this.captureWindowBaseline();
			let expected: Awaited<ReturnType<typeof this.beginMutation>>;
			try {
				expected = await this.beginMutation(
					token,
					app,
					(observation) => {
						for (const step of steps) {
							driver.validate(step, observation);
						}
					},
					steps.some(
						(step) =>
							step.type === "drag" ||
							(step.type === "click" && step.element_index === undefined && step.target === undefined),
					),
				);
			} catch (error: unknown) {
				const refused = this.refusalFrom(error);
				if (refused !== undefined) {
					return refused;
				}
				throw error;
			}
			const beforeAction = await beforeActionPromise;
			this.forgetClosedBoundWindow(expected.pid, beforeAction);
			const reports: RunStepReport[] = [];
			let stoppedEarly = false;
			let refused: string | undefined;
			// The settled read behind the token can answer the first pre-dispatch read, but only until this
			// batch waits or dispatches: from then on the UI is what the batch itself made of it.
			let canReuseRead = true;
			let treeReads = 0;
			const readBaseline = async (): ReturnType<GuardedSession["readFieldBaseline"]> => {
				const reusable = canReuseRead ? this.takeReusableRead(expected.observation) : undefined;
				canReuseRead = false;
				if (reusable !== undefined) {
					return { elements: reusable, changed: false };
				}
				treeReads += 1;
				return await this.readFieldBaseline(expected.pid);
			};
			// Fast pace keeps the chain's one read until a wait or a miss makes it stale. Either pace runs the window
			// guard before every step once something has run: a verified read of the tree proves the element, not that
			// the window, its bounds or the app's approval still hold.
			const fast = control.pace === "fast";
			const chain: ChainTree = {
				keep: fast,
				elements: undefined,
				changed: false,
				framesStale: false,
				idsRebased: false,
				read: readBaseline,
			};
			let guardNeeded = false;
			// The stop switch and the client's cancel end the batch at the step at `position`, with it and every later
			// step reported skipped: checked before the step's reads and again right before its input goes out.
			const halted = (position: number): boolean => {
				const halt = this.inputHalt(control.signal);
				if (halt === undefined) {
					return false;
				}
				for (const [remaining, skipped] of steps.entries()) {
					if (remaining >= position) {
						reports.push(skippedRunStep(remaining, skipped.type, halt.message));
					}
				}
				stoppedEarly = true;
				if (halt.reason === "user-stopped") {
					refused = halt.reason;
				}
				return true;
			};

			for (const [position, step] of steps.entries()) {
				if (halted(position)) {
					break;
				}

				const wait = driver.wait(step);
				if (wait !== undefined) {
					canReuseRead = false;
					chain.elements = undefined;
					guardNeeded = true;
					const waited = await this.waitForStep(expected.pid, wait, control.signal);
					chain.changed = chain.changed || waited.changed;
					if (!waited.satisfied) {
						reports.push({
							step: position,
							type: step.type,
							input_dispatched: false,
							status: "failed",
							reason: waited.reason,
						});
						stoppedEarly = true;
						break;
					}
					reports.push({
						step: position,
						type: step.type,
						input_dispatched: false,
						status: "satisfied",
						detail: { waited_ms: waited.waitedMs },
					});
					control.onProgress?.(position + 1, steps.length, `${step.type} satisfied`);
					continue;
				}

				let runnable = step;
				let targetActions: readonly string[] | undefined;
				let resolvedElement:
					| { readonly id: number; readonly role: string; readonly label: string | null }
					| undefined;
				let foundEvidence: FindEvidence | undefined;
				const target = driver.target(step);
				if (target?.find !== undefined) {
					const searched = await this.searchByScrolling(chain, expected, step, target, target.find, control);
					if ("missing" in searched) {
						reports.push({ ...skippedRunStep(position, step.type, searched.missing), found: searched.evidence });
						stoppedEarly = true;
						if (searched.refused !== undefined) {
							refused = searched.refused;
						}
						break;
					}
					foundEvidence = searched.evidence;
					if (searched.found.kind === "element") {
						const element = searched.found.element;
						targetActions = element.actions;
						resolvedElement = { id: element.id, role: element.role, label: element.label };
						// A control that does not advertise AXPress (a Finder row's name field) takes no accessibility
						// press, so its click goes to the centre the search just measured, through the pointer route.
						const pointerClick =
							step.type === "click" &&
							!element.actions.includes(AX_PRESS_ACTION) &&
							!(step.mouse_button === "right" && element.actions.includes("AXShowMenu"));
						runnable = pointerClick
							? driver.resolveAtPoint(step, expected.observation, searched.found.centre)
							: driver.resolve(step, element.id);
					} else {
						try {
							runnable = driver.resolveAtPoint(step, expected.observation, searched.found.point);
						} catch (error: unknown) {
							reports.push({
								...skippedRunStep(position, step.type, error instanceof Error ? error.message : String(error)),
								found: searched.evidence,
							});
							stoppedEarly = true;
							break;
						}
					}
				} else if (target !== undefined) {
					const located = await this.resolveStepTarget(chain, findQueryTarget(target));
					if ("missing" in located) {
						reports.push(skippedRunStep(position, step.type, located.missing));
						stoppedEarly = true;
						break;
					}
					const match = located.found;
					targetActions = match.element.actions;
					resolvedElement = { id: match.element.id, role: match.element.role, label: match.element.label };
					runnable = driver.resolve(step, match.element.id);
				}

				const elementIndex = target === undefined ? driver.elementIndex(step) : undefined;
				if (elementIndex !== undefined && chain.idsRebased && chain.elements !== undefined) {
					reports.push(
						skippedRunStep(
							position,
							step.type,
							"element ids were renumbered by an earlier scroll-find in this chain; name this step's element with target",
						),
					);
					stoppedEarly = true;
					break;
				}
				if (elementIndex !== undefined) {
					const located = await this.resolveStepTarget(
						chain,
						findObservedElement(elementIndex, expected.elements?.get(elementIndex)),
					);
					if ("missing" in located) {
						reports.push(skippedRunStep(position, step.type, located.missing));
						stoppedEarly = true;
						break;
					}
					targetActions = located.found.actions;
				}

				if (guardNeeded) {
					const blocked = await this.chainGuard(expected.pid, expected.observation, step);
					if (blocked !== undefined) {
						const reason = `the window guard refused this step (${blocked}); nothing further was dispatched`;
						for (const [remaining, skipped] of steps.entries()) {
							if (remaining >= position) {
								reports.push(skippedRunStep(remaining, skipped.type, reason));
							}
						}
						stoppedEarly = true;
						refused = blocked;
						break;
					}
				}

				// Read again right before the input goes out: target reads and the window guard all awaited.
				if (halted(position)) {
					break;
				}
				canReuseRead = false;
				guardNeeded = true;
				try {
					const finalReadCoversWrite =
						position === steps.length - 1 && step.type === "type_text" && expect === undefined;
					const dispatch = await timed("dispatch", () =>
						this.inInputScope(expected.pid, expected.observation, control.signal, () =>
							driver.dispatch(runnable, expected.pid, expected.observation, targetActions, {
								settleWrite: !finalReadCoversWrite,
							}),
						),
					);
					reports.push({
						step: position,
						type: step.type,
						input_dispatched: true,
						status: "dispatched",
						route: dispatch.route,
						delivery: dispatch.delivery,
						...(dispatch.fallback === undefined ? {} : { fallback: dispatch.fallback }),
						...(resolvedElement === undefined ? {} : { resolved_element: resolvedElement }),
						...(foundEvidence === undefined ? {} : { found: foundEvidence }),
						...(dispatch.detail === undefined ? {} : { detail: dispatch.detail }),
					});
					control.onProgress?.(position + 1, steps.length, `${step.type} dispatched`);
				} catch (error: unknown) {
					reports.push({
						step: position,
						type: step.type,
						input_dispatched: false,
						status: "failed",
						reason:
							error instanceof InputInterrupted
								? `stopped while this step was sending input; nothing more was sent. ${error.message}`
								: error instanceof Error
									? error.message
									: String(error),
					});
					stoppedEarly = true;
					if (error instanceof InputInterrupted) {
						halted(position + 1);
					}
					break;
				}
			}

			const report = {
				...summarizeRunSteps(reports, steps.length, stoppedEarly, chain.changed),
				...(refused === undefined ? {} : { refused }),
				...(fast
					? {
							pace: "fast",
							pace_note: FAST_PACE_NOTE,
							tree_reads: treeReads,
						}
					: {}),
			};
			try {
				const windowEventsPromise = this.describeWindowSideEffects(beforeAction, expected.pid);
				const verificationStartedAt = Date.now();
				const outcome = await this.readOutcome(
					expected.pid,
					expected.observation,
					expect?.checks !== undefined && expect.checks.length > 0 ? { ...options, fullState: true } : options,
				);
				let verification =
					expect === undefined ? undefined : await this.runChecks(expected.pid, outcome.state, expect);
				let finalOutcome = outcome;
				if (
					expect !== undefined &&
					verification !== undefined &&
					!verification.verified &&
					expect.timeoutMs !== undefined
				) {
					const polled = await this.pollVerification(expected.pid, expect, this.boundWindows.get(expected.pid), {
						state: outcome.state,
						verification,
						startedAt: verificationStartedAt,
					});
					verification = polled.verification;
					finalOutcome = this.outcomeFromState(expected.pid, expected.observation, polled.state, {
						...outcome.timing,
						verificationPoll: Math.round(performance.now() - verificationStartedAt),
					});
				}
				const windowEvents = await windowEventsPromise;
				return observedRunStepsResult(
					finalOutcome.state,
					report,
					verification,
					finalOutcome.contextUnchanged,
					finalOutcome.nextToken,
					windowEvents,
				);
			} catch (error: unknown) {
				this.clearTokenFor(expected.pid);
				return postActionErrorResult(error, { runSteps: report });
			}
		});
	}

	/**
	 * Run keyboard and pointer lanes against one observation, with an optional capture watching
	 * while they work. The whole batch holds the app's lane once, so the scheduler can overlap
	 * lanes the native driver keeps independent; only the final read and verification run after
	 * every lane has settled. A lane failure is reported per lane, never silently retried.
	 */
	runHands(request: RunHandsRequest, driver: RunStepDriver, control: RunControl = {}): Promise<ToolResult> {
		return this.enqueue(this.laneForRequestedToken(request.token), async () => {
			// A text write cannot open or close a window; pointer input and key sequences can.
			const trackWindowSideEffects =
				request.pointer.length > 0 || request.keyboard.some((step) => step.type !== "type_text");
			const beforeActionPromise = trackWindowSideEffects ? this.captureWindowBaseline() : Promise.resolve(undefined);
			let expected: Awaited<ReturnType<typeof this.beginMutation>>;
			try {
				expected = await this.beginMutation(
					request.token,
					request.app,
					(observation) => {
						for (const step of [...request.keyboard, ...request.pointer]) {
							driver.validate(step, observation);
						}
					},
					request.pointer.some((step) => step.type === "click" && step.element_index === undefined),
				);
			} catch (error: unknown) {
				const refused = this.refusalFrom(error);
				if (refused !== undefined) {
					return refused;
				}
				throw error;
			}
			const beforeAction = await beforeActionPromise;
			if (beforeAction !== undefined) {
				this.forgetClosedBoundWindow(expected.pid, beforeAction);
			}
			this.hotFrames.start(expected.pid, expected.observation.windowId, expected.observation.windowBounds);
			const halted = this.inputHalt(control.signal);
			if (halted !== undefined) {
				return refusalResult(halted.reason, halted.message);
			}

			const delivery = this.computer.delivery === "background" ? "background" : "attended";
			const focusResources: readonly HandResource[] = delivery === "attended" ? ["focus"] : [];
			const runLane = async (
				kind: "keyboard" | "pointer",
				steps: readonly RunStep[],
			): Promise<readonly RunStepReport[]> => {
				const reports: RunStepReport[] = [];
				try {
					for (const [index, step] of steps.entries()) {
						const stop = this.inputHalt(control.signal);
						if (stop !== undefined) {
							throw stop;
						}
						// beginMutation already ran the one preflight for this call. The first step only has
						// to prove that the observation still names the same window; later steps retain the
						// full preflight because their own input may have moved or replaced it.
						const guard = await this.chainGuard(expected.pid, expected.observation, step, {
							preflight: index > 0,
						});
						if (guard !== undefined) {
							throw new Error(`window guard refused the ${kind} lane: ${guard}`);
						}
						const elementIndex = driver.elementIndex(step);
						const actions =
							elementIndex === undefined ? undefined : expected.elements?.get(elementIndex)?.actions;
						const finalReadCoversWrite =
							index === steps.length - 1 && step.type === "type_text" && request.expect === undefined;
						const dispatch = await timed(`hands.${kind}.dispatch`, () =>
							this.inInputScope(expected.pid, expected.observation, control.signal, () =>
								driver.dispatch(step, expected.pid, expected.observation, actions, {
									settleWrite: !finalReadCoversWrite,
								}),
							),
						);
						reports.push({
							step: index,
							type: step.type,
							input_dispatched: true,
							status: "dispatched",
							...dispatch,
						});
						control.onProgress?.(reports.length, steps.length, `${kind} ${step.type} dispatched`);
					}
					return reports;
				} catch (error: unknown) {
					throw new HandsLaneError(reports, error);
				}
			};

			const tasks: HandTask<HandsLaneValue>[] = [];
			let settleInputs = (): void => {};
			const inputsSettled = new Promise<void>((resolve) => {
				settleInputs = resolve;
			});
			let remainingInputLanes = 0;
			const finishInputLane = (): void => {
				remainingInputLanes -= 1;
				if (remainingInputLanes === 0) {
					settleInputs();
				}
			};
			if (request.keyboard.length > 0) {
				remainingInputLanes += 1;
				tasks.push({
					hand: "right",
					resources: ["keyboard", ...focusResources],
					run: async () => {
						try {
							return await runLane("keyboard", request.keyboard);
						} finally {
							finishInputLane();
						}
					},
				});
			}
			if (request.pointer.length > 0) {
				remainingInputLanes += 1;
				tasks.push({
					hand: "left",
					resources: ["pointer", ...focusResources],
					run: async () => {
						try {
							return await runLane("pointer", request.pointer);
						} finally {
							finishInputLane();
						}
					},
				});
			}
			const vision = request.vision;
			if (vision !== undefined) {
				tasks.push({
					hand: "vision",
					resources: ["capture"],
					run: async () =>
						await timed("hands.vision.capture", () =>
							this.captureVisionLane(expected.pid, vision, this.boundWindows.get(expected.pid)),
						),
				});
			}
			if (remainingInputLanes === 0) {
				settleInputs();
			}

			const handsPromise = timed("hands.coordinator", () =>
				new HandsCoordinator().run(tasks, {
					policy: request.overlap,
					...(control.signal === undefined ? {} : { signal: control.signal }),
				}),
			);
			void handsPromise.then(settleInputs, settleInputs);
			await inputsSettled;
			const deferredOutcome =
				(request.outcomeMode ?? "deferred") === "deferred" &&
				request.expect === undefined &&
				request.fullState !== true &&
				request.includeScreenshot !== true &&
				(request.keyboard.length > 0 || request.pointer.length > 0 || request.vision !== undefined);
			if (deferredOutcome) {
				return await this.deferredHandsTail(handsPromise, tasks, expected, beforeAction, request);
			}
			const windowEventsPromise = trackWindowSideEffects
				? this.describeWindowSideEffects(beforeAction, expected.pid)
				: Promise.resolve<readonly WindowEvent[]>([]);
			void windowEventsPromise.catch(() => undefined);
			const verificationStartedAt = Date.now();
			const outcomePromise = this.readOutcome(
				expected.pid,
				expected.observation,
				{
					fullState:
						request.expect?.checks !== undefined && request.expect.checks.length > 0 ? true : request.fullState,
					includeScreenshot: request.includeScreenshot,
				},
				expected.elements,
			);
			void outcomePromise.catch(() => undefined);

			let hands: HandsRunResult<HandsLaneValue>;
			try {
				hands = await handsPromise;
			} catch (error: unknown) {
				this.clearTokenFor(expected.pid);
				throw error;
			}

			const lanes = hands.lanes.map((lane) => this.handsLaneReport(lane.hand, lane, tasks));
			const visionLane = hands.lanes.find((lane) => lane.hand === "vision");
			const visionCapture =
				visionLane?.ok === true && isVisionCapture(visionLane.value) ? visionLane.value : undefined;
			try {
				const outcome = await outcomePromise;
				let verification =
					request.expect === undefined
						? undefined
						: await this.runChecks(expected.pid, outcome.state, request.expect);
				let finalOutcome = outcome;
				if (
					request.expect !== undefined &&
					verification !== undefined &&
					!verification.verified &&
					request.expect.timeoutMs !== undefined
				) {
					const polled = await this.pollVerification(
						expected.pid,
						request.expect,
						this.boundWindows.get(expected.pid),
						{ state: outcome.state, verification, startedAt: verificationStartedAt },
					);
					verification = polled.verification;
					finalOutcome = this.outcomeFromState(expected.pid, expected.observation, polled.state, {
						...outcome.timing,
						verificationPoll: Math.round(performance.now() - verificationStartedAt),
					});
				}
				const windowEvents = await windowEventsPromise;
				const dispatch = handsDispatch(hands.lanes);
				const visionImage =
					visionCapture?.image === undefined
						? undefined
						: {
								type: "image" as const,
								data: visionCapture.image.base64,
								mimeType: visionCapture.image.mimeType,
							};
				const visionReport = handsVisionReport(
					request.vision,
					visionLane,
					visionCapture,
					finalOutcome.state.screenshotBase64.length > 0 ? 1 : 0,
				);
				const report: RunHandsReport = {
					policy: hands.policy,
					overlap_ms: Math.round(hands.overlapMs),
					sequential_estimate_ms: Math.round(hands.sequentialEstimateMs),
					aborted: hands.aborted,
					lanes,
					...(hands.notStarted.length === 0
						? {}
						: { unstarted: hands.notStarted.map((index) => tasks[index]?.hand ?? String(index)) }),
					...(visionReport === undefined ? {} : { vision: visionReport }),
				};
				return observedHandsResult(
					finalOutcome.state,
					report,
					verification,
					finalOutcome.contextUnchanged,
					finalOutcome.nextToken,
					windowEvents,
					dispatch,
					finalOutcome.timing,
					visionImage === undefined ? [] : [visionImage],
				);
			} catch (error: unknown) {
				this.clearTokenFor(expected.pid);
				return postActionErrorResult(error, {
					hands: {
						policy: hands.policy,
						overlap_ms: Math.round(hands.overlapMs),
						sequential_estimate_ms: Math.round(hands.sequentialEstimateMs),
						aborted: hands.aborted,
						lanes,
					},
				});
			}
		});
	}

	/**
	 * The deferred outcome for an input-only call: no result read at all. The app's own accessibility
	 * events (bounded settle) stand in for the read, and the next token carries the pre-action
	 * observation without element ids, so the window guard still protects every later call while
	 * element ids are honestly labeled as predating the action.
	 */
	private async deferredHandsTail(
		handsPromise: Promise<HandsRunResult<HandsLaneValue>>,
		tasks: readonly HandTask<HandsLaneValue>[],
		expected: {
			readonly pid: number;
			readonly observation: InputObservation;
			readonly elements: ObservedElementIdentity | undefined;
		},
		beforeAction: readonly number[] | undefined,
		request: Pick<RunHandsRequest, "vision">,
	): Promise<ToolResult> {
		let hands: HandsRunResult<HandsLaneValue>;
		try {
			hands = await handsPromise;
		} catch (error: unknown) {
			this.clearTokenFor(expected.pid);
			throw error;
		}
		const lanes = hands.lanes.map((lane) => this.handsLaneReport(lane.hand, lane, tasks));
		const visionLane = hands.lanes.find((lane) => lane.hand === "vision");
		const visionCapture = visionLane?.ok === true && isVisionCapture(visionLane.value) ? visionLane.value : undefined;
		if (hands.aborted || hands.lanes.some((lane) => !lane.ok)) {
			// Part of the input may have gone out with no dispatch report to trust: read the result live
			// instead of deferring it, exactly as a failed mutation would.
			const outcome = await this.readOutcome(
				expected.pid,
				expected.observation,
				{ fullState: false, includeScreenshot: false },
				expected.elements,
			);
			const finalOutcome = this.outcomeFromState(expected.pid, expected.observation, outcome.state, outcome.timing);
			const windowEvents = await this.describeWindowSideEffects(beforeAction, expected.pid);
			return observedHandsResult(
				finalOutcome.state,
				{
					policy: hands.policy,
					overlap_ms: Math.round(hands.overlapMs),
					sequential_estimate_ms: Math.round(hands.sequentialEstimateMs),
					aborted: hands.aborted,
					lanes,
					...(hands.notStarted.length === 0
						? {}
						: { unstarted: hands.notStarted.map((index) => tasks[index]?.hand ?? String(index)) }),
				},
				undefined,
				finalOutcome.contextUnchanged,
				finalOutcome.nextToken,
				windowEvents,
				handsDispatch(hands.lanes),
				finalOutcome.timing,
				[],
			);
		}
		const inputDispatched = hands.lanes.some(
			(lane) => isStepReports(lane.value) && lane.value.some((step) => step.input_dispatched),
		);
		const settle = inputDispatched ? settleDeferredOutcome(expected.pid) : { events: 0, settleMs: 0 };
		const nextToken = this.issue(expected.observation, undefined, true);
		const dispatch = handsDispatch(hands.lanes);
		const visionImage =
			visionCapture?.image === undefined
				? undefined
				: {
						type: "image" as const,
						data: visionCapture.image.base64,
						mimeType: visionCapture.image.mimeType,
					};
		const visionReport = handsVisionReport(request.vision, visionLane, visionCapture, 0);
		const report: RunHandsReport = {
			policy: hands.policy,
			overlap_ms: Math.round(hands.overlapMs),
			sequential_estimate_ms: Math.round(hands.sequentialEstimateMs),
			aborted: hands.aborted,
			lanes,
			...(hands.notStarted.length === 0
				? {}
				: { unstarted: hands.notStarted.map((index) => tasks[index]?.hand ?? String(index)) }),
			...(visionReport === undefined ? {} : { vision: visionReport }),
		};
		return deferredHandsResult(
			expected.observation,
			report,
			settle,
			nextToken,
			dispatch,
			{
				settle: settle.settleMs,
			},
			visionImage === undefined ? [] : [visionImage],
		);
	}

	/**
	 * The Jev decision kernel: one indexed action-space observation per step, one fan-out decision
	 * call, execution guarded by a preflight per step. The endpoint contract and every risk gate
	 * live in @opencua/agent; this method supplies the safety rails (stop switch, preflight,
	 * per-step refusal) and the honest record.
	 */
	runDecision(request: DecisionRunRequest): Promise<ToolResult> {
		return this.enqueue(undefined, async () => {
			this.assertOpen();
			const halted = this.userStopped();
			if (halted !== undefined) {
				return refusalResult(halted.reason, halted.message);
			}
			const endpoint = process.env["OPENCUA_DECISION_ENDPOINT"];

			const model = process.env["OPENCUA_DECISION_MODEL"] ?? "typesafe/jev-latest";
			const apiKey = process.env["LLM_POOL_PROXY_API_KEY"] ?? process.env["TYPESAFE_API_KEY"];
			if (endpoint === undefined || endpoint === "" || apiKey === undefined || apiKey === "") {
				return refusalResult(
					"decision-endpoint-not-configured",
					"set OPENCUA_DECISION_ENDPOINT and LLM_POOL_PROXY_API_KEY (or TYPESAFE_API_KEY); scripts/llm-pool-systemone.mjs serves the local proxy",
				);
			}
			let decisionSurface: InputObservation | undefined;
			const latestFrame = () => latestDecisionFrame(this.hotFrames, decisionSurface);
			const decide = createDecider({
				endpoint,
				model,
				apiKey,
				latestFrame,
				onPrefetch: (prefetch) => {
					// stderr stays observable even when speculation completes after the tool response.
					process.stderr.write(`${JSON.stringify({ event: "decision-prefetch", prefetch, app: request.app })}\n`);
				},
				...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
			});
			const inner = macosAdapter({ computer: this.computer, app: request.app });
			const guarded: PlatformAdapter<AppState> = {
				platform: "macos",
				observe: async () => {
					const observation = await inner.observe();
					decisionSurface = this.computer.getInputObservation(observation.state.pid);
					if (decisionSurface !== undefined) {
						this.hotFrames.start(decisionSurface.pid, decisionSurface.windowId, decisionSurface.windowBounds);
					}
					return observation;
				},
				execute: async (observation, decision) => {
					const expected = this.computer.getInputObservation(observation.state.pid);
					if (expected === undefined) {
						return {
							status: "refused",
							route: "none",
							detail: "preflight-unavailable: no stored input observation for this app",
						};
					}
					const preflight = await this.computer.preflightInput(expected, { requireSameBounds: false });
					if (!preflight.ok) {
						return { status: "refused", route: "none", detail: preflight.reason };
					}
					// The guard now verifies the screen is unchanged since the decision snapshot (capture-byte
					// identity), a strictly more direct check than the previous published-hot-hash comparison.
					// Published hot-frame hashes remain in service for vision/hot-frames consumers.
					if (decision.frameHash !== undefined && latestFrame()?.hash !== decision.frameHash) {
						return { status: "refused", route: "none", detail: "stale-frame: hot frame changed before dispatch" };
					}
					return await inner.execute(observation, decision);
				},
			};
			const agent = new DecisionAgent({
				adapter: guarded,
				goal: request.goal,
				decide,
				...(request.approveRisk === true ? { approve: () => true } : {}),
			});
			const steps: Record<string, unknown>[] = [];
			let executed = 0;
			let lastStatus: string | undefined;
			const stepCap = Math.min(60, Math.max(1, Math.trunc(request.maxSteps ?? 8)));
			let processed = 0;
			for await (const record of agent.run()) {
				processed += 1;
				if (record.status === "ran") {
					executed += 1;
				}
				lastStatus = record.status;
				steps.push({
					step: record.step,
					status: record.status,
					detail: record.detail,
					elapsed_ms: record.elapsedMs,
					...(record.decision === undefined
						? {}
						: {
								operation: record.decision.operation,
								...(record.decision.cache === undefined ? {} : { cache: record.decision.cache }),
								...(record.decision.target === undefined ? {} : { target: record.decision.target.label }),
								risk: record.decision.risk,
								risk_class: record.decision.riskClass,
							}),
				});
				if (processed >= stepCap) {
					break;
				}
			}
			return textResult(
				JSON.stringify(
					{
						app: request.app,
						goal: request.goal,
						executed,
						last_status: lastStatus,
						steps,
					},
					null,
					2,
				),
			);
		});
	}

	private async captureVisionLane(
		pid: number,
		vision: RunHandsVisionOptions,
		windowId?: number,
	): Promise<HandsVisionCapture> {
		const startedAt = performance.now();
		if (windowId !== undefined && vision.includeScreenshot !== false) {
			const warm = this.hotFrames.latestFor(pid, windowId);
			if (warm !== undefined) {
				return {
					image: {
						base64: warm.data.toString("base64"),
						mimeType: "image/jpeg",
						width: warm.width,
						height: warm.height,
					},
					durationMs: performance.now() - startedAt,
					frameAgeMs: Math.max(0, Date.now() - warm.capturedAt),
					hot: true,
				};
			}
			if (this.hotFrames.engaged(pid, windowId)) {
				const waited = await this.hotFrames.waitForFrame(pid, windowId, HOT_FRAME_WAIT_BUDGET_MS);
				if (waited !== undefined) {
					return {
						image: {
							base64: waited.data.toString("base64"),
							mimeType: "image/jpeg",
							width: waited.width,
							height: waited.height,
						},
						durationMs: performance.now() - startedAt,
						frameAgeMs: Math.max(0, Date.now() - waited.capturedAt),
						hot: true,
					};
				}
				this.hotFrames.drop();
			}
		}
		const state = await this.computer.getAppState(pid, {
			...STRICT_STATE_OPTIONS,
			includeScreenshot: vision.includeScreenshot !== false,
			includeAccessibilityTree: false,
			settleMs: vision.settleMs ?? 0,
			...(vision.maxElements === undefined ? {} : { maxElements: vision.maxElements }),
			...(windowId === undefined ? {} : { windowId }),
		});
		const captured = state.screenshotBase64.length > 0;
		return {
			image: captured
				? {
						base64: state.screenshotBase64,
						mimeType: state.screenshotMimeType ?? "image/png",
						width: state.screenshotWidth,
						height: state.screenshotHeight,
					}
				: undefined,
			...(captured ? {} : { unavailable: state.screenshotUnavailable ?? "the capture returned no image" }),
			durationMs: performance.now() - startedAt,
			hot: false,
		};
	}

	private handsLaneReport(
		hand: HandTask<unknown>["hand"],
		lane: HandsRunResult<unknown>["lanes"][number],
		tasks: readonly HandTask<unknown>[],
	): RunHandsLaneReport {
		const task = tasks.find((candidate) => candidate.hand === hand);
		const failure = lane.error instanceof HandsLaneError ? lane.error : undefined;
		return {
			hand,
			lane: hand === "right" ? "keyboard" : hand === "left" ? "pointer" : "vision",
			status: lane.ok ? "completed" : lane.aborted ? "aborted" : "failed",
			resources: task?.resources ?? [],
			steps: isStepReports(lane.value) ? lane.value : (failure?.reports ?? []),
			started_ms: lane.startedMs,
			finished_ms: lane.finishedMs,
			wait_ms: lane.waitMs,
			duration_ms: lane.durationMs,
			...(lane.error === undefined
				? {}
				: { error: handsErrorText(failure === undefined ? lane.error : failure.laneError) }),
		};
	}

	invalidate(): void {
		this.closed = true;
		this.tokens.clear();
		this.tokenByPid.clear();
	}

	/** Retire a released worker's context without disturbing another app's live token. */
	revokeToken(token: string): void {
		const live = this.tokens.get(token);
		if (live === undefined) return;
		this.tokens.delete(token);
		if (this.tokenByPid.get(live.key) === token) {
			this.tokenByPid.delete(live.key);
			this.reusableReads.delete(live.key);
		}
	}

	async close(): Promise<void> {
		this.invalidate();
		this.hotFrames.dispose();
		this.closePromise ??= Promise.all([this.globalTail, ...this.tails.values()]).then(async () =>
			this.computer.close(),
		);
		await this.closePromise;
	}

	verify(token: string, app: string, request: VerifyRequest): Promise<ToolResult> {
		return this.enqueue(this.laneForRequestedToken(token), async () => {
			const active = this.consume(token);
			const targetPid = await this.resolvePidForToken(app, active.observation.pid);
			if (targetPid !== active.observation.pid) {
				throw new Error("requested app does not match the token observation");
			}
			const { state, verification } = await this.pollVerification(targetPid, request, active.observation.windowId);
			const observation = this.computer.getInputObservation(targetPid);
			const nextToken =
				observation !== undefined && observationMatchesState(observation, state)
					? this.issue(observation, observedElementIdentity(state))
					: undefined;
			return verificationResult(verification, state, nextToken);
		});
	}

	private async waitForStep(
		targetPid: number,
		wait: StepWait,
		signal: AbortSignal | undefined,
	): Promise<{
		readonly satisfied: boolean;
		readonly changed: boolean;
		readonly waitedMs: number;
		readonly reason: string;
	}> {
		const startedAt = Date.now();
		const deadline = startedAt + wait.timeoutMs;
		// A zero timeout keeps its single-pass meaning; only a positive budget gates whether work may start.
		const budgeted = wait.timeoutMs > 0;
		let changed = false;
		let firstObservation = true;
		let lastUnmet = "wait condition is unmet";
		for (;;) {
			this.assertOpen();
			if (!firstObservation && deadline - Date.now() <= 0) {
				const waitedMs = Date.now() - startedAt;
				return { satisfied: false, changed, waitedMs, reason: `after ${waitedMs} ms: ${lastUnmet}` };
			}
			// The bound-window listing is an inventory query like any other: an expired budget must not start it.
			const windowOption = await this.boundWindowOption(targetPid);
			if (budgeted && deadline - Date.now() <= 0) {
				const waitedMs = Date.now() - startedAt;
				return { satisfied: false, changed, waitedMs, reason: `after ${waitedMs} ms: ${lastUnmet}` };
			}
			firstObservation = false;
			const state = await this.computer.getAppState(targetPid, {
				...STRICT_STATE_OPTIONS,
				includeScreenshot: false,
				settleMs: 0,
				...windowOption,
			});
			this.assertOpen();
			changed = changed || hasAxChange(state);
			const unmet: string[] = [];
			if (wait.query !== undefined) {
				const present = matchElements(state.elements, wait.query).length > 0;
				if (present === wait.gone) {
					unmet.push(`${describeQuery(wait.query)} is ${wait.gone ? "still shown" : "not shown"}`);
				}
			}
			if (wait.windowTitle !== undefined) {
				if (state.windowTitle !== wait.windowTitle) {
					const remainingBeforeProbe = deadline - Date.now();
					const titles =
						remainingBeforeProbe > 0 ? (await this.windowsForPid(targetPid)).map((window) => window.title) : [];
					if (state.windowTitle !== undefined && !titles.includes(state.windowTitle)) {
						titles.push(state.windowTitle);
					}
					if (!titles.includes(wait.windowTitle)) {
						unmet.push(`no window titled ${JSON.stringify(wait.windowTitle)} is open`);
					}
				}
			}
			const waitedMs = Date.now() - startedAt;
			if (unmet.length === 0) {
				return { satisfied: true, changed, waitedMs, reason: "" };
			}
			lastUnmet = unmet.join("; ");
			if (signal?.aborted === true) {
				return { satisfied: false, changed, waitedMs, reason: "cancelled by the client while waiting" };
			}
			if (Date.now() >= deadline) {
				return { satisfied: false, changed, waitedMs, reason: `after ${waitedMs} ms: ${unmet.join("; ")}` };
			}
			const remaining = deadline - Date.now();
			if (remaining > 0) {
				await delayMilliseconds(Math.min(VERIFY_POLL_INTERVAL_MILLISECONDS, Math.max(0, remaining)));
			}
		}
	}

	private async pollVerification(
		targetPid: number,
		request: VerifyRequest,
		windowId?: number,
		initial?: {
			readonly state: AppState;
			readonly verification: Verification;
			readonly startedAt: number;
		},
	): Promise<{ readonly state: AppState; readonly verification: Verification }> {
		const deadline = (initial?.startedAt ?? Date.now()) + (request.timeoutMs ?? 0);
		// An absent or zero timeout keeps its single-pass meaning; only a positive budget gates whether work may start.
		const budgeted = request.timeoutMs !== undefined && request.timeoutMs > 0;
		let firstObservation = initial === undefined;
		let lastState: AppState | undefined = initial?.state;
		let lastVerification: Verification | undefined = initial?.verification;
		if (initial !== undefined) {
			if (initial.verification.verified || Date.now() >= deadline) {
				return { state: initial.state, verification: initial.verification };
			}
			this.assertOpen();
			const remaining = deadline - Date.now();
			if (remaining > 0) {
				await delayMilliseconds(Math.min(VERIFY_POLL_INTERVAL_MILLISECONDS, remaining));
			}
		}
		for (;;) {
			this.assertOpen();
			if (!firstObservation && deadline - Date.now() <= 0) {
				if (lastState === undefined || lastVerification === undefined) {
					throw new Error("verification deadline expired before an initial observation");
				}
				return { state: lastState, verification: lastVerification };
			}
			// Resolving the bound window probes the window list, so the budget is checked on both sides of it.
			const windowOption = windowId === undefined ? await this.boundWindowOption(targetPid) : { windowId };
			if (budgeted && deadline - Date.now() <= 0) {
				if (lastState === undefined || lastVerification === undefined) {
					throw new Error("verification deadline expired before an initial observation");
				}
				return { state: lastState, verification: lastVerification };
			}
			firstObservation = false;
			const state = await this.computer.getAppState(targetPid, {
				...STRICT_STATE_OPTIONS,
				includeScreenshot: false,
				settleMs: 0,
				...windowOption,
			});
			this.assertOpen();
			const verification = await this.runChecks(targetPid, state, request, budgeted ? deadline : undefined);
			lastState = state;
			lastVerification = verification;
			if (verification.verified || Date.now() >= deadline) {
				return { state, verification };
			}
			const remaining = deadline - Date.now();
			if (remaining > 0) {
				await delayMilliseconds(Math.min(VERIFY_POLL_INTERVAL_MILLISECONDS, Math.max(0, remaining)));
			}
		}
	}

	private async runChecks(
		pid: number,
		state: AppState,
		request: VerifyRequest,
		deadline?: number,
	): Promise<Verification> {
		const byId = new Map(state.elements.map((element) => [element.id, element] as const));
		const checks: VerificationCheck[] = [];
		for (const check of request.checks ?? []) {
			const index = parseElementIndex(check.element_index);
			const element = byId.get(index);
			if (check.exists === false) {
				checks.push({
					check: `element ${index} is absent`,
					verified: element === undefined,
					actual: element === undefined ? "absent" : describeElement(element),
				});
				continue;
			}
			if (element === undefined) {
				checks.push({ check: `element ${index} exists`, verified: false, actual: "absent" });
				continue;
			}
			if (check.value !== undefined) {
				checks.push({
					check: `element ${index} value is ${JSON.stringify(check.value)}`,
					verified: (element.value ?? "") === check.value,
					actual: `value ${JSON.stringify(element.value ?? "")}`,
				});
			}
			if (check.label !== undefined) {
				checks.push({
					check: `element ${index} label is ${JSON.stringify(check.label)}`,
					verified: (element.label ?? "") === check.label,
					actual: `label ${JSON.stringify(element.label ?? "")}`,
				});
			}
			if (check.value === undefined && check.label === undefined) {
				checks.push({ check: `element ${index} exists`, verified: true, actual: describeElement(element) });
			}
		}
		if (request.windowTitle !== undefined) {
			const check = `a window titled ${JSON.stringify(request.windowTitle)} is open`;
			if (deadline !== undefined && deadline - Date.now() <= 0) {
				// The budget is spent: keep the title the observation itself reported rather than starting a new query.
				checks.push({
					check,
					verified: state.windowTitle === request.windowTitle,
					actual:
						state.windowTitle === undefined
							? "window list not queried: deadline expired"
							: `observed window title ${JSON.stringify(state.windowTitle)}`,
				});
			} else {
				const titles = (await this.windowsForPid(pid)).map((window) => window.title);
				if (state.windowTitle !== undefined && !titles.includes(state.windowTitle)) {
					titles.push(state.windowTitle);
				}
				checks.push({
					check,
					verified: titles.includes(request.windowTitle),
					actual: titles.length === 0 ? "window titles are unavailable" : titles.join(" | "),
				});
			}
		}
		return { verified: checks.every((check) => check.verified), checks };
	}

	private async windowsForPid(pid: number): Promise<readonly TopLevelWindow[]> {
		if (this.windowProbe === undefined) {
			return [];
		}
		try {
			return (await this.windowProbe({ titlesFor: [pid] })).filter((window) => window.ownerPid === pid);
		} catch {
			return [];
		}
	}

	private async beginMutation(
		token: string,
		app: string,
		validate: Validation,
		screenPoints: boolean,
	): Promise<{
		readonly pid: number;
		readonly observation: InputObservation;
		readonly elements: ObservedElementIdentity | undefined;
	}> {
		const stopped = this.userStopped();
		if (stopped !== undefined) {
			throw stopped;
		}
		let active: ReturnType<GuardedSession["consume"]>;
		try {
			active = this.consume(token);
		} catch (error: unknown) {
			throw new InputRefusal("stale-observation-token", error instanceof Error ? error.message : undefined);
		}
		const targetPid = await this.resolvePidForToken(app, active.observation.pid);
		if (targetPid !== active.observation.pid) {
			throw new InputRefusal("token-observation-mismatch", "requested app does not match the token observation");
		}
		try {
			validate(active.observation);
		} catch (error: unknown) {
			throw new InputRefusal("element-not-observed", error instanceof Error ? error.message : undefined);
		}
		const preflight = await timed("preflightInput", () =>
			this.computer.preflightInput(active.observation, { requireSameBounds: screenPoints }),
		);
		if (!preflight.ok) {
			this.resolvedAppPids.delete(appKey(app));
			throw new InputRefusal(preflight.reason);
		}
		this.assertOpen();
		return { pid: targetPid, observation: active.observation, elements: active.elements };
	}

	/**
	 * THE seam where a run_steps chain turns what a step names (a described target or an element id) into
	 * an element. Verified pace reads the UI first, every time. Fast pace tries the chain's one read first
	 * and reads again, for this step only, when the element is not in it (UI an earlier step created);
	 * the fresh read then becomes the chain's tree, because ids belong to the snapshot they came from.
	 * Anything that finds elements the plain read cannot (scrolling a list until the row exists, text
	 * recognition when no accessibility element matches) extends this function, not the chain loop.
	 */
	private async resolveStepTarget<T>(chain: ChainTree, find: ElementFinder<T>): Promise<TargetLookup<T>> {
		// Frames a scroll in this chain moved cannot be trusted to aim an action, so they force a fresh read.
		if (chain.elements !== undefined && !chain.framesStale) {
			const attempt = find(chain.elements);
			if ("found" in attempt) {
				return attempt;
			}
		}
		const baseline = await chain.read();
		chain.changed = chain.changed || baseline.changed;
		chain.framesStale = false;
		chain.idsRebased = false;
		chain.elements = chain.keep ? baseline.elements : undefined;
		return find(baseline.elements);
	}

	/**
	 * A step that names its target with `find`: look at what is shown (accessibility, then the window's pixels),
	 * scroll the area a page and look again, and stop at the first sighting. The stop switch, the cancel signal and
	 * the window guards are checked before every look, so a long search can be stopped between pages.
	 */
	private async searchByScrolling(
		chain: ChainTree,
		expected: { readonly pid: number; readonly observation: InputObservation },
		step: RunStep,
		target: StepTarget,
		find: StepFind,
		control: RunControl,
	): Promise<ScrollFindResult> {
		return await findByScrolling(
			{
				computer: this.computer,
				pid: expected.pid,
				observation: expected.observation,
				interrupted: async (scrolled) => {
					this.assertOpen();
					const stopped = this.userStopped();
					if (stopped !== undefined) {
						return { message: stopped.message, refused: stopped.reason };
					}
					if (control.signal?.aborted === true) {
						return { message: "cancelled by the client while looking for the target" };
					}
					if (!scrolled) {
						return undefined;
					}
					const blocked = await this.chainGuard(expected.pid, expected.observation, step);
					return blocked === undefined
						? undefined
						: {
								message: `the window guard refused the search (${blocked}); nothing further was dispatched`,
								refused: blocked,
							};
				},
			},
			chain,
			target.query,
			target.index,
			find,
		);
	}

	/**
	 * The check before every chain step after the first, in either pace: the window the chain was observed on is
	 * still the same window (and, for steps that aim at screen points, the same bounds), the app is still approved
	 * and running, and the observation was not replaced. A reason means refuse.
	 */
	private async chainGuard(
		pid: number,
		observed: InputObservation,
		step: RunStep,
		options: { readonly preflight?: boolean } = {},
	): Promise<string | undefined> {
		const pointer = POINTER_STEP_TYPES.has(step.type);
		const current = this.computer.getInputObservation(pid);
		if (current === undefined) {
			return "observation-replaced";
		}
		if (current !== observed) {
			if (
				current.pid !== observed.pid ||
				current.bundleId !== observed.bundleId ||
				current.windowId !== observed.windowId
			) {
				return "window-changed";
			}
			if (pointer && !sameInputContext(observed, current)) {
				return "window-bounds-changed";
			}
		}
		if (options.preflight === false) {
			return undefined;
		}
		const result = await timed("chainGuard", () =>
			this.computer.preflightInput(current, { requireSameBounds: pointer }),
		);
		return result.ok ? undefined : result.reason;
	}

	/**
	 * Why input must not go out now: the user's stop switch, or the client cancelling the request. Read right before
	 * every dispatch and, through the dispatch's input scope, before every event of one that is not a release.
	 */
	private inputHalt(signal: AbortSignal | undefined): InputRefusal | undefined {
		return (
			this.userStopped() ??
			(signal?.aborted === true
				? new InputRefusal("cancelled", "cancelled by the client before this step ran")
				: undefined)
		);
	}

	/**
	 * Send one validated action's input in an input scope naming the app and the observed window. Every event the
	 * driver posts for it is addressed from that scope, never from state another app's dispatch running meanwhile
	 * could change, and stops at the next event once {@link inputHalt} says so.
	 */
	private async inInputScope<T>(
		pid: number,
		observation: InputObservation,
		signal: AbortSignal | undefined,
		send: () => Promise<T>,
	): Promise<T> {
		return await runInInputScope(
			{ target: { pid, windowId: observation.windowId }, interruption: () => this.inputHalt(signal)?.message },
			send,
		);
	}

	/**
	 * The answer for input a stop or a cancel cut short: part of it may have gone out, so the app is in an unknown
	 * state and is observed again before anything else; undefined for any other error.
	 */
	private interruptedResult(pid: number, error: unknown, partial?: Record<string, unknown>): ToolResult | undefined {
		if (!(error instanceof InputInterrupted)) {
			return undefined;
		}
		this.clearTokenFor(pid);
		const halt = this.userStopped();
		return {
			...postActionErrorResult(error, { ...partial, refused: halt?.reason ?? "interrupted" }),
			isError: true,
		};
	}

	/** The refusal to raise while the user's stop switch is on, or nothing while computer use is allowed. */
	private userStopped(): InputRefusal | undefined {
		const status = this.stopSwitch?.status();
		return status?.stopped === true ? new InputRefusal("user-stopped", describeUserStop(status)) : undefined;
	}

	private refusalFrom(error: unknown): ToolResult | undefined {
		return error instanceof InputRefusal ? refusalResult(error.reason, error.message) : undefined;
	}

	private async readOutcome(
		targetPid: number,
		expected: InputObservation,
		options: MutationOptions,
		observedElements?: ObservedElementIdentity,
	): Promise<{
		readonly state: AppState;
		readonly contextUnchanged: boolean;
		readonly nextToken: string | undefined;
		readonly timing?: Readonly<Record<string, number>>;
		readonly setValue?: {
			readonly element_index: number;
			readonly requested_value: string;
			readonly observed_value: string | null;
			readonly verified: boolean;
		};
	}> {
		this.assertOpen();
		// A retained read asks for the whole tree and answers with the same diff-only state the walk would
		// have produced on its own.
		const retain = (options.retainTree === true || options.valueCheck !== undefined) && options.fullState !== true;
		// A bound window is the one the observation named. The pre-action listing already validated
		// it and dropped it when closed, so the outcome read needs no second inventory probe.
		const windowId = this.boundWindows.get(targetPid);
		const startedAt = timingEnabled() ? performance.now() : undefined;
		const read = await timed("readOutcome.getAppState", () =>
			this.computer.getAppState(targetPid, {
				...(options.fullState === true || retain
					? STRICT_STATE_OPTIONS
					: { ...STRICT_DIFF_STATE_OPTIONS, maxElements: FAST_OUTCOME_MAX_ELEMENTS }),
				includeScreenshot: options.includeScreenshot === true,
				...(windowId === undefined ? {} : { windowId }),
			}),
		);
		const state: AppState =
			retain && read.axChangeSummary !== undefined && read.treeSkipped !== true
				? { ...read, elements: [], treeOmitted: true }
				: read;
		this.assertOpen();
		const current = this.computer.getInputObservation(targetPid);
		// Background delivery acts on a window that is deliberately not frontmost, so requiring focus
		// here withheld the next token after every background action and cost a full re-observation.
		// A post-action read that produced a comparable tree is itself a fresh observation, so it earns
		// a token whether or not the tree changed; only an unavailable tree still pauses.
		const focusSatisfied = state.frontmost || this.computer.delivery === "background";
		const contextUnchanged =
			current !== undefined &&
			focusSatisfied &&
			observationMatchesState(current, state) &&
			sameInputContext(expected, current);
		const nextToken =
			contextUnchanged && state.axChangeSummary !== undefined ? this.issue(current, undefined) : undefined;
		if (nextToken !== undefined) {
			this.rememberRead(targetPid, current, read);
		}
		const check = options.valueCheck;
		const element =
			check === undefined ? undefined : read.elements.find((candidate) => candidate.id === check.elementIndex);
		const identity = check === undefined ? undefined : observedElements?.get(check.elementIndex);
		return {
			state,
			contextUnchanged,
			nextToken,
			...(startedAt === undefined ? {} : { timing: { capture: Math.round(performance.now() - startedAt) } }),
			...(check === undefined
				? {}
				: {
						setValue: {
							element_index: check.elementIndex,
							requested_value: check.value,
							observed_value: element?.value ?? null,
							verified:
								contextUnchanged &&
								element !== undefined &&
								(identity === undefined || sameElementIdentity(identity, element)) &&
								element.value === check.value,
						},
					}),
		};
	}

	/** Turn a fresh state into the next token/context answer without another read. */
	private outcomeFromState(
		targetPid: number,
		expected: InputObservation,
		state: AppState,
		timing?: Readonly<Record<string, number>>,
	): {
		readonly state: AppState;
		readonly contextUnchanged: boolean;
		readonly nextToken: string | undefined;
		readonly timing?: Readonly<Record<string, number>>;
	} {
		this.assertOpen();
		const current = this.computer.getInputObservation(targetPid);
		const focusSatisfied = state.frontmost || this.computer.delivery === "background";
		const contextUnchanged =
			current !== undefined &&
			focusSatisfied &&
			observationMatchesState(current, state) &&
			sameInputContext(expected, current);
		const nextToken =
			contextUnchanged && state.axChangeSummary !== undefined ? this.issue(current, undefined) : undefined;
		if (nextToken !== undefined) {
			this.rememberRead(targetPid, current, state);
		}
		return { state, contextUnchanged, nextToken, ...(timing === undefined ? {} : { timing }) };
	}

	private async readFieldBaseline(targetPid: number): Promise<{
		readonly elements: ReadonlyMap<number, AXTreeElement>;
		readonly changed: boolean;
	}> {
		this.assertOpen();
		const bound = await this.boundWindowOption(targetPid);
		const state = await timed("readFieldBaseline.getAppState", () =>
			this.computer.getAppState(targetPid, { ...FIELD_VERIFY_STATE_OPTIONS, ...bound }),
		);
		this.assertOpen();
		return {
			elements: new Map(state.elements.map((element) => [element.id, element] as const)),
			changed: hasAxChange(state),
		};
	}

	private async captureWindowBaseline(): Promise<readonly number[] | undefined> {
		if (this.windowProbe === undefined) {
			return undefined;
		}
		const probe = this.windowProbe;
		try {
			return (await timed("windowProbe.before", () => probe())).map((window) => window.id);
		} catch {
			return undefined;
		}
	}

	private async describeWindowSideEffects(
		baseline: readonly number[] | undefined,
		targetPid: number,
	): Promise<readonly WindowEvent[]> {
		if (baseline === undefined || this.windowProbe === undefined) {
			return [];
		}
		try {
			const known = new Set(baseline);
			const probe = this.windowProbe;
			let opened = (await timed("windowProbe.after", () => probe())).filter(
				(window) => window.ownerPid === targetPid && !known.has(window.id),
			);
			const untitled = [...new Set(opened.filter((window) => window.title === "").map((window) => window.ownerPid))];
			if (untitled.length > 0) {
				// Titles the WindowServer withholds come from the apps that opened the windows.
				const titles = new Map(
					(await probe({ titlesFor: untitled })).map((window) => [window.id, window.title] as const),
				);
				opened = opened.map((window) =>
					window.title === "" ? { ...window, title: titles.get(window.id) ?? "" } : window,
				);
			}
			return opened.map((window) => ({
				id: window.id,
				ownerPid: window.ownerPid,
				ownerName: window.ownerName,
				title: window.title,
			}));
		} catch {
			return [];
		}
	}

	private issue(
		observation: InputObservation,
		elements: ObservedElementIdentity | undefined,
		deferred = false,
	): string {
		const token = randomUUID();
		const key = this.laneKey(observation.pid);
		const previous = this.tokenByPid.get(key);
		if (previous !== undefined) {
			this.tokens.delete(previous);
		}
		this.tokens.set(token, { token, key, observation, elements, deferred });
		this.tokenByPid.set(key, token);
		return token;
	}

	/** A pre-action listing is also the bound-window liveness check; no extra probe is needed. */
	private forgetClosedBoundWindow(pid: number, openWindowIds: readonly number[] | undefined): void {
		const windowId = this.boundWindows.get(pid);
		if (windowId !== undefined && openWindowIds !== undefined && !openWindowIds.includes(windowId)) {
			this.boundWindows.delete(pid);
		}
	}

	/**
	 * Keep this app's later reads (action outcomes, step baselines, waits) on the window an observation
	 * named, or let them follow the app's focused window again when the observation named none.
	 */
	private bindWindow(pid: number, windowId: number | undefined): void {
		if (windowId === undefined) {
			this.boundWindows.delete(pid);
		} else {
			this.boundWindows.set(pid, windowId);
		}
	}

	/**
	 * The window an internal read of `pid` is scoped to: the one its latest observation named, while that
	 * window is still open, so an action's outcome and the next step's baseline come from the window acted
	 * on even when another of the app's windows has focus. A bound window that has closed is let go.
	 */
	private async boundWindowOption(pid: number): Promise<{ readonly windowId?: number }> {
		const windowId = this.boundWindows.get(pid);
		if (windowId === undefined) {
			return {};
		}
		if (this.windowProbe !== undefined) {
			let open = true;
			try {
				open = (await this.windowProbe()).some((window) => window.id === windowId && window.ownerPid === pid);
			} catch {
				// The listing could not be read: keep the window, and let the read report it if it is gone.
			}
			if (!open) {
				this.boundWindows.delete(pid);
				return {};
			}
		}
		return { windowId };
	}

	/**
	 * One live token per app, or per cursor on an opencua-owned surface: a new observation invalidates only the
	 * previous token of the same lane.
	 */
	private clearTokenFor(pid: number): void {
		const key = this.laneKey(pid);
		this.reusableReads.delete(key);
		const token = this.tokenByPid.get(key);
		if (token !== undefined) {
			this.tokens.delete(token);
			this.tokenByPid.delete(key);
		}
	}

	/** An owned surface is shared by cursors, so each cursor gets its own lane; any other app has one lane. */
	private laneKey(pid: number): LaneKey {
		const identity = currentCursorIdentity();
		return identity !== undefined && isOwnedSurfacePid(pid) ? `${pid}:${identity}` : pid;
	}

	/** Resolve an app name to a pid, remembering the answer for later requests naming the same app. */
	private async resolvePid(app: string): Promise<number> {
		const pid = await timed("resolveAppPid", () => resolveAppPid(this.computer, app));
		this.resolvedAppPids.set(appKey(app), pid);
		return pid;
	}

	/**
	 * The pid a token-carrying request names. When this session already resolved the same app name to the
	 * token's pid, enumerating every running app again (the dominant cost of a small action) adds nothing:
	 * preflight still proves that exact process is running, is the observed bundle and is approved.
	 */
	private async resolvePidForToken(app: string, tokenPid: number): Promise<number> {
		return this.resolvedAppPids.get(appKey(app)) === tokenPid ? tokenPid : await this.resolvePid(app);
	}

	/** Keep the complete tree of a settled read so the next action can resolve its target against it. */
	private rememberRead(pid: number, observation: InputObservation | undefined, state: AppState): void {
		if (
			observation === undefined ||
			state.treeSkipped === true ||
			state.treeOmitted === true ||
			state.elementsTruncated === true ||
			!observationMatchesState(observation, state)
		) {
			this.reusableReads.delete(this.laneKey(pid));
			return;
		}
		const now = Date.now();
		// Cursors on a shared surface each leave a read behind; one past its reuse window is never taken again.
		for (const [key, read] of this.reusableReads) {
			if (now - read.at > READ_REUSE_MILLISECONDS) this.reusableReads.delete(key);
		}
		this.reusableReads.set(this.laneKey(pid), {
			observation,
			elements: new Map(state.elements.map((element) => [element.id, element] as const)),
			at: now,
		});
	}

	/**
	 * The tree of the read that produced `expected`, once. It stands in for a fresh read only while that
	 * read is still the app's latest observation (nothing observed or acted since) and younger than
	 * {@link READ_REUSE_MILLISECONDS}.
	 */
	private takeReusableRead(expected: InputObservation): ReadonlyMap<number, AXTreeElement> | undefined {
		const key = this.laneKey(expected.pid);
		const entry = this.reusableReads.get(key);
		this.reusableReads.delete(key);
		if (
			entry === undefined ||
			entry.observation !== expected ||
			Date.now() - entry.at > READ_REUSE_MILLISECONDS ||
			this.computer.getInputObservation(expected.pid) !== expected
		) {
			return undefined;
		}
		return entry.elements;
	}

	private laneForRequestedToken(token: string): number | undefined {
		return this.tokens.get(token)?.observation.pid;
	}

	private consume(token: string): LiveToken {
		const live = this.tokens.get(token);
		if (live === undefined) {
			throw new Error("observation token is missing, stale, or already consumed");
		}
		this.tokens.delete(token);
		if (this.tokenByPid.get(live.key) === token) {
			this.tokenByPid.delete(live.key);
		}
		return live;
	}

	private assertOpen(): void {
		if (this.closed) {
			throw new Error("MCP computer session is closed");
		}
	}

	private enqueue(pid: number | undefined, operation: () => Promise<ToolResult>): Promise<ToolResult> {
		const lane = pid === undefined ? undefined : this.laneKey(pid);
		const previous = lane === undefined ? this.globalTail : (this.tails.get(lane) ?? Promise.resolve());
		// A locked Mac is not a tool failure: it answers as a refusal that asks for the person.
		const result = previous
			.then(async () => {
				this.assertOpen();
				return await operation();
			})
			.catch((error: unknown) => {
				const refusal = lockRefusalResult(error);
				if (refusal !== undefined) {
					return refusal;
				}
				const message = error instanceof Error ? error.message : String(error);
				throw message.trim().length === 0
					? new Error("Computer operation failed without error details; observe the app before retrying.", {
							cause: error,
						})
					: error;
			});
		const settled = result.then(
			() => undefined,
			() => undefined,
		);
		if (lane === undefined) {
			this.globalTail = settled;
		} else {
			this.tails.set(lane, settled);
		}
		return result;
	}
}

type HandsLaneSnapshot = HandsRunResult<unknown>["lanes"][number];

class HandsLaneError extends Error {
	constructor(
		readonly reports: readonly RunStepReport[],
		readonly laneError: unknown,
	) {
		super(handsErrorText(laneError));
		this.name = "HandsLaneError";
	}
}

function isStepReports(value: unknown): value is readonly RunStepReport[] {
	return Array.isArray(value);
}

function isVisionCapture(value: unknown): value is HandsVisionCapture {
	return (
		typeof value === "object" &&
		value !== null &&
		"image" in value &&
		"durationMs" in value &&
		typeof value.durationMs === "number"
	);
}

function handsErrorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function handsDispatch(lanes: readonly HandsLaneSnapshot[]): ActionDispatch | undefined {
	const routes = new Set<ActionDispatch["route"]>();
	const deliveries = new Set<ActionDispatch["delivery"]>();
	for (const lane of lanes) {
		if (!isStepReports(lane.value)) {
			continue;
		}
		for (const step of lane.value) {
			if (step.route !== undefined) {
				routes.add(step.route);
			}
			if (step.delivery !== undefined) {
				deliveries.add(step.delivery);
			}
		}
	}
	const route = routes.size === 1 ? ([...routes][0] ?? "unknown") : "unknown";
	const delivery = deliveries.size === 1 ? ([...deliveries][0] ?? "unknown") : "unknown";
	return { route, delivery };
}

function handsVisionReport(
	vision: RunHandsVisionOptions | undefined,
	lane: HandsLaneSnapshot | undefined,
	capture: HandsVisionCapture | undefined,
	imageIndex: number,
): RunHandsVisionReport | undefined {
	if (vision === undefined) {
		return undefined;
	}
	if (capture !== undefined) {
		const image = capture.image;
		const captured = image !== undefined;
		return {
			captured,
			width: image?.width ?? 0,
			height: image?.height ?? 0,
			bytes: image === undefined ? 0 : Buffer.byteLength(image.base64, "base64"),
			duration_ms: Math.round(capture.durationMs),
			...(capture.hot === true ? { source: "hot" as const, frame_age_ms: capture.frameAgeMs ?? 0 } : {}),
			...(capture.hot === true ? {} : { source: "live" as const }),
			...(captured ? { image_index: imageIndex } : {}),
			...(captured ? {} : { unavailable: capture.unavailable ?? "the capture returned no image" }),
		};
	}
	return {
		captured: false,
		width: 0,
		height: 0,
		bytes: 0,
		duration_ms: lane?.durationMs ?? 0,
		unavailable: lane?.error === undefined ? "the vision lane did not run" : handsErrorText(lane.error),
	};
}

export function validateElement(observation: InputObservation, elementIndex: number): void {
	if (!observation.observedElementIds.has(elementIndex)) {
		throw new Error(`element index ${elementIndex} was not present in the token observation`);
	}
}

export function validatePoint(observation: InputObservation, point: Point): void {
	const { width, height } = observation.screenshotViewport;
	if (
		!Number.isFinite(point.x) ||
		!Number.isFinite(point.y) ||
		point.x < 0 ||
		point.y < 0 ||
		point.x >= width ||
		point.y >= height
	) {
		throw new Error(`coordinates must be within the observed viewport [0, ${width}) x [0, ${height})`);
	}
}

export function observedPointToScreen(observation: InputObservation, point: Point): Point {
	validatePoint(observation, point);
	const viewport = observation.screenshotViewport;
	return {
		x: viewport.bounds.x + (point.x / viewport.width) * viewport.bounds.width,
		y: viewport.bounds.y + (point.y / viewport.height) * viewport.bounds.height,
	};
}

function parseFieldIndex(elementIndex: string): number {
	const index = Number(elementIndex.trim());
	if (!Number.isSafeInteger(index) || index < 0) {
		throw new Error(`Invalid element index: ${elementIndex}`);
	}
	return index;
}

function appKey(app: string): string {
	return app.trim().toLowerCase();
}

function observedElementIdentity(state: AppState): ObservedElementIdentity | undefined {
	if (state.treeOmitted === true) {
		return undefined;
	}
	return new Map(
		state.elements.map(
			(element) =>
				[
					element.id,
					{ role: element.role, label: element.label, y: Math.round(element.frame.y), actions: element.actions },
				] as const,
		),
	);
}

function sameElementIdentity(
	observed: { readonly role: string; readonly label: string | null; readonly y: number },
	element: AXTreeElement,
): boolean {
	return (
		observed.role === element.role && observed.label === element.label && observed.y === Math.round(element.frame.y)
	);
}

function skippedStep(elementIndex: number, requestedValue: string, reason: string): SetFieldStepReport {
	return {
		element_index: elementIndex,
		requested_value: requestedValue,
		input_dispatched: false,
		status: "skipped",
		reason,
	};
}

function skippedRunStep(position: number, type: string, reason: string): RunStepReport {
	return {
		step: position,
		type,
		input_dispatched: false,
		status: "skipped",
		reason,
	};
}

function summarizeRunSteps(
	steps: readonly RunStepReport[],
	requested: number,
	stoppedEarly: boolean,
	uiChanged: boolean,
): RunStepsReport {
	return {
		requested,
		completed: steps.filter((step) => step.input_dispatched).length,
		stoppedEarly,
		uiChanged,
		steps,
	};
}

function summarize(
	steps: readonly SetFieldStepReport[],
	requested: number,
	stoppedEarly: boolean,
	uiChanged: boolean,
): SetFieldsReport {
	const inputDispatched = steps.filter((step) => step.input_dispatched).length;
	const verified = steps.filter((step) => step.status === "verified").length;
	return {
		requested,
		inputDispatched,
		verified,
		outcomeVerified: verified === requested && !stoppedEarly,
		stoppedEarly,
		uiChanged,
		steps,
	};
}

function observationMatchesState(observation: InputObservation, state: AppState): boolean {
	return (
		observation.pid === state.pid &&
		observation.bundleId === state.bundleId &&
		state.windowBounds !== undefined &&
		rectsEqual(observation.windowBounds, state.windowBounds) &&
		observation.screenshotViewport.width === state.screenshotWidth &&
		observation.screenshotViewport.height === state.screenshotHeight
	);
}

function sameInputContext(before: InputObservation, after: InputObservation): boolean {
	return (
		before.pid === after.pid &&
		before.bundleId === after.bundleId &&
		before.windowId === after.windowId &&
		rectsEqual(before.windowBounds, after.windowBounds) &&
		rectsEqual(before.screenshotViewport.bounds, after.screenshotViewport.bounds) &&
		before.screenshotViewport.width === after.screenshotViewport.width &&
		before.screenshotViewport.height === after.screenshotViewport.height
	);
}

function rectsEqual(left: Rect, right: Rect): boolean {
	return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}

function hasAxChange(state: AppState): boolean {
	const summary = state.axChangeSummary;
	return summary !== undefined && summary.added + summary.removed + summary.changed > 0;
}
