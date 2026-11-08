import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { classifyContentKind } from "../accessibility/content-kind.js";
import { diffAxTreeChanges, diffAxTreesByKey } from "../accessibility/diff.js";
import { normalizeAxTree } from "../accessibility/normalize.js";
import type { AXTreeElement, AppInfo, AppState, DisplayInfo, DisplayInventoryEntry } from "../accessibility/types.js";
import type { OcrTextEntry, WindowInventoryEntry } from "../accessibility/types.js";
import { resolveAppInstructions } from "../app-instructions/index.js";
import { resolveDisplayMetadata } from "../computer/display-metadata.js";
import type { InputObservation, PreflightOptions, PreflightResult } from "../computer/guarded-interface.js";
import { denyHostInteraction } from "../computer/host-interaction-policy.js";
import { assertElementInInputRegion, assertFocusInInputRegion } from "../computer/input-region.js";
import { currentInputScope } from "../computer/input-scope.js";
import type { ComputerInterface, ScreenshotResult, WindowTextRead } from "../computer/interface.js";
import { assertScreenUnlocked } from "../computer/lock-guard.js";
import { type ScreenshotViewport, resolveWindowScreenshotSize, screenRectToScreenshot } from "../computer/viewport.js";
import type { AppApprovalStore } from "../permission/app-approval.js";
import { blockedUrl, browserUrlScript, isBrowserBundle } from "../permission/url-blocklist.js";
import type {
	AppStateOptions,
	DragOptions,
	KeyOptions,
	Point,
	PointerOptions,
	Rect,
	ScreenshotOptions,
	ScrollOptions,
	SelectTextOptions,
} from "../types/index.js";
import { type RunningAppInfo, collectAppUsage, getRunningMacOSApps } from "./app-list.js";
import { CursorKeyedObservations } from "./cursor-observations.js";
import { execFileStdout, execFileStdoutBuffer } from "./exec-util.js";
import { HostComputer, type HostComputerOptions } from "./host.js";
import { parseImageDimensions, sniffImageMimeType } from "./image-format.js";
import { InputLock } from "./input-lock.js";
import { type KeyboardFenceClock, awaitAccessibilityWriteSettled, awaitKeyboardFence } from "./keyboard-fence.js";
import {
	currentObservationKey,
	elementFrameByIndex,
	extractAccessibilityTree,
	focusedElementFrame,
	focusedWindowIdsForObservationPid,
	focusedWindowIsModal,
	focusedWindowShowsFilePanel,
	isWebElementByIndex,
	performActionByIndex,
	pressElementAtScreenPoint,
	rebaselineObservedElement,
	releaseAccessibilitySnapshot,
	releaseSnapshotsForExitedPids,
	relocatedElementFrame,
	scrollToVisibleByIndex,
	setValueByIndex,
	typeIntoFocusedAXElement,
	windowMinimizedForPid,
	windowTitlesForPid,
} from "./macos-ffi/accessibility.js";
import type { AccessibilityTreeOptions } from "./macos-ffi/accessibility.js";
import { createAxEventWaiter, waitForAxQuiet } from "./macos-ffi/ax-observer.js";
import {
	type CursorMotionConfig,
	cursorMotionFromEnvironment,
	parseCursorMotion,
} from "./macos-ffi/cursor-motion-config.js";
import { NOOP_POINTER_OVERLAY, type PointerOverlay } from "./macos-ffi/cursor-overlay.js";
import { onlineDisplayInfo } from "./macos-ffi/display-list.js";
import { isScreenLocked } from "./macos-ffi/lock-screen.js";
import { readClipboard, writeClipboard } from "./macos-ffi/pasteboard.js";
import { NOOP_DISPLAY_SLEEP } from "./macos-ffi/power.js";
import {
	captureDisplayImage,
	captureDisplayRegionImage,
	captureWindowImage,
	getMainDisplayId,
	getMainDisplayLogicalSize,
	getMainDisplayNativePixelSize,
	screenCaptureAllowed,
} from "./macos-ffi/screenshot.js";
import {
	replaceSelectionInFocusedTextElement,
	selectAllInFocusedTextElement,
	selectTextByIndex,
	selectedTextOfFocusedElement,
} from "./macos-ffi/select-text.js";
import type { SkyLightTargetWindow } from "./macos-ffi/skylight.js";
import { recognizeTextInImage } from "./macos-ffi/vision.js";
import { listWindows as listOwnedCandidateWindows } from "./macos-ffi/window-list.js";
import { MacOSInputController } from "./macos-input.js";
import type { InputDelivery } from "./macos-input.js";
import { currentOnscreenWindowIds, guardAgainstFocusSteal } from "./macos-input.js";
import {
	type BackgroundKeyPlan,
	type InvokeMenuResult,
	applicationIsFrontmost,
	commandChordMask,
	findMenuKeyEquivalent,
	invokeMenu,
	invokeWindowMenu,
	normalizeMenuPath,
	planBackgroundKeyEquivalent,
	pressMenuItem,
	waitForKeyEquivalentEnabled,
} from "./macos-menu.js";
import { observedWindowForPid, openWindowsForTargeting } from "./macos-open-windows.js";
import { selectSystemEventsTargetWindow } from "./macos-window-target-fallback.js";
import { resolveTargetWindow, visibleWindowsForPid } from "./macos-window-target.js";
import type { MacOSWindowInfo } from "./macos-window-target.js";
import { resolveOcrCrop } from "./ocr-region.js";
import { isOwnedSurfacePid, surfaceAudioState } from "./owned-surfaces.js";
import { currentSystemPrompts } from "./system-prompts.js";

const execFileAsync = promisify(execFile);

const FINDER_DESKTOP_BOUNDS_TIMEOUT_MILLISECONDS = 2_000;
const SYSTEM_PROFILER_TIMEOUT_MILLISECONDS = 10_000;
const SCREENSHOT_TIMEOUT_MILLISECONDS = 10_000;
const SCREENSHOT_MAX_BUFFER_BYTES = 100 * 1024 * 1024;
const DEFAULT_APP_STATE_SETTLE_MILLISECONDS = 300;
const WINDOW_APPEAR_WAIT_MILLISECONDS = 3_000;
const WINDOW_APPEAR_POLL_MILLISECONDS = 150;
const KEYBOARD_FENCE_CLOCK: KeyboardFenceClock = {
	now: () => performance.now(),
	sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};
/** Interval between accessibility-tree polls while waiting for the UI to settle. */
const UI_SETTLE_POLL_MILLISECONDS = 40;
/** How long accessibility must stay silent before the event-driven settle call returns. */
const AX_SETTLE_QUIET_MILLISECONDS = 60;
/** How often, and how many times, a scrolled-into-view element's frame is re-read until it holds still. */
const SCROLL_SETTLE_POLL_MILLISECONDS = 25;
const SCROLL_SETTLE_MAX_POLLS = 12;
/** Element budget for settle polls: enough to see the visible tree change, far cheaper to walk. */
const SETTLE_SIGNATURE_MAX_ELEMENTS = 250;

export interface MacOSHostComputerOptions extends HostComputerOptions {
	defaultTargetPid?: number;
	overlay?: PointerOverlay;
	/** Omit to use OPENCUA_CURSOR_MOTION; null keeps the original native glide. */
	readonly cursorMotion?: CursorMotionConfig | null | undefined;
	appApproval?: AppApprovalStore;
	urlBlocklist?: readonly string[];
	/**
	 * The shared host is observation-only. "attended" is rejected; "background" does not
	 * grant input capability. Mutations require an agent-owned isolated backend.
	 */
	delivery?: InputDelivery;
	/** Reports whether the Mac is locked. Defaults to the console session's lock flag. */
	isLocked?: () => boolean;
}

export class MacOSHostComputer extends HostComputer {
	readonly capabilities: ComputerInterface["capabilities"] = Object.freeze({
		supportsScreenshot: false,
		supportsInput: false,
		supportsAccessibility: true,
		supportsClipboard: false,
	});

	private readonly input: MacOSInputController;
	private readonly inputLock = new InputLock();
	private readonly lastViewportByPid = new Map<number, ScreenshotViewport>();
	private readonly lastAxTreeByPid = new Map<
		number,
		{ readonly elements: AXTreeElement[]; readonly truncated: boolean; readonly walkKey: string }
	>();
	private readonly observedAxPids = new Set<number>();
	private readonly appApproval: AppApprovalStore | undefined;
	readonly delivery: InputDelivery;
	private readonly urlBlocklist: readonly string[];
	private readonly overlay: PointerOverlay;
	private readonly displayId: number | undefined;
	private readonly highlightedApps = new Set<number>();
	private readonly inputObservations = new CursorKeyedObservations<InputObservation>((pid) => isOwnedSurfacePid(pid));
	private observationGeneration = 0;
	private readonly isLocked: () => boolean;

