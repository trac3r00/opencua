import { currentCursorIdentity, currentCursorOwner, inContextClick } from "../../computer/cursor-scope.js";
import {
	isOwnedSurfacePid,
	nameSurfaceCursor,
	sendSurfacePointer,
	surfaceCursorFor,
	surfaceCursorUserData,
} from "../owned-surfaces.js";
import { createNSEventBackedMouseEvent } from "./appkit.js";
import { cfRelease } from "./corefoundation.js";
import {
	createCursorEvent,
	createKeyboardEvent,
	createMouseEvent,
	createScrollEvent,
	getLocation,
	postToHidEventTap,
	setEventType,
	setFlags,
	setIntegerValueField,
	setLocation,
	setUnicodeString,
	stampEvent,
	warpCursorPosition as warpCursorPositionBinding,
} from "./coregraphics-bindings.js";
import {
	type CGEventRef,
	type CGPoint,
	K_CG_EVENT_FLAGS_CHANGED,
	K_CG_MOUSE_EVENT_BUTTON_NUMBER,
	K_CG_MOUSE_EVENT_CLICK_STATE,
	K_CG_MOUSE_EVENT_SUBTYPE,
	K_CG_MOUSE_EVENT_WINDOW_UNDER_MOUSE_POINTER,
	K_CG_MOUSE_EVENT_WINDOW_UNDER_MOUSE_POINTER_THAT_CAN_HANDLE_THIS_EVENT,
	type KeyboardEventOptions,
	type MouseButton,
	type MouseEventKind,
	type MouseEventOptions,
	type ScrollEventOptions,
	mouseButtonNumber,
	mouseEventType,
} from "./coregraphics-types.js";
import {
	type SkyLightTargetWindow,
	postAuthenticatedSkyLightEventToPid,
	postBackgroundEventRecordToWindowOwner,
	postCoreGraphicsEventToWindowOwner,
	postSkyLightEventToPid,
	setSkyLightIntegerField,
	setSkyLightWindowLocation,
} from "./skylight.js";

export type { MouseButton } from "./coregraphics-types.js";
export {
	K_CG_EVENT_FLAG_MASK_ALTERNATE,
	K_CG_EVENT_FLAG_MASK_COMMAND,
	K_CG_EVENT_FLAG_MASK_CONTROL,
	K_CG_EVENT_FLAG_MASK_SHIFT,
} from "./coregraphics-types.js";

export function postMouseEvent(options: MouseEventOptions): void {
	if (sendToOwnedSurface(options)) return;
	const event = makeMouseEvent(options.kind, options.position, options.button, options.targetWindow, options.flags);
	try {
		setIntegerValueField(event, K_CG_MOUSE_EVENT_BUTTON_NUMBER, mouseButtonNumber(options.button));
		if (options.clickState !== undefined) {
			setIntegerValueField(event, K_CG_MOUSE_EVENT_CLICK_STATE, options.clickState);
		}
		if (options.flags !== undefined) {
			setFlags(event, options.flags);
		}
		if (options.targetPid === undefined) {
			postMouse(event, undefined, options.targetWindow);
			return;
		}
		stampTargetedMouseEvent(event, options.targetPid, options.position, options.targetWindow);
		postMouse(event, options.targetPid, options.targetWindow);
	} finally {
		cfRelease(event);
	}
}

export function postKeyboardEvent(options: KeyboardEventOptions): void {
	const event = createKeyboardEvent(options.keyCode, options.keyDown);
	try {
		if (options.flagsChanged === true) {
			// A modifier key going down or up is a flagsChanged event whose flags already show the new state.
			setEventType(event, K_CG_EVENT_FLAGS_CHANGED);
		}
		setFlags(event, options.flags);
		if (options.text !== undefined) {
			setUnicodeString(event, options.text);
		}
		postKeyboard(event, options.targetPid, options.targetWindow);
	} finally {
		cfRelease(event);
	}
}

