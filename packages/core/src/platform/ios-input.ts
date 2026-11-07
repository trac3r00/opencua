import { setTimeout as sleep } from "node:timers/promises";
import { assertInputMayContinue, currentInputScope } from "../computer/input-scope.js";
import type { Point } from "../types/index.js";
import {
	K_CG_EVENT_FLAG_MASK_ALTERNATE,
	K_CG_EVENT_FLAG_MASK_COMMAND,
	K_CG_EVENT_FLAG_MASK_CONTROL,
	K_CG_EVENT_FLAG_MASK_SHIFT,
	getCurrentCursorPosition,
	postKeyboardEvent,
	postMouseEvent,
	postScrollEvent,
	warpCursorPosition,
} from "./macos-ffi/coregraphics.js";
import { readClipboard, writeClipboard } from "./macos-ffi/pasteboard.js";
import {
	CGS_EVENT_LEFT_MOUSE_DOWN,
	CGS_EVENT_LEFT_MOUSE_DRAGGED,
	CGS_EVENT_LEFT_MOUSE_UP,
	type SkyLightTargetWindow,
	beginFocusWithoutRaise,
	postMouseEventRecordToWindow,
	restoreFrontProcessNoWindows,
} from "./macos-ffi/skylight.js";
import { interpolatePointDrag } from "./macos-input-drag.js";
import { virtualKeyCodeFor } from "./macos-keycodes.js";

/**
 * How input reaches the phone.
 *
 * "background" (the default) delivers synthesized mouse records straight to the mirroring
 * window's process, so the phone is driven without bringing the window forward and without
 * touching the user's pointer. "attended" is the explicit foreground path. If window-targeted
 * delivery is unavailable, background input refuses rather than sending global mouse events.
 */
export type IOSDelivery = "background" | "attended";

/** The mirroring window as the input layer needs it: who to post to, and where it is. */
export interface IOSInputTarget {
	readonly pid: number;
	readonly windowId: number;
	readonly bounds: {
		readonly x: number;
		readonly y: number;
		readonly width: number;
		readonly height: number;
	};
	readonly delivery?: IOSDelivery;
}

export type SwipeKind = "flick" | "drag";

export interface SwipeOptions {
	readonly from: Point;
	readonly to: Point;
	readonly kind?: SwipeKind;
	readonly durationMs?: number;
	readonly steps?: number;
}

export interface IOSScrollOptions {
	/** Where the gesture lands. Only the scroll view under this point moves, so aim it at the list. */
	readonly at: Point;
	/** Positive reveals content further down; positive deltaX reveals content further right. */
	readonly deltaY: number;
	readonly deltaX?: number;
	readonly steps?: number;
	/**
	 * Allow the scroll to take the person's real pointer for the length of the gesture. Required under
	 * background delivery, where it is otherwise refused; attended delivery always borrows it.
	 */
	readonly borrowPointer?: boolean;
}

/** iPhone Mirroring forwards raw HID keycodes; a CGEvent flag mask never reaches the phone. */
const MODIFIER_KEY_CODES: Readonly<Record<string, number>> = {
	cmd: 55,
	command: 55,
	shift: 56,
	alt: 58,
	option: 58,
	ctrl: 59,
	control: 59,
};

const MODIFIER_FLAGS: Readonly<Record<string, number>> = {
	cmd: K_CG_EVENT_FLAG_MASK_COMMAND,
	command: K_CG_EVENT_FLAG_MASK_COMMAND,
	shift: K_CG_EVENT_FLAG_MASK_SHIFT,
	alt: K_CG_EVENT_FLAG_MASK_ALTERNATE,
	option: K_CG_EVENT_FLAG_MASK_ALTERNATE,
	ctrl: K_CG_EVENT_FLAG_MASK_CONTROL,
	control: K_CG_EVENT_FLAG_MASK_CONTROL,
};