	constructor(options: MacOSHostComputerOptions = {}) {
		super();
		if (options.delivery === "attended") denyHostInteraction("global-input");
		this.appApproval = options.appApproval;
		this.delivery = options.delivery ?? "background";
		this.urlBlocklist = options.urlBlocklist ?? [];
		const cursorMotion =
			options.cursorMotion !== undefined ? parseCursorMotion(options.cursorMotion) : cursorMotionFromEnvironment();
		const cursorTravelEnabled = cursorMotion !== undefined;
		this.overlay = options.overlay ?? NOOP_POINTER_OVERLAY;
		this.isLocked = options.isLocked ?? isScreenLocked;
		this.input = new MacOSInputController(
			options.defaultTargetPid,
			this.overlay,
			this.isLocked,
			NOOP_DISPLAY_SLEEP,
			this.delivery,
			undefined,
			cursorTravelEnabled,
		);
		this.displayId = options.display;
	}

	setTarget(pid?: number): void {
		this.input.setTarget(pid);
	}

	async rememberTargetWindow(pid: number): Promise<void> {
		await this.input.rememberTargetWindow(pid);
	}

	async screenshot(options?: ScreenshotOptions): Promise<ScreenshotResult> {
		return this.captureScreenshot(options);
	}

	private async captureScreenshot(options?: ScreenshotOptions, windowId?: number): Promise<ScreenshotResult> {
		// Even an otherwise permitted host capture can raise macOS capture-consent UI.
		if (!this.capabilities.supportsScreenshot && !this.isOwnedWindow(windowId)) denyHostInteraction("host-window");
		if (!screenCaptureAllowed()) {
			throw new Error(
				"Screen Recording permission is not granted to the process running opencua, so no image was captured (capturing would raise macOS's permission prompt). Grant it in System Settings > Privacy & Security > Screen Recording to the app that launches this server, then restart the server.",
			);
		}
		const size = options?.targetSize ?? (await this.getScreenSize());
		if (options?.region !== undefined) {
			if (windowId !== undefined) {
				throw new Error("region capture cannot be combined with a window target; capture the window instead");
			}
			const region = captureDisplayRegionImage(
				this.displayId ?? getMainDisplayId(),
				options.region,
				size.width,
				size.height,
				options.format ?? "png",
				options.quality ?? 72,
			);
			return {
				data: region.data,
				mimeType: sniffImageMimeType(region.data),
				width: region.width,
				height: region.height,
			};
		}
		const data = await captureMacOSScreenshot(
			size,
			windowId,
			options?.format ?? "png",
			options?.quality ?? 72,
			this.displayId,
		);
		const dimensions = parseImageDimensions(data);
		return {
			data,
			mimeType: sniffImageMimeType(data),
			width: dimensions.width,
			height: dimensions.height,
		};
	}

	async move(position: Point): Promise<void> {
		this.assertInputAvailable();
		await this.pointerBurst(() => this.input.move(position));
	}

	async click(position: Point, options?: PointerOptions): Promise<void> {
		this.assertInputAvailable();
		await this.pointerBurst(() => this.input.click(position, "left", options?.modifiers), options?.modifiers);
	}

	async rightClick(position: Point, options?: PointerOptions): Promise<void> {
		this.assertInputAvailable();
		await this.inputLock.run(() => this.input.click(position, "right", options?.modifiers));
	}

	async middleClick(position: Point, options?: PointerOptions): Promise<void> {
		this.assertInputAvailable();
		await this.inputLock.run(() => this.input.click(position, "middle", options?.modifiers));
	}

	async doubleClick(position: Point, options?: PointerOptions): Promise<void> {
		this.assertInputAvailable();
		await this.pointerBurst(() => this.input.doubleClick(position, options?.modifiers), options?.modifiers);
	}

	async type(text: string): Promise<void> {
		this.assertInputAvailable();
		await this.inputLock.run(() => this.input.typeText(text));
	}

	async key(key: string, options?: KeyOptions): Promise<void> {
		this.assertInputAvailable();
		const pid = this.input.currentTargetPid;
		const modifiers = options?.modifiers ?? [];
		if (this.delivery === "background" && pid !== undefined && commandChordMask(modifiers) !== undefined) {
			await this.assertBackgroundFinderCommand(pid, { key, modifiers });
			await this.input.prepareKeyboardTarget();
			// A file panel owns its shortcuts. Looking up the app menu first turns
			// Go to Folder into commands such as Keynote's disabled Find Previous.
			if (focusedWindowShowsFilePanel(pid)) {
				await this.input.pressKey(key, options);
				return;
			}
			// Select All in a native text field is done on the field itself, which has taken effect when
			// this returns: text typed next always replaces the selection instead of racing a posted key.
			if (commandChordMask(modifiers) === 0 && key.toLowerCase() === "a" && this.selectAllInTextField(pid)) {
				return;
			}
			const item = findMenuKeyEquivalent(pid, key, modifiers);
			const plan = planBackgroundKeyEquivalent({
				// An app this driver told it is active reports itself frontmost while the person still uses
				// another app, so its chords are carried out the background way all the same.
				frontmost: applicationIsFrontmost(pid) && !this.input.holdsActivation(pid),
				key,
				modifiers,
				item,
			});
			const chord = { key, modifiers };
			if (plan.kind === "refuse" && item !== undefined) {
				await this.pressKeyEquivalent(pid, chord, item.path, plan.message);
				this.input.noteKeyboardInput(pid);
				return;
			}
			if (await this.runBackgroundKeyPlan(pid, plan, chord)) {
				if (plan.kind === "menu") {
					this.input.noteKeyboardInput(pid);
				}
				return;
			}
		}
		await this.input.pressKey(key, options);
	}

	/**
	 * Invoke a menu path. Edit > Select All, Copy, Cut and Paste are done on the focused native text
	 * field through accessibility: AppKit validates those items only while their menu is shown, so
	 * their AXEnabled flag says "disabled" even when the command would run, and pressing the item in a
	 * background app does nothing. Every other path is pressed as a menu item, for the window the app
	 * was last observed in: a menu command acts on the app's key window, and an app in the background is
	 * told it is active when that is what keeps the command disabled (see invokeWindowMenu).
	 */
	async invokeMenu(targetPid: number, path: readonly string[]): Promise<InvokeMenuResult> {
		this.assertInputAvailable(targetPid);
		const normalized = normalizeMenuPath(path);
		await this.assertBackgroundFinderCommand(targetPid, { path: normalized });
		const command = normalized.length === 2 && normalized[0] === "Edit" ? normalized[1] : undefined;
		if (command !== undefined) {
			const done = await this.editCommandOnTextField(targetPid, command);
			if (done) {
				this.input.showKeyboard();
				return { resolvedPath: normalized, action: "accessibility" };
			}
		}
		const window = this.observedWindow(targetPid);
		let result: InvokeMenuResult;
		if (window === undefined) {
			result = await invokeMenu(targetPid, normalized);
		} else {
			result = await invokeWindowMenu(targetPid, normalized, (disabled, run) =>
				this.input.withWindowCommand(targetPid, window, disabled, run),
			);
		}
		this.input.noteKeyboardInput(targetPid);
		return result;
	}

	private async assertBackgroundFinderCommand(
		pid: number,
		command: {
			readonly key?: string;
			readonly modifiers?: readonly string[];
			readonly path?: readonly string[];
		},
	): Promise<void> {
		if (this.delivery !== "background" || (applicationIsFrontmost(pid) && !this.input.holdsActivation(pid))) {
			return;
		}
		const chord =
			command.key?.toLowerCase() === "g" &&
			commandChordMask(command.modifiers ?? []) === commandChordMask(["shift", "cmd"]);
		if (!chord && command.path === undefined) {
			return;
		}
		const bundleId =
			this.inputObservations.get(pid)?.bundleId ??
			(await getRunningMacOSApps()).find((app) => app.pid === pid)?.bundleId;
		if (bundleId !== "com.apple.finder") {
			return;
		}
		const path = command.path;
		if (!chord && path !== undefined) {
			const equivalent = findMenuKeyEquivalent(pid, "g", ["shift", "cmd"])?.path;
			const matched =
				equivalent?.length === path.length && equivalent.every((segment, index) => segment === path[index]);
			const named =
				path.length === 2 && path[0] === "Go" && (path[1] === "Go to Folder…" || path[1] === "Go to Folder...");
			if (!matched && !named) {
				return;
			}
		}
		throw new Error(
			"Background command refused: Finder Go to Folder activates Finder and changes the person's front app. No key or menu action was sent. Call ask_user if the person needs to perform this command.",
		);
	}

	/** The window the latest observation of `pid` is scoped to: where window commands for the app are aimed. */
	private observedWindow(pid: number): SkyLightTargetWindow | undefined {
		const observation = this.inputObservations.get(pid);
		return observation === undefined ? undefined : { id: observation.windowId, bounds: observation.windowBounds };
	}

