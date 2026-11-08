import { setTimeout as sleep } from "node:timers/promises";
import type { KoffiFunc } from "koffi";
import type { Rect } from "../types/index.js";
import {
	type AXUIElementRef,
	copyAttributeValue,
	createApplicationElement,
	releaseAXElement,
	setAttributeValue,
} from "./macos-ffi/accessibility.js";
import { type CFTypeRef, cfArrayLength, cfArrayValueAt, cfRelease, cfRetain } from "./macos-ffi/corefoundation.js";
import { koffi } from "./macos-ffi/koffi.js";
import { openWindowsForTargeting } from "./macos-open-windows.js";

const VERIFY_TOLERANCE_POINTS = 2;
const VERIFY_TIMEOUT_MILLISECONDS = 1_000;
const VERIFY_POLL_MILLISECONDS = 40;
const AX_VALUE_CG_POINT = 1;
const AX_VALUE_CG_SIZE = 2;

const applicationServices = koffi.load("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices");
const AX_UI_ELEMENT_REF = koffi.pointer("AXUIElementRefForWindowFrame", koffi.opaque());
const AX_VALUE_REF = koffi.pointer("AXValueRefForWindowFrame", koffi.opaque());
const AXValueCreate = applicationServices.func("AXValueCreate", AX_VALUE_REF, ["int32_t", "void *"]) as KoffiFunc<
	(type: number, value: Buffer) => CFTypeRef | null
>;
const AXUIElementGetWindow = applicationServices.func("_AXUIElementGetWindow", "int32_t", [
	AX_UI_ELEMENT_REF,
	"_Out_ uint32_t *",
]) as KoffiFunc<(element: AXUIElementRef, windowId: Uint32Array) => number>;

export interface WindowFrameDependencies {
	findWindowElement(pid: number, windowId: number): AXUIElementRef | null;
	setPosition(element: AXUIElementRef, x: number, y: number): void;
	setSize(element: AXUIElementRef, width: number, height: number): void;
	release(element: AXUIElementRef): void;
	windowFrames(): Promise<readonly { readonly id: number; readonly pid?: number; readonly frame: Rect }[]>;
	now(): number;
	delay(milliseconds: number): Promise<void>;
}

export interface SetWindowFrameResult {
	readonly requested: Rect;
	readonly applied: Rect | null;
	readonly verified: boolean;
	readonly attempts: number;
}

export async function setWindowFrame(
	pid: number,
	windowId: number,
	requested: Rect,
	dependencies: WindowFrameDependencies = nativeWindowFrameDependencies,
): Promise<SetWindowFrameResult> {
	validateFrame(requested);
	const initialFrames = await dependencies.windowFrames();
	const initial = initialFrames.find((window) => window.id === windowId);
	if (initial === undefined) {
		throw new Error(`set_window_frame: window_id ${windowId} is closed, stale, or unknown to WindowServer`);
	}
	if (initial.pid !== undefined && initial.pid !== pid) {
		throw new Error(`set_window_frame: window_id ${windowId} belongs to pid ${initial.pid}, not pid ${pid}`);
	}

	const element = dependencies.findWindowElement(pid, windowId);
	if (element === null) {
		throw new Error(`set_window_frame: window_id ${windowId} belongs to pid ${pid} but has no matching AXWindow`);
	}
	let attempts = 0;
	try {
		applyCorrections(element, requested, null, dependencies);
		attempts += 1;
		const deadline = dependencies.now() + VERIFY_TIMEOUT_MILLISECONDS;
		while (true) {
			const frame = (await dependencies.windowFrames()).find((window) => window.id === windowId)?.frame ?? null;
			if (frame !== null && framesApproximatelyEqual(requested, frame)) {
				return { requested: { ...requested }, applied: { ...frame }, verified: true, attempts };
			}
			if (dependencies.now() >= deadline) {
				return {
					requested: { ...requested },
					applied: frame === null ? null : { ...frame },
					verified: false,
					attempts,
				};
			}
			applyCorrections(element, requested, frame, dependencies);
			attempts += 1;
			await dependencies.delay(VERIFY_POLL_MILLISECONDS);
		}
	} finally {
		dependencies.release(element);
	}
}

