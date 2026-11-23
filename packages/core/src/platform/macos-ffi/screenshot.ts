import type { KoffiFunc } from "koffi";
import type { Rect } from "../../types/index.js";
import { CaptureMaskedError, maskedCaptureWindows } from "../capture-mask.js";
import { type CFTypeRef, cfRelease, toCFString, withCFString } from "./corefoundation.js";
import { koffi } from "./koffi.js";
import {
	captureMainDisplayPngViaSck,
	captureWindowViaSck,
	captureWindowViaSckAsync,
	getSckitLoadError,
	isSckitAvailable,
} from "./sckit.js";
import { listWindows } from "./window-list.js";
import { findRunningApplication } from "./workspace.js";

type CGImageRef = CFTypeRef;
type CGImageDestinationRef = CFTypeRef;
type CFMutableDataRef = CFTypeRef;
type CFNumberRef = CFTypeRef;
type CFMutableDictionaryRef = CFTypeRef;

type CGPoint = { x: number; y: number };
type CGSize = { width: number; height: number };
type CGRect = { origin: CGPoint; size: CGSize };
type CFRange = { location: number; length: number };

const CG_POINT = koffi.struct("CGPointForScreenshot", { x: "double", y: "double" });
const CG_SIZE = koffi.struct("CGSize", { width: "double", height: "double" });
const CG_RECT = koffi.struct("CGRect", { origin: CG_POINT, size: CG_SIZE });
const CF_RANGE = koffi.struct("CFRange", { location: "long", length: "long" });

const CG_IMAGE_REF = koffi.pointer("CGImageRef", koffi.opaque());
const CG_IMAGE_DESTINATION_REF = koffi.pointer("CGImageDestinationRef", koffi.opaque());
const CF_MUTABLE_DATA_REF = koffi.pointer("CFMutableDataRef", koffi.opaque());
const CF_MUTABLE_DICTIONARY_REF = koffi.pointer("CFMutableDictionaryRef", koffi.opaque());
const CF_NUMBER_REF = koffi.pointer("CFNumberRef", koffi.opaque());

const coreGraphics = koffi.load("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics");
const imageIO = koffi.load("/System/Library/Frameworks/ImageIO.framework/ImageIO");
const coreFoundation = koffi.load("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation");

const CGPreflightScreenCaptureAccess = coreGraphics.func("CGPreflightScreenCaptureAccess", "bool", []) as KoffiFunc<
	() => boolean
>;

/**
 * Whether this process may capture the screen. Unlike a capture attempt, the preflight never raises
 * macOS's permission prompt, so a server without Screen Recording can decline pixels quietly instead
 * of putting a system dialog over the person's work in the middle of a task.
 */
export function screenCaptureAllowed(): boolean {
	return CGPreflightScreenCaptureAccess();
}

const PNG_UNIFORM_TYPE = "public.png";
const JPEG_UNIFORM_TYPE = "public.jpeg";
const MAX_PIXEL_SIZE_KEY = "kCGImageDestinationImageMaxPixelSize";
const LOSSY_QUALITY_KEY = "kCGImageDestinationLossyCompressionQuality";
const CF_NUMBER_INT_TYPE = 9;
const CF_NUMBER_DOUBLE_TYPE = 13;
const SCK_WINDOW_DEFAULT_QUALITY = 100;

const CGMainDisplayID = coreGraphics.func("CGMainDisplayID", "uint32_t", []) as KoffiFunc<() => number>;

const CGDisplayBounds = coreGraphics.func("CGDisplayBounds", CG_RECT, ["uint32_t"]) as KoffiFunc<
	(displayId: number) => CGRect
>;

const CGDisplayCreateImage = coreGraphics.func("CGDisplayCreateImage", CG_IMAGE_REF, ["uint32_t"]) as KoffiFunc<
	(displayId: number) => CGImageRef | null
>;

