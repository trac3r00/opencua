import { execFileSync } from "node:child_process";
import { currentCursorIdentity } from "../computer/cursor-scope.js";
import {
	assertFocusInInputRegion,
	assertPointInInputRegion,
	clampToInputRegion,
	currentInputRegion,
} from "../computer/input-region.js";
import {
	InputInterrupted,
	type InputScope,
	assertInputMayContinue,
	currentInputScope,
} from "../computer/input-scope.js";
import { assertScreenUnlocked } from "../computer/lock-guard.js";
import { type VirtualPointer, VirtualPointerSet } from "../computer/virtual-pointer.js";
import type {
	DragOptions,
	InputDelivery,
	KeyModifierName,
	KeyOptions,
	Point,
	Rect,
	ScrollOptions,
} from "../types/index.js";
import { readRealCursorPosition } from "./macos-cursor.js";
import {
	focusedElementFrame,
	focusedElementInWebArea,
	focusedWindowIdForPid,
	focusedWindowIsModal,
	focusedWindowShowsFilePanel,
	raiseWindowInApp,
	windowIdsAtScreenPoint,
	windowMinimizedForPid,
	windowTitlesForPid,
} from "./macos-ffi/accessibility.js";
import {
	type MouseButton,
	postKeyboardEvent,
	postMouseEvent,
	postScrollEvent,
	postUnicodeText,
} from "./macos-ffi/coregraphics.js";
import { cursorBackgroundCuesEnabled } from "./macos-ffi/cursor-background-cues.js";
import { NOOP_POINTER_OVERLAY, type PointerOverlay, type ScrollDirection } from "./macos-ffi/cursor-overlay.js";
import { onlineDisplayBounds } from "./macos-ffi/display-list.js";
import { filePanelServicePid } from "./macos-ffi/file-panel-service.js";
import { isScreenLocked } from "./macos-ffi/lock-screen.js";
import { type DisplaySleepAssertion, NOOP_DISPLAY_SLEEP } from "./macos-ffi/power.js";
import {
	type SkyLightTargetWindow,
	focusGuardFor,
	frontProcessSerialNumber,
	setProcessAppActive,
} from "./macos-ffi/skylight.js";
import { listOnscreenWindows, listWindows } from "./macos-ffi/window-list.js";
import { startFocusStealWatch } from "./macos-focus-watch.js";
import { dragSteps, interpolatePointEased, pointerTravelDuration, scrollEventPlan } from "./macos-input-drag.js";
import { pointerModifierFlags, withHeldModifiers } from "./macos-input-modifiers.js";
import {
	type MousePost,
	type ScreenLayout,
	postActivationPrimer,
	postClick,
	postDoubleClick,
	postDragSequence,
	primerPosition,
	runFocusLeasedClick,
	runFocusLeasedDoubleClick,
	runFocusLeasedDrag,
} from "./macos-input-pointer.js";
import { modifierFlags, virtualKeyCodeFor } from "./macos-keycodes.js";
import { openWindowsForTargeting } from "./macos-open-windows.js";
import { selectSystemEventsTargetWindow } from "./macos-window-target-fallback.js";
import type { MacOSWindowInfo } from "./macos-window-target.js";
import { resolveTargetWindow, toTargetWindow, visibleWindowsForPid } from "./macos-window-target.js";
import { isOwnedSurfacePid } from "./owned-surfaces.js";
import { humanBaseMilliseconds, humanCharacterDelay, typingRhythm } from "./typing-rhythm.js";

/**
 * On-screen window ids in the WindowServer's front-to-back order. A window that is minimized or
 * on another space is absent, so using this list is what stops targeted input from being routed
 * to a window the caller cannot see.
 */
let onscreenWindowIdsSource: () => readonly number[] | undefined = () =>
	listOnscreenWindows()?.map((window) => window.id);

export function currentOnscreenWindowIds(): readonly number[] | undefined {
	return onscreenWindowIdsSource();
}

let focusedFrameSource: (pid: number) => Rect | undefined = focusedElementFrame;

/** Replaces the focused-element frame reader the region check uses; pass undefined to restore the native one. */
export function setFocusedFrameSourceForTesting(source: ((pid: number) => Rect | undefined) | undefined): void {
	focusedFrameSource = source ?? focusedElementFrame;
}

export function setOnscreenWindowIdsSourceForTesting(source: () => readonly number[] | undefined): void {
	onscreenWindowIdsSource = source;
}

/**
 * Keyboard events posted to a process go to its key window, not to the window they name, so with
 * two documents open the observed window has to be made the app's focused window first. Raising
 * inside the app does not activate it, which keeps background delivery background.
 */
let keyboardWindowFocuser: (pid: number, windowId: number) => Promise<void> = async (pid, windowId) => {
	const focusedId = focusedWindowIdForPid(pid);
	if (focusedId === windowId || focusedWindowIsModal(pid)) {
		return;
	}
	if (!currentOnscreenWindowIds()?.includes(windowId)) {
		return;
	}
	if (focusedId !== undefined) {
		// An untitled focused window is a helper of the target's own interaction (Finder's rename field
		// editor, a popover); raising the target over it would end that interaction. Only another
		// document window takes the keys away from the target. The WindowServer hides every title from a
		// process without Screen Recording, so accessibility names the window when the listing does not.
		const listedTitle = (await openWindowsForTargeting()).find((window) => window.id === focusedId)?.title;
		const focusedTitle = listedTitle || windowTitlesForPid(pid).get(focusedId);
		if (!focusedTitle || raiseWindowInApp(pid, windowId)) {
			return;
		}
	}
	// Off the physical console accessibility exposes no windows, but the menu bar still works and the
	// Window menu's entry for a document makes that window key. Only when another titled window of the
	// app is in front of the target: untitled helper windows (Finder's inline rename editor) belong to
	// the target's own interaction, and re-selecting the target would end it.
	const order = currentOnscreenWindowIds() ?? [];
	const depth = (id: number) => order.indexOf(id);
	const windows = (await openWindowsForTargeting()).filter(
		(window) => window.owner?.processId === pid && depth(window.id) >= 0,
	);
	const title = windows.find((window) => window.id === windowId)?.title;
	const coveredByDocument = windows.some(
		(window) => window.id !== windowId && Boolean(window.title) && depth(window.id) < depth(windowId),
	);
	if (!title || !coveredByDocument) {
		return;
	}
	try {
		// Loaded on use: the menu module binds accessibility calls this module otherwise never needs.
		const { invokeMenu } = await import("./macos-menu.js");
		await invokeMenu(pid, ["Window", title]);
	} catch {
		// No Window menu entry for it (or two windows share the title): keys go to the key window, as before.
	}
};

/**
 * Some apps activate themselves in response to background keys (Finder's Go to Folder panel), which
 * would pull the person out of the app they are using. Background delivery snapshots who was
 * frontmost before the input and, if the target app takes the front shortly after, sends it back
 * (polling every few milliseconds, off this thread; see macos-focus-watch.ts). A third app coming
 * forward is left alone.
 */
