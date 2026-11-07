import type { SystemPrompt } from "../platform/system-prompts.js";
export interface AXTreeElement {
	id: number;
	role: string;
	label: string | null;
	value: string | null;
	/**
	 * Element bounds. When the screenshot is scoped to a single window
	 * ({@link AppState.windowBounds} is set), the frame is in that window
	 * screenshot's pixel space so it shares one coordinate system with the
	 * screenshot. Otherwise it is in global logical screen points.
	 */
	frame: { x: number; y: number; width: number; height: number };
	actions: string[];
	children: number[];
}

export interface DisplayInfo {
	readonly id?: number;
	readonly isMain?: boolean;
	readonly x?: number;
	readonly y?: number;
	readonly width: number;
	readonly height: number;
	readonly scaleFactor: number;
}

export interface DisplayInventoryEntry extends DisplayInfo {
	readonly id: number;
	readonly x: number;
	readonly y: number;
}

export interface AxTreeChangeSummary {
	added: number;
	removed: number;
	changed: number;
}

/**
 * The element-level accessibility diff: the actual elements that were added,
 * removed, and changed between two snapshots. This is the token-efficient
 * observation the model reads to see *what* changed, not just *how much*
 * ({@link AxTreeChangeSummary}).
 */
export interface AxTreeChanges {
	added: AXTreeElement[];
	removed: AXTreeElement[];
	changed: Array<{ before: AXTreeElement; after: AXTreeElement }>;
}

/** One window of an app that input could target, as reported back on an observation. */
export interface WindowInventoryEntry {
	readonly id: number;
	readonly title: string;
	readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
	readonly displayIds?: readonly number[];
	readonly displayId?: number;
}

export interface AppState {
	app: string;
	bundleId: string;
	pid: number;
	/**
	 * Whether an opencua-owned surface's page is playing sound and when that last changed (epoch ms). Only owned
	 * surfaces report it; the person's own apps are never listened to.
	 */
	audio?: {
		readonly playing: boolean;
		readonly changedAt: number;
		readonly level?: {
			readonly rmsDb: number;
			readonly peakDb: number;
			readonly bands: readonly number[];
			readonly at: number;
		};
		readonly gpuPid?: number;
	};
	frontmost: boolean;
	axAvailable: boolean;
	elements: AXTreeElement[];
	screenshotBase64: string;
	screenshotWidth: number;
	screenshotHeight: number;
	screenshotMimeType?: "image/png" | "image/jpeg";
	display: DisplayInfo;
	/** Every online display in global logical coordinates; undefined if inventory is unavailable. */
	displays?: readonly DisplayInventoryEntry[];
	/**
	 * Key of the observation these element ids came from. A caller that intends to act on an id
	 * passes this back so the driver can prove the ids are still the current observation rather
	 * than ones an earlier walk produced.
	 */
	observationKey?: string;
	/**
	 * Whether the accessibility tree or the screenshot is the more reliable
	 * perception channel for this screen ("ax" or "image"). When "image", the
	 * tree is sparse or image-dominated, so prefer the screenshot (vision).
	 */
	contentKind?: import("./content-kind.js").ContentKind;
	axChangeSummary?: AxTreeChangeSummary;
	/**
	 * True when `elements` was intentionally omitted from this result because a
	 * diff-only observation replaced the tree with {@link axChanges}. Consumers that
	 * need element ids must ask for a full observation.
	 */
	treeOmitted?: boolean;
	/**
	 * True when `elements` is empty because the caller asked for a capture-only observation
	 * (`includeAccessibilityTree: false`) rather than because the app exposed no tree. Consumers
	 * that need element ids must ask for a tree observation.
	 */
	treeSkipped?: boolean;
	/**
	 * True when `elements` is incomplete because the element budget was reached or descendants were omitted
	 * at the depth limit. Raise `max_elements` for budget truncation, or observe a subtree
	 * to explore descendants omitted at the depth limit.
	 */
	elementsTruncated?: boolean;
	/**
	 * The element-level diff from the previous `get_app_state` call for this app,
	 * present when a prior snapshot exists. Prefer this over re-reading the full
	 * `elements` tree when you only need to know what changed.
	 */
	axChanges?: AxTreeChanges;
	appInstructions?: string;
	/**
	 * Target window rect in global logical screen points, present when the
	 * screenshot is scoped to a single app window. Screenshot pixel coordinates
	 * map onto the screen through this rect.
	 */
	windowBounds?: { x: number; y: number; width: number; height: number };
	/** Display containing the observed window, when its global bounds intersect one. */
	windowDisplayId?: number;
	/** Displays intersecting the observed window, ordered by intersection area descending. */
	windowDisplayIds?: readonly number[];
	/** WindowServer id of the window this observation was scoped to. */
	windowId?: number;
	/** Title of that window, when the window server reports one. */
	windowTitle?: string;
	/**
	 * Every window of this app that input could target, present when there is more than one,
	 * so a caller can pick explicitly instead of relying on the driver's default choice.
	 */
	windowCandidates?: readonly WindowInventoryEntry[];
	/**
	 * The app answered accessibility with application elements where its windows should be, which
	 * is what a session without the physical console gets: window content cannot be read or acted
	 * on over accessibility, only the menu bar can. {@link ocrText} is the window read from pixels.
	 */
	windowContentUnavailable?: boolean;
	/** Text recognized in the window image with its screen frame, present when window content is unavailable. */
	ocrText?: readonly OcrTextEntry[];
	/**
	 * Why an observation that asked for an image carries none: the person's desktop is never captured
	 * (isolated-session-required), or this process lacks the Screen Recording permission and capturing
	 * anyway would raise macOS's permission prompt over the person's work.
	 */
	screenshotUnavailable?: "isolated-session-required" | "screen-recording-permission";
	/**
	 * Dialogs macOS itself has on screen (a permission request, a password sheet, a system alert).
	 * They belong to no app being driven, can block input or capture, and only the person can answer.
	 */
	systemPrompts?: readonly SystemPrompt[];
}

export interface OcrTextEntry {
	readonly text: string;
	readonly confidence: number;
	/** Screen frame in global logical points, the same space as element frames and click points. */
	readonly frame: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

export interface SkyshotResult {
	appState: AppState;
	captureTimestampMs: number;
}

export interface AppInfo {
	name: string;
	bundleId: string;
	pid: number;
	isRunning: boolean;
	isFrontmost?: boolean;
	lastUsedDate?: string;
	useCount?: number;
}