const CGImageCreateWithImageInRect = coreGraphics.func("CGImageCreateWithImageInRect", CG_IMAGE_REF, [
	CG_IMAGE_REF,
	CG_RECT,
]) as KoffiFunc<(image: CGImageRef, rect: CGRect) => CGImageRef | null>;

const CGImageGetWidth = coreGraphics.func("CGImageGetWidth", "size_t", [CG_IMAGE_REF]) as KoffiFunc<
	(image: CGImageRef) => number
>;

const CGImageGetHeight = coreGraphics.func("CGImageGetHeight", "size_t", [CG_IMAGE_REF]) as KoffiFunc<
	(image: CGImageRef) => number
>;

const CGImageDestinationCreateWithData = imageIO.func("CGImageDestinationCreateWithData", CG_IMAGE_DESTINATION_REF, [
	"void *",
	"void *",
	"size_t",
	"void *",
]) as KoffiFunc<
	(data: CFMutableDataRef, type: CFTypeRef, count: number, options: null) => CGImageDestinationRef | null
>;

const CGImageDestinationAddImage = imageIO.func("CGImageDestinationAddImage", "void", [
	CG_IMAGE_DESTINATION_REF,
	CG_IMAGE_REF,
	CF_MUTABLE_DICTIONARY_REF,
]) as KoffiFunc<
	(destination: CGImageDestinationRef, image: CGImageRef, properties: CFMutableDictionaryRef | null) => void
>;

const CGImageDestinationFinalize = imageIO.func("CGImageDestinationFinalize", "bool", [
	CG_IMAGE_DESTINATION_REF,
]) as KoffiFunc<(destination: CGImageDestinationRef) => boolean>;

const CFDataCreateMutable = coreFoundation.func("CFDataCreateMutable", CF_MUTABLE_DATA_REF, [
	"void *",
	"long",
]) as KoffiFunc<(allocator: null, capacity: number) => CFMutableDataRef | null>;

const CFDataGetLength = coreFoundation.func("CFDataGetLength", "long", ["void *"]) as KoffiFunc<
	(data: CFMutableDataRef) => number
>;

const CFDataGetBytes = coreFoundation.func("CFDataGetBytes", "void", ["void *", CF_RANGE, "char *"]) as KoffiFunc<
	(data: CFMutableDataRef, range: CFRange, buffer: Buffer) => void
>;

const CFDictionaryCreateMutable = coreFoundation.func("CFDictionaryCreateMutable", CF_MUTABLE_DICTIONARY_REF, [
	"void *",
	"long",
	"void *",
	"void *",
]) as KoffiFunc<
	(allocator: null, capacity: number, keyCallBacks: null, valueCallBacks: null) => CFMutableDictionaryRef | null
>;

const CFDictionarySetValue = coreFoundation.func("CFDictionarySetValue", "void", [
	CF_MUTABLE_DICTIONARY_REF,
	"void *",
	"void *",
]) as KoffiFunc<(dict: CFMutableDictionaryRef, key: CFTypeRef, value: CFTypeRef) => void>;

const CFNumberCreate = coreFoundation.func("CFNumberCreate", CF_NUMBER_REF, ["void *", "int", "void *"]) as KoffiFunc<
	(allocator: null, numberType: number, valuePtr: Buffer) => CFNumberRef | null
>;

export type CapturedScreenshot = {
	readonly data: Buffer;
	readonly width: number;
	readonly height: number;
};

export type CapturedWindow = {
	readonly data: Buffer;
};

export function captureWindowPng(windowId: number, maxWidth: number, maxHeight: number): CapturedWindow {
	return captureWindowImage(windowId, maxWidth, maxHeight, "png", SCK_WINDOW_DEFAULT_QUALITY);
}

/**
 * Window capture in the requested encoding. Callers that show the image to a model want
 * JPEG, which is far smaller than PNG for a Retina window; PNG is the lossless default.
 */