let focusStealWatcher: (window: SkyLightTargetWindow) => void = (window) => {
	const guard = focusGuardFor(window);
	if (guard !== null) {
		startFocusStealWatch(guard);
	}
};

/** The same focus guard for accessibility presses, which can activate an app just as keys can. */
export function guardAgainstFocusSteal(window: SkyLightTargetWindow): void {
	focusStealWatcher(window);
}

export function setFocusStealWatcherForTesting(watcher: (window: SkyLightTargetWindow) => void): void {
	focusStealWatcher = watcher;
}

/**
 * Keys for an open Save or Open panel go to the panel's service process, the only place they are
 * received; everything else goes to the app itself.
 */
let keyboardPidResolver: (pid: number) => number = (pid) =>
	focusedWindowShowsFilePanel(pid) ? (filePanelServicePid(pid) ?? pid) : pid;

/** The target app is not frontmost (so WebKit refuses the paste) and its focused element is in a web page. */
let backgroundPasteTarget: (pid: number, window: SkyLightTargetWindow) => boolean = (pid, window) =>
	focusGuardFor(window) !== null && focusedElementInWebArea(pid);
let clipboardText: () => string | undefined = () => {
	try {
		return execFileSync("pbpaste", [], { encoding: "utf8", timeout: 2000 });
	} catch {
		return undefined;
	}
};

export function setBackgroundPasteForTesting(
	target: (pid: number, window: SkyLightTargetWindow) => boolean,
	text: () => string | undefined,
): void {
	backgroundPasteTarget = target;
	clipboardText = text;
}

export function setKeyboardPidResolverForTesting(resolver: (pid: number) => number): void {
	keyboardPidResolver = resolver;
}

export function setKeyboardWindowFocuserForTesting(focuser: (pid: number, windowId: number) => Promise<void>): void {
	keyboardWindowFocuser = focuser;
}

/**
 * The windows containing the element an app shows at a screen point, innermost first: how a pointer event bound to
 * an observed window tells a sheet of that window (which takes the event) from another window covering it.
 */
let pointWindowIds: (pid: number, position: Point) => readonly number[] | undefined = (pid, position) =>
	windowIdsAtScreenPoint(pid, position.x, position.y);

export function setPointWindowIdsForTesting(
	source: (pid: number, position: Point) => readonly number[] | undefined,
): void {
	pointWindowIds = source;
}

/**
 * Every display and on-screen window, read when an app is told it is active so that its activation primer lands clear
 * of all of them; undefined when either list cannot be read. Desktop elements (wallpaper, desktop icons) are left out
 * of the window list, and they lie on the displays, which are in it.
 */
let screenLayoutSource: () => ScreenLayout | undefined = () => {
	const displays = onlineDisplayBounds();
	const windows = listWindows()?.map((window) => window.bounds);
	return displays === undefined || windows === undefined ? undefined : { displays, windows };
};

export function setScreenLayoutSourceForTesting(source: () => ScreenLayout | undefined): void {
	screenLayoutSource = source;
}

/** Logged when an app was told it is active but no point is provably clear for its primer click. */
const PRIMER_SKIPPED_MESSAGE =
	"opencua: activation primer skipped: the display and window layout could not be read, so no point outside all of them is known; a first-mouse app (Finder) may spend the next background click on activating its window\n";

/**
 * Background activation (see MacOSInputController.activateBehind) is on unless OPENCUA_BACKGROUND_ACTIVATION turns it
 * off (off, 0, false, no).
 */
export function backgroundActivationEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
	const value = environment["OPENCUA_BACKGROUND_ACTIVATION"]?.trim().toLowerCase();
	return !(value === "off" || value === "0" || value === "false" || value === "no");
}

/** Re-exported for callers that import the delivery mode beside the input controller. */
export type { InputDelivery };

/**
 * Inter-character delay for typeText. Posting keystrokes back-to-back outruns the
 * target app's event loop and drops characters; the default paces each keystroke.
 * OPENCUA_TYPE_CHARACTER_DELAY_MS raises or lowers it (0 posts every character
 * back-to-back, which known-fast apps tolerate but slower ones drop).
 */
export function typeCharacterDelayMilliseconds(environment: NodeJS.ProcessEnv = process.env): number {
	const raw = environment["OPENCUA_TYPE_CHARACTER_DELAY_MS"]?.trim();
	if (raw === undefined || raw.length === 0) {
		return TYPE_CHARACTER_DELAY_MS_DEFAULT;
	}
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 0) {
		return TYPE_CHARACTER_DELAY_MS_DEFAULT;
	}
	return value;
}

const TYPE_CHARACTER_DELAY_MS_DEFAULT = 4;

/** How often a held key checks whether its call was stopped, so a long hold is released soon after a stop. */
const HOLD_CHECK_MILLISECONDS = 50;

/**
 * Whom one input call is for, and whether it may go on, fixed when the call starts (see beginCall) and handed down to
 * every event it posts. Nothing another call does changes it, so calls for different apps that overlap never post to
 * each other's app.
 */
interface InputCall {
	readonly pid: number | undefined;
	/** The observed window the call is bound to: its input reaches that window or is refused. */
	readonly windowId: number | undefined;
	readonly scope: InputScope | undefined;
}

/** How long an app behind the person's that background input told it is active stays so without another action. */
export const BACKGROUND_ACTIVATION_IDLE_MILLISECONDS = 2_000;

export class MacOSInputController {
	private closed = false;
	/** The app input goes to when no input scope names one: the constructor's, or setTarget's. */
	private defaultTargetPid: number | undefined;
	/** The window each app's input last went to (or its observation named), by pid. */
	private readonly targetWindowsByPid = new Map<number, SkyLightTargetWindow>();
	private readonly keyboardInputAt = new Map<number, number>();
	/** Apps behind the person's that this controller told they are active, by pid, to be told otherwise once idle. */
	private readonly activations = new Map<number, { readonly window: SkyLightTargetWindow; readonly psn: Buffer }>();
	private readonly activationReleaseTimers = new Map<number, NodeJS.Timeout>();
	/**
	 * Registered on process exit while any app is held: a process that ends (a server turns termination
	 * signals into an exit) still tells every app it told it is active otherwise, synchronously on the way out.
	 */
	private readonly releaseOnExit = (): void => {
		for (const pid of [...this.activations.keys()]) {
			this.releaseActivation(pid);
		}
	};
	private exitHookRegistered = false;
	private readonly overlay: PointerOverlay;
	private readonly processPointers: VirtualPointerSet;
	private readonly pointersByIdentity = new Map<string, VirtualPointerSet>();
	private readonly isLocked: () => boolean;
	private readonly displaySleep: DisplaySleepAssertion;
	private globalGestureChain: Promise<void> = Promise.resolve();
	private readonly appGestureChains = new Map<number | string, Promise<void>>();
	private readonly delivery: InputDelivery;
	/** Whether background delivery may tell an app behind the person's that it is active (see activateBehind). */
	private readonly backgroundActivation: boolean;
	private readonly backgroundCues: boolean;

