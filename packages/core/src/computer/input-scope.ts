import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The app one dispatch is aimed at and, when the dispatch was validated against an observation, the window that
 * observation was of. Input of the dispatch goes to that window of that app, or is refused.
 */
export interface InputTarget {
	readonly pid: number;
	readonly windowId?: number;
}

/**
 * What one dispatch carries down to every event it posts: whom the events are for, and the check that says whether
 * input may still go out. Immutable, and bound to the async flow that opened it, so two dispatches running at the
 * same time for different apps never see each other's target, which one shared, mutable "current target" could not
 * promise: a call waiting for its window lookup would resume aimed at whichever app was set last, or at none.
 */
export interface InputScope {
	readonly target?: InputTarget;
	/**
	 * Why input must stop now (the person's stop switch, the client cancelling), or undefined while it may go on.
	 * Read before every event that is not a release, so a long text or drag stops part-way; held keys and buttons
	 * are still released.
	 */
	readonly interruption?: () => string | undefined;
}

/** Raised when a scope's interruption stops input part-way; what was held has been released. */
export class InputInterrupted extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = "InputInterrupted";
	}
}

const scopes = new AsyncLocalStorage<InputScope>();

let inputTargetListener: ((pid: number) => void) | undefined;

/** Be told the target pid of every scoped input before it is sent (one listener; undefined removes it). */
export function onInputTarget(listener: ((pid: number) => void) | undefined): void {
	inputTargetListener = listener;
}

/** Run `action` with `scope` as the input scope of everything it awaits, and of nothing else. */
export async function runInInputScope<T>(scope: InputScope, action: () => Promise<T>): Promise<T> {
	const target = scope.target === undefined ? undefined : Object.freeze({ ...scope.target });
	const frozen: InputScope = Object.freeze({
		...(target === undefined ? {} : { target }),
		...(scope.interruption === undefined ? {} : { interruption: scope.interruption }),
	});
	if (target !== undefined) {
		inputTargetListener?.(target.pid);
	}
	return await scopes.run(frozen, action);
}

/** The input scope of the calling async flow, or undefined outside any. */
export function currentInputScope(): InputScope | undefined {
	return scopes.getStore();
}

/** Throws {@link InputInterrupted} once the scope says input must stop; returns while it may go on. */
export function assertInputMayContinue(scope: InputScope | undefined): void {
	const reason = scope?.interruption?.();
	if (reason !== undefined) {
		throw new InputInterrupted(reason);
	}
}