const FLICK_DURATION_MILLISECONDS = 120;
const DRAG_DURATION_MILLISECONDS = 350;
const FLICK_STEPS = 6;
const DRAG_STEPS = 12;
const TAP_HOLD_MILLISECONDS = 50;
const LONG_PRESS_DEFAULT_MILLISECONDS = 800;
const KEYSTROKE_DELAY_MILLISECONDS = 30;
const KEY_HOLD_MILLISECONDS = 10;
const MODIFIER_SETTLE_MILLISECONDS = 12;
const WARP_SETTLE_MILLISECONDS = 50;
const SCROLL_STEP_MILLISECONDS = 30;
const SCROLL_DEFAULT_STEPS = 6;

/** Characters a US layout reaches with shift, mapped to the key that carries them. */
const SHIFTED_CHARACTERS: Readonly<Record<string, string>> = {
	"!": "1",
	"@": "2",
	"#": "3",
	$: "4",
	"%": "5",
	"^": "6",
	"&": "7",
	"*": "8",
	"(": "9",
	")": "0",
	_: "-",
	"+": "=",
	":": ";",
	'"': "'",
	"<": ",",
	">": ".",
	"?": "/",
	"~": "`",
	"{": "[",
	"}": "]",
	"|": "\\",
};

export interface KeystrokePlanEntry {
	readonly key: string;
	readonly shift: boolean;
}

/**
 * The gestures of a swipe, eased like a finger: still at the press, fastest in the middle,
 * still at the release. Includes both endpoints, so the path is what actually gets posted.
 */
export function gesturePath(from: Point, to: Point, steps: number): readonly Point[] {
	if (!Number.isInteger(steps) || steps < 1) {
		throw new Error("a gesture needs at least one step");
	}
	const path: Point[] = [];
	for (let step = 0; step <= steps; step += 1) {
		path.push(interpolatePointDrag(from, to, step / steps));
	}
	return path;
}

/**
 * How long a swipe takes. A short fast drag is a momentum flick on iOS — it snaps pages and
 * carousels — while a slow one barely registers. Distance stretches both a little so a
 * full-screen gesture is not a teleport.
 */
export function swipeDurationMs(distance: number, kind: SwipeKind): number {
	const base = kind === "flick" ? FLICK_DURATION_MILLISECONDS : DRAG_DURATION_MILLISECONDS;
	return Math.round(base + Math.min(600, Math.max(0, distance)) * 0.2);
}

/** "cmd+1" -> key "1" with the command modifier held around it. */
export function comboParts(combo: string): { readonly key: string; readonly modifiers: readonly string[] } {
	const parts = combo
		.toLowerCase()
		.split("+")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
	const key = parts.at(-1);
	if (key === undefined) {
		throw new Error("a key combo needs a key");
	}
	virtualKeyCodeFor(key);
	const modifiers = parts.slice(0, -1);
	for (const modifier of modifiers) {
		if (MODIFIER_KEY_CODES[modifier] === undefined) {
			throw new Error(`unknown modifier ${JSON.stringify(modifier)}`);
		}
	}
	return { key, modifiers };
}

/**
 * The keystroke sequence for typing text on the phone. iPhone Mirroring ignores the Unicode
 * payload a CGEvent can carry and forwards raw keycodes, so every character has to be a real
 * key — which is also why the paste path is the default for anything whose wording matters.
 */
export function typingPlan(text: string): readonly KeystrokePlanEntry[] {
	const plan: KeystrokePlanEntry[] = [];
	const lines = text.split("\n");
	for (const [index, line] of lines.entries()) {
		if (index > 0) {
			plan.push({ key: "return", shift: false });
		}
		for (const character of line) {
			const entry = keystrokeFor(character);
			if (entry === undefined) {
				throw new Error(
					`cannot type ${JSON.stringify(character)}: it has no US-layout keycode. Use the paste path instead.`,
				);
			}
			plan.push(entry);
		}
	}
	return plan;
}