	constructor(
		targetPid?: number,
		overlay: PointerOverlay = NOOP_POINTER_OVERLAY,
		isLocked: () => boolean = isScreenLocked,
		displaySleep: DisplaySleepAssertion = NOOP_DISPLAY_SLEEP,
		delivery: InputDelivery = "background",
		backgroundActivation: boolean = backgroundActivationEnabled(),
		private readonly cursorMotionEnabled = false,
	) {
		this.delivery = delivery;
		this.backgroundActivation = backgroundActivation;
		this.backgroundCues = cursorBackgroundCuesEnabled();
		this.overlay = overlay;
		this.isLocked = isLocked;
		this.displaySleep = displaySleep;
		this.processPointers = new VirtualPointerSet(readRealCursorPosition());
		this.setTarget(targetPid);
	}

	private get pointers(): VirtualPointerSet {
		const identity = currentCursorIdentity();
		if (identity === undefined) {
			return this.processPointers;
		}
		let pointers = this.pointersByIdentity.get(identity);
		if (pointers === undefined) {
			pointers = new VirtualPointerSet(this.processPointers.forPid(0).position());
			this.pointersByIdentity.set(identity, pointers);
		}
		return pointers;
	}

	private beforeInput(): void {
		this.assertOpen();
		assertScreenUnlocked(this.isLocked());
		this.displaySleep.acquire();
	}

	private get isBackground(): boolean {
		return this.delivery === "background";
	}

	/**
	 * Start one input call: whom it is for is read here, once. The input scope of the calling async flow names the app
	 * (and the observed window) of the dispatch it belongs to; without a scope the default target applies. Background
	 * delivery may only use routes that leave the user's session alone, so a call with no target app at all is refused
	 * with the action named: untargeted events would take over the person's cursor and frontmost app.
	 */
	private beginCall(action: string): InputCall {
		const scope = currentInputScope();
		const pid = scope?.target?.pid ?? this.defaultTargetPid;
		if (this.isBackground && pid === undefined) {
			throw new Error(
				`background delivery cannot ${action} without a target app: global input would take over the cursor and focus`,
			);
		}
		const call: InputCall = { pid, windowId: scope?.target?.windowId, scope };
		this.checkpoint(call);
		return call;
	}

	/** Stops the call (InputInterrupted) once its scope says input must stop: the stop switch, a client cancel. */
	private checkpoint(call: InputCall): void {
		this.assertOpen();
		assertInputMayContinue(call.scope);
	}

	private assertOpen(): void {
		if (this.closed) {
			throw new InputInterrupted("input controller is closed");
		}
	}

	/**
	 * The last check before an event leaves. Under background delivery an event with no target app is never posted,
	 * whatever path led to it: it would go through the session-wide HID tap to the app in front of the person.
	 */
	private assertDeliverable(pid: number | undefined): void {
		if (pid === undefined && this.isBackground) {
			throw new Error(
				"background delivery refused an event with no target app: it would reach the app in front of the person",
			);
		}
	}

	/**
	 * Hold modifier keys across one pointer gesture, to the same process and window the pointer events
	 * go to: flagsChanged key events before it, the flags handed to the gesture to stamp on every
	 * mouse or wheel event, and the keys released afterwards even when the gesture throws. Posting is
	 * per process under a target, so the person's own keyboard state is never touched.
	 *
	 * An app behind the person's swallows a click (the system spends it on activating the window, so a
	 * plain click selects nothing) and does not extend a selection on a command-click either, so in
	 * background delivery a click, double click or drag first has the target app told it is active (see
	 * activateBehind). Wheel events scroll a background app without that, so a scroll asks for it only
	 * when it carries modifiers.
	 */
	private async holdModifiers<T>(
		call: InputCall,
		modifiers: ReadonlyArray<KeyModifierName> | undefined,
		targetWindow: SkyLightTargetWindow | undefined,
		activation: "pointer" | "wheel",
		gesture: (flags: number | undefined) => Promise<T>,
	): Promise<T> {
		// Read first: an unknown modifier name is refused here, before anything is posted.
		const modified = pointerModifierFlags(modifiers) !== 0;
		const pid = call.pid;
		if (
			this.isBackground &&
			targetWindow !== undefined &&
			!currentOnscreenWindowIds()?.includes(targetWindow.id) &&
			modified
		) {
			throw new Error("modified pointer input refused for an off-Space window; activation priming is unavailable");
		}
		let held = false;
		if (pid !== undefined && targetWindow !== undefined) {
			if (this.isBackground && !currentOnscreenWindowIds()?.includes(targetWindow.id)) {
				held = false;
			} else {
				held =
					activation === "pointer" || modified
						? await this.activateBehind(pid, targetWindow)
						: this.postponeActivationRelease(pid);
			}
		}
		try {
			return await this.postWithHeldModifiers(call, modifiers, targetWindow, gesture);
		} finally {
			if (held && pid !== undefined) {
				this.scheduleActivationRelease(pid);
			}
		}
	}

	/**
	 * Tell the app owning `window`, which sits behind the person's app, that it is active with `window` as
	 * its key window: no front-process change, no raise, nothing told to the person's app. An app that
	 * believes it is active takes the first click of a gesture instead of spending it on activating the
	 * window, reads modifier flags off a click, and enables its window commands (Save, New Folder). The
	 * first click after the activation is still spent on it, so a primer click at a point inside no display and no
	 * window absorbs it; when no such point can be proven (the layout cannot be read) the primer is skipped and that is
	 * logged, and the gesture's first click may then be spent on the activation.
	 *
	 * The app stays told until no background action has reached it for
	 * {@link BACKGROUND_ACTIVATION_IDLE_MILLISECONDS} (or the controller closes): telling it otherwise
	 * right after each action leaves some apps (Finder) deaf to the very next activation, while a chain of
	 * actions shares one. An app held for another of its windows is told again, naming this one. True when
	 * this controller holds the app active afterwards; the caller then schedules the release. Never done with
	 * background activation turned off (OPENCUA_BACKGROUND_ACTIVATION=off), which avoids the release's autosave (see
	 * releaseActivation) at the cost of the clicks and window commands above.
	 */
	private async activateBehind(pid: number, window: SkyLightTargetWindow): Promise<boolean> {
		// Notification hosts are nonactivating accessory apps, not document windows.
		// Priming and later deactivating them can dismiss the hosted banner.
		// An owned surface takes the first click without activation, and activating it would touch the person's focus.
		if (!this.isBackground || !this.backgroundActivation || window.layer === 21 || isOwnedSurfacePid(pid)) {
			return false;
		}
		this.cancelActivationRelease(pid);
		const held = this.activations.get(pid);
		if (held?.window.id === window.id) {
			return true;
		}
		const guard = focusGuardFor(window);
		if (guard === null || !setProcessAppActive(guard.targetPsn, window.id, true)) {
			// Frontmost already (there is nothing to tell it), or out of reach: an earlier hold stays as it was.
			return held !== undefined;
		}
		this.activations.set(pid, { window, psn: guard.targetPsn });
		this.syncExitHook();
		focusStealWatcher(window);
		const primer = primerPosition(screenLayoutSource());
		if (primer === undefined) {
			process.stderr.write(PRIMER_SKIPPED_MESSAGE);
		} else {
			await postActivationPrimer(this.mousePostFor(pid), window, primer);
		}
		return true;
	}