export function captureWindowImage(
	windowId: number,
	maxWidth: number,
	maxHeight: number,
	format: "png" | "jpeg",
	quality: number,
): CapturedWindow {
	assertWindowCaptureArguments(windowId, maxWidth, maxHeight);
	const data = captureWindowViaSck(windowId, maxWidth, maxHeight, format, clampQuality(quality));
	if (data === null) {
		throw new Error(`Native ScreenCaptureKit window capture is unavailable: ${getSckitLoadError()}`);
	}
	return { data };
}

/** captureWindowImage without blocking this thread while ScreenCaptureKit captures. */
export async function captureWindowImageAsync(
	windowId: number,
	maxWidth: number,
	maxHeight: number,
	format: "png" | "jpeg",
	quality: number,
): Promise<CapturedWindow> {
	assertWindowCaptureArguments(windowId, maxWidth, maxHeight);
	const data = await captureWindowViaSckAsync(windowId, maxWidth, maxHeight, format, clampQuality(quality));
	if (data === null) {
		throw new Error(`Native ScreenCaptureKit window capture is unavailable: ${getSckitLoadError()}`);
	}
	return { data };
}

function assertWindowCaptureArguments(windowId: number, maxWidth: number, maxHeight: number): void {
	if (!Number.isSafeInteger(windowId) || windowId <= 0) {
		throw new Error(`captureWindowImage requires a positive integer windowId, got ${windowId}`);
	}
	if (!Number.isSafeInteger(maxWidth) || !Number.isSafeInteger(maxHeight) || maxWidth <= 0 || maxHeight <= 0) {
		throw new Error(`captureWindowImage requires positive integer dimensions, got ${maxWidth}x${maxHeight}`);
	}
}

const bundleIdOfPid = (pid: number): string | undefined => findRunningApplication(pid)?.bundleId;

/** The screencapture fallback captures any window id it is given, so a masked app's window is refused before it runs. */
export function assertWindowCaptureNotMasked(windowId: number): void {
	const window = readableWindowList({ onScreenOnly: false }).find((candidate) => candidate.id === windowId);
	if (window !== undefined && maskedCaptureWindows([window], bundleIdOfPid).length > 0) {
		throw new CaptureMaskedError(windowId);
	}
}

/** Masking needs to know which windows are up: when the list cannot be read, nothing is captured. */
function readableWindowList(options?: Parameters<typeof listWindows>[0]): NonNullable<ReturnType<typeof listWindows>> {
	const windows = listWindows(options);
	if (windows === undefined) {
		throw new Error(
			"capture refused: the window list could not be read, so password manager and authentication windows could not be masked",
		);
	}
	return windows;
}

/** CoreGraphics cannot leave a window out of a display image, so it captures nothing while a masked window is in the area. */
function assertAreaHasNoMaskedWindow(areaOf: () => Rect): void {
	const masked = maskedCaptureWindows(readableWindowList(), bundleIdOfPid);
	if (masked.length === 0) {
		return;
	}
	const area = areaOf();
	const inside = masked.find(
		({ bounds }) =>
			bounds.x < area.x + area.width &&
			area.x < bounds.x + bounds.width &&
			bounds.y < area.y + area.height &&
			area.y < bounds.y + bounds.height,
	);
	if (inside !== undefined) {
		throw new CaptureMaskedError(inside.id);
	}
}

function displayArea(displayId: number): Rect {
	const bounds = CGDisplayBounds(displayId);
	return { x: bounds.origin.x, y: bounds.origin.y, width: bounds.size.width, height: bounds.size.height };
}

function clampQuality(quality: number): number {
	return Math.min(100, Math.max(1, Math.round(quality)));
}

export function getMainDisplayId(): number {
	return CGMainDisplayID();
}

function openDisplayImage(displayId: number): CGImageRef {
	if (!Number.isSafeInteger(displayId) || displayId <= 0) {
		throw new Error(`display id must be a positive integer, got ${displayId}`);
	}
	const sourceImage = CGDisplayCreateImage(displayId);
	if (sourceImage === null) {
		throw new Error(
			`CGDisplayCreateImage returned null for display ${displayId} (check the display id and Screen Recording permission)`,
		);
	}
	return sourceImage;
}

