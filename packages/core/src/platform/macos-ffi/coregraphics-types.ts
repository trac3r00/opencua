import type { CFTypeRef } from "./corefoundation.js";
import type { SkyLightTargetWindow } from "./skylight.js";

export type CGEventRef = CFTypeRef;
export type CGEventSourceRef = CFTypeRef;

export type CGPoint = {
	readonly x: number;
	readonly y: number;
};

export type MouseButton = "left" | "right" | "middle";
export type MouseEventKind = "move" | "down" | "up" | "drag";

export type MouseEventOptions = {
	readonly kind: MouseEventKind;
	readonly position: CGPoint;
	readonly button: MouseButton;
	readonly clickState: number | undefined;
	readonly targetPid: number | undefined;
	readonly targetWindow?: SkyLightTargetWindow | undefined;
	/** CGEventFlags mask stamped on the event (held modifiers); left alone when undefined. */
	readonly flags?: number | undefined;
};

export type KeyboardEventOptions = {
	readonly keyCode: number;
	readonly keyDown: boolean;
	readonly flags: number;
	readonly text: string | undefined;
	readonly targetPid: number | undefined;
	readonly targetWindow?: SkyLightTargetWindow | undefined;
	/** Post a flagsChanged event (a modifier key going down or up) instead of a key down/up. */
	readonly flagsChanged?: boolean | undefined;
};

export type ScrollEventOptions = {
	readonly deltaX: number;
	readonly deltaY: number;
	readonly targetPid: number | undefined;
	readonly targetWindow?: SkyLightTargetWindow | undefined;
	/** CGEventFlags mask stamped on the event (held modifiers); left alone when undefined. */
	readonly flags?: number | undefined;
	/** Screen point the wheel event is delivered at; the real cursor position when undefined. */
	readonly position?: CGPoint | undefined;
};

export const K_CG_EVENT_SOURCE_STATE_HID_SYSTEM_STATE = 1;
export const K_CG_HID_EVENT_TAP = 0;
export const K_CG_EVENT_FLAGS_CHANGED = 12;
export const K_CG_SCROLL_EVENT_UNIT_PIXEL = 0;
export const K_CG_MOUSE_EVENT_CLICK_STATE = 1;
export const K_CG_MOUSE_EVENT_BUTTON_NUMBER = 3;
export const K_CG_MOUSE_EVENT_SUBTYPE = 7;
export const K_CG_MOUSE_EVENT_WINDOW_UNDER_MOUSE_POINTER = 91;
export const K_CG_MOUSE_EVENT_WINDOW_UNDER_MOUSE_POINTER_THAT_CAN_HANDLE_THIS_EVENT = 92;
export const K_CG_EVENT_FLAG_MASK_SHIFT = 0x00020000;
export const K_CG_EVENT_FLAG_MASK_CONTROL = 0x00040000;
export const K_CG_EVENT_FLAG_MASK_ALTERNATE = 0x00080000;
export const K_CG_EVENT_FLAG_MASK_COMMAND = 0x00100000;

export function mouseButtonNumber(button: MouseButton): number {
	switch (button) {
		case "left":
			return 0;
		case "right":
			return 1;
		case "middle":
			return 2;
	}
}

export function mouseEventType(kind: MouseEventKind, button: MouseButton): number {
	if (kind === "move") {
		return 5;
	}

	if (button === "left") {
		switch (kind) {
			case "down":
				return 1;
			case "up":
				return 2;
			case "drag":
				return 6;
		}
	}

	if (button === "right") {
		switch (kind) {
			case "down":
				return 3;
			case "up":
				return 4;
			case "drag":
				return 7;
		}
	}

	switch (kind) {
		case "down":
			return 25;
		case "up":
			return 26;
		case "drag":
			return 27;
	}
}
