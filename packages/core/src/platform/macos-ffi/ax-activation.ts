/**
 * Electron and Chromium build their accessibility tree only once something asks them to, so a cold Slack, VS Code
 * or Chrome answers an accessibility walk with a window and an empty web area. Electron documents
 * AXManualAccessibility on its application element for exactly this; Chromium browsers listen for
 * AXEnhancedUserInterface, the flag VoiceOver sets. This module decides when to set which flag on which process,
 * remembers what it was before so it can be put back, and sizes the walk budget for the large trees these apps
 * expose once they are awake. Every system call goes through {@link AxActivationDeps}.
 */

export type AxToolkit = "electron" | "chromium" | "native";

export const AX_MANUAL_ACCESSIBILITY_ATTRIBUTE = "AXManualAccessibility";
export const AX_ENHANCED_USER_INTERFACE_ATTRIBUTE = "AXEnhancedUserInterface";

/** How long a detection stands, and the least time between two writes of the flag to one app. */
export const AX_ACTIVATION_TTL_MS = 60_000;
export const DEFAULT_WALK_BUDGET = 2_000;
/** The largest element budget a default walk grows to: one AX round trip per element keeps a walk this size near a second. */
export const MAX_ADAPTIVE_WALK_BUDGET = 5_000;
export const DEFAULT_WALK_DEPTH = 30;
/** Slack's message list sits below depth 30; twice that reaches it without letting a runaway tree recurse forever. */
export const MAX_ADAPTIVE_WALK_DEPTH = 60;
const WALK_DEPTH_STEP = 15;

export interface AxActivationDeps {
	readonly executablePath: (pid: number) => string | undefined;
	readonly pathExists: (path: string) => boolean;
	readonly listDirectory: (path: string) => readonly string[];
	/** The attribute's value on the application element, or undefined when the app does not report one. */
	readonly readBooleanAttribute: (pid: number, attribute: string) => boolean | undefined;
	readonly writeBooleanAttribute: (pid: number, attribute: string, value: boolean) => boolean;
	readonly now: () => number;
}

export interface AxWalkObservation {
	readonly budgetExhausted: boolean;
	readonly depthTruncated: boolean;
	/** True only for a whole-app or whole-window walk at the default limits, the walks whose size describes the app. */
	readonly sizesTree: boolean;
	readonly flat: boolean;
}

export interface AxWalkLimits {
	readonly maxElements: number;
	readonly maxDepth: number;
}

export interface AxRestoreResult {
	readonly pid: number;
	readonly attribute: string;
	readonly restoredTo: boolean;
	readonly restored: boolean;
}

interface Activation {
	readonly attribute: string;
	/** What the app reported before this process wrote the flag. */
	readonly prior: boolean;
	/** False when the app already had the flag on, so there is nothing to put back. */
	written: boolean;
	verifiedAt: number;
	/** Set when the app refused the write, so it is not asked again within the TTL. */
	refusedAt: number | undefined;
}

interface PidState {
	readonly toolkit: AxToolkit;
	readonly executablePath: string | undefined;
	detectedAt: number;
	budget: number;
	depth: number;
	activation: Activation | undefined;
}

export interface AxActivation {
	readonly toolkitFor: (pid: number) => AxToolkit;
	readonly beforeWalk: (pid: number) => void;
	readonly afterWalk: (pid: number, observation: AxWalkObservation) => void;
	/** The limits for a walk of `pid` that did not ask for its own. */
	readonly walkLimits: (pid: number) => AxWalkLimits;
	/** Put back every flag this process changed (or only `pid`'s) and forget it. */
	readonly restore: (pid?: number) => readonly AxRestoreResult[];
	/** Drop what is known about exited processes: a flag set on a process that is gone has nothing to put back. */
	readonly forgetExcept: (runningPids: ReadonlySet<number>) => void;
}

const CONTENTS_MACOS = "/Contents/MacOS/";
const ELECTRON_FRAMEWORK = "Electron Framework.framework";
/** Every Chromium framework (Google Chrome, Brave Browser, Microsoft Edge, Chromium, ...) ships its crash handler here. */
const CHROMIUM_FRAMEWORK_SIGNATURE = "Versions/Current/Helpers/chrome_crashpad_handler";

/** The outermost-nearest app bundle an executable belongs to: the one whose Contents/MacOS holds it. */
export function bundlePathForExecutable(executablePath: string): string | undefined {
	const index = executablePath.lastIndexOf(CONTENTS_MACOS);
	return index <= 0 ? undefined : executablePath.slice(0, index);
}

export function detectAxToolkit(
	executablePath: string | undefined,
	deps: Pick<AxActivationDeps, "pathExists" | "listDirectory">,
): AxToolkit {
	const bundle = executablePath === undefined ? undefined : bundlePathForExecutable(executablePath);
	if (bundle === undefined) {
		return "native";
	}
	const frameworks = `${bundle}/Contents/Frameworks`;
	if (deps.pathExists(`${frameworks}/${ELECTRON_FRAMEWORK}`)) {
		return "electron";
	}
	if (!deps.pathExists(frameworks)) {
		return "native";
	}
	const chromium = deps
		.listDirectory(frameworks)
		.some(
			(entry) =>
				entry.endsWith(" Framework.framework") &&
				deps.pathExists(`${frameworks}/${entry}/${CHROMIUM_FRAMEWORK_SIGNATURE}`),
		);
	return chromium ? "chromium" : "native";
}