function keystrokeFor(character: string): KeystrokePlanEntry | undefined {
	if (character === character.toUpperCase() && character !== character.toLowerCase()) {
		return { key: character.toLowerCase(), shift: true };
	}
	const shifted = SHIFTED_CHARACTERS[character];
	if (shifted !== undefined) {
		return { key: shifted, shift: true };
	}
	try {
		virtualKeyCodeFor(character);
		return { key: character, shift: false };
	} catch {
		return undefined;
	}
}

function deliveryFor(target: IOSInputTarget): IOSDelivery {
	return target.delivery ?? "background";
}

/**
 * macOS routes a wheel event by pointer location, so a phone scroll has to move the real pointer.
 * That contradicts background delivery's promise not to touch it; refuse unless the caller opts in.
 */
export function assertScrollMayBorrowPointer(delivery: IOSDelivery, borrowPointer: boolean | undefined): void {
	if (delivery === "background" && borrowPointer !== true) {
		throw new Error(
			"scrolling the phone would borrow the person's pointer: macOS sends wheel events to the window under the real cursor, so the cursor must move onto the phone and back. Background delivery refuses that by default. Pass borrow_pointer: true to allow a brief pointer borrow, or use a swipe (ios_swipe) for pages and carousels, which leaves the pointer alone.",
		);
	}
}

function skyLightWindow(target: IOSInputTarget): SkyLightTargetWindow {
	return { id: target.windowId, bounds: target.bounds };
}

function postRecord(target: IOSInputTarget, eventType: number, point: Point): boolean {
	if (eventType !== CGS_EVENT_LEFT_MOUSE_UP) assertInputMayContinue(currentInputScope());
	const posted = postMouseEventRecordToWindow(skyLightWindow(target), eventType, point);
	if (!posted && eventType !== CGS_EVENT_LEFT_MOUSE_UP) {
		throw new Error("Window-targeted iPhone input is unavailable; refusing global mouse fallback.");
	}
	return posted;
}

async function postAttendedMouse(kind: "move" | "down" | "up", point: Point): Promise<void> {
	if (kind !== "up") assertInputMayContinue(currentInputScope());
	postMouseEvent({ kind, position: point, button: "left", clickState: undefined, targetPid: undefined });
}

/** A tap: press, hold briefly, release. In the background path nothing is moved or focused. */
export async function tapMirroring(target: IOSInputTarget, point: Point): Promise<void> {
	if (deliveryFor(target) === "background" && postRecord(target, CGS_EVENT_LEFT_MOUSE_DOWN, point)) {
		await sleep(TAP_HOLD_MILLISECONDS);
		postRecord(target, CGS_EVENT_LEFT_MOUSE_UP, point);
		return;
	}
	await postAttendedMouse("move", point);
	await sleep(TAP_HOLD_MILLISECONDS);
	await postAttendedMouse("down", point);
	await sleep(TAP_HOLD_MILLISECONDS);
	await postAttendedMouse("up", point);
}

/** A long press: iOS reads the same press held longer as a context menu or a drag handle. */
export async function longPressMirroring(
	target: IOSInputTarget,
	point: Point,
	durationMs = LONG_PRESS_DEFAULT_MILLISECONDS,
): Promise<void> {
	if (deliveryFor(target) === "background" && postRecord(target, CGS_EVENT_LEFT_MOUSE_DOWN, point)) {
		await sleep(durationMs);
		postRecord(target, CGS_EVENT_LEFT_MOUSE_UP, point);
		return;
	}
	await postAttendedMouse("move", point);
	await sleep(TAP_HOLD_MILLISECONDS);
	await postAttendedMouse("down", point);
	await sleep(durationMs);
	await postAttendedMouse("up", point);
}

/**
 * A swipe: press, travel the eased path, release. "flick" is the momentum gesture — it snaps
 * Home Screen pages and carousels; "drag" is the slow one for rearranging.
 */
