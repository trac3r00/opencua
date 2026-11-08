import type { KoffiFunc } from "koffi";
import { denyHostInteraction } from "../../computer/host-interaction-policy.js";
import type { CGEventRef, CGPoint } from "./coregraphics-types.js";
import { koffi } from "./koffi.js";

export interface SkyLightTargetWindow {
	readonly id: number;
	/** Verified notification layer, retained to skip document-window activation priming. */
	readonly layer?: number;
	readonly bounds: {
		readonly x: number;
		readonly y: number;
		readonly width: number;
		readonly height: number;
	};
}

export interface FocusRestoreToken {
	readonly previousPsn: Buffer;
	/** Process serial number the lease focused, so the holder can tell whether it still holds focus. */
	readonly targetPsn: Buffer;
}

const skyLight = koffi.load("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight");
const coreGraphics = koffi.load("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics");
const objc = koffi.load("/usr/lib/libobjc.A.dylib");
const CG_POINT = koffi.struct("SLCGPoint", { x: "double", y: "double" });

/** Background per-process delivery: the event reaches one app without the HID stream, focus or the pointer. */
const SLEventPostToPid = skyLight.func("SLEventPostToPid", "void", ["int32_t", "void *"]) as KoffiFunc<
	(pid: number, event: CGEventRef) => void
>;

const SLEventSetAuthenticationMessage = skyLight.func("SLEventSetAuthenticationMessage", "void", [
	"void *",
	"void *",
]) as KoffiFunc<(event: CGEventRef, message: object) => void>;

const SLEventSetIntegerValueField = skyLight.func("SLEventSetIntegerValueField", "void", [
	"void *",
	"uint32_t",
	"int64_t",
]) as KoffiFunc<(event: CGEventRef, field: number, value: number) => void>;

const CGEventSetWindowLocation = skyLight.func("CGEventSetWindowLocation", "void", ["void *", CG_POINT]) as KoffiFunc<
	(event: CGEventRef, point: CGPoint) => void
>;

const CGSMainConnectionID = skyLight.func("CGSMainConnectionID", "uint32_t", []) as KoffiFunc<() => number>;

const SLPSPostEventRecordTo = skyLight.func("SLPSPostEventRecordTo", "int32_t", ["void *", "void *"]) as KoffiFunc<
	(psn: Buffer, eventRecord: object) => number
>;

const _SLPSGetFrontProcess = skyLight.func("_SLPSGetFrontProcess", "int32_t", ["void *"]) as KoffiFunc<
	(psn: Buffer) => number
>;

const SLSGetWindowOwner = skyLight.func("SLSGetWindowOwner", "int32_t", [
	"uint32_t",
	"uint32_t",
	"_Out_ uint32_t *",
]) as KoffiFunc<(connection: number, windowId: number, ownerConnection: number[]) => number>;

const SLSGetConnectionPSN = skyLight.func("SLSGetConnectionPSN", "int32_t", ["uint32_t", "void *"]) as KoffiFunc<
	(connection: number, psn: Buffer) => number
>;

const CGEventPostToPSN = coreGraphics.func("CGEventPostToPSN", "void", ["void *", "void *"]) as KoffiFunc<
	(psn: Buffer, event: CGEventRef) => void
>;

const objcGetClass = objc.func("objc_getClass", "void *", ["str"]) as KoffiFunc<(name: string) => object | null>;
const selRegisterName = objc.func("sel_registerName", "void *", ["str"]) as KoffiFunc<(name: string) => object | null>;
const objcMsgSendAuthenticationMessage = objc.func("objc_msgSend", "void *", [
	"void *",
	"void *",
	"void *",
	"int32_t",
	"uint32_t",
]) as KoffiFunc<
	(receiver: object, selector: object, eventRecord: object, pid: number, version: number) => object | null
>;

const authenticationMessageClass = objcGetClass("SLSEventAuthenticationMessage");
const authenticationMessageSelector = selRegisterName("messageWithEventRecord:pid:version:");

/** CGS event types, which share CGEventType's numbering for the mouse events we synthesize. */
export const CGS_EVENT_LEFT_MOUSE_DOWN = 1;
export const CGS_EVENT_LEFT_MOUSE_UP = 2;
export const CGS_EVENT_LEFT_MOUSE_DRAGGED = 6;

const EVENT_RECORD_LENGTH = 0xf8;
const RECORD_LENGTH_OFFSET = 0x04;
const RECORD_TYPE_OFFSET = 0x08;
const RECORD_LOCATION_OFFSET = 0x10;
const RECORD_WINDOW_LOCATION_OFFSET = 0x20;
const RECORD_FLAG_OFFSET = 0x3a;
const RECORD_WINDOW_ID_OFFSET = 0x3c;
const RECORD_FLAG_VALUE = 0x10;

/**
 * One synthesized mouse event as the window server reads it: a fixed-length record addressed to
 * a window, with the pointer located globally and in window coordinates. Written by hand because
 * the layout is the documented yabai one; every field stays inside the buffer, so a wrong value
 * is a no-op rather than a crash. Exported for its own unit test — the layout is the contract.
 */
