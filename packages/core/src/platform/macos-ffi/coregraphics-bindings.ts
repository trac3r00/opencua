import type { KoffiFunc } from "koffi";
import { requireAttendedHostDelivery } from "../../computer/host-interaction-policy.js";
import { cfRelease } from "./corefoundation.js";
import {
	type CGEventRef,
	type CGEventSourceRef,
	type CGPoint,
	K_CG_EVENT_SOURCE_STATE_HID_SYSTEM_STATE,
	K_CG_HID_EVENT_TAP,
	K_CG_SCROLL_EVENT_UNIT_PIXEL,
} from "./coregraphics-types.js";
import { koffi } from "./koffi.js";

const CLOCK_UPTIME_RAW = 8;

const coreGraphics = koffi.load("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics");
const systemLibrary = koffi.load(null);
const CG_POINT = koffi.struct("CGPoint", { x: "double", y: "double" });
const CG_EVENT_REF = koffi.pointer("CGEventRef", koffi.opaque());
const CG_EVENT_SOURCE_REF = koffi.pointer("CGEventSourceRef", koffi.opaque());

const CGEventSourceCreate = coreGraphics.func("CGEventSourceCreate", CG_EVENT_SOURCE_REF, ["uint32_t"]) as KoffiFunc<
	(stateId: number) => CGEventSourceRef | null
>;

const CGEventCreate = coreGraphics.func("CGEventCreate", CG_EVENT_REF, [CG_EVENT_SOURCE_REF]) as KoffiFunc<
	(source: CGEventSourceRef | null) => CGEventRef | null
>;

const CGEventCreateMouseEvent = coreGraphics.func("CGEventCreateMouseEvent", CG_EVENT_REF, [
	CG_EVENT_SOURCE_REF,
	"uint32_t",
	CG_POINT,
	"uint32_t",
]) as KoffiFunc<(source: CGEventSourceRef, eventType: number, position: CGPoint, button: number) => CGEventRef | null>;

const CGEventCreateKeyboardEvent = coreGraphics.func("CGEventCreateKeyboardEvent", CG_EVENT_REF, [
	CG_EVENT_SOURCE_REF,
	"uint16_t",
	"bool",
]) as KoffiFunc<(source: CGEventSourceRef, keyCode: number, keyDown: boolean) => CGEventRef | null>;

const CGEventCreateScrollWheelEvent = coreGraphics.func("CGEventCreateScrollWheelEvent", CG_EVENT_REF, [
	CG_EVENT_SOURCE_REF,
	"uint32_t",
	"uint32_t",
	"int32_t",
	"int32_t",
]) as KoffiFunc<
	(source: CGEventSourceRef, units: number, wheelCount: number, wheel1: number, wheel2: number) => CGEventRef | null
>;

const CGEventKeyboardSetUnicodeString = coreGraphics.func("CGEventKeyboardSetUnicodeString", "void", [
	CG_EVENT_REF,
	"uint64_t",
	"string16",
]) as KoffiFunc<(event: CGEventRef, stringLength: number, text: string) => void>;

const CGEventSetFlags = coreGraphics.func("CGEventSetFlags", "void", [CG_EVENT_REF, "uint64_t"]) as KoffiFunc<
	(event: CGEventRef, flags: number) => void
>;

const CGEventSetType = coreGraphics.func("CGEventSetType", "void", [CG_EVENT_REF, "uint32_t"]) as KoffiFunc<
	(event: CGEventRef, eventType: number) => void
>;

const CGEventSetIntegerValueField = coreGraphics.func("CGEventSetIntegerValueField", "void", [
	CG_EVENT_REF,
	"uint32_t",
	"int64_t",
]) as KoffiFunc<(event: CGEventRef, field: number, value: number) => void>;

const CGEventSetTimestamp = coreGraphics.func("CGEventSetTimestamp", "void", [CG_EVENT_REF, "uint64_t"]) as KoffiFunc<
	(event: CGEventRef, timestamp: bigint) => void
>;

const CGEventSetLocation = coreGraphics.func("CGEventSetLocation", "void", [CG_EVENT_REF, CG_POINT]) as KoffiFunc<
	(event: CGEventRef, location: CGPoint) => void
>;

const CGEventGetLocation = coreGraphics.func("CGEventGetLocation", CG_POINT, [CG_EVENT_REF]) as KoffiFunc<
	(event: CGEventRef) => CGPoint
>;

