import type { KoffiFunc } from "koffi";
import type { DisplayInventoryEntry, DisplaySpaceEntry } from "../../accessibility/types.js";
import { activeSpacesByDisplay } from "../display-placement.js";
import { type CFTypeRef, cfRelease, fromCFString } from "./corefoundation.js";
import { koffi } from "./koffi.js";
import { managedDisplaySpaces } from "./sls-spaces.js";

const coreGraphics = koffi.load("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics");
const CG_POINT = koffi.struct("CGPointForDisplayList", { x: "double", y: "double" });
const CG_SIZE = koffi.struct("CGSizeForDisplayList", { width: "double", height: "double" });
const CG_RECT = koffi.struct("CGRectForDisplayList", { origin: CG_POINT, size: CG_SIZE });

const CGGetOnlineDisplayList = coreGraphics.func("CGGetOnlineDisplayList", "int32_t", [
	"uint32_t",
	"void *",
	"void *",
]) as KoffiFunc<(maxDisplays: number, displays: Buffer | null, displayCount: Buffer) => number>;

const CGDisplayBounds = coreGraphics.func("CGDisplayBounds", CG_RECT, ["uint32_t"]) as KoffiFunc<
	(display: number) => {
		readonly origin: { readonly x: number; readonly y: number };
		readonly size: { readonly width: number; readonly height: number };
	}
>;
const CGDisplayPixelsWide = coreGraphics.func("CGDisplayPixelsWide", "size_t", ["uint32_t"]) as KoffiFunc<
	(display: number) => number
>;
const CGDisplayPixelsHigh = coreGraphics.func("CGDisplayPixelsHigh", "size_t", ["uint32_t"]) as KoffiFunc<
	(display: number) => number
>;
const CGMainDisplayID = coreGraphics.func("CGMainDisplayID", "uint32_t", []) as KoffiFunc<() => number>;
const colorSync = koffi.load("/System/Library/Frameworks/ColorSync.framework/ColorSync");
const CGDisplayCreateUUIDFromDisplayID = colorSync.func("CGDisplayCreateUUIDFromDisplayID", "void *", [
	"uint32_t",
]) as KoffiFunc<(display: number) => CFTypeRef | null>;
const coreFoundation = koffi.load("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation");
const CFUUIDCreateString = coreFoundation.func("CFUUIDCreateString", "void *", ["void *", "void *"]) as KoffiFunc<
	(allocator: null, uuid: CFTypeRef) => CFTypeRef | null
>;

const DISPLAY_ID_BYTES = 4;

/**
 * The bounds of every online display (awake, asleep or mirrored) in global points with a top-left origin, the
 * coordinates the window list uses. Undefined when the list cannot be read, names no display, or a display appeared
 * while it was read: callers must then treat the layout as unknown.
 */
export function onlineDisplayInfo(): readonly DisplayInventoryEntry[] | undefined {
	try {
		const mainDisplayId = CGMainDisplayID();
		const count = Buffer.alloc(DISPLAY_ID_BYTES);
		if (CGGetOnlineDisplayList(0, null, count) !== 0) {
			return undefined;
		}
		// One slot more than reported: a list that fills it grew in between, and could have grown further.
		const capacity = count.readUInt32LE(0) + 1;
		const ids = Buffer.alloc(capacity * DISPLAY_ID_BYTES);
		if (CGGetOnlineDisplayList(capacity, ids, count) !== 0) {
			return undefined;
		}
		const found = count.readUInt32LE(0);
		if (found === 0 || found >= capacity) {
			return undefined;
		}
		const displays: DisplayInventoryEntry[] = [];
		for (let index = 0; index < found; index += 1) {
			const id = ids.readUInt32LE(index * DISPLAY_ID_BYTES);
			const { origin, size } = CGDisplayBounds(id);
			const horizontalScale = size.width > 0 ? CGDisplayPixelsWide(id) / size.width : 1;
			const verticalScale = size.height > 0 ? CGDisplayPixelsHigh(id) / size.height : 1;
			const scaleFactor = Math.max(1, Math.round((horizontalScale + verticalScale) / 2));
			displays.push({
				id,
				isMain: id === mainDisplayId,
				x: origin.x,
				y: origin.y,
				width: size.width,
				height: size.height,
				scaleFactor: Math.max(1, scaleFactor),
			});
		}
		return displays;
	} catch {
		return undefined;
	}
}

/** A display's UUID, the name the WindowServer's Space listing gives it; undefined when it cannot be read. */
function displayUuid(id: number): string | undefined {
	const uuid = CGDisplayCreateUUIDFromDisplayID(id);
	if (uuid === null) return undefined;
	try {
		const text = CFUUIDCreateString(null, uuid);
		if (text === null) return undefined;
		try {
			return fromCFString(text);
		} finally {
			cfRelease(text);
		}
	} finally {
		cfRelease(uuid);
	}
}

/** Every online display with the Space it shows now; undefined when the display layout cannot be read. */
export function onlineDisplaysWithSpaces(): readonly DisplaySpaceEntry[] | undefined {
	const displays = onlineDisplayInfo();
	if (displays === undefined) return undefined;
	const active = activeSpacesByDisplay(
		displays.map(({ id }) => id),
		displayUuid,
		managedDisplaySpaces(),
	);
	return displays.map((display) => {
		const activeSpaceId = active.get(display.id);
		return activeSpaceId === undefined ? display : { ...display, activeSpaceId };
	});
}

/** Legacy bounds view retained for the input gesture lane. */
export function onlineDisplayBounds():
	| readonly { readonly x: number; readonly y: number; readonly width: number; readonly height: number }[]
	| undefined {
	return onlineDisplayInfo()?.map(({ x = 0, y = 0, width, height }) => ({ x, y, width, height }));
}