export function buildMouseEventRecord(window: SkyLightTargetWindow, eventType: number, location: CGPoint): Buffer {
	const record = Buffer.alloc(EVENT_RECORD_LENGTH);
	record[RECORD_LENGTH_OFFSET] = EVENT_RECORD_LENGTH;
	record[RECORD_FLAG_OFFSET] = RECORD_FLAG_VALUE;
	record[RECORD_TYPE_OFFSET] = eventType;
	record.writeUInt32LE(window.id, RECORD_WINDOW_ID_OFFSET);
	record.writeDoubleLE(location.x, RECORD_LOCATION_OFFSET);
	record.writeDoubleLE(location.y, RECORD_LOCATION_OFFSET + 8);
	record.writeDoubleLE(location.x - window.bounds.x, RECORD_WINDOW_LOCATION_OFFSET);
	record.writeDoubleLE(location.y - window.bounds.y, RECORD_WINDOW_LOCATION_OFFSET + 8);
	return record;
}

/**
 * The foreground transport (it brings the target process forward) stays forbidden on the host.
 */
export function postMouseEventRecordToWindow(
	_window: SkyLightTargetWindow,
	_eventType: number,
	_location: CGPoint,
): boolean {
	return denyHostInteraction("host-focus");
}

export function postSkyLightEventToPid(pid: number, event: CGEventRef): void {
	SLEventPostToPid(pid, event);
}

export function postAuthenticatedSkyLightEventToPid(pid: number, event: CGEventRef): boolean {
	const message = authenticationMessage(pid, event);
	if (message === null) {
		return false;
	}
	SLEventSetAuthenticationMessage(event, message);
	SLEventPostToPid(pid, event);
	return true;
}

export function setSkyLightIntegerField(event: CGEventRef, field: number, value: number): void {
	SLEventSetIntegerValueField(event, field, value);
}

export function setSkyLightWindowLocation(event: CGEventRef, point: CGPoint): void {
	CGEventSetWindowLocation(event, point);
}

export function activateWindowWithoutRaise(_window: SkyLightTargetWindow): boolean {
	return denyHostInteraction("host-focus");
}

/**
 * Synthesized activation changes which app believes it is active, so it stays forbidden on the host.
 */
export function setProcessAppActive(_psn: Buffer, _windowId: number, _active: boolean): boolean {
	return denyHostInteraction("host-focus");
}

export function beginFocusWithoutRaise(_window: SkyLightTargetWindow): FocusRestoreToken | null {
	return denyHostInteraction("host-focus");
}

/** The process that is frontmost right now, or null when the query fails. */
export function frontProcessSerialNumber(): Buffer | null {
	const frontProcess = Buffer.alloc(8);
	return _SLPSGetFrontProcess(frontProcess) === 0 ? frontProcess : null;
}

/**
 * Who is frontmost before background input reaches `window`, so a target app that activates itself
 * in response (Finder's Go to Folder panel does) can be sent back behind the person's app. Null
 * when the target already is frontmost or either process cannot be resolved.
 */
export function focusGuardFor(window: SkyLightTargetWindow): FocusRestoreToken | null {
	const previousPsn = frontProcessSerialNumber();
	const targetPsn = processSerialNumberForWindow(window.id);
	if (previousPsn === null || targetPsn === null || previousPsn.equals(targetPsn)) {
		return null;
	}
	return { previousPsn, targetPsn };
}

export function processSerialNumbersMatch(left: Buffer, right: Buffer): boolean {
	return left.equals(right);
}

export function restoreFrontProcessNoWindows(_token: FocusRestoreToken): boolean {
	return denyHostInteraction("host-focus");
}

export function postCoreGraphicsEventToWindowOwner(window: SkyLightTargetWindow, event: CGEventRef): boolean {
	const targetPsn = processSerialNumberForWindow(window.id);
	if (targetPsn === null) {
		return false;
	}
	CGEventPostToPSN(targetPsn, event);
	return true;
}

/** Post a window-stamped event record without activating a process or using global input. */
export function postBackgroundEventRecordToWindowOwner(window: SkyLightTargetWindow, event: CGEventRef): boolean {
	const targetPsn = processSerialNumberForWindow(window.id);
	if (targetPsn === null) {
		return false;
	}
	const record = eventRecord(event);
	if (record === null) {
		return false;
	}
	if (
		koffi.decode(record, RECORD_LENGTH_OFFSET, "uint32_t") !== EVENT_RECORD_LENGTH ||
		koffi.decode(record, RECORD_WINDOW_ID_OFFSET, "uint32_t") !== window.id
	) {
		return false;
	}
	return SLPSPostEventRecordTo(targetPsn, record) === 0;
}

function processSerialNumberForWindow(windowId: number): Buffer | null {
	const ownerConnection = [0];
	if (SLSGetWindowOwner(CGSMainConnectionID(), windowId, ownerConnection) !== 0) {
		return null;
	}
	const [connection] = ownerConnection;
	if (connection === undefined) {
		return null;
	}

	const targetPsn = Buffer.alloc(8);
	return SLSGetConnectionPSN(connection, targetPsn) === 0 ? targetPsn : null;
}

function authenticationMessage(pid: number, event: CGEventRef): object | null {
	if (authenticationMessageClass === null || authenticationMessageSelector === null) {
		return null;
	}
	const record = eventRecord(event);
	if (record === null) {
		return null;
	}
	return objcMsgSendAuthenticationMessage(authenticationMessageClass, authenticationMessageSelector, record, pid, 0);
}

function eventRecord(event: CGEventRef): object | null {
	for (const offset of [24, 32, 16]) {
		const pointer = koffi.decode(event, offset, "void *") as object | null;
		if (pointer !== null) {
			return pointer;
		}
	}
	return null;
}