	/** Keep a held activation from running out while another action reaches the app; false when none is held. */
	private postponeActivationRelease(pid: number): boolean {
		if (!this.activations.has(pid)) {
			return false;
		}
		this.cancelActivationRelease(pid);
		return true;
	}

	private cancelActivationRelease(pid: number): void {
		const timer = this.activationReleaseTimers.get(pid);
		if (timer !== undefined) {
			clearTimeout(timer);
			this.activationReleaseTimers.delete(pid);
		}
	}

	private scheduleActivationRelease(pid: number): void {
		this.cancelActivationRelease(pid);
		const timer = setTimeout(() => {
			this.activationReleaseTimers.delete(pid);
			this.releaseActivation(pid);
		}, BACKGROUND_ACTIVATION_IDLE_MILLISECONDS);
		timer.unref();
		this.activationReleaseTimers.set(pid, timer);
	}

	/**
	 * Tell a held app it is no longer active, unless the person brought it forward meanwhile: then it
	 * really is the active app, and telling it otherwise would take that from them. Addressed by process,
	 * so it still lands after the window it was activated with has closed.
	 *
	 * This is the deactivation event AppKit gets when a person switches away from the app, and the app reacts the same
	 * way: -[NSApplication _handleDeactivateEvent:] posts NSApplicationWillResignActiveNotification before anything else,
	 * and NSDocumentController autosaves every document of a class that autosaves in place (TextEdit, Preview, Pages),
	 * so another document of the app with unsaved changes is written to its file. No narrower release exists: the
	 * window named does not matter, the event autosaves even an app that is not active, and without it the app goes on
	 * believing it is active (AXFrontmost) behind the person's. Only not activating avoids it (backgroundActivation).
	 */
	private releaseActivation(pid: number): void {
		const held = this.activations.get(pid);
		if (held === undefined) {
			return;
		}
		this.activations.delete(pid);
		this.syncExitHook();
		if (frontProcessSerialNumber()?.equals(held.psn) !== true) {
			setProcessAppActive(held.psn, held.window.id, false);
		}
	}

	/** The exit hook is registered exactly while some app is held. */
	private syncExitHook(): void {
		const wanted = this.activations.size > 0;
		if (wanted && !this.exitHookRegistered) {
			process.on("exit", this.releaseOnExit);
		} else if (!wanted && this.exitHookRegistered) {
			process.off("exit", this.releaseOnExit);
		}
		this.exitHookRegistered = wanted;
	}

	/** Mouse events for `pid`, whichever app the controller is aimed at right now. */
	private mousePostFor(pid: number): MousePost {
		return async (kind, position, button, clickState, targetWindow, flags) => {
			assertPointInInputRegion(position, `pointer ${kind}`);
			postMouseEvent({ kind, position, button, clickState, targetPid: pid, targetWindow, flags });
		};
	}

	/**
	 * Run a window command (a menu item, a key equivalent) meant for `window` of app `pid`. A window command
	 * acts on the app's key window, so `window` is first made the app's focused window inside its own app.
	 * macOS validates window commands against their app being active, so under background delivery an app
	 * behind the person's is told it is active with `window` as its key window (see activateBehind) before
	 * `command` runs, when `wantsActivation()` says the command can use that (and always while this
	 * controller already holds the app); the person's own frontmost app is told nothing. `command` learns
	 * whether the app is held active; the hold lasts through it and ends once idle afterwards, like a
	 * pointer gesture's.
	 */
	async withWindowCommand<T>(
		pid: number,
		window: SkyLightTargetWindow,
		wantsActivation: () => boolean,
		command: (held: boolean) => Promise<T>,
	): Promise<T> {
		this.beforeInput();
		if (this.isBackground && !currentOnscreenWindowIds()?.includes(window.id)) {
			const target = await this.windowByIdForPid(pid, window.id, undefined, true);
			if (target === undefined || focusedWindowIdForPid(pid) !== window.id) {
				throw new Error("off-Space command target is unavailable or is not the app's verified focused window");
			}
			focusStealWatcher(target);
			return await command(false);
		}
		await keyboardWindowFocuser(pid, window.id);
		if (currentInputScope()?.target?.windowId !== undefined && focusedWindowIdForPid(pid) !== window.id) {
			throw new Error("observed command target is not the verified focused window; input refused");
		}
		const activate = this.activations.has(pid) || (this.isBackground && wantsActivation());
		const held = activate ? await this.activateBehind(pid, window) : false;
		try {
			return await command(held);
		} finally {
			if (held) {
				this.scheduleActivationRelease(pid);
			}
		}
	}

	/** Whether this controller holds `pid` told it is active, so the app's own AXFrontmost is not the person's doing. */
	holdsActivation(pid: number): boolean {
		return this.activations.has(pid);
	}

	/** Keys reaching an app this controller holds active keep it so: its idle period restarts after them. */
	private async keepingActivation<T>(call: InputCall, work: () => Promise<T>): Promise<T> {
		const pid = call.pid;
		const held = pid !== undefined && this.postponeActivationRelease(pid);
		try {
			return await work();
		} finally {
			if (held && pid !== undefined) {
				this.scheduleActivationRelease(pid);
			}
		}
	}

	private async postWithHeldModifiers<T>(
		call: InputCall,
		modifiers: ReadonlyArray<KeyModifierName> | undefined,
		targetWindow: SkyLightTargetWindow | undefined,
		gesture: (flags: number | undefined) => Promise<T>,
	): Promise<T> {
		return await withHeldModifiers(
			modifiers,
			(keyCode, keyDown, flags) => {
				this.assertDeliverable(call.pid);
				postKeyboardEvent({
					keyCode,
					keyDown,
					flags,
					text: undefined,
					targetPid: call.pid,
					targetWindow,
					flagsChanged: true,
				});
			},
			gesture,
		);
	}

	private serialize<T>(pid: number | undefined, run: () => Promise<T>): Promise<T> {
		const appLane = this.isBackground && pid !== undefined;
		// An owned surface merges its cursors' input itself, so each cursor there gets its own gesture chain.
		const identity = currentCursorIdentity();
		const lane = pid !== undefined && identity !== undefined && isOwnedSurfacePid(pid) ? `${pid}:${identity}` : pid;
		const previous =
			appLane && lane !== undefined
				? (this.appGestureChains.get(lane) ?? Promise.resolve())
				: this.globalGestureChain;
		const result = previous.then(run, run);
		const next = result.then(
			() => undefined,
			() => undefined,
		);
		if (appLane && lane !== undefined) {
			this.appGestureChains.set(lane, next);
			void next.then(() => {
				if (this.appGestureChains.get(lane) === next) {
					this.appGestureChains.delete(lane);
				}
			});
		} else {
			this.globalGestureChain = next;
		}
		return result;
	}