/**
 * A walk whose web content never came back. Both toolkits put their content under an AXWebArea; while
 * accessibility is off it is missing or has no children.
 */
export function looksFlat(
	elements: readonly { readonly role: string; readonly children: readonly number[] }[],
): boolean {
	return !elements.some((element) => element.role === "AXWebArea" && element.children.length > 0);
}

export function createAxActivation(deps: AxActivationDeps): AxActivation {
	const states = new Map<number, PidState>();

	function stateFor(pid: number): PidState {
		const now = deps.now();
		const known = states.get(pid);
		if (known !== undefined && now - known.detectedAt < AX_ACTIVATION_TTL_MS) {
			return known;
		}
		const executablePath = deps.executablePath(pid);
		if (known !== undefined && known.executablePath === executablePath) {
			known.detectedAt = now;
			return known;
		}
		// A new process, or a pid the system handed to another program: whatever was set on the old one is gone with it.
		const fresh: PidState = {
			toolkit: detectAxToolkit(executablePath, deps),
			executablePath,
			detectedAt: now,
			budget: DEFAULT_WALK_BUDGET,
			depth: DEFAULT_WALK_DEPTH,
			activation: undefined,
		};
		states.set(pid, fresh);
		return fresh;
	}

	/**
	 * Turn the flag on, at most once per TTL. Each write makes the app rebuild its tree, so after the first one only a
	 * walk that came back flat asks again, and not before the TTL lapses. The read-back cannot be the trigger: Electron
	 * reports AXManualAccessibility as false even after accepting true.
	 */
	function activate(pid: number, state: PidState, attribute: string): void {
		const now = deps.now();
		const activation = state.activation;
		if (activation !== undefined) {
			const since = activation.refusedAt ?? activation.verifiedAt;
			if (now - since < AX_ACTIVATION_TTL_MS) {
				return;
			}
		}
		const current = deps.readBooleanAttribute(pid, attribute);
		if (current === true) {
			if (activation === undefined) {
				state.activation = { attribute, prior: true, written: false, verifiedAt: now, refusedAt: undefined };
			} else {
				activation.verifiedAt = now;
				activation.refusedAt = undefined;
			}
			return;
		}
		const accepted = deps.writeBooleanAttribute(pid, attribute, true);
		if (activation === undefined) {
			state.activation = {
				attribute,
				prior: current ?? false,
				written: accepted,
				verifiedAt: now,
				refusedAt: accepted ? undefined : now,
			};
			return;
		}
		activation.written ||= accepted;
		activation.verifiedAt = now;
		activation.refusedAt = accepted ? undefined : now;
	}

	return {
		toolkitFor: (pid) => stateFor(pid).toolkit,
		beforeWalk: (pid) => {
			const state = stateFor(pid);
			// AXManualAccessibility exists for this and has no side effects, so an Electron app is woken before its first
			// walk instead of after a flat one: the renderer builds its tree asynchronously, and the sooner it starts the
			// sooner an observation sees it.
			if (state.toolkit === "electron" && state.activation === undefined) {
				activate(pid, state, AX_MANUAL_ACCESSIBILITY_ATTRIBUTE);
			}
		},
		afterWalk: (pid, observation) => {
			const state = stateFor(pid);
			if (state.toolkit === "native") {
				return;
			}
			// AXEnhancedUserInterface also changes how the browser animates and places windows, so it is set only when the
			// browser's tree is flat; a browser whose accessibility is already on keeps its normal behavior. A cut-off walk
			// can hide the web area's children, so only a complete one counts as flat.
			if (observation.flat && !observation.budgetExhausted && !observation.depthTruncated) {
				activate(
					pid,
					state,
					state.toolkit === "electron" ? AX_MANUAL_ACCESSIBILITY_ATTRIBUTE : AX_ENHANCED_USER_INTERFACE_ATTRIBUTE,
				);
			}
			if (!observation.sizesTree) {
				return;
			}
			// The limits only grow: element ids and diffs are keyed by them, so they settle instead of following each walk.
			if (observation.budgetExhausted) {
				state.budget = Math.min(MAX_ADAPTIVE_WALK_BUDGET, state.budget * 2);
			}
			if (observation.depthTruncated) {
				state.depth = Math.min(MAX_ADAPTIVE_WALK_DEPTH, state.depth + WALK_DEPTH_STEP);
			}
		},
		walkLimits: (pid) => {
			const state = stateFor(pid);
			return state.toolkit === "native"
				? { maxElements: DEFAULT_WALK_BUDGET, maxDepth: DEFAULT_WALK_DEPTH }
				: { maxElements: state.budget, maxDepth: state.depth };
		},
		restore: (pid) => {
			const results: AxRestoreResult[] = [];
			const pids = pid === undefined ? [...states.keys()] : [pid];
			for (const target of pids) {
				const activation = states.get(target)?.activation;
				states.delete(target);
				if (activation === undefined || !activation.written) {
					continue;
				}
				results.push({
					pid: target,
					attribute: activation.attribute,
					restoredTo: activation.prior,
					restored: deps.writeBooleanAttribute(target, activation.attribute, activation.prior),
				});
			}
			return results;
		},
		forgetExcept: (runningPids) => {
			for (const pid of states.keys()) {
				if (!runningPids.has(pid)) {
					states.delete(pid);
				}
			}
		},
	};
}