	/**
	 * Press the menu item a Command chord stands for, in an app behind the person's. macOS validates window
	 * commands against their app being active, and the enabled flags and titles an inactive app reports are
	 * only what it last validated, so the app is told it is active for the observed window and the item the
	 * chord names is pressed once it reads enabled (looked up again by its key, since re-validating can
	 * retitle it). `refusal` (given when the item read disabled) is raised with nothing sent when the app
	 * could not be told so (no observed window to aim at); an item that stays disabled even with the app
	 * told it is active is refused as well.
	 */
	private async pressKeyEquivalent(
		pid: number,
		chord: { readonly key: string; readonly modifiers: readonly string[] },
		path: readonly string[],
		refusal: string | undefined,
	): Promise<void> {
		const window = this.observedWindow(pid);
		let outcome: "pressed" | "not-held" | "still-disabled" = "not-held";
		if (window !== undefined) {
			outcome = await this.input.withWindowCommand(
				pid,
				window,
				() => true,
				async (held): Promise<"pressed" | "not-held" | "still-disabled"> => {
					if (!held) {
						return "not-held";
					}
					const enabled = await waitForKeyEquivalentEnabled(pid, chord.key, chord.modifiers);
					if (enabled === undefined) {
						return "still-disabled";
					}
					pressMenuItem(pid, enabled.path);
					return "pressed";
				},
			);
		}
		if (outcome === "not-held") {
			// The app was not told it is active: an item that read enabled is pressed as before, one that read
			// disabled is refused.
			if (refusal !== undefined) {
				throw new Error(refusal);
			}
			pressMenuItem(pid, path);
			return;
		}
		if (outcome === "still-disabled") {
			throw new Error(
				`${[...chord.modifiers, chord.key].join("+")} would do nothing: ${path.join(" > ")} stays disabled for this window even with the app told it is active, so no key was sent. Use set_value for text, or call ask_user if the person needs to run the command.`,
			);
		}
	}

	/** True when the Edit command ran on the focused native text field; false hands it to the menu. */
	private async editCommandOnTextField(pid: number, command: string): Promise<boolean> {
		switch (command) {
			case "Select All":
				return this.selectAllInTextField(pid);
			case "Copy":
			case "Cut": {
				const text = selectedTextOfFocusedElement(pid);
				if (text === undefined || text.length === 0) {
					return false;
				}
				writeClipboard({ type: "text", text });
				if (command === "Cut") {
					if (!replaceSelectionInFocusedTextElement(pid, "")) {
						return false;
					}
					await this.settleAccessibilityWrite(pid);
				}
				return true;
			}
			case "Paste": {
				const text = readClipboard().text;
				return text !== undefined && text.length > 0 && (await this.typeIntoFocused(pid, text));
			}
			default:
				return false;
		}
	}

	/**
	 * Select All on the focused native text field, except in a sheet or dialog: a Save panel's name
	 * field lives in another process, and there Cmd+A deliberately selects the name without its
	 * extension, which only the real key does.
	 */
	private selectAllInTextField(pid: number): boolean {
		return !focusedWindowIsModal(pid) && selectAllInFocusedTextElement(pid);
	}

	/** Carries out a Command chord for a background app; false hands the chord back to real key events. */
	private async runBackgroundKeyPlan(
		pid: number,
		plan: BackgroundKeyPlan,
		chord: { readonly key: string; readonly modifiers: readonly string[] },
	): Promise<boolean> {
		switch (plan.kind) {
			case "keys":
				return false;
			case "menu":
				await this.pressKeyEquivalent(pid, chord, plan.path, undefined);
				return true;
			case "select-all":
				if (this.selectAllInTextField(pid)) {
					return true;
				}
				throw new Error(
					"Select All would do nothing: the app is in the background, where Edit > Select All is disabled, and no native text field has focus to select through accessibility. Observe the app and use select_text or set_value on the field instead.",
				);
			case "copy-selection": {
				const text = selectedTextOfFocusedElement(pid);
				if (text === undefined || text.length === 0) {
					throw new Error(
						"Copy would do nothing: the app is in the background, where Edit > Copy is disabled, and no text is selected in a focused native text field to copy through accessibility.",
					);
				}
				writeClipboard({ type: "text", text });
				return true;
			}
			case "paste-text": {
				const text = readClipboard().text;
				// A native field takes the clipboard text at its selection; anything else (a web page) goes
				// back to the key path, which types the clipboard there for a background app.
				return text !== undefined && text.length > 0 && (await this.typeIntoFocused(pid, text));
			}
			case "refuse":
				throw new Error(plan.message);
		}
	}

	async scroll(options: ScrollOptions): Promise<void> {
		this.assertInputAvailable();
		await this.inputLock.run(() => this.input.scroll(options));
	}

	async drag(options: DragOptions): Promise<void> {
		this.assertInputAvailable();
		const burst = () => this.input.drag(options);
		await ((options.button ?? "left") === "left"
			? this.pointerBurst(burst, options.modifiers)
			: this.inputLock.run(burst));
	}

	/**
	 * Pointer input to an owned surface goes to that one process (its socket, or events posted to its pid), never to the
	 * shared event stream, so the cursors of different agents on one surface do not wait for each other's bursts.
	 * Held modifiers are process-wide flagsChanged events, so a burst that holds any stays under the shared lock, and
	 * right and middle clicks, which the surface socket does not carry, never leave it.
	 */
	private pointerBurst<T>(burst: () => Promise<T>, modifiers?: readonly string[]): Promise<T> {
		const pid = this.input.currentTargetPid;
		const ownLane = pid !== undefined && isOwnedSurfacePid(pid) && (modifiers?.length ?? 0) === 0;
		return ownLane ? burst() : this.inputLock.run(burst);
	}

	async getCursorPosition(): Promise<Point> {
		this.assertInputAvailable();
		return this.input.getCursorPosition();
	}

	async getScreenSize(): Promise<{ width: number; height: number }> {
		try {
			return getMainDisplayLogicalSize();
		} catch {
			return await getMacOSLogicalScreenSize();
		}
	}

	async getAppState(targetPid?: number, options?: AppStateOptions): Promise<AppState> {
		try {
			return await this.captureAppState(targetPid, options);
		} catch (error) {
			if (targetPid === undefined) {
				for (const pid of this.inputObservations.pids()) {
					this.invalidateInputObservation(pid);
				}
				this.inputObservations.clear();
			} else {
				this.invalidateInputObservation(targetPid);
			}
			throw error;
		}
	}

	/**
	 * Pick the window an observation is scoped to: an explicitly requested window, otherwise
	 * the app's focused window, otherwise whatever window enumeration reports. The chosen id
	 * travels back on the state so input can be checked against the same window instead of a
	 * fresh guess.
	 */
	private async describeWindowsForPid(
		pid: number,
		windows?: readonly MacOSWindowInfo[],
	): Promise<readonly WindowInventoryEntry[]> {
		try {
			let list = windows ?? (await openWindowsForTargeting());
			if (this.delivery === "background") {
				// Optional broader inventory must not erase windows already proven on this Space.
				list = await openWindowsForTargeting(undefined, { includeOffscreen: true }).catch(() => list);
			}
			const entries = visibleWindowsForPid(list, pid).map((window) => ({
				id: window.id,
				title: window.title ?? "",
				bounds: {
					x: Math.round(window.bounds.x),
					y: Math.round(window.bounds.y),
					width: Math.round(window.bounds.width),
					height: Math.round(window.bounds.height),
				},
			}));
			if (!entries.some((entry) => entry.title === "")) {
				return entries;
			}
			// The WindowServer hides titles from a process without Screen Recording; the app names its own windows.
			const titles = appWindowTitles(pid);
			return entries.map((entry) => (entry.title === "" ? { ...entry, title: titles.get(entry.id) ?? "" } : entry));
		} catch {
			return [];
		}
	}

	private async resolveObservationWindow(
		pid: number,
		requestedWindowId?: number,
		windows?: readonly MacOSWindowInfo[],
	): Promise<SkyLightTargetWindow | undefined> {
		if (requestedWindowId !== undefined) {
			return await this.input.rememberTargetWindow(pid, requestedWindowId, windows);
		}
		const { focusedWindowId, sheetOwnerWindowId } = focusedWindowIdsForObservationPid(pid);
		if (sheetOwnerWindowId !== undefined) {
			const ownerWindow = await this.input.rememberTargetWindow(pid, sheetOwnerWindowId, windows);
			if (ownerWindow !== undefined) {
				return ownerWindow;
			}
		}
		if (focusedWindowId !== undefined) {
			const focusedWindow = await this.input.rememberTargetWindow(pid, focusedWindowId, windows);
			if (focusedWindow !== undefined) {
				return focusedWindow;
			}
		}
		return await this.input.rememberTargetWindow(pid, undefined, windows);
	}