	/** The default target: where input goes when no input scope names an app (see beginCall). */
	setTarget(pid?: number): void {
		if (pid !== undefined && (!Number.isSafeInteger(pid) || pid <= 0)) {
			throw new Error("target pid must be a positive integer");
		}
		this.defaultTargetPid = pid;
	}

	async rememberTargetWindow(
		pid: number,
		windowId?: number,
		windows?: readonly MacOSWindowInfo[],
	): Promise<SkyLightTargetWindow | undefined> {
		if (!Number.isSafeInteger(pid) || pid <= 0) {
			throw new Error("target pid must be a positive integer");
		}
		let targetWindow: SkyLightTargetWindow | undefined;
		if (windowId === undefined) {
			targetWindow = await this.visibleWindowForPid(pid, undefined, windows);
		} else {
			targetWindow = await this.windowByIdForPid(pid, windowId, windows, this.isBackground);
		}
		if (targetWindow !== undefined) {
			this.targetWindowsByPid.set(pid, targetWindow);
		}
		return targetWindow;
	}

	async move(position: Point): Promise<void> {
		const call = this.beginCall("move the pointer");
		await this.serialize(call.pid, async () => {
			this.beforeInput();
			const window = await this.pointerWindow(call, position);
			this.requirePointerWindow(call, window);
			const previous = this.pointerFor(call.pid).position();
			// An app-targeted path starts inside that window, never through another app or display.
			let from = previous;
			if (window !== undefined) {
				from = {
					x: Math.max(window.bounds.x, Math.min(window.bounds.x + window.bounds.width - 1, previous.x)),
					y: Math.max(window.bounds.y, Math.min(window.bounds.y + window.bounds.height - 1, previous.y)),
				};
			}
			from = clampToInputRegion(from);
			const duration = pointerTravelDuration(from, position);
			const steps = dragSteps(duration);
			if (this.delivery !== "background") {
				this.overlay.setMode("pointer", call.pid);
			}
			for (let step = 1; step <= steps; step += 1) {
				this.checkpoint(call);
				const at = interpolatePointEased(from, position, step / steps);
				await this.mousePost(call)("move", at, "left", undefined, window);
				this.trackPointer(at, call.pid);
				if (step < steps) {
					await delayMilliseconds(duration / steps);
				}
			}
		});
	}

	private async postMove(call: InputCall, position: Point): Promise<void> {
		await this.mousePost(call)("move", position, "left", undefined, await this.pointerWindow(call, position));
		this.markPointer(position, call.pid);
	}

	/** Expand the lease's hover into already-paced travel, after its saved cursor snapshot. */
	private clickPost(call: InputCall): MousePost {
		const post = this.mousePost(call);
		if (this.isBackground || !this.cursorMotionEnabled) {
			return post;
		}
		return async (kind, position, button, clickState, window, flags) => {
			const from = clampToInputRegion(this.pointerFor(call.pid).position());
			if (kind === "move" && Math.hypot(position.x - from.x, position.y - from.y) > 8) {
				const duration = pointerTravelDuration(from, position);
				const steps = dragSteps(duration);
				const started = performance.now();
				for (let step = 1; step <= steps; step += 1) {
					const remaining = started + (duration * step) / steps - performance.now();
					if (remaining > 0) await delayMilliseconds(Math.ceil(remaining));
					this.checkpoint(call);
					const at = interpolatePointEased(from, position, step / steps);
					await post("move", at, button, clickState, window, flags);
					this.trackPointer(at, call.pid);
				}
				return;
			}
			await post(kind, position, button, clickState, window, flags);
		};
	}

	async click(
		position: Point,
		button: MouseButton = "left",
		modifiers?: ReadonlyArray<KeyModifierName>,
	): Promise<void> {
		const call = this.beginCall("click");
		await this.serialize(call.pid, async () => {
			this.beforeInput();
			const targetWindow = await this.pointerWindow(call, position);
			this.requirePointerWindow(call, targetWindow);
			// Read after waiting for the gesture before this one and for the window lookup: nothing goes down once stopped.
			this.checkpoint(call);
			const post = this.clickPost(call);
			await this.holdModifiers(call, modifiers, targetWindow, "pointer", async (flags) => {
				if (call.pid === undefined) {
					await post("move", position, "left", undefined, targetWindow);
					await postClick(post, position, button, 1, targetWindow, flags);
					this.markPointer(position);
				} else if (targetWindow !== undefined) {
					if (this.isBackground || isOwnedSurfacePid(call.pid)) {
						await postClick(post, position, button, 1, targetWindow, flags);
						this.showPointer(position, true, call.pid);
						return;
					}
					await runFocusLeasedClick(targetWindow, position, button, post, flags, { targetPid: call.pid });
					this.showPointer(position, true, call.pid);
				}
			});
		});
	}

	async doubleClick(position: Point, modifiers?: ReadonlyArray<KeyModifierName>): Promise<void> {
		const call = this.beginCall("double click");
		await this.serialize(call.pid, async () => {
			this.beforeInput();
			const targetWindow = await this.pointerWindow(call, position);
			this.requirePointerWindow(call, targetWindow);
			this.checkpoint(call);
			const post = this.clickPost(call);
			await this.holdModifiers(call, modifiers, targetWindow, "pointer", async (flags) => {
				if (call.pid === undefined) {
					await post("move", position, "left", undefined, targetWindow);
					await postDoubleClick(post, position, targetWindow, flags);
					this.markPointer(position);
				} else if (targetWindow !== undefined) {
					if (this.isBackground || isOwnedSurfacePid(call.pid)) {
						await postDoubleClick(post, position, targetWindow, flags);
						this.showPointer(position, true, call.pid);
						return;
					}
					await runFocusLeasedDoubleClick(targetWindow, position, post, flags, { targetPid: call.pid });
					this.showPointer(position, true, call.pid);
				}
			});
		});
	}

	async typeText(text: string): Promise<void> {
		const call = this.beginCall("type");
		await this.keepingActivation(call, () => this.postText(call, text));
	}