const CGEventPost = coreGraphics.func("CGEventPost", "void", ["uint32_t", CG_EVENT_REF]) as KoffiFunc<
	(tap: number, event: CGEventRef) => void
>;

const CGWarpMouseCursorPosition = coreGraphics.func("CGWarpMouseCursorPosition", "int32_t", [CG_POINT]) as KoffiFunc<
	(position: CGPoint) => number
>;

const clockGetTimeNanoseconds = systemLibrary.func("clock_gettime_nsec_np", "uint64_t", ["int"]) as KoffiFunc<
	(clockId: number) => bigint
>;

function currentUptimeNanoseconds(): bigint {
	return clockGetTimeNanoseconds(CLOCK_UPTIME_RAW);
}

export function createMouseEvent(eventType: number, position: CGPoint, buttonNumber: number): CGEventRef {
	const source = createEventSource();
	try {
		const event = CGEventCreateMouseEvent(source, eventType, position, buttonNumber);
		if (event === null) {
			throw new Error("CGEventCreateMouseEvent returned null");
		}
		return event;
	} finally {
		cfRelease(source);
	}
}

export function createKeyboardEvent(keyCode: number, keyDown: boolean): CGEventRef {
	const source = createEventSource();
	try {
		const event = CGEventCreateKeyboardEvent(source, keyCode, keyDown);
		if (event === null) {
			throw new Error("CGEventCreateKeyboardEvent returned null");
		}
		stampEvent(event);
		return event;
	} finally {
		cfRelease(source);
	}
}

// Pixels per scroll "unit" — browsers (Chrome) honor PIXEL-unit scroll events but
// often ignore small LINE-unit ones, so amounts are delivered as pixels.
const SCROLL_PIXELS_PER_UNIT = 12;

export function createScrollEvent(deltaX: number, deltaY: number): CGEventRef {
	const source = createEventSource();
	try {
		const event = CGEventCreateScrollWheelEvent(
			source,
			K_CG_SCROLL_EVENT_UNIT_PIXEL,
			2,
			Math.round(deltaY * SCROLL_PIXELS_PER_UNIT),
			Math.round(deltaX * SCROLL_PIXELS_PER_UNIT),
		);
		if (event === null) {
			throw new Error("CGEventCreateScrollWheelEvent returned null");
		}
		// kCGScrollWheelEventIsContinuous (field 88): mark this as a continuous
		// (trackpad-style) scroll. Chrome and other apps ignore non-continuous
		// synthetic wheel events, so without this the page doesn't move.
		setIntegerValueField(event, 88, 1);
		stampEvent(event);
		return event;
	} finally {
		cfRelease(source);
	}
}

export function createCursorEvent(): CGEventRef {
	const event = CGEventCreate(null);
	if (event === null) {
		throw new Error("CGEventCreate returned null");
	}
	return event;
}

export function setUnicodeString(event: CGEventRef, text: string): void {
	CGEventKeyboardSetUnicodeString(event, text.length, text);
}

export function setFlags(event: CGEventRef, flags: number): void {
	CGEventSetFlags(event, flags);
}

export function setEventType(event: CGEventRef, eventType: number): void {
	CGEventSetType(event, eventType);
}

export function setIntegerValueField(event: CGEventRef, field: number, value: number): void {
	CGEventSetIntegerValueField(event, field, value);
}

export function setLocation(event: CGEventRef, position: CGPoint): void {
	CGEventSetLocation(event, position);
}

export function getLocation(event: CGEventRef): CGPoint {
	return CGEventGetLocation(event);
}

/** Global HID input, attended delivery only: the event reaches whatever app is in front, under the real pointer. */
export function postToHidEventTap(event: CGEventRef): void {
	requireAttendedHostDelivery("global-input");
	CGEventPost(K_CG_HID_EVENT_TAP, event);
}

export function stampEvent(event: CGEventRef): void {
	CGEventSetTimestamp(event, currentUptimeNanoseconds());
}

/** Moves the real pointer, attended delivery only. */
export function warpCursorPosition(position: CGPoint): void {
	requireAttendedHostDelivery("physical-pointer");
	CGWarpMouseCursorPosition(position);
}

function createEventSource(): CGEventSourceRef {
	const source = CGEventSourceCreate(K_CG_EVENT_SOURCE_STATE_HID_SYSTEM_STATE);
	if (source === null) {
		throw new Error("CGEventSourceCreate returned null");
	}
	return source;
}