	private async captureAppState(targetPid?: number, options?: AppStateOptions): Promise<AppState> {
		// A locked Mac shows only the lock screen and hides every app window from accessibility, so an
		// observation would return a useless image and a whole-app tree. Stop with the ask instead.
		assertScreenUnlocked(this.isLocked());
		const settleMs = options?.settleMs ?? DEFAULT_APP_STATE_SETTLE_MILLISECONDS;
		const apps = await getRunningMacOSApps();
		releaseSnapshotsForExitedPids(apps.map((runningApp) => runningApp.pid));
		const app = resolveTargetApp(apps, targetPid);
		this.assertAppApproved(app);
		await this.assertBrowserUrlAllowed(app, options?.requireWindow === true);
		let windows = await openWindowsForTargeting();
		let targetWindow = await this.resolveObservationWindow(app.pid, options?.windowId, windows);
		// A window that was just opened (open_app, a new document, a reopened app) can take a moment to
		// reach the window server. Wait a bounded time for it instead of failing the first observation.
		const windowDeadline = Date.now() + WINDOW_APPEAR_WAIT_MILLISECONDS;
		while (options?.requireWindow === true && targetWindow === undefined && Date.now() < windowDeadline) {
			await new Promise((resolve) => setTimeout(resolve, WINDOW_APPEAR_POLL_MILLISECONDS));
			windows = await openWindowsForTargeting();
			targetWindow = await this.resolveObservationWindow(app.pid, options?.windowId, windows);
		}
		if (options?.requireWindow === true && targetWindow === undefined) {
			throw new Error(`No visible target window available for pid ${app.pid}`);
		}
		const windowInventory = await this.describeWindowsForPid(app.pid, windows);
		const listedTargetTitle = windowInventory.find((entry) => entry.id === targetWindow?.id)?.title;
		const nativeTargetTitle =
			targetWindow === undefined || (listedTargetTitle !== undefined && listedTargetTitle.length > 0)
				? undefined
				: observedWindowForPid(app.pid, targetWindow.id)?.title;
		const inventoryTitle =
			listedTargetTitle !== undefined && listedTargetTitle.length > 0
				? listedTargetTitle
				: nativeTargetTitle !== undefined && nativeTargetTitle !== null && nativeTargetTitle.length > 0
					? nativeTargetTitle
					: undefined;
		this.observedAxPids.add(app.pid);
		const walkOptions = {
			...(options?.maxElements === undefined ? {} : { maxElements: options.maxElements }),
			...(options?.includeMenuBar === undefined ? {} : { includeMenuBar: options.includeMenuBar }),
			...(targetWindow === undefined ? {} : { windowId: targetWindow.id }),
			...(options?.subtreeOf === undefined ? {} : { subtreeOf: options.subtreeOf }),
			...(options?.visibleOnly === true ? { visibleOnly: true } : {}),
		};
		const captureTree = options?.includeAccessibilityTree !== false;
		if (settleMs > 0 && captureTree) {
			await this.waitForUiSettle(app.pid, settleMs, walkOptions);
		}
		// Scope the screenshot to the target window at its own aspect ratio (capped),
		// so the model sees an undistorted window image and coordinates invert cleanly.
		// Without a target window, fall back to the full display.
		const size =
			options?.screenshotSize ??
			(targetWindow !== undefined ? resolveWindowScreenshotSize(targetWindow.bounds) : await this.getScreenSize());
		// The person's desktop is never captured, and without Screen Recording a capture would raise macOS's
		// permission prompt mid-task; observe the elements anyway and say why the image is missing.
		const screenshotUnavailable =
			options?.includeScreenshot === false
				? undefined
				: !this.capabilities.supportsScreenshot && !this.isOwnedWindow(targetWindow?.id)
					? ("isolated-session-required" as const)
					: screenCaptureAllowed()
						? undefined
						: ("screen-recording-permission" as const);
		const screenshot =
			options?.includeScreenshot === false || screenshotUnavailable !== undefined
				? { data: Buffer.alloc(0), mimeType: "image/png" as const, width: size.width, height: size.height }
				: await this.captureScreenshot({ targetSize: size, format: "jpeg" }, targetWindow?.id);
		const tree = captureTree ? extractAccessibilityTree(app.pid, walkOptions) : undefined;
		// WindowServer can hide titles without Screen Recording while the matched AX window still
		// exposes them. Use that observed title, not an unrelated window from an app-wide fallback.
		const targetWindowTitle = tree?.windowTitle ?? inventoryTitle;
		const displayInventory = onlineDisplayInfo();
		let windowCandidates: readonly WindowInventoryEntry[] | undefined;
		if (windowInventory.length > 1) {
			windowCandidates = windowInventory.map((window) => {
				let title = window.title;
				if (window.id === targetWindow?.id && targetWindowTitle !== undefined) {
					title = targetWindowTitle;
				}
				const windowDisplays = displaysForWindow(window.bounds, displayInventory);
				return {
					...window,
					title,
					...(windowDisplays[0] === undefined ? {} : { displayId: windowDisplays[0].id }),
					...(windowDisplays.length === 0 ? {} : { displayIds: windowDisplays.map(({ id }) => id) }),
				};
			});
		}
		const ocrText =
			tree?.windowContentUnavailable === true && targetWindow !== undefined
				? await this.readWindowText(screenshot, size, targetWindow)
				: undefined;
		const displays = displayInventory;
		const mainDisplayId = getMainDisplayId();
		const inventoryMainDisplay = displays?.find((candidate) => candidate.isMain === true);
		const displayMetadata = resolveDisplayInfo(mainDisplayId);
		const display = { ...displayMetadata, ...inventoryMainDisplay };
		const appInstructions = resolveAppInstructions(app.name, app.bundleId);
		const systemPrompts = currentSystemPrompts();

		let elements = tree?.elements ?? [];
		let windowBounds: ScreenshotViewport["windowBounds"] | undefined;
		if (targetWindow !== undefined) {
			const viewport: ScreenshotViewport = {
				windowBounds: { ...targetWindow.bounds },
				screenshotWidth: screenshot.width,
				screenshotHeight: screenshot.height,
			};
			this.lastViewportByPid.set(app.pid, viewport);
			windowBounds = viewport.windowBounds;
			elements = tree === undefined ? [] : remapElementFramesToScreenshot(tree.elements, viewport);
			if (this.capabilities.supportsInput && !this.highlightedApps.has(app.pid)) {
				this.highlightedApps.add(app.pid);
				this.overlay.highlight(viewport.windowBounds, app.pid);
			}
		} else {
			this.lastViewportByPid.delete(app.pid);
		}
		elements = normalizeAxTree(elements);
		const previousTree = this.lastAxTreeByPid.get(app.pid);
		const comparable = tree !== undefined && previousTree !== undefined && previousTree.walkKey === tree.walkKey;
		const axChangeSummary = comparable ? diffAxTreesByKey(previousTree.elements, elements) : undefined;
		const axChanges = comparable ? diffAxTreeChanges(previousTree.elements, elements) : undefined;
		if (tree !== undefined && options?.probe !== true) {
			this.lastAxTreeByPid.set(app.pid, { elements, truncated: tree.truncated, walkKey: tree.walkKey });
		}
		const contentKind =
			tree === undefined
				? undefined
				: classifyContentKind(elements, { width: screenshot.width, height: screenshot.height });
		const diffOnly = options?.diffOnly === true && previousTree !== undefined && tree !== undefined;
		const observationKey = currentObservationKey(app.pid);
		const windowDisplays = windowBounds === undefined ? [] : displaysForWindow(windowBounds, displays);
		const windowDisplayId = windowDisplays[0]?.id;

		const audio = isOwnedSurfacePid(app.pid) ? surfaceAudioState(app.pid) : undefined;
		const state: AppState = {
			app: app.name,
			bundleId: app.bundleId,
			pid: app.pid,
			...(audio === undefined ? {} : { audio }),
			frontmost: app.isActive,
			axAvailable: tree?.axAvailable ?? true,
			elements: diffOnly ? [] : elements,
			...(observationKey === undefined ? {} : { observationKey }),
			...(tree?.truncated === true ? { elementsTruncated: true } : {}),
			screenshotBase64: screenshot.data.toString("base64"),
			screenshotWidth: screenshot.width,
			screenshotHeight: screenshot.height,
			screenshotMimeType: screenshot.mimeType,
			display,
			...(displays === undefined ? {} : { displays }),
			...(contentKind === undefined ? {} : { contentKind }),
			...(tree === undefined ? { treeSkipped: true } : {}),
			...(axChangeSummary !== undefined ? { axChangeSummary } : {}),
			...(axChanges !== undefined ? { axChanges } : {}),
			...(diffOnly ? { treeOmitted: true } : {}),
			...(appInstructions !== undefined ? { appInstructions } : {}),
			...(windowBounds !== undefined ? { windowBounds } : {}),
			...(windowDisplayId === undefined ? {} : { windowDisplayId }),
			...(windowDisplays.length === 0 ? {} : { windowDisplayIds: windowDisplays.map(({ id }) => id) }),
			...(targetWindow !== undefined ? { windowId: targetWindow.id } : {}),
			...(targetWindowTitle !== undefined ? { windowTitle: targetWindowTitle } : {}),
			...(windowCandidates !== undefined ? { windowCandidates } : {}),
			...(tree?.windowContentUnavailable === true ? { windowContentUnavailable: true } : {}),
			...(ocrText !== undefined ? { ocrText } : {}),
			...(screenshotUnavailable === undefined ? {} : { screenshotUnavailable }),
			...(systemPrompts.length > 0 ? { systemPrompts } : {}),
		};
		if (targetWindow === undefined) {
			this.inputObservations.delete(app.pid);
		} else if (tree !== undefined && options?.probe !== true) {
			this.observationGeneration += 1;
			this.inputObservations.set(app.pid, {
				generation: this.observationGeneration,
				pid: app.pid,
				bundleId: app.bundleId,
				windowId: targetWindow.id,
				windowBounds: { ...targetWindow.bounds },
				screenshotViewport: {
					width: screenshot.width,
					height: screenshot.height,
					bounds: { ...targetWindow.bounds },
				},
				observedElementIds: new Set(elements.map((element) => element.id)),
			});
		}
		// The agent reads this observation next, so the overlay dot pulses until the next action.
		if (this.capabilities.supportsInput && options?.probe !== true) {
			this.input.showThinking();
		}
		return state;
	}