	private async postText(call: InputCall, text: string): Promise<void> {
		this.beforeInput();
		const targetWindow = await this.requireSessionWindow(call, "keyboard");
		const keyboardPid = this.keyboardPid(call);
		assertFocusInInputRegion(() => (keyboardPid === undefined ? undefined : focusedFrameSource(keyboardPid)));
		this.showKeyboard();
		// Pace keystrokes: posting characters back-to-back outruns the target app's
		// event processing and drops characters ("https://example.com" -> "https://e").
		// A small inter-character delay lets each keystroke be consumed before the next,
		// so a single delivery per char is reliable (no drops) without doubling.
		const pacing = typeCharacterDelayMilliseconds();
		const rhythm = typingRhythm();
		const segments = Array.from(text);
		for (let i = 0; i < segments.length; i++) {
			const segment = segments[i];
			if (segment === undefined) {
				continue;
			}
			// Read before every character, so a stop or a cancel ends a long text part-way rather than after it.
			this.checkpoint(call);
			this.assertDeliverable(keyboardPid);
			// Focus can move between characters (another worker clicks elsewhere): recheck it before each one.
			assertFocusInInputRegion(() => (keyboardPid === undefined ? undefined : focusedFrameSource(keyboardPid)));
			postUnicodeText(segment, keyboardPid, targetWindow);
			if (!this.isBackground || this.backgroundCues) this.overlay.keyPress?.(call.pid);
			this.noteKeyboardInput(call.pid);
			const next = segments[i + 1];
			// The wait after this character is the transition into the next one.
			const delay =
				rhythm === "human" && next !== undefined
					? humanCharacterDelay(segment, next, humanBaseMilliseconds(pacing), Math.random, pacing)
					: pacing;
			if (delay > 0 && i < segments.length - 1) {
				await delayMilliseconds(delay);
			}
		}
	}

	async pressKey(key: string, options?: KeyOptions): Promise<void> {
		const call = this.beginCall("press keys");
		await this.keepingActivation(call, () => this.postKey(call, key, options));
	}

	private async postKey(call: InputCall, key: string, options?: KeyOptions): Promise<void> {
		this.beforeInput();
		assertFocusInInputRegion(() => {
			const pid = this.keyboardPid(call);
			return pid === undefined ? undefined : focusedFrameSource(pid);
		});
		if (await this.pasteAsTyping(call, key, options)) {
			return;
		}
		const keyCode = virtualKeyCodeFor(key);
		const flags = modifierFlags(options?.modifiers ?? []);
		const targetWindow = await this.requireSessionWindow(call, "keyboard");
		const keyboardPid = this.keyboardPid(call);
		this.showKeyboard();
		this.checkpoint(call);
		this.assertDeliverable(keyboardPid);
		postKeyboardEvent({
			keyCode,
			keyDown: true,
			flags,
			text: undefined,
			targetPid: keyboardPid,
			targetWindow,
		});
		if (!this.isBackground || this.backgroundCues) this.overlay.keyPress?.(call.pid);
		try {
			if (options?.holdMilliseconds !== undefined) {
				await this.holdKey(call, options.holdMilliseconds);
			}
		} finally {
			// The release goes out even when a stop cuts the hold short: a key left down keeps repeating.
			postKeyboardEvent({
				keyCode,
				keyDown: false,
				flags,
				text: undefined,
				targetPid: keyboardPid,
				targetWindow,
			});
			this.noteKeyboardInput(call.pid);
		}
	}

	/** Wait out a key hold in short slices, ending it early (InputInterrupted) once the call is stopped. */
	private async holdKey(call: InputCall, milliseconds: number): Promise<void> {
		for (let left = milliseconds; left > 0; left -= HOLD_CHECK_MILLISECONDS) {
			await delayMilliseconds(Math.min(left, HOLD_CHECK_MILLISECONDS));
			this.checkpoint(call);
		}
	}

	/**
	 * Aim keyboard input at the observed window without posting a key: an accessibility action that
	 * stands in for a key (Select All on the focused field) must act on that window's focused element,
	 * not on whichever window of the app happened to be focused.
	 */
	async prepareKeyboardTarget(): Promise<void> {
		const call = this.beginCall("press keys");
		this.beforeInput();
		await this.requireSessionWindow(call, "keyboard");
		this.showKeyboard();
	}

	/**
	 * The app keyboard and pointer input of the calling async flow is aimed at, if any: its input scope's target, else
	 * the default target.
	 */
	get currentTargetPid(): number | undefined {
		return currentInputScope()?.target?.pid ?? this.defaultTargetPid;
	}

	/** When keys or a menu equivalent last ran, so an accessibility write can wait until they were handled. */
	lastKeyboardInputAt(pid: number): number | undefined {
		return this.keyboardInputAt.get(pid);
	}

	noteKeyboardInput(pid: number | undefined): void {
		if (pid !== undefined) {
			this.keyboardInputAt.set(pid, performance.now());
		}
		if (!this.isBackground || this.backgroundCues) {
			this.overlay.setMode("keyboard", pid);
		}
	}

	async scroll(options: ScrollOptions): Promise<void> {
		const call = this.beginCall("scroll");
		this.beforeInput();
		const amount = Math.max(0, Math.trunc(Math.abs(options.amount)));
		const targetWindow = await this.requireSessionWindow(call, "scroll");
		let position: Point;
		const region = currentInputRegion();
		if (options.position !== undefined) {
			position = options.position;
		} else if (region !== undefined) {
			// A confined worker scrolls its own part of a shared window, not the window's centre.
			position = { x: region.x + region.width / 2, y: region.y + region.height / 2 };
		} else if (targetWindow !== undefined) {
			position = {
				x: targetWindow.bounds.x + targetWindow.bounds.width / 2,
				y: targetWindow.bounds.y + targetWindow.bounds.height / 2,
			};
		} else {
			position = this.pointerFor(call.pid).position();
		}
		if (options.position !== undefined) {
			await this.pointerWindow(call, position);
		}
		assertPointInInputRegion(position, "scroll");
		this.showScrollPointer(position, call.pid, options.direction);
		const unit: Record<ScrollOptions["direction"], [number, number]> = {
			up: [0, 1],
			down: [0, -1],
			left: [-1, 0],
			right: [1, 0],
		};
		const [ux, uy] = unit[options.direction];
		const plan = scrollEventPlan(amount);
		await this.holdModifiers(call, options.modifiers, targetWindow, "wheel", async (flags) => {
			const started = performance.now();
			for (const [index, d] of plan.entries()) {
				const remaining = started + 14 * index - performance.now();
				if (remaining > 0) {
					await delayMilliseconds(Math.ceil(remaining));
				}
				this.checkpoint(call);
				this.assertDeliverable(call.pid);
				postScrollEvent({
					deltaX: d * ux,
					deltaY: d * uy,
					targetPid: call.pid,
					targetWindow,
					flags,
					position: options.position ?? (targetWindow === undefined ? undefined : position),
				});
			}
		});
	}