export function postUnicodeText(
	text: string,
	targetPid: number | undefined,
	targetWindow?: SkyLightTargetWindow | undefined,
): void {
	for (const segment of Array.from(text)) {
		// Set the unicode string on keyDown ONLY. Setting it on keyUp too makes macOS
		// insert each character twice ("abc" -> "aabbcc"); keyUp is just the release.
		postKeyboardEvent({ keyCode: 0, keyDown: true, flags: 0, text: segment, targetPid, targetWindow });
		postKeyboardEvent({ keyCode: 0, keyDown: false, flags: 0, text: undefined, targetPid, targetWindow });
	}
}

export function postScrollEvent(options: ScrollEventOptions): void {
	const event = createScrollEvent(options.deltaX, options.deltaY);
	try {
		if (options.flags !== undefined) {
			setFlags(event, options.flags);
		}
		if (options.position !== undefined) {
			stampScrollLocation(event, options.position, options.targetPid, options.targetWindow);
		}
		postScroll(event, options.targetPid, options.targetWindow);
	} finally {
		cfRelease(event);
	}
}

export function getCurrentCursorPosition(): CGPoint {
	const event = createCursorEvent();
	try {
		return getLocation(event);
	} finally {
		cfRelease(event);
	}
}

export function warpCursorPosition(position: CGPoint): void {
	warpCursorPositionBinding(position);
}

function makeMouseEvent(
	kind: MouseEventKind,
	position: CGPoint,
	button: MouseButton,
	targetWindow: SkyLightTargetWindow | undefined,
	flags: number | undefined,
): CGEventRef {
	// The app reads modifiers from the NSEvent backing a targeted event, not from the CGEvent flags
	// set afterwards, so held modifiers have to be part of the NSEvent itself. NSEventModifierFlags
	// use the same bits as CGEventFlags for command, option, control and shift.
	const eventType = mouseEventType(kind, button);
	const event =
		targetWindow === undefined
			? createMouseEvent(eventType, position, mouseButtonNumber(button))
			: createNSEventBackedMouseEvent(eventType, position, flags ?? 0, targetWindow.id, kind === "move" ? 0 : 1);
	setLocation(event, position);
	stampEvent(event);
	return event;
}

function postMouse(
	event: CGEventRef,
	targetPid: number | undefined,
	targetWindow: SkyLightTargetWindow | undefined,
): void {
	if (targetPid === undefined) {
		postToHidEventTap(event);
		return;
	}
	if (targetWindow === undefined) {
		throw new Error("targeted mouse input requires a target window from get_app_state or a visible app window");
	}
	if (targetWindow.layer === 21) {
		if (!postBackgroundEventRecordToWindowOwner(targetWindow, event)) {
			throw new Error("failed to post notification-window mouse record without foreground activation");
		}
		return;
	}
	postSkyLightEventToPid(targetPid, event);
}

function postKeyboard(
	event: CGEventRef,
	targetPid: number | undefined,
	targetWindow: SkyLightTargetWindow | undefined,
): void {
	if (targetPid === undefined) {
		postToHidEventTap(event);
		return;
	}
	if (targetWindow === undefined) {
		throw new Error("targeted keyboard input requires a target window from get_app_state or a prior pointer action");
	}
	// Deliver via ONE path only. Posting both the authenticated SkyLight event AND the
	// CoreGraphics event to the window owner delivers every keystroke twice — apps that
	// accept both insert each character twice ("abc" -> "aabbcc"). Use the authenticated
	// SkyLight path as primary; fall back to CG to the window owner only when the
	// authenticated SkyLight event can't be built.
	if (!postAuthenticatedSkyLightEventToPid(targetPid, event)) {
		if (!postCoreGraphicsEventToWindowOwner(targetWindow, event)) {
			throw new Error("failed to deliver targeted keyboard event (SkyLight auth and CG both failed)");
		}
	}
}