	/**
	 * Read the window from pixels when accessibility cannot reach its content, so an observation
	 * still says what is on screen instead of listing only the menu bar. Recognition failing is not
	 * an observation failure: the state then simply carries no text, as it would for a blank window.
	 */
	private async readWindowText(
		screenshot: { readonly data: Buffer; readonly width: number; readonly height: number },
		size: { readonly width: number; readonly height: number },
		window: SkyLightTargetWindow,
		region?: Rect,
	): Promise<readonly OcrTextEntry[] | undefined> {
		try {
			const image =
				screenshot.data.byteLength > 0
					? screenshot
					: await this.captureScreenshot({ targetSize: size, format: "jpeg" }, window.id);
			const scaleX = window.bounds.width / image.width;
			const scaleY = window.bounds.height / image.height;
			// Only the searched region reaches Vision; boxes come back in whole-image pixels, so the mapping below
			// is the same with or without a region.
			const crop = region === undefined ? undefined : resolveOcrCrop(region, window.bounds, image);
			if (region !== undefined && crop === undefined) {
				return [];
			}
			const recognized = recognizeTextInImage(image.data, crop === undefined ? {} : { region: crop });
			return recognized.map((observation) => ({
				text: observation.text,
				confidence: observation.confidence,
				frame: {
					x: Math.round(window.bounds.x + observation.box.x * scaleX),
					y: Math.round(window.bounds.y + observation.box.y * scaleY),
					width: Math.round(observation.box.width * scaleX),
					height: Math.round(observation.box.height * scaleY),
				},
			}));
		} catch {
			return undefined;
		}
	}

	private async assertBrowserUrlAllowed(app: RunningAppInfo, requireUrl: boolean): Promise<void> {
		if (this.urlBlocklist.length === 0 || !isBrowserBundle(app.bundleId)) {
			return;
		}
		const url = await readCurrentBrowserUrl(app.bundleId);
		if (url === undefined) {
			if (requireUrl) {
				throw new Error("Computer Use cannot verify the current browser URL.");
			}
			return;
		}
		if (blockedUrl(url, this.urlBlocklist)) {
			throw new Error(`Computer Use is not allowed on the current browser URL: ${url}`);
		}
	}

	private assertAppApproved(app: RunningAppInfo): void {
		if (this.appApproval === undefined) {
			return;
		}
		const decision = this.appApproval.decide(app.bundleId);
		if (decision === "denied") {
			throw new Error(`Computer Use is not allowed to use the app '${app.name}'.`);
		}
		if (decision === "needs-approval") {
			throw new Error(`Computer Use needs your approval to use '${app.name}'. Approve the app and try again.`);
		}
	}

	/** The person's own apps stay refused; only windows opencua launched itself take host input. */
	private assertInputAvailable(targetPid: number | undefined = this.input.currentTargetPid): void {
		if (this.capabilities.supportsInput || (targetPid !== undefined && isOwnedSurfacePid(targetPid))) return;
		denyHostInteraction("host-window");
	}

	private isOwnedWindow(windowId: number | undefined): boolean {
		if (windowId === undefined) return false;
		const window = listOwnedCandidateWindows()?.find((candidate) => candidate.id === windowId);
		return window !== undefined && isOwnedSurfacePid(window.ownerPid);
	}