	async drag(options: DragOptions): Promise<void> {
		if (options.duration !== undefined) {
			dragSteps(options.duration);
		}
		const call = this.beginCall("drag");
		await this.serialize(call.pid, async () => {
			this.beforeInput();
			const targetWindow = await this.pointerWindow(call, options.from);
			this.requirePointerWindow(call, targetWindow);
			if (
				targetWindow !== undefined &&
				options.waypoints?.some((waypoint) => !containsPoint(targetWindow, waypoint))
			) {
				throw new Error("drag waypoint is outside the target window; observe the destination window first");
			}
			for (const waypoint of options.waypoints ?? []) assertPointInInputRegion(waypoint, "drag waypoint");
			await this.pointerWindow(call, options.to);
			if (targetWindow !== undefined && !containsPoint(targetWindow, options.to)) {
				throw new Error("drag destination is outside the target window; observe the destination window first");
			}
			this.checkpoint(call);
			this.showDragPointer(options.from, call.pid);
			const mousePost = this.mousePost(call);
			const post: MousePost = async (kind, at, button, clickState, window, flags) => {
				await mousePost(kind, at, button, clickState, window, flags);
				if (kind === "drag" || kind === "up") {
					this.trackPointer(at, call.pid);
				}
			};
			// Read between drag steps; a stopped drag lets go of the button where it is and sends nothing more.
			const checkpoint = (): void => this.checkpoint(call);
			await this.holdModifiers(call, options.modifiers, targetWindow, "pointer", async (flags) => {
				if (call.pid === undefined) {
					await this.postMove(call, options.from);
					await postDragSequence(post, options, targetWindow, flags, checkpoint);
				} else if (targetWindow !== undefined) {
					if (this.isBackground || isOwnedSurfacePid(call.pid)) {
						this.showPointer(options.from, false, call.pid);
						await postDragSequence(post, options, targetWindow, flags, checkpoint);
						return;
					}
					await runFocusLeasedDrag(targetWindow, options, post, flags, checkpoint);
				}
			});
		});
	}

	getCursorPosition(): Point {
		return this.pointerFor(this.currentTargetPid).position();
	}