/**
 * Converts a region in global logical points into the pixel rectangle to cut from a display
 * image, which may be captured at a different scale and may not start at the origin.
 */
export function computeDisplayCrop(
	region: Rect,
	displayBounds: {
		readonly origin: { readonly x: number; readonly y: number };
		readonly size: { readonly width: number; readonly height: number };
	},
	imageSize: { readonly width: number; readonly height: number },
): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
	if (
		!Number.isFinite(region.x) ||
		!Number.isFinite(region.y) ||
		!Number.isFinite(region.width) ||
		!Number.isFinite(region.height)
	) {
		throw new Error("region coordinates must be finite numbers");
	}
	if (region.width <= 0 || region.height <= 0) {
		throw new Error(`region must have a positive size, got ${region.width}x${region.height}`);
	}
	if (displayBounds.size.width <= 0 || displayBounds.size.height <= 0) {
		throw new Error("display bounds are empty, so the display is not active");
	}
	if (imageSize.width <= 0 || imageSize.height <= 0) {
		throw new Error("display image has no pixels");
	}

	const scaleX = imageSize.width / displayBounds.size.width;
	const scaleY = imageSize.height / displayBounds.size.height;
	const left = (region.x - displayBounds.origin.x) * scaleX;
	const top = (region.y - displayBounds.origin.y) * scaleY;
	const x = Math.max(0, Math.round(left));
	const y = Math.max(0, Math.round(top));
	const right = Math.min(imageSize.width, Math.round(left + region.width * scaleX));
	const bottom = Math.min(imageSize.height, Math.round(top + region.height * scaleY));
	if (right <= x || bottom <= y) {
		throw new Error(
			`region ${region.x},${region.y} ${region.width}x${region.height} does not overlap the display area`,
		);
	}
	return { x, y, width: right - x, height: bottom - y };
}

export type CapturedImageFormat = "png" | "jpeg";

export function captureDisplayImage(
	displayId: number,
	targetWidth: number,
	targetHeight: number,
	format: CapturedImageFormat,
	quality: number,
): CapturedScreenshot {
	if (targetWidth <= 0 || targetHeight <= 0) {
		throw new Error(`captureDisplayImage requires positive dimensions, got ${targetWidth}x${targetHeight}`);
	}

	const maxPixelSize = Math.max(Math.round(targetWidth), Math.round(targetHeight));

	// The ScreenCaptureKit helper encodes PNG only, so a JPEG request takes the CoreGraphics
	// path below. Both paths return the dimensions they actually produced.
	let sckFailure: string | undefined;
	if (format === "png" && displayId === CGMainDisplayID() && isSckitAvailable()) {
		try {
			const captured = captureMainDisplayPngViaSck(targetWidth, targetHeight);
			if (captured !== null) {
				return captured;
			}
		} catch (error: unknown) {
			sckFailure = error instanceof Error ? error.message : String(error);
		}
	}

	assertAreaHasNoMaskedWindow(() => displayArea(displayId));
	let sourceImage: CGImageRef;
	try {
		sourceImage = openDisplayImage(displayId);
	} catch (error: unknown) {
		// The CoreGraphics fallback cannot capture on current macOS, so its error alone hides why ScreenCaptureKit failed.
		if (sckFailure !== undefined && error instanceof Error) {
			throw new Error(`${sckFailure}; CoreGraphics fallback: ${error.message}`);
		}
		throw error;
	}
	try {
		const sourceWidth = CGImageGetWidth(sourceImage);
		const sourceHeight = CGImageGetHeight(sourceImage);
		const outputDimensions = computeAspectPreservedDimensions(sourceWidth, sourceHeight, maxPixelSize);
		return {
			data: encodeImage(sourceImage, maxPixelSize, format, quality),
			width: outputDimensions.width,
			height: outputDimensions.height,
		};
	} finally {
		cfRelease(sourceImage);
	}
}