	/**
	 * Wait for the target app's UI to stop changing before capturing state, instead of
	 * sleeping a fixed duration. Polls the accessibility tree and returns as soon as two
	 * consecutive snapshots are identical (the UI has settled) or the `settleMs` cap
	 * elapses, whichever comes first. This is the ChatGPT computer-use "skyshot settle"
	 * technique: faster when the UI is already stable, more robust when it is still moving.
	 */
	private async waitForUiSettle(pid: number, settleMs: number, walkOptions: AccessibilityTreeOptions): Promise<void> {
		if (settleMs <= 0) {
			return;
		}
		// Accessibility notifications say when the app changes, so the common "nothing moved"
		// case costs one quiet window instead of repeated signature walks, and changes past the
		// signature cap are still noticed. Polling stays as the fallback when the observer is
		// unavailable, and remains the source of truth whenever no notifications arrive.
		const waiter = createAxEventWaiter(pid);
		if (waiter !== null) {
			try {
				waitForAxQuiet(waiter, {
					quietMs: AX_SETTLE_QUIET_MILLISECONDS,
					deadlineMs: settleMs,
					now: () => Date.now(),
				});
				return;
			} finally {
				waiter.release();
			}
		}

		// Stability only needs the shape of the visible tree, so each poll walks a capped
		// slice instead of the whole window; the observation that follows is a full walk.
		const signatureOptions: AccessibilityTreeOptions = {
			...walkOptions,
			maxElements: SETTLE_SIGNATURE_MAX_ELEMENTS,
			signatureOnly: true,
		};
		const deadline = Date.now() + settleMs;
		let previous = normalizeAxTree(extractAccessibilityTree(pid, signatureOptions).elements);
		// Poll until the tree is stable across two consecutive reads, or the cap elapses.
		while (Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, UI_SETTLE_POLL_MILLISECONDS));
			const current = normalizeAxTree(extractAccessibilityTree(pid, signatureOptions).elements);
			const change = diffAxTreesByKey(previous, current);
			if (change.added === 0 && change.removed === 0 && change.changed === 0) {
				return;
			}
			previous = current;
		}
	}

	assertObservationCurrent(targetPid: number, observationKey: string): void {
		const current = currentObservationKey(targetPid);
		if (current === undefined || current !== observationKey) {
			throw new Error(
				"the observation these element ids came from is no longer the current one; call get_app_state again before acting",
			);
		}
	}

	async getScreenshotViewport(targetPid: number): Promise<ScreenshotViewport | undefined> {
		const stored = this.lastViewportByPid.get(targetPid);
		if (stored !== undefined) {
			return stored;
		}
		// No prior get_app_state this session: derive a viewport from the current
		// target window so a click still maps onto the right screen region.
		const targetWindow = await this.input.rememberTargetWindow(targetPid);
		if (targetWindow === undefined) {
			return undefined;
		}
		const size = resolveWindowScreenshotSize(targetWindow.bounds);
		return {
			windowBounds: { ...targetWindow.bounds },
			screenshotWidth: size.width,
			screenshotHeight: size.height,
		};
	}

	async listAppIdentities(): Promise<AppInfo[]> {
		const running = await getRunningMacOSApps();
		return running.map((app) => ({
			bundleId: app.bundleId,
			name: app.name,
			pid: app.pid,
			isRunning: true,
			isFrontmost: app.isActive,
		}));
	}

	async listAppIdentitiesForOpen(): Promise<AppInfo[]> {
		return this.listAppIdentities();
	}

	async listApps(): Promise<AppInfo[]> {
		const running = await getRunningMacOSApps();
		const usage = await collectAppUsage(running.map((app) => app.path).filter((path) => path.length > 0));
		return running.map((app) => {
			const appUsage = usage.get(app.path) ?? {};
			return {
				bundleId: app.bundleId,
				name: app.name,
				pid: app.pid,
				isRunning: true,
				isFrontmost: app.isActive,
				...(appUsage.lastUsedDate !== undefined ? { lastUsedDate: appUsage.lastUsedDate } : {}),
				...(appUsage.useCount !== undefined ? { useCount: appUsage.useCount } : {}),
			};
		});
	}

	async setValue(targetPid: number, elementIndex: number, value: string): Promise<void> {
		this.assertInputAvailable(targetPid);
		assertElementInInputRegion(
			() => elementFrameByIndex(targetPid, elementIndex),
			`set_value on element ${elementIndex}`,
		);
		this.showElement(targetPid, elementIndex, false);
		setValueByIndex(targetPid, elementIndex, value);
		this.input.showKeyboard();
		await this.settleAccessibilityWrite(targetPid);
	}

	async selectText(targetPid: number, elementIndex: number, options: SelectTextOptions): Promise<void> {
		this.assertInputAvailable(targetPid);
		assertElementInInputRegion(
			() => elementFrameByIndex(targetPid, elementIndex),
			`select_text on element ${elementIndex}`,
		);
		this.showElement(targetPid, elementIndex, false);
		selectTextByIndex(targetPid, elementIndex, options);
		this.input.showKeyboard();
	}

	async performAction(targetPid: number, elementIndex: number, action: string): Promise<void> {
		if (this.delivery === "background" && action === "AXRaise") {
			throw new Error("AXRaise requires foreground delivery; refusing to raise a window over the user's work");
		}
		this.assertInputAvailable(targetPid);
		assertElementInInputRegion(
			() => elementFrameByIndex(targetPid, elementIndex),
			`${action} on element ${elementIndex}`,
		);
		this.showElement(targetPid, elementIndex, !action.startsWith("AXScroll"), action.startsWith("AXScroll"));
		// Pressing or focusing an element can make its app activate itself (Safari does for a web
		// field); background delivery hands the front back to the person's app when that happens.
		const observation = this.inputObservations.get(targetPid);
		if (this.delivery === "background" && observation !== undefined) {
			const window = { id: observation.windowId, bounds: observation.windowBounds };
			guardAgainstFocusSteal(window);
			const element = this.lastAxTreeByPid.get(targetPid)?.elements.find((item) => item.id === elementIndex);
			const opensMenu =
				action === "AXShowMenu" ||
				(action === "AXPress" && (element?.role === "AXPopUpButton" || element?.role === "AXMenuButton"));
			if (opensMenu) {
				// AppKit accepts popup actions while inactive but does not show them. Hold only this app
				// active behind the person's app, just as a background pointer gesture does.
				await this.input.withWindowCommand(
					targetPid,
					window,
					() => true,
					async () => {
						performActionByIndex(targetPid, elementIndex, action);
					},
				);
				this.input.showKeyboard();
				return;
			}
		}
		performActionByIndex(targetPid, elementIndex, action);
		if (action === "AXPress" || action === "AXShowMenu") {
			this.input.showKeyboard();
		}
	}

	async isWebElement(targetPid: number, elementIndex: number): Promise<boolean> {
		return isWebElementByIndex(targetPid, elementIndex);
	}

	async pressAtPosition(targetPid: number, position: Point): Promise<boolean> {
		this.assertInputAvailable(targetPid);
		this.input.showPointer(position, true, targetPid);
		// A press inside a dispatch bound to an observed window only takes an element of that window.
		const target = currentInputScope()?.target;
		const windowId = target?.pid === targetPid ? target.windowId : undefined;
		return pressElementAtScreenPoint(targetPid, position.x, position.y, windowId);
	}

	/**
	 * Accessibility routes act without any pointer, so the overlay dot is moved to the element's
	 * centre first to keep every action visible. The frame lookup is display only: when it fails the
	 * action still runs and reports its own error, so a lookup failure is not surfaced here.
	 */
	private showElement(targetPid: number, elementIndex: number, press: boolean, scroll = false): void {
		let frame: Rect | undefined;
		try {
			frame = elementFrameByIndex(targetPid, elementIndex);
		} catch {
			return;
		}
		if (frame !== undefined && frame.width > 0 && frame.height > 0) {
			const position = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
			if (scroll) {
				this.input.showScrollPointer(position, targetPid);
			} else {
				this.input.showPointer(position, press, targetPid);
			}
		}
	}

	async elementFrame(targetPid: number, elementIndex: number): Promise<Rect | undefined> {
		return elementFrameByIndex(targetPid, elementIndex);
	}

	async scrollElementIntoView(targetPid: number, elementIndex: number): Promise<Rect | undefined> {
		this.assertInputAvailable(targetPid);
		assertElementInInputRegion(
			() => elementFrameByIndex(targetPid, elementIndex),
			`scroll-to-visible on element ${elementIndex}`,
		);
		if (!scrollToVisibleByIndex(targetPid, elementIndex)) {
			return undefined;
		}
		return await this.refreshElementFrame(targetPid, elementIndex);
	}

	async refreshElementFrame(targetPid: number, elementIndex: number): Promise<Rect | undefined> {
		// Some apps animate a scroll: wait for the frame to hold still before trusting it.
		let frame = relocatedElementFrame(targetPid, elementIndex);
		for (let poll = 0; poll < SCROLL_SETTLE_MAX_POLLS; poll += 1) {
			await new Promise((resolve) => setTimeout(resolve, SCROLL_SETTLE_POLL_MILLISECONDS));
			const next = relocatedElementFrame(targetPid, elementIndex);
			const held = frame !== undefined && next !== undefined && sameRect(frame, next);
			frame = next;
			if (held) {
				break;
			}
		}
		rebaselineObservedElement(targetPid, elementIndex);
		return frame;
	}

	async recognizeWindowText(targetPid: number, options?: { readonly region?: Rect }): Promise<WindowTextRead> {
		if (!this.capabilities.supportsScreenshot && !isOwnedSurfacePid(targetPid)) {
			return { unavailable: "isolated-session-required" };
		}
		if (!screenCaptureAllowed()) {
			return { unavailable: "screen-recording-permission" };
		}
		const window = await this.resolveObservationWindow(targetPid, this.inputObservations.get(targetPid)?.windowId);
		if (window === undefined) {
			return { unavailable: "no-window" };
		}
		const size = resolveWindowScreenshotSize(window.bounds);
		const entries = await this.readWindowText(
			{ data: Buffer.alloc(0), width: size.width, height: size.height },
			size,
			window,
			options?.region,
		);
		return entries === undefined ? { unavailable: "recognition-failed" } : { entries };
	}

	showPointerAt(position: Point, press: boolean): void {
		this.assertInputAvailable();
		this.input.showPointer(position, press);
	}

	async typeIntoFocused(
		targetPid: number,
		text: string,
		options?: { readonly settleWrite?: boolean },
	): Promise<boolean> {
		this.assertInputAvailable();
		// Keys posted just before (Cmd+A) still wait in the app's event queue, while this write lands at
		// once: without the fence the text lands at the old caret instead of replacing the selection.
		await awaitKeyboardFence(
			this.input.lastKeyboardInputAt(targetPid),
			() => createAxEventWaiter(targetPid),
			KEYBOARD_FENCE_CLOCK,
		);
		// In a sheet or dialog (a Save panel, whose UI is hosted by another process), the element
		// accessibility calls focused can differ from where keys really go (its Go to Folder field), so
		// real key events are the route that types where the user would.
		if (focusedWindowIsModal(targetPid)) {
			return false;
		}
		const focused = focusedElementFrame(targetPid);
		if (focused !== undefined && focused.width > 0 && focused.height > 0) {
			this.input.showPointer({ x: focused.x + focused.width / 2, y: focused.y + focused.height / 2 }, false);
		}
		// Checked after the fence, right before the write: focus may have moved while it waited.
		assertFocusInInputRegion(() => focusedElementFrame(targetPid));
		if (!typeIntoFocusedAXElement(targetPid, text)) {
			return false;
		}
		this.input.showKeyboard();
		if (options?.settleWrite !== false) {
			await this.settleAccessibilityWrite(targetPid);
		}
		return true;
	}

	/**
	 * A text write over accessibility returns before the app has taken it in (TextEdit marks the
	 * document edited ~100 ms later); a key posted meanwhile acts on the old state. Wait for the app's
	 * own change notifications, bounded, so the next action sees the write.
	 */
	private async settleAccessibilityWrite(targetPid: number): Promise<void> {
		await awaitAccessibilityWriteSettled(() => createAxEventWaiter(targetPid), KEYBOARD_FENCE_CLOCK);
	}

	getInputObservation(targetPid: number): InputObservation | undefined {
		return this.inputObservations.get(targetPid);
	}

	private invalidateInputObservation(targetPid: number): void {
		this.inputObservations.delete(targetPid);
		releaseAccessibilitySnapshot(targetPid);
	}

	async preflightInput(expected: InputObservation, options?: PreflightOptions): Promise<PreflightResult> {
		if (!this.capabilities.supportsInput && !(expected !== undefined && isOwnedSurfacePid(expected.pid))) {
			return { ok: false, reason: "isolated-session-required" };
		}
		const stored = this.inputObservations.get(expected.pid);
		if (stored === undefined || !sameObservation(stored, expected)) {
			return { ok: false, reason: "observation-replaced" };
		}

		let apps: readonly RunningAppInfo[];
		try {
			apps = await getRunningMacOSApps();
		} catch (error) {
			if (error instanceof Error) {
				return { ok: false, reason: "app-not-frontmost" };
			}
			throw error;
		}
		const app = apps.find((candidate) => candidate.pid === expected.pid);
		// Background delivery routes every action to the target process, so a window the user is
		// not looking at is a legal target and the refusal would defeat the mode. Attended delivery
		// may still take focus, so it keeps requiring the frontmost app.
		if (app === undefined || (!app.isActive && this.delivery !== "background")) {
			return { ok: false, reason: "app-not-frontmost" };
		}
		if (app.bundleId !== expected.bundleId) {
			return { ok: false, reason: "observation-replaced" };
		}
		if (this.appApproval?.decide(app.bundleId) !== "approved") {
			return { ok: false, reason: "app-not-approved" };
		}

		if (this.urlBlocklist.length > 0 && isBrowserBundle(app.bundleId)) {
			const url = await readCurrentBrowserUrl(app.bundleId);
			if (url === undefined) {
				return { ok: false, reason: "url-unavailable" };
			}
			if (blockedUrl(url, this.urlBlocklist)) {
				return { ok: false, reason: "url-blocked" };
			}
		}

		let targetWindow: Awaited<ReturnType<typeof queryVisibleTargetWindow>>;
		try {
			targetWindow = await queryVisibleTargetWindow(expected.pid, expected.windowId, this.delivery === "background");
		} catch (error) {
			if (error instanceof Error) {
				return { ok: false, reason: "window-missing" };
			}
			throw error;
		}
		const current = this.inputObservations.get(expected.pid);
		if (current === undefined || !sameObservation(current, expected)) {
			return { ok: false, reason: "observation-replaced" };
		}
		if (this.appApproval?.decide(app.bundleId) !== "approved") {
			return { ok: false, reason: "app-not-approved" };
		}
		if (targetWindow === undefined) {
			const otherWindows = await queryVisibleWindowsForPid(expected.pid, this.delivery === "background");
			return { ok: false, reason: otherWindows.length > 0 ? "window-changed" : "window-missing" };
		}
		if (targetWindow.id !== expected.windowId) {
			return { ok: false, reason: "window-changed" };
		}
		if (options?.requireSameBounds !== false && !sameRect(targetWindow.bounds, expected.windowBounds)) {
			return { ok: false, reason: "window-bounds-changed" };
		}
		return { ok: true };
	}

	async close(): Promise<void> {
		try {
			this.input.close();
		} finally {
			this.inputObservations.clear();
			for (const pid of this.observedAxPids) {
				releaseAccessibilitySnapshot(pid);
			}
			this.observedAxPids.clear();
		}
	}
}