export function framesApproximatelyEqual(expected: Rect, observed: Rect, tolerance = VERIFY_TOLERANCE_POINTS): boolean {
	return (
		positionApproximatelyEqual(expected, observed, tolerance) && sizeApproximatelyEqual(expected, observed, tolerance)
	);
}

function validateFrame(frame: Rect): void {
	if (
		!Number.isFinite(frame.x) ||
		!Number.isFinite(frame.y) ||
		!Number.isFinite(frame.width) ||
		!Number.isFinite(frame.height) ||
		frame.width <= 0 ||
		frame.height <= 0
	) {
		throw new Error("set_window_frame: x/y must be finite and width/height must be finite positive numbers");
	}
}

function applyCorrections(
	element: AXUIElementRef,
	requested: Rect,
	observed: Rect | null,
	dependencies: WindowFrameDependencies,
): void {
	if (observed === null || !positionApproximatelyEqual(requested, observed, VERIFY_TOLERANCE_POINTS)) {
		dependencies.setPosition(element, requested.x, requested.y);
	}
	if (observed === null || !sizeApproximatelyEqual(requested, observed, VERIFY_TOLERANCE_POINTS)) {
		dependencies.setSize(element, requested.width, requested.height);
	}
}

function positionApproximatelyEqual(expected: Rect, observed: Rect, tolerance: number): boolean {
	return Math.abs(expected.x - observed.x) <= tolerance && Math.abs(expected.y - observed.y) <= tolerance;
}

function sizeApproximatelyEqual(expected: Rect, observed: Rect, tolerance: number): boolean {
	return (
		Math.abs(expected.width - observed.width) <= tolerance && Math.abs(expected.height - observed.height) <= tolerance
	);
}

function findNativeWindowElement(pid: number, windowId: number): AXUIElementRef | null {
	const application = createApplicationElement(pid);
	try {
		let windowsValue: CFTypeRef | null;
		try {
			windowsValue = copyAttributeValue(application, "AXWindows");
		} catch {
			return null;
		}
		if (windowsValue === null) {
			return null;
		}
		try {
			for (let index = 0; index < cfArrayLength(windowsValue); index += 1) {
				const window = cfArrayValueAt(windowsValue, index);
				if (window !== null && nativeWindowId(window) === windowId) {
					return cfRetain(window);
				}
			}
			return null;
		} finally {
			cfRelease(windowsValue);
		}
	} finally {
		releaseAXElement(application);
	}
}

function nativeWindowId(element: AXUIElementRef): number | null {
	const output = new Uint32Array(1);
	return AXUIElementGetWindow(element, output) === 0 ? (output[0] ?? null) : null;
}

function setNativePair(
	element: AXUIElementRef,
	attribute: "AXPosition" | "AXSize",
	type: number,
	a: number,
	b: number,
): void {
	const pair = Buffer.alloc(16);
	pair.writeDoubleLE(a, 0);
	pair.writeDoubleLE(b, 8);
	const value = AXValueCreate(type, pair);
	if (value === null) {
		throw new Error(`set_window_frame: AXValueCreate returned null for ${attribute}`);
	}
	try {
		setAttributeValue(element, attribute, value);
	} finally {
		cfRelease(value);
	}
}

const nativeWindowFrameDependencies: WindowFrameDependencies = {
	findWindowElement: findNativeWindowElement,
	setPosition: (element, x, y) => setNativePair(element, "AXPosition", AX_VALUE_CG_POINT, x, y),
	setSize: (element, width, height) => setNativePair(element, "AXSize", AX_VALUE_CG_SIZE, width, height),
	release: releaseAXElement,
	windowFrames: async () =>
		(await openWindowsForTargeting()).map((window) => ({
			id: window.id,
			...(window.owner?.processId === undefined ? {} : { pid: window.owner.processId }),
			frame: { ...window.bounds },
		})),
	now: () => Date.now(),
	delay: async (milliseconds) => await sleep(milliseconds),
};