/** Zooms a region of one display. CoreGraphics has no region-capture call, so the full display
 * image is taken and cropped in memory before encoding. */
export function captureDisplayRegionImage(
	displayId: number,
	region: Rect,
	targetWidth: number,
	targetHeight: number,
	format: CapturedImageFormat,
	quality: number,
): CapturedScreenshot {
	const maxPixelSize = Math.max(Math.round(targetWidth), Math.round(targetHeight));
	if (maxPixelSize <= 0) {
		throw new Error(`captureDisplayRegionImage requires positive dimensions, got ${targetWidth}x${targetHeight}`);
	}

	assertAreaHasNoMaskedWindow(() => region);
	const sourceImage = openDisplayImage(displayId);
	try {
		const crop = computeDisplayCrop(region, CGDisplayBounds(displayId), {
			width: CGImageGetWidth(sourceImage),
			height: CGImageGetHeight(sourceImage),
		});
		const cropped = CGImageCreateWithImageInRect(sourceImage, {
			origin: { x: crop.x, y: crop.y },
			size: { width: crop.width, height: crop.height },
		});
		if (cropped === null) {
			throw new Error(`CoreGraphics could not crop ${crop.width}x${crop.height} from display ${displayId}`);
		}
		try {
			const outputDimensions = computeAspectPreservedDimensions(crop.width, crop.height, maxPixelSize);
			return {
				data: encodeImage(cropped, maxPixelSize, format, quality),
				width: outputDimensions.width,
				height: outputDimensions.height,
			};
		} finally {
			cfRelease(cropped);
		}
	} finally {
		cfRelease(sourceImage);
	}
}

const CG_DISPLAY_MODE_REF = koffi.pointer("CGDisplayModeRefForScreenshot", koffi.opaque());
const CGDisplayCopyDisplayMode = coreGraphics.func("CGDisplayCopyDisplayMode", CG_DISPLAY_MODE_REF, [
	"uint32_t",
]) as KoffiFunc<(display: number) => CFTypeRef | null>;
const CGDisplayModeGetPixelWidth = coreGraphics.func("CGDisplayModeGetPixelWidth", "size_t", [
	CG_DISPLAY_MODE_REF,
]) as KoffiFunc<(mode: CFTypeRef) => number | bigint>;
const CGDisplayModeGetPixelHeight = coreGraphics.func("CGDisplayModeGetPixelHeight", "size_t", [
	CG_DISPLAY_MODE_REF,
]) as KoffiFunc<(mode: CFTypeRef) => number | bigint>;
const CGDisplayModeRelease = coreGraphics.func("CGDisplayModeRelease", "void", [CG_DISPLAY_MODE_REF]) as KoffiFunc<
	(mode: CFTypeRef) => void
>;

/**
 * The main display's backing pixel size, read from its display mode. Capturing the display to
 * measure it would need Screen Recording (raising macOS's permission prompt where it is missing)
 * and cost a full-screen image on every observation.
 */
export function getMainDisplayNativePixelSize(): { width: number; height: number } {
	const mode = CGDisplayCopyDisplayMode(CGMainDisplayID());
	if (mode === null) {
		throw new Error("CGDisplayCopyDisplayMode returned null for the main display");
	}
	try {
		return { width: Number(CGDisplayModeGetPixelWidth(mode)), height: Number(CGDisplayModeGetPixelHeight(mode)) };
	} finally {
		CGDisplayModeRelease(mode);
	}
}

export function getMainDisplayLogicalSize(): { width: number; height: number } {
	const bounds = CGDisplayBounds(CGMainDisplayID());
	return {
		width: Math.round(bounds.size.width),
		height: Math.round(bounds.size.height),
	};
}

