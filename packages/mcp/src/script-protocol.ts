/**
 * Messages between the run_script host (guarded session, main thread) and the script worker
 * (the agent's JavaScript, in a terminable thread). Everything crossing is structured-cloneable data.
 */

/** Which window of its app a handle acts on: a title (exact, else a unique part of one, any case) or a window id. */
export type WindowSelector = string | number;

/** The app handle a call acts on; the host keeps the mutable window binding under `id`. */
export interface WorkerTarget {
	readonly id: number;
	readonly app: string;
	readonly window: WindowSelector | undefined;
}

export type CallMethod =
	| "apps"
	| "windows"
	| "observe"
	| "find"
	| "step"
	| "batch"
	| "chain"
	| "hands"
	| "verify"
	| "dockObserve"
	| "dockAct"
	| "terminalRun"
	| "terminalRead"
	| "osascript"
	| "spacesActive"
	| "spacesDisplays"
	| "visibleFrames"
	| "cleanUp"
	| "browser"
	| "menubarObserve"
	| "menubarPress";

export type ScriptOutcome =
	| { readonly ok: true; readonly value: unknown; readonly valueTruncated: boolean }
	| { readonly ok: false; readonly kind: string; readonly error: string; readonly payload?: unknown };

/** A failed host call, rebuilt as a catchable error inside the script. */
export interface CallError {
	/** "unexpected" for anything that was not a ScriptActionError. */
	readonly kind: string;
	readonly message: string;
	readonly name: string;
	readonly refused: string | undefined;
	readonly payload: unknown;
}

interface WorkerCall {
	readonly type: "call";
	readonly id: number;
	readonly method: CallMethod;
	readonly target: WorkerTarget | undefined;
	readonly args: readonly unknown[];
}

export type WorkerMessage =
	| WorkerCall
	| { readonly type: "log"; readonly text: string }
	| { readonly type: "done"; readonly outcome: ScriptOutcome; readonly logDropped: number };

export type HostMessage =
	| { readonly type: "run"; readonly code: string }
	| { readonly type: "reply"; readonly id: number; readonly ok: true; readonly value: unknown }
	| { readonly type: "reply"; readonly id: number; readonly ok: false; readonly error: CallError };
