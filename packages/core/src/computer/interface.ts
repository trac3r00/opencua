import type { AppInfo, AppState, OcrTextEntry } from "../accessibility/types.js";
import type {
	AppStateOptions,
	ComputerCapabilities,
	DragOptions,
	InputDelivery,
	KeyOptions,
	Point,
	PointerOptions,
	Rect,
	ScreenshotOptions,
	ScrollOptions,
	SelectTextOptions,
} from "../types/index.js";
import type { ScreenshotViewport } from "./viewport.js";

export interface ScreenshotResult {
	data: Buffer;
	mimeType: "image/png" | "image/jpeg";
	width: number;
	height: number;
}

/** Text read from the pixels of an app window, or why the pixels could not be read. */
export type WindowTextRead =
	| { readonly entries: readonly OcrTextEntry[] }
	| { readonly unavailable: "screen-recording-permission" | "no-window" | "recognition-failed" };

export interface ComputerInterface {
	readonly capabilities: ComputerCapabilities;
	/**
	 * How this computer delivers input: "attended" may lease the foreground for a targeted
	 * action, "background" posts to the target process without touching the frontmost app.
	 * Platforms that do not distinguish the two leave it undefined.
	 */
	readonly delivery?: InputDelivery;

	screenshot(options?: ScreenshotOptions): Promise<ScreenshotResult>;
	/**
	 * The app input goes to when no input scope names one (see withTargetedApp and runInInputScope). One value
	 * shared by every call, so it suits a single-action caller such as the CLI; calls that can overlap must aim
	 * their input through a scope instead.
	 */
	setTarget(pid?: number): void;
	move(position: Point): Promise<void>;
	click(position: Point, options?: PointerOptions): Promise<void>;
	rightClick(position: Point, options?: PointerOptions): Promise<void>;
	middleClick(position: Point, options?: PointerOptions): Promise<void>;
	doubleClick(position: Point, options?: PointerOptions): Promise<void>;
	type(text: string): Promise<void>;
	key(key: string, options?: KeyOptions): Promise<void>;
	scroll(options: ScrollOptions): Promise<void>;
	drag(options: DragOptions): Promise<void>;
	getCursorPosition(): Promise<Point>;
	getScreenSize(): Promise<{ width: number; height: number }>;
	getAppState(targetPid?: number, options?: AppStateOptions): Promise<AppState>;
	/**
	 * Refuses when `observationKey` is not the observation currently backing element ids for this
	 * app. Callers hold the key from the state whose ids they are about to use; this is what stops
	 * an index outliving the tree it was derived from and silently naming another control.
	 */
	assertObservationCurrent(targetPid: number, observationKey: string): void;
	/**
	 * Viewport that maps the most recent `get_app_state` window screenshot for
	 * `targetPid` onto global logical screen coordinates, or undefined when no
	 * window-scoped screenshot is available.
	 */
	getScreenshotViewport(targetPid: number): Promise<ScreenshotViewport | undefined>;
	listApps(): Promise<AppInfo[]>;
	/**
	 * Running apps with identity only (name, bundle id, pid, frontmost) and no usage enrichment.
	 * Name resolution needs nothing more, and enriching every app costs a spawned `mdls` per call.
	 * Always read fresh: a cached pid would name a recycled process. Callers fall back to
	 * {@link ComputerInterface.listApps} when an implementation does not provide it.
	 */
	listAppIdentities?(): Promise<AppInfo[]>;
	setValue(targetPid: number, elementIndex: number, value: string): Promise<void>;
	selectText(targetPid: number, elementIndex: number, options: SelectTextOptions): Promise<void>;
	performAction(targetPid: number, elementIndex: number, action: string): Promise<void>;
	pressAtPosition(targetPid: number, position: Point): Promise<boolean>;
	/**
	 * Screen frame (global logical points) of an element from the current observation, or
	 * undefined when it reports none. Lets an action fall back from an accessibility press the
	 * control does not support to a click at the control's centre instead of failing.
	 */
	elementFrame?(targetPid: number, elementIndex: number): Promise<Rect | undefined>;
	/** Whether this current observed element belongs to a live web accessibility subtree. */
	isWebElement?(targetPid: number, elementIndex: number): Promise<boolean>;
	/**
	 * Scroll an observed element into view through accessibility (AXScrollToVisible), with no pointer
	 * and no keyboard. Resolves to the element's settled on-screen frame (global logical points) and
	 * accepts its new position as its observed one; undefined when the element does not advertise the action.
	 */
	scrollElementIntoView?(targetPid: number, elementIndex: number): Promise<Rect | undefined>;
	/**
	 * The settled on-screen frame (global logical points) of an observed element that may have moved since it
	 * was observed, because its scroll area scrolled. Accepts the new position as its observed one, so actions
	 * on its id keep working. Reads just that element: no tree walk.
	 */
	refreshElementFrame?(targetPid: number, elementIndex: number): Promise<Rect | undefined>;
	/**
	 * Read the text of the observed window from a capture of it, frames in global logical points. Never
	 * triggers the Screen Recording prompt: without the permission it answers `unavailable`.
	 * With `region` (global logical points) only that part of the window, widened by a few points, is cut
	 * from the capture and recognised, so only text inside it comes back.
	 */
	recognizeWindowText?(targetPid: number, options?: { readonly region?: Rect }): Promise<WindowTextRead>;
	/** Show the drawn agent cursor at a point (it glides there); never moves the real pointer. */
	showPointerAt?(position: Point, press: boolean): void;
	typeIntoFocused(targetPid: number, text: string, options?: { readonly settleWrite?: boolean }): Promise<boolean>;
	close(): Promise<void>;
}