export async function swipeMirroring(target: IOSInputTarget, options: SwipeOptions): Promise<number> {
	const { from, to } = options;
	const kind = options.kind ?? "flick";
	const distance = Math.hypot(to.x - from.x, to.y - from.y);
	const durationMs = options.durationMs ?? swipeDurationMs(distance, kind);
	const steps = options.steps ?? (kind === "flick" ? FLICK_STEPS : DRAG_STEPS);
	const path = gesturePath(from, to, steps);
	const delay = path.length <= 1 ? 0 : durationMs / path.length;
	const background = deliveryFor(target) === "background" && postRecord(target, CGS_EVENT_LEFT_MOUSE_DOWN, from);
	let pressed = background;
	let lastPoint = from;
	try {
		if (!background) {
			await postAttendedMouse("move", from);
			await sleep(TAP_HOLD_MILLISECONDS);
			await postAttendedMouse("down", from);
			pressed = true;
		}
		for (const point of path.slice(1)) {
			if (background) {
				postRecord(target, CGS_EVENT_LEFT_MOUSE_DRAGGED, point);
			} else {
				await postAttendedMouse("move", point);
			}
			lastPoint = point;
			if (delay > 0) {
				await sleep(delay);
			}
		}
		return durationMs;
	} finally {
		if (pressed) {
			if (background) {
				postRecord(target, CGS_EVENT_LEFT_MOUSE_UP, lastPoint);
			} else {
				await postAttendedMouse("up", lastPoint);
			}
		}
	}
}

/**
 * Scroll the phone.
 *
 * macOS routes a scroll to the window under the real pointer — not to the active app, and not
 * to the event's own location — so this borrows the pointer for the length of the gesture and
 * puts it straight back. Under background delivery that borrow must be opted into with
 * `borrowPointer`; without it nothing is moved and the call throws. Verified on macOS 26: a vertical touch-drag is dropped, and the wheel
 * is the gesture that moves a list. The caller must have proven the phone window owns the
 * point (see requireMirroringWindowAt); otherwise the scroll lands in whatever is in front.
 */
export async function scrollMirroring(target: IOSInputTarget, options: IOSScrollOptions): Promise<void> {
	assertScrollMayBorrowPointer(deliveryFor(target), options.borrowPointer);
	assertInputMayContinue(currentInputScope());
	const steps = options.steps ?? SCROLL_DEFAULT_STEPS;
	const deltaY = options.deltaY;
	const deltaX = options.deltaX ?? 0;
	const home = getCurrentCursorPosition();
	const previous = deliveryFor(target) === "background" ? undefined : home;
	try {
		warpCursorPosition(options.at);
		await sleep(WARP_SETTLE_MILLISECONDS);
		// Re-run the hit test after warping so the wheel reaches the phone rather than the old pointer target.
		await postAttendedMouse("move", options.at);
		await sleep(WARP_SETTLE_MILLISECONDS);
		for (let step = 0; step < steps; step += 1) {
			assertInputMayContinue(currentInputScope());
			postScrollEvent({
				deltaX: Math.round(deltaX / steps),
				deltaY: Math.round(deltaY / steps),
				targetPid: undefined,
			});
			await sleep(SCROLL_STEP_MILLISECONDS);
		}
		await sleep(WARP_SETTLE_MILLISECONDS);
	} finally {
		warpCursorPosition(previous ?? home);
	}
}

/**
 * A key combo, with its modifiers held as real keys. iPhone Mirroring forwards raw HID keycodes
 * and drops the flag mask a CGEvent carries, so cmd+v expressed as a flag arrives as a bare "v".
 * The window is made key for the keystroke without being raised, then the previous front process
 * is restored.
 */