/** The app's own titles for its windows; an app that cannot answer leaves them untitled. */
function appWindowTitles(pid: number): ReadonlyMap<number, string> {
	try {
		return windowTitlesForPid(pid);
	} catch {
		return new Map();
	}
}

async function queryVisibleTargetWindow(pid: number, windowId?: number, allowOffscreen = false) {
	let windows = await openWindowsForTargeting();
	const onscreen = currentOnscreenWindowIds();
	if (windowId !== undefined) {
		let requested = resolveTargetWindow(windows, pid, onscreen, undefined, windowId);
		if (requested.kind !== "resolved" && allowOffscreen) {
			windows = await openWindowsForTargeting(undefined, { includeOffscreen: true });
			requested = resolveTargetWindow(windows, pid, onscreen, undefined, windowId, { allowOffscreen: true });
		}
		if (requested.kind !== "resolved") {
			return undefined;
		}
		if (allowOffscreen && !onscreen?.includes(windowId) && windowMinimizedForPid(pid, windowId) !== false) {
			return undefined;
		}
		return requested.window;
	}
	const resolution = resolveTargetWindow(windows, pid, onscreen);
	return resolution.kind === "resolved" ? resolution.window : await selectSystemEventsTargetWindow(windows, pid);
}

async function queryVisibleWindowsForPid(pid: number, includeOffscreen = false) {
	try {
		const current = visibleWindowsForPid(await openWindowsForTargeting(), pid);
		if (current.length > 0 || !includeOffscreen) {
			return current;
		}
		return visibleWindowsForPid(await openWindowsForTargeting(undefined, { includeOffscreen: true }), pid);
	} catch {
		return [];
	}
}

async function readCurrentBrowserUrl(bundleId: string): Promise<string | undefined> {
	const script = browserUrlScript(bundleId);
	if (script === undefined) {
		return undefined;
	}
	try {
		const result = await execFileAsync("osascript", ["-e", script], {
			encoding: "utf8",
			timeout: FINDER_DESKTOP_BOUNDS_TIMEOUT_MILLISECONDS,
		});
		const url = execFileStdout(result).trim();
		return url.length === 0 ? undefined : url;
	} catch (error) {
		if (error instanceof Error) {
			return undefined;
		}
		throw error;
	}
}

function sameObservation(left: InputObservation, right: InputObservation): boolean {
	return (
		left.generation === right.generation &&
		left.pid === right.pid &&
		left.bundleId === right.bundleId &&
		left.windowId === right.windowId &&
		sameRect(left.windowBounds, right.windowBounds) &&
		left.screenshotViewport.width === right.screenshotViewport.width &&
		left.screenshotViewport.height === right.screenshotViewport.height &&
		sameRect(left.screenshotViewport.bounds, right.screenshotViewport.bounds) &&
		sameNumberSet(left.observedElementIds, right.observedElementIds)
	);
}

/** The drawn agent cursor is on unless OPENCUA_CURSOR turns it off (off, 0, false, no). */
export function agentCursorEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
	const value = environment["OPENCUA_CURSOR"]?.trim().toLowerCase();
	return !(value === "off" || value === "0" || value === "false" || value === "no");
}

function sameRect(left: Rect, right: Rect): boolean {
	return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}

function sameNumberSet(left: ReadonlySet<number>, right: ReadonlySet<number>): boolean {
	if (left.size !== right.size) {
		return false;
	}
	for (const value of left) {
		if (!right.has(value)) {
			return false;
		}
	}
	return true;
}

export async function getMacOSLogicalScreenSize(): Promise<{ width: number; height: number }> {
	const finderSize = await getFinderDesktopBounds().catch(() => undefined);
	if (finderSize !== undefined) {
		return finderSize;
	}

	const result = await execFileAsync("system_profiler", ["SPDisplaysDataType"], {
		encoding: "utf8",
		timeout: SYSTEM_PROFILER_TIMEOUT_MILLISECONDS,
	});
	const stdout = execFileStdout(result);
	const systemProfilerSize = parseSystemProfilerLogicalScreenSize(stdout);
	if (systemProfilerSize === undefined) {
		throw new Error("Failed to parse logical screen size from system_profiler output");
	}
	return systemProfilerSize;
}

export async function captureMacOSScreenshot(
	targetSize: {
		readonly width: number;
		readonly height: number;
	},
	windowId?: number,
	format: "png" | "jpeg" = "png",
	quality = 72,
	displayId?: number,
): Promise<Buffer> {
	if (!Number.isSafeInteger(targetSize.width) || !Number.isSafeInteger(targetSize.height)) {
		throw new Error("requested screenshot dimensions must be integers");
	}
	if (targetSize.width <= 0 || targetSize.height <= 0) {
		throw new Error("requested screenshot dimensions must be positive");
	}
	if (windowId !== undefined && (!Number.isSafeInteger(windowId) || windowId <= 0)) {
		throw new Error("windowId must be a positive integer");
	}

	if (windowId === undefined) {
		const captured = captureDisplayImage(
			displayId ?? getMainDisplayId(),
			targetSize.width,
			targetSize.height,
			format,
			quality,
		);
		parseImageDimensions(captured.data);
		return captured.data;
	}

	return await captureWindowScreenshot(targetSize, windowId, format, quality);
}

const CAPTURE_FAILURE_MARKERS = {
	sckitLibraryMissing: "libsckit.dylib not found", // macos-ffi/sckit.ts:54
	screenRecordingPermissionMissing: "Screen Recording permission is not granted", // macos.ts:155
	windowCaptureFailed: "Native ScreenCaptureKit window capture failed", // macos-ffi/sckit.ts:176; native NULL at native/sckit.m:543-553,617-622
};