	close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		for (const timer of this.activationReleaseTimers.values()) {
			clearTimeout(timer);
		}
		this.activationReleaseTimers.clear();
		for (const pid of [...this.activations.keys()]) {
			this.releaseActivation(pid);
		}
		this.displaySleep.release();
		this.overlay.close();
	}

	private markPointer(position: Point, pid = this.currentTargetPid): void {
		this.pointerFor(pid).moveTo(position);
		if (!this.isBackground || this.backgroundCues) {
			this.overlay.set(position, pid);
		}
	}

	private pointerFor(pid: number | undefined): VirtualPointer {
		return pid === undefined ? this.pointers.forPid(0) : this.pointers.forPid(pid);
	}

	private trackPointer(position: Point, pid = this.currentTargetPid): void {
		this.pointerFor(pid).moveTo(position);
		if (this.isBackground && !this.backgroundCues) {
			return;
		}
		if (this.overlay.track === undefined) {
			this.overlay.set(position, pid, true);
		} else {
			this.overlay.track(position, pid);
		}
	}

	showScrollPointer(position: Point, pid = this.currentTargetPid, direction?: ScrollDirection): void {
		if (!this.isBackground || this.backgroundCues) {
			if (direction !== undefined && this.overlay.setScrollMode !== undefined) {
				this.overlay.setScrollMode(direction, pid);
			} else {
				this.overlay.setMode("scroll", pid);
			}
		}
		this.markPointer(position, pid);
	}

	private showDragPointer(position: Point, pid: number | undefined): void {
		if (this.isBackground && !this.backgroundCues) return;
		this.overlay.setMode("drag", pid);
		this.markPointer(position, pid);
	}

	/**
	 * Show where the agent is acting with the drawn overlay dot, and ripple it for a press. Background
	 * delivery updates the drawn marker only when background cues are enabled (see
	 * OPENCUA_CURSOR_BACKGROUND_CUES); otherwise it updates the logical pointer model silently.
	 */
	showPointer(position: Point, press: boolean, pid = this.currentTargetPid): void {
		if (this.isBackground && !this.backgroundCues) {
			this.pointerFor(pid).moveTo(position);
			return;
		}
		this.overlay.setMode("pointer", pid);
		this.markPointer(position, pid);
		if (press) {
			this.overlay.setMode("click", pid);
		}
	}

	showThinking(): void {
		if (!this.isBackground) {
			this.overlay.setMode("thinking", this.currentTargetPid);
		}
	}

	/** Show keyboard activity on the drawn cursor in either delivery mode. */
	showKeyboard(): void {
		if (!this.isBackground || this.backgroundCues) {
			const pid = this.currentTargetPid;
			this.overlay.setMode("keyboard", pid);
			this.overlay.set(this.pointerFor(pid).position(), pid);
		}
	}

	/** Mouse events of one call, addressed to its app; with no app they would take the HID tap (see assertDeliverable). */
	private mousePost(call: InputCall): MousePost {
		return async (kind, position, button, clickState, targetWindow, flags) => {
			this.assertDeliverable(call.pid);
			// Every posted point, interpolated moves included, stays inside a confined worker's region.
			assertPointInInputRegion(position, `pointer ${kind}`);
			postMouseEvent({ kind, position, button, clickState, targetPid: call.pid, targetWindow, flags });
		};
	}

	/**
	 * The window a pointer event at `position` goes to. A call bound to an observed window addresses that window by its
	 * id, also where another window of the same app covers the point, because the coordinates came from that window's
	 * observation; only a sheet or popover of the observed window covering the point takes the event instead, since its
	 * controls are part of what was observed. A bound window that is no longer on screen, or a point outside it, refuses
	 * the input. An unbound call takes the app's window under the point.
	 */
	private async pointerWindow(call: InputCall, position: Point): Promise<SkyLightTargetWindow | undefined> {
		assertPointInInputRegion(position, "pointer input");
		const pid = call.pid;
		if (pid === undefined) {
			return undefined;
		}
		if (call.windowId === undefined) {
			const targetWindow = await this.visibleWindowForPid(pid, position);
			if (targetWindow !== undefined) {
				this.targetWindowsByPid.set(pid, targetWindow);
			}
			return targetWindow;
		}
		const windows = await openWindowsForTargeting();
		const bound = await this.boundWindow(pid, call.windowId, "pointer", windows);
		if (!containsPoint(bound, position)) {
			throw new Error(
				`pointer input refused: (${Math.round(position.x)}, ${Math.round(position.y)}) is outside the observed window ${bound.id}; observe the app again`,
			);
		}
		if (!currentOnscreenWindowIds()?.includes(bound.id)) {
			this.targetWindowsByPid.set(pid, bound);
			return bound;
		}
		const covering = frontmostWindowAt(windows, pid, position);
		const hosted =
			covering !== undefined &&
			covering.id !== bound.id &&
			isHostedBy(pointWindowIds(pid, position), covering.id, bound.id);
		const targetWindow = hosted ? covering : bound;
		this.targetWindowsByPid.set(pid, targetWindow);
		return targetWindow;
	}

	/** The observed window a call is bound to, as the WindowServer shows it now; refused when it is not on screen. */
	private async boundWindow(
		pid: number,
		windowId: number,
		action: "pointer" | "keyboard" | "scroll",
		windows?: readonly MacOSWindowInfo[],
	): Promise<SkyLightTargetWindow> {
		const targetWindow = await this.windowByIdForPid(pid, windowId, windows, this.isBackground);
		if (targetWindow === undefined) {
			throw new Error(
				`${action} input refused: the observed window ${windowId} is unavailable on this Space for this app, is minimized, or its minimized state is unknown; observe the app again`,
			);
		}
		return targetWindow;
	}

	private async visibleWindowForPid(
		pid: number,
		position?: Point,
		windows?: readonly MacOSWindowInfo[],
	): Promise<SkyLightTargetWindow | undefined> {
		const list = windows ?? (await openWindowsForTargeting());
		const resolution = resolveTargetWindow(list, pid, currentOnscreenWindowIds(), position);
		if (resolution.kind === "resolved") {
			return resolution.window;
		}
		return await selectSystemEventsTargetWindow(list, pid, position);
	}

	private async windowByIdForPid(
		pid: number,
		windowId: number,
		windows?: readonly MacOSWindowInfo[],
		allowOffscreen = false,
	): Promise<SkyLightTargetWindow | undefined> {
		const onscreenIds = currentOnscreenWindowIds();
		const currentList = windows ?? (await openWindowsForTargeting());
		const currentResolution = resolveTargetWindow(currentList, pid, onscreenIds, undefined, windowId);
		if (currentResolution.kind === "resolved") {
			return currentResolution.window;
		}
		if (!allowOffscreen || onscreenIds?.includes(windowId)) {
			return undefined;
		}
		const allSpaces = await openWindowsForTargeting(undefined, { includeOffscreen: true });
		const resolution = resolveTargetWindow(allSpaces, pid, onscreenIds, undefined, windowId, {
			allowOffscreen: true,
		});
		if (resolution.kind !== "resolved" || windowMinimizedForPid(pid, windowId) !== false) {
			return undefined;
		}
		return resolution.window;
	}

	private requirePointerWindow(call: InputCall, targetWindow: SkyLightTargetWindow | undefined): void {
		if (call.pid !== undefined && targetWindow === undefined) {
			throw new Error("targeted pointer input requires get_app_state or a visible target window");
		}
	}

	/**
	 * WebKit pastes only for the active app, so Cmd+V into a web page of an app in the background does
	 * nothing and Edit > Paste is disabled. Background delivery types the clipboard's plain text there
	 * instead: the same text lands and the person's app keeps focus. Anything else is a real key press.
	 */
	private async pasteAsTyping(call: InputCall, key: string, options?: KeyOptions): Promise<boolean> {
		const modifiers = options?.modifiers ?? [];
		const isPaste =
			key.toLowerCase() === "v" && modifiers.length === 1 && ["cmd", "command"].includes(modifiers[0] ?? "");
		if (!isPaste || !this.isBackground || call.pid === undefined) {
			return false;
		}
		const targetWindow = await this.requireSessionWindow(call, "keyboard");
		if (targetWindow === undefined || !backgroundPasteTarget(call.pid, targetWindow)) {
			return false;
		}
		const text = clipboardText();
		if (text === undefined || text.length === 0) {
			return false;
		}
		await this.postText(call, text);
		return true;
	}

	private keyboardPid(call: InputCall): number | undefined {
		return call.pid === undefined ? undefined : keyboardPidResolver(call.pid);
	}

	/**
	 * The window keyboard and wheel input of a call goes to its observed window, else the window the app's input last
	 * went to, else its front window.
	 */
	private async requireSessionWindow(
		call: InputCall,
		action: "keyboard" | "scroll",
	): Promise<SkyLightTargetWindow | undefined> {
		const pid = call.pid;
		if (pid === undefined) {
			return undefined;
		}
		let targetWindow: SkyLightTargetWindow | undefined;
		if (call.windowId !== undefined) {
			targetWindow = await this.boundWindow(pid, call.windowId, action);
		} else {
			const remembered = this.targetWindowsByPid.get(pid);
			if (remembered === undefined) {
				targetWindow = await this.visibleWindowForPid(pid);
			} else if (currentOnscreenWindowIds()?.includes(remembered.id)) {
				targetWindow = remembered;
			} else if (this.isBackground) {
				targetWindow = await this.windowByIdForPid(pid, remembered.id, undefined, true);
			}
			if (remembered !== undefined && targetWindow === undefined) {
				throw new Error(
					`${action} input refused: the remembered window ${remembered.id} is unavailable on this Space, is minimized, or its minimized state is unknown`,
				);
			}
		}
		if (targetWindow === undefined) {
			throw new Error(
				`targeted ${action} input requires get_app_state, a visible target window, or a prior pointer action`,
			);
		}
		this.targetWindowsByPid.set(pid, targetWindow);
		if (action === "keyboard") {
			if (this.isBackground && !currentOnscreenWindowIds()?.includes(targetWindow.id)) {
				if (focusedWindowIdForPid(pid) !== targetWindow.id) {
					throw new Error(
						"keyboard input refused for an off-Space observed window: it must already be the app's verified focused window",
					);
				}
				focusStealWatcher(targetWindow);
				return targetWindow;
			}
			if (this.isBackground) {
				focusStealWatcher(targetWindow);
			}
			await keyboardWindowFocuser(pid, targetWindow.id);
			if (call.windowId !== undefined && focusedWindowIdForPid(pid) !== targetWindow.id) {
				throw new Error("observed keyboard target is not the verified focused window; input refused");
			}
		}
		return targetWindow;
	}
}

function containsPoint(window: SkyLightTargetWindow, position: Point): boolean {
	const { x, y, width, height } = window.bounds;
	return position.x >= x && position.x <= x + width && position.y >= y && position.y <= y + height;
}

/** The app's frontmost on-screen window containing `position`, by the WindowServer's front-to-back order. */
function frontmostWindowAt(
	windows: readonly MacOSWindowInfo[],
	pid: number,
	position: Point,
): SkyLightTargetWindow | undefined {
	const order = currentOnscreenWindowIds();
	if (order === undefined) {
		return undefined;
	}
	const depth = new Map(order.map((id, index) => [id, index] as const));
	const front = visibleWindowsForPid(windows, pid)
		.map(toTargetWindow)
		.filter((window) => depth.has(window.id) && containsPoint(window, position))
		.sort((left, right) => (depth.get(left.id) ?? 0) - (depth.get(right.id) ?? 0))[0];
	return front;
}

/**
 * Whether the window covering a point is a sheet or popover of the observed window: the element the app shows there
 * lies in the covering window (innermost) and, further out, in the observed one.
 */
function isHostedBy(windowIds: readonly number[] | undefined, coveringId: number, boundId: number): boolean {
	return windowIds !== undefined && windowIds[0] === coveringId && windowIds.includes(boundId);
}

function delayMilliseconds(milliseconds: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, milliseconds);
	});
}
