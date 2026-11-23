import type { Rect } from "../types/index.js";
import type { ComputerInterface } from "./interface.js";
import type { LeaseRefusalCode } from "./window-lease.js";

export interface InputObservation {
	readonly generation: number;
	readonly pid: number;
	readonly bundleId: string;
	readonly windowId: number;
	readonly windowBounds: Rect;
	readonly screenshotViewport: {
		readonly width: number;
		readonly height: number;
		readonly bounds: Rect;
	};
	readonly observedElementIds: ReadonlySet<number>;
}

type PreflightRefusalReason =
	| "isolated-session-required"
	| "app-not-frontmost"
	| "app-not-approved"
	| "url-blocked"
	| "url-unavailable"
	| "window-missing"
	| "window-changed"
	| "window-bounds-changed"
	| "observation-replaced"
	| LeaseRefusalCode;

interface PreflightRefusal {
	readonly ok: false;
	readonly reason: PreflightRefusalReason;
	/** What was refused and how it is lifted, when the reason alone does not say (a window lease names its grant). */
	readonly detail?: string;
}

export type PreflightResult = { readonly ok: true } | PreflightRefusal;

export interface PreflightOptions {
	/**
	 * Refuse when the window moved or resized since the observation. Only input that maps observed
	 * screenshot coordinates onto the screen depends on the bounds; element, keyboard and menu input
	 * does not, and would otherwise be refused while a window is still animating into place.
	 * Defaults to true.
	 */
	readonly requireSameBounds?: boolean;
}

export interface GuardedComputerInterface extends ComputerInterface {
	getInputObservation(targetPid: number): InputObservation | undefined;
	preflightInput(expected: InputObservation, options?: PreflightOptions): Promise<PreflightResult>;
}