/**
 * Classifies errors emitted by the window-capture adapter. Its native NULL failure is retryable;
 * unrecognized errors retain the shell fallback behavior.
 */
export function classifyCaptureFailure(error: unknown): "unavailable" | "transient" {
	const message = error instanceof Error ? error.message : String(error);
	if (message.includes(CAPTURE_FAILURE_MARKERS.windowCaptureFailed)) {
		return "transient";
	}
	return "unavailable";
}

/**
 * Prefer in-process ScreenCaptureKit for a single window: it captures the window's own
 * pixels even when occluded, and avoids the two subprocesses (screencapture + sips) plus
 * their temporary files. Known unavailable cases use the existing shell fallback.
 */
async function captureWindowScreenshot(
	targetSize: { readonly width: number; readonly height: number },
	windowId: number,
	format: "png" | "jpeg",
	quality: number,
): Promise<Buffer> {
	try {
		const captured = captureWindowImage(windowId, targetSize.width, targetSize.height, format, quality);
		parseImageDimensions(captured.data);
		return captured.data;
	} catch (error) {
		if (classifyCaptureFailure(error) !== "transient") {
			return await captureWindowScreenshotViaCli(targetSize, windowId, format, quality);
		}
		try {
			const retried = captureWindowImage(windowId, targetSize.width, targetSize.height, format, quality);
			parseImageDimensions(retried.data);
			return retried.data;
		} catch {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`window capture failed (transient): ${message}`);
		}
	}
}

async function captureWindowScreenshotViaCli(
	targetSize: { readonly width: number; readonly height: number },
	windowId: number,
	format: "png" | "jpeg",
	quality: number,
): Promise<Buffer> {
	const captureCommand = `screencapture -x -o -l ${windowId} -t png "$tmp"`;
	const resizeCommand =
		format === "jpeg"
			? 'sips -s format jpeg -s formatOptions "$4" -z "$2" "$1" "$tmp" --out "$out" >/dev/null'
			: 'sips -z "$2" "$1" "$tmp" --out "$out" >/dev/null';
	const script = [
		"set -eu",
		'tmp=$(mktemp "${TMPDIR:-/tmp}/opencua-shot.XXXXXX")',
		'out=""',
		'cleanup() { rm -f "$tmp"; if [ -n "$out" ]; then rm -f "$out"; fi; }',
		"trap cleanup EXIT",
		captureCommand,
		'out=$(mktemp "${TMPDIR:-/tmp}/opencua-shot-resized.XXXXXX")',
		resizeCommand,
		'cat "$out"',
	].join("\n");
	const result = await execFileAsync(
		"sh",
		[
			"-c",
			script,
			"opencua-screenshot",
			String(targetSize.width),
			String(targetSize.height),
			format,
			String(Math.max(1, Math.min(100, Math.round(quality)))),
		],
		{
			encoding: "buffer",
			maxBuffer: SCREENSHOT_MAX_BUFFER_BYTES,
			timeout: SCREENSHOT_TIMEOUT_MILLISECONDS,
		},
	);
	const data = execFileStdoutBuffer(result);
	parseImageDimensions(data);
	return data;
}

async function getFinderDesktopBounds(): Promise<{ width: number; height: number }> {
	const result = await execFileAsync(
		"osascript",
		["-e", 'tell application "Finder" to get bounds of window of desktop'],
		{
			encoding: "utf8",
			timeout: FINDER_DESKTOP_BOUNDS_TIMEOUT_MILLISECONDS,
		},
	);
	const bounds = parseFinderDesktopBounds(execFileStdout(result));
	if (bounds === undefined) {
		throw new Error("Failed to parse Finder desktop bounds");
	}
	return bounds;
}

function parseFinderDesktopBounds(output: string): { width: number; height: number } | undefined {
	const match = output.match(
		/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/,
	);
	if (match === null) {
		return undefined;
	}
	const left = finiteNumber(match[1]);
	const top = finiteNumber(match[2]);
	const right = finiteNumber(match[3]);
	const bottom = finiteNumber(match[4]);
	if (left === undefined || top === undefined || right === undefined || bottom === undefined) {
		return undefined;
	}
	return positiveSize(right - left, bottom - top);
}

export function parseSystemProfilerLogicalScreenSize(output: string): { width: number; height: number } | undefined {
	const uiLooksLike = parseFirstSize(output, /UI Looks like:\s*(\d+)\s*[x×]\s*(\d+)/i);
	if (uiLooksLike !== undefined) {
		return uiLooksLike;
	}

	const resolutionLines = output
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => /^Resolution:/i.test(line));
	for (const line of resolutionLines) {
		if (/Retina/i.test(line)) {
			continue;
		}
		const size = parseFirstSize(line, /(\d+)\s*[x×]\s*(\d+)/);
		if (size !== undefined) {
			return size;
		}
	}

	for (const line of resolutionLines) {
		const sizes = Array.from(line.matchAll(/(\d+)\s*[x×]\s*(\d+)/g), sizeFromMatch).filter(
			(size) => size !== undefined,
		);
		const smallestSize = smallestScreenSize(sizes);
		if (smallestSize === undefined) {
			continue;
		}
		return sizes.length > 1 ? smallestSize : retinaLogicalFallback(smallestSize);
	}

	return undefined;
}

function parseFirstSize(output: string, expression: RegExp): { width: number; height: number } | undefined {
	const match = output.match(expression);
	if (match === null) {
		return undefined;
	}
	return sizeFromMatch(match);
}

function sizeFromMatch(match: RegExpMatchArray): { width: number; height: number } | undefined {
	const width = positiveNumber(match[1]);
	const height = positiveNumber(match[2]);
	if (width === undefined || height === undefined) {
		return undefined;
	}
	return { width: Math.round(width), height: Math.round(height) };
}

function positiveNumber(value: string | undefined): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	const numberValue = Number(value);
	return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : undefined;
}

function finiteNumber(value: string | undefined): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	const numberValue = Number(value);
	return Number.isFinite(numberValue) ? numberValue : undefined;
}

function positiveSize(width: number, height: number): { width: number; height: number } | undefined {
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
		return undefined;
	}
	return { width: Math.round(width), height: Math.round(height) };
}

function remapElementFramesToScreenshot(
	elements: readonly AXTreeElement[],
	viewport: ScreenshotViewport,
): AXTreeElement[] {
	return elements.map((element) => ({
		...element,
		frame: screenRectToScreenshot(element.frame, viewport),
	}));
}

function resolveDisplayInfo(id: number): DisplayInfo {
	const logical = getMainDisplayLogicalSize();
	let nativePixel: { width: number; height: number } | undefined;
	try {
		nativePixel = getMainDisplayNativePixelSize();
	} catch {
		nativePixel = undefined;
	}
	const metadata = resolveDisplayMetadata(nativePixel === undefined ? { logical } : { logical, nativePixel });
	return { ...metadata, id, isMain: true, x: 0, y: 0 };
}

function displaysForWindow(
	window: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
	displays: ReturnType<typeof onlineDisplayInfo>,
): readonly DisplayInventoryEntry[] {
	if (displays === undefined) {
		return [];
	}
	return displays
		.map((display) => {
			const width = Math.min(window.x + window.width, display.x + display.width) - Math.max(window.x, display.x);
			const height = Math.min(window.y + window.height, display.y + display.height) - Math.max(window.y, display.y);
			const intersectionArea = Math.max(0, width) * Math.max(0, height);
			return { display, intersectionArea };
		})
		.filter(({ intersectionArea }) => intersectionArea > 0)
		.sort((left, right) => right.intersectionArea - left.intersectionArea)
		.map(({ display }) => display);
}

function resolveTargetApp(apps: readonly RunningAppInfo[], targetPid: number | undefined): RunningAppInfo {
	if (targetPid !== undefined) {
		const app = apps.find((candidate) => candidate.pid === targetPid);
		if (app === undefined) {
			throw new Error(`No running app matched pid ${targetPid}`);
		}
		return app;
	}
	const frontmost = apps.find((candidate) => candidate.isActive);
	if (frontmost === undefined) {
		throw new Error("No frontmost application available");
	}
	return frontmost;
}

function smallestScreenSize(
	sizes: ReadonlyArray<{ readonly width: number; readonly height: number }>,
): { width: number; height: number } | undefined {
	let smallest: { width: number; height: number } | undefined;
	for (const size of sizes) {
		if (smallest === undefined || size.width * size.height < smallest.width * smallest.height) {
			smallest = { width: size.width, height: size.height };
		}
	}
	return smallest;
}

function retinaLogicalFallback(size: { readonly width: number; readonly height: number }): {
	width: number;
	height: number;
} {
	if (size.width % 2 === 0 && size.height % 2 === 0) {
		return { width: size.width / 2, height: size.height / 2 };
	}
	return { width: size.width, height: size.height };
}