function postScroll(
	event: CGEventRef,
	targetPid: number | undefined,
	targetWindow: SkyLightTargetWindow | undefined,
): void {
	if (targetPid === undefined) {
		postToHidEventTap(event);
		return;
	}
	if (targetWindow === undefined) {
		throw new Error("targeted scroll input requires a target window from get_app_state or a prior pointer action");
	}
	postSkyLightEventToPid(targetPid, event);
	postCoreGraphicsEventToWindowOwner(targetWindow, event);
}

/** Aim a wheel event at a point instead of wherever the real cursor happens to be. */
function stampScrollLocation(
	event: CGEventRef,
	position: CGPoint,
	targetPid: number | undefined,
	targetWindow: SkyLightTargetWindow | undefined,
): void {
	setLocation(event, position);
	if (targetPid === undefined || targetWindow === undefined) {
		return;
	}
	setIntegerValueField(event, K_CG_MOUSE_EVENT_WINDOW_UNDER_MOUSE_POINTER, targetWindow.id);
	setIntegerValueField(event, K_CG_MOUSE_EVENT_WINDOW_UNDER_MOUSE_POINTER_THAT_CAN_HANDLE_THIS_EVENT, targetWindow.id);
	setSkyLightWindowLocation(event, {
		x: position.x - targetWindow.bounds.x,
		y: position.y - targetWindow.bounds.y,
	});
}

function stampTargetedMouseEvent(
	event: CGEventRef,
	targetPid: number,
	position: CGPoint,
	targetWindow: SkyLightTargetWindow | undefined,
): void {
	if (targetWindow?.layer !== 21) {
		setIntegerValueField(event, K_CG_MOUSE_EVENT_SUBTYPE, 3);
	}
	if (targetWindow !== undefined) {
		setIntegerValueField(event, K_CG_MOUSE_EVENT_WINDOW_UNDER_MOUSE_POINTER, targetWindow.id);
		setIntegerValueField(
			event,
			K_CG_MOUSE_EVENT_WINDOW_UNDER_MOUSE_POINTER_THAT_CAN_HANDLE_THIS_EVENT,
			targetWindow.id,
		);
		setSkyLightWindowLocation(event, {
			x: position.x - targetWindow.bounds.x,
			y: position.y - targetWindow.bounds.y,
		});
	} else {
		setSkyLightWindowLocation(event, position);
	}
	setSkyLightIntegerField(event, 40, targetPid);
	stampSurfaceCursor(event, targetPid);
}

/** An owned surface takes its agents' left-button input on its own socket, tagged with the sending cursor. */
function sendToOwnedSurface(options: MouseEventOptions): boolean {
	const { targetPid, targetWindow } = options;
	// The socket carries no modifier flags, so input with held modifiers is posted as before.
	if (targetPid === undefined || targetWindow === undefined || options.button !== "left") return false;
	if ((options.flags ?? 0) !== 0) return false;
	if (!isOwnedSurfacePid(targetPid)) return false;
	const { tag, name } = surfaceCursorFor(currentCursorIdentity(), currentCursorOwner());
	const sent = sendSurfacePointer(targetPid, {
		tag,
		context: inContextClick(),
		kind: options.kind,
		x: options.position.x - targetWindow.bounds.x,
		y: options.position.y - targetWindow.bounds.y,
	});
	if (sent) nameSurfaceCursor(tag, name);
	return sent;
}

/** kCGEventSourceUserData: an owned surface reads it to draw the sending agent's cursor where the event landed. */
const K_CG_EVENT_SOURCE_USER_DATA = 42;

function stampSurfaceCursor(event: CGEventRef, targetPid: number): void {
	if (!isOwnedSurfacePid(targetPid)) return;
	// Every agent event carries a nonzero tag, so the surface can tell it from the person's own clicks.
	const { tag, name } = surfaceCursorFor(currentCursorIdentity(), currentCursorOwner());
	setIntegerValueField(event, K_CG_EVENT_SOURCE_USER_DATA, surfaceCursorUserData(tag, inContextClick()));
	nameSurfaceCursor(tag, name);
}
