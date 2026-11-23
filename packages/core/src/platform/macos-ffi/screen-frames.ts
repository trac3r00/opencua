import type { KoffiFunc } from "koffi";
import type { Rect } from "../../types/index.js";
import { koffi } from "./koffi.js";

const appKit = koffi.load("/System/Library/Frameworks/AppKit.framework/AppKit");
const objc = koffi.load("/usr/lib/libobjc.A.dylib");
const CG_POINT = koffi.struct("CGPointForScreenFrames", { x: "double", y: "double" });
const CG_SIZE = koffi.struct("CGSizeForScreenFrames", { width: "double", height: "double" });
const CG_RECT = koffi.struct("CGRectForScreenFrames", { origin: CG_POINT, size: CG_SIZE });

interface CocoaRect {
	readonly origin: { readonly x: number; readonly y: number };
	readonly size: { readonly width: number; readonly height: number };
}

const objcGetClass = objc.func("objc_getClass", "void *", ["str"]) as KoffiFunc<(name: string) => object | null>;
const selRegisterName = objc.func("sel_registerName", "void *", ["str"]) as KoffiFunc<(name: string) => object | null>;
const msgSendObject = objc.func("objc_msgSend", "void *", ["void *", "void *"]) as KoffiFunc<
	(receiver: object, selector: object) => object | null
>;
const msgSendCount = objc.func("objc_msgSend", "uint64_t", ["void *", "void *"]) as KoffiFunc<
	(receiver: object, selector: object) => number
>;
const msgSendAtIndex = objc.func("objc_msgSend", "void *", ["void *", "void *", "uint64_t"]) as KoffiFunc<
	(receiver: object, selector: object, index: number) => object | null
>;
const msgSendRect = objc.func("objc_msgSend", CG_RECT, ["void *", "void *"]) as KoffiFunc<
	(receiver: object, selector: object) => CocoaRect
>;

void appKit;

/** One screen's whole frame and the part windows may use (without the menu bar and Dock), top-left global points. */
export interface ScreenFrames {
	readonly frame: Rect;
	readonly visible: Rect;
}

/**
 * Every screen's frame and visible frame, in the top-left global points windows and set_window_frame use, the screen
 * with the menu bar first. Undefined when AppKit cannot answer.
 */
export function visibleScreenFrames(): readonly ScreenFrames[] | undefined {
	try {
		const screenClass = objcGetClass("NSScreen");
		const screensSelector = selRegisterName("screens");
		const countSelector = selRegisterName("count");
		const atIndexSelector = selRegisterName("objectAtIndex:");
		const frameSelector = selRegisterName("frame");
		const visibleSelector = selRegisterName("visibleFrame");
		if (
			screenClass === null ||
			screensSelector === null ||
			countSelector === null ||
			atIndexSelector === null ||
			frameSelector === null ||
			visibleSelector === null
		) {
			return undefined;
		}
		const screens = msgSendObject(screenClass, screensSelector);
		if (screens === null) {
			return undefined;
		}
		const cocoa: { readonly frame: CocoaRect; readonly visible: CocoaRect }[] = [];
		const count = Number(msgSendCount(screens, countSelector));
		for (let index = 0; index < count; index += 1) {
			const screen = msgSendAtIndex(screens, atIndexSelector, index);
			if (screen !== null) {
				cocoa.push({ frame: msgSendRect(screen, frameSelector), visible: msgSendRect(screen, visibleSelector) });
			}
		}
		const primary = cocoa[0];
		if (primary === undefined) {
			return undefined;
		}
		// Cocoa measures up from the bottom of the menu bar screen; windows are placed down from its top.
		const flip = (rect: CocoaRect): Rect => ({
			x: rect.origin.x,
			y: primary.frame.size.height - (rect.origin.y + rect.size.height),
			width: rect.size.width,
			height: rect.size.height,
		});
		return cocoa.map(({ frame, visible }) => ({ frame: flip(frame), visible: flip(visible) }));
	} catch {
		return undefined;
	}
}