export async function pressMirroringCombo(target: IOSInputTarget, combo: string): Promise<void> {
	const { key, modifiers } = comboParts(combo);
	const keyCode = virtualKeyCodeFor(key);
	assertInputMayContinue(currentInputScope());
	const token = beginFocusWithoutRaise(skyLightWindow(target));
	let flags = 0;
	let keyHeld = false;
	const heldModifiers: { readonly code: number; readonly flag: number }[] = [];
	try {
		for (const modifier of modifiers) {
			const code = MODIFIER_KEY_CODES[modifier];
			const flag = MODIFIER_FLAGS[modifier];
			if (code === undefined || flag === undefined) {
				continue;
			}
			const nextFlags = flags | flag;
			postTargetedKey(target, code, true, nextFlags);
			flags = nextFlags;
			heldModifiers.push({ code, flag });
			await sleep(MODIFIER_SETTLE_MILLISECONDS);
		}
		postTargetedKey(target, keyCode, true, flags);
		keyHeld = true;
		await sleep(KEY_HOLD_MILLISECONDS);
	} finally {
		if (keyHeld) postTargetedKey(target, keyCode, false, flags);
		// Release only modifiers that went down; one left latched corrupts every later keystroke.
		for (const { code, flag } of [...heldModifiers].reverse()) {
			// Clear the bit before the key-up: an up event still carrying its own flag reads as held.
			flags &= ~flag;
			postTargetedKey(target, code, false, flags);
			await sleep(MODIFIER_SETTLE_MILLISECONDS);
		}
		if (token !== null) {
			restoreFrontProcessNoWindows(token);
		}
	}
}

/**
 * Type into the focused iOS field.
 *
 * "paste" (the default) is exact: autocorrect and keyboard layout cannot touch it. "keystrokes"
 * sends real key events for the fields that need them, at the cost of running through iOS
 * autocorrect. Neither path can tell whether a field had focus — a phone screen that did not
 * change is the only evidence — so a caller should observe afterwards.
 */
export async function typeIntoMirroring(
	target: IOSInputTarget,
	text: string,
	options: { readonly mode?: "paste" | "keystrokes"; readonly delayMs?: number } = {},
): Promise<{ readonly mode: "paste" | "keystrokes" }> {
	const mode = options.mode ?? "paste";
	if (mode === "keystrokes" || text.length === 0) {
		await typeKeystrokes(target, text, options.delayMs ?? KEYSTROKE_DELAY_MILLISECONDS);
		return { mode: "keystrokes" };
	}
	await pasteIntoMirroring(target, text);
	return { mode: "paste" };
}

async function pasteIntoMirroring(target: IOSInputTarget, text: string): Promise<void> {
	assertInputMayContinue(currentInputScope());
	writeClipboard({ type: "text", text });
	const written = readClipboard().text;
	if (written !== text) {
		throw new Error("the clipboard did not take the text, so pasting would send the previous contents");
	}
	await sleep(WARP_SETTLE_MILLISECONDS);
	await pressMirroringCombo(target, "cmd+v");
}

async function typeKeystrokes(target: IOSInputTarget, text: string, delayMs: number): Promise<void> {
	const plan = typingPlan(text);
	assertInputMayContinue(currentInputScope());
	const token = beginFocusWithoutRaise(skyLightWindow(target));
	try {
		for (const entry of plan) {
			const keyCode = virtualKeyCodeFor(entry.key);
			const flags = entry.shift ? K_CG_EVENT_FLAG_MASK_SHIFT : 0;
			postTargetedKey(target, keyCode, true, flags);
			await sleep(KEY_HOLD_MILLISECONDS);
			postTargetedKey(target, keyCode, false, flags);
			await sleep(delayMs);
		}
	} finally {
		if (token !== null) {
			restoreFrontProcessNoWindows(token);
		}
	}
}

function postTargetedKey(target: IOSInputTarget, keyCode: number, keyDown: boolean, flags: number): void {
	if (keyDown) assertInputMayContinue(currentInputScope());
	postKeyboardEvent({
		keyCode,
		keyDown,
		flags,
		text: undefined,
		targetPid: target.pid,
		targetWindow: skyLightWindow(target),
	});
}