function computeAspectPreservedDimensions(
	sourceWidth: number,
	sourceHeight: number,
	maxPixelSize: number,
): { width: number; height: number } {
	const longestSourceEdge = Math.max(sourceWidth, sourceHeight);
	if (longestSourceEdge <= maxPixelSize) {
		return { width: sourceWidth, height: sourceHeight };
	}
	const scale = maxPixelSize / longestSourceEdge;
	return {
		width: Math.max(1, Math.round(sourceWidth * scale)),
		height: Math.max(1, Math.round(sourceHeight * scale)),
	};
}

function createCFNumberInt32(value: number): CFNumberRef {
	const valueBytes = Buffer.alloc(4);
	valueBytes.writeInt32LE(value, 0);
	const reference = CFNumberCreate(null, CF_NUMBER_INT_TYPE, valueBytes);
	if (reference === null) {
		throw new Error("CFNumberCreate returned null for an integer property");
	}
	return reference;
}

function createCFNumberDouble(value: number): CFNumberRef {
	const valueBytes = Buffer.alloc(8);
	valueBytes.writeDoubleLE(value, 0);
	const reference = CFNumberCreate(null, CF_NUMBER_DOUBLE_TYPE, valueBytes);
	if (reference === null) {
		throw new Error("CFNumberCreate returned null for a double property");
	}
	return reference;
}

function encodeImage(image: CGImageRef, maxPixelSize: number, format: CapturedImageFormat, quality: number): Buffer {
	// ImageIO's max-pixel-size property resizes to the requested edge in both directions, so a
	// small crop would be upscaled into invented pixels and a dimension mismatch. Clamp it to
	// the source edge, which keeps the metadata this module reports equal to the real image.
	const longestSourceEdge = Math.max(CGImageGetWidth(image), CGImageGetHeight(image));
	const effectiveMaxPixelSize = Math.max(1, Math.min(Math.round(maxPixelSize), longestSourceEdge));

	return withCFString(format === "jpeg" ? JPEG_UNIFORM_TYPE : PNG_UNIFORM_TYPE, (imageType) =>
		withCFString(MAX_PIXEL_SIZE_KEY, (maxPixelSizeKey) => {
			const properties = CFDictionaryCreateMutable(null, 0, null, null);
			if (properties === null) {
				throw new Error("CFDictionaryCreateMutable returned null");
			}
			// The dictionary is created without retain callbacks, so every value has to outlive
			// the encode call below instead of being released once it is set.
			const propertyValues: CFTypeRef[] = [];
			try {
				const maxPixelSizeValue = createCFNumberInt32(effectiveMaxPixelSize);
				propertyValues.push(maxPixelSizeValue);
				CFDictionarySetValue(properties, maxPixelSizeKey, maxPixelSizeValue);
				if (format === "jpeg") {
					const qualityKey = toCFString(LOSSY_QUALITY_KEY);
					const qualityValue = createCFNumberDouble(Math.min(1, Math.max(0, quality / 100)));
					propertyValues.push(qualityKey, qualityValue);
					CFDictionarySetValue(properties, qualityKey, qualityValue);
				}

				const cfData = CFDataCreateMutable(null, 0);
				if (cfData === null) {
					throw new Error("CFDataCreateMutable returned null");
				}
				try {
					const destination = CGImageDestinationCreateWithData(cfData, imageType, 1, null);
					if (destination === null) {
						throw new Error("CGImageDestinationCreateWithData returned null");
					}
					try {
						CGImageDestinationAddImage(destination, image, properties);
						if (!CGImageDestinationFinalize(destination)) {
							throw new Error("CGImageDestinationFinalize returned false");
						}
						const length = CFDataGetLength(cfData);
						if (length <= 0) {
							throw new Error(`Image encode produced no bytes (length=${length})`);
						}
						const buffer = Buffer.alloc(length);
						CFDataGetBytes(cfData, { location: 0, length }, buffer);
						return buffer;
					} finally {
						cfRelease(destination);
					}
				} finally {
					cfRelease(cfData);
				}
			} finally {
				for (const value of propertyValues) {
					cfRelease(value);
				}
				cfRelease(properties);
			}
		}),
	);
}
