import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread } from "node:worker_threads";
import type { KoffiFunc } from "koffi";
import { CaptureMaskedError } from "../capture-mask.js";
import { koffi } from "./koffi.js";

type SckBindings = {
	readonly capture: KoffiFunc<
		(
			width: number,
			height: number,
			outBytes: [Buffer | null],
			outLen: [number],
			outWidth: [number],
			outHeight: [number],
		) => number
	>;
	readonly captureWindow: KoffiFunc<
		(
			windowId: number,
			maxWidth: number,
			maxHeight: number,
			format: number,
			quality: number,
			outLen: [number],
		) => Buffer | null
	>;
	readonly measureProcessAudio: KoffiFunc<
		(pid: number, durationMs: number, outRms: [number], outPeak: [number], outSamples: [number | bigint]) => number
	>;
	readonly freeBytes: KoffiFunc<(bytes: Buffer) => void>;
	readonly invalidateCache: KoffiFunc<() => void>;
	readonly serviceMainRunLoop: KoffiFunc<(milliseconds: number) => void>;
};

const SCK_OK = 0;
const SCK_ERR_NO_SHAREABLE_CONTENT = -1;
const SCK_ERR_NO_DISPLAY = -2;
const SCK_ERR_CAPTURE_FAILED = -3;
const SCK_ERR_ENCODE_FAILED = -4;
const SCK_ERR_INVALID_ARGS = -5;
const SCK_ERR_TIMEOUT = -6;
/** sckit_capture_window's length when it left a masked app's window uncaptured. */
const SCK_ERR_MASKED = -7;
const SCK_WINDOW_FORMAT_PNG = 0;
const SCK_WINDOW_FORMAT_JPEG = 1;
/** One main-run-loop slice while an async capture is pending; see sck_service_main_run_loop in sckit.m. */
const MAIN_RUN_LOOP_SLICE_MILLISECONDS = 10;

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const sckitDylibCandidatePaths: readonly string[] = [
	join(moduleDirectory, "../../../native/libsckit.dylib"),
	join(moduleDirectory, "../../../../native/libsckit.dylib"),
	join(moduleDirectory, "../../native/libsckit.dylib"),
];

let cachedBindings: SckBindings | null = null;
let bindingsLoadAttempted = false;
let loadErrorMessage = "";

/**
 * The native capture library, loaded once. Null when it cannot be used on this host: the file is missing, or
 * dlopen refuses it (for example a binary without this machine's architecture slice). Every caller then takes its
 * CoreGraphics or screencapture fallback, and getSckitLoadError() says why.
 */
function tryLoadSckitBindings(): SckBindings | null {
	if (bindingsLoadAttempted) {
		return cachedBindings;
	}
	bindingsLoadAttempted = true;

	const existingPaths = sckitDylibCandidatePaths.filter((candidatePath) => existsSync(candidatePath));
	if (existingPaths.length === 0) {
		loadErrorMessage = `libsckit.dylib not found (looked in ${sckitDylibCandidatePaths.join(", ")})`;
		return null;
	}
	for (const candidatePath of existingPaths) {
		try {
			const library = koffi.load(candidatePath);
			const capture = library.func("sck_capture_main_display_png", "int", [
				"int",
				"int",
				koffi.out("uint8_t **"),
				koffi.out("size_t *"),
				koffi.out("int *"),
				koffi.out("int *"),
			]) as SckBindings["capture"];
			const captureWindow = library.func("sckit_capture_window", "uint8_t *", [
				"uint32_t",
				"int32_t",
				"int32_t",
				"int32_t",
				"int32_t",
				koffi.out("int32_t *"),
			]) as SckBindings["captureWindow"];
			const measureProcessAudio = library.func("sck_measure_process_audio", "int32_t", [
				"int32_t",
				"int32_t",
				koffi.out("double *"),
				koffi.out("double *"),
				koffi.out("int64_t *"),
			]) as SckBindings["measureProcessAudio"];
			const freeBytes = library.func("sck_free", "void", ["uint8_t *"]) as SckBindings["freeBytes"];
			const invalidateCache = library.func("sck_invalidate_cache", "void", []) as SckBindings["invalidateCache"];
			const serviceMainRunLoop = library.func("sck_service_main_run_loop", "void", [
				"int32_t",
			]) as SckBindings["serviceMainRunLoop"];
			cachedBindings = {
				capture,
				captureWindow,
				measureProcessAudio,
				freeBytes,
				invalidateCache,
				serviceMainRunLoop,
			};
			return cachedBindings;
		} catch (error) {
			loadErrorMessage = error instanceof Error ? error.message : String(error);
		}
	}
	return null;
}

export function isSckitAvailable(): boolean {
	return tryLoadSckitBindings() !== null;
}

export function getSckitLoadError(): string {
	tryLoadSckitBindings();
	return cachedBindings === null ? loadErrorMessage : "";
}

export type SckCapturedScreenshot = {
	readonly data: Buffer;
	readonly width: number;
	readonly height: number;
};

export function captureMainDisplayPngViaSck(targetWidth: number, targetHeight: number): SckCapturedScreenshot | null {
	const bindings = tryLoadSckitBindings();
	if (bindings === null) {
		return null;
	}
	if (!Number.isSafeInteger(targetWidth) || !Number.isSafeInteger(targetHeight)) {
		throw new Error("captureMainDisplayPngViaSck requires integer dimensions");
	}
	if (targetWidth <= 0 || targetHeight <= 0) {
		throw new Error(`captureMainDisplayPngViaSck requires positive dimensions, got ${targetWidth}x${targetHeight}`);
	}

	const outBytes: [Buffer | null] = [null];
	const outLen: [number] = [0];
	const outWidth: [number] = [0];
	const outHeight: [number] = [0];

	const resultCode = bindings.capture(targetWidth, targetHeight, outBytes, outLen, outWidth, outHeight);
	if (resultCode !== SCK_OK) {
		throw new Error(`SCK capture failed: ${describeSckError(resultCode)} (code ${resultCode})`);
	}

	const bytesPointer = outBytes[0];
	const byteLength = outLen[0];
	if (bytesPointer === null || byteLength <= 0) {
		throw new Error("SCK capture returned no data");
	}

	try {
		const decoded: ArrayLike<number> = koffi.decode(bytesPointer, "uint8_t", byteLength);
		return {
			data: Buffer.from(decoded),
			width: outWidth[0],
			height: outHeight[0],
		};
	} finally {
		bindings.freeBytes(bytesPointer);
	}
}

/**
 * One window encoded by ScreenCaptureKit, or null when the native capture is unavailable on this host (see
 * getSckitLoadError). Throws when the library is there but the capture itself fails.
 */
export function captureWindowViaSck(
	windowId: number,
	maxWidth: number,
	maxHeight: number,
	format: "png" | "jpeg",
	quality: number,
): Buffer | null {
	const bindings = tryLoadSckitBindings();
	if (bindings === null) {
		return null;
	}
	const outLen: [number] = [0];
	const bytesPointer = bindings.captureWindow(
		windowId,
		maxWidth,
		maxHeight,
		format === "jpeg" ? SCK_WINDOW_FORMAT_JPEG : SCK_WINDOW_FORMAT_PNG,
		quality,
		outLen,
	);
	return takeWindowBytes(bindings, windowId, bytesPointer, outLen[0]);
}

/**
 * captureWindowViaSck on koffi's worker thread: the capture waits on ScreenCaptureKit, so the caller's
 * thread stays free for work that does not depend on the pixels, such as reading the accessibility tree.
 * ScreenCaptureKit completes only while the main run loop is serviced, which Node's main thread never does on
 * its own, so the main thread runs it in short slices between its other work until the capture settles.
 */
export async function captureWindowViaSckAsync(
	windowId: number,
	maxWidth: number,
	maxHeight: number,
	format: "png" | "jpeg",
	quality: number,
): Promise<Buffer | null> {
	const bindings = tryLoadSckitBindings();
	if (bindings === null) {
		return null;
	}
	const outLen: [number] = [0];
	const capture = new Promise<Buffer | null>((resolve, reject) => {
		bindings.captureWindow.async(
			windowId,
			maxWidth,
			maxHeight,
			format === "jpeg" ? SCK_WINDOW_FORMAT_JPEG : SCK_WINDOW_FORMAT_PNG,
			quality,
			outLen,
			(error: unknown, result: Buffer | null) => {
				if (error !== null && error !== undefined)
					reject(error instanceof Error ? error : new Error(String(error)));
				else resolve(result);
			},
		);
	});
	const bytesPointer = await whileServicingMainRunLoop(bindings, capture);
	return takeWindowBytes(bindings, windowId, bytesPointer, outLen[0]);
}

async function whileServicingMainRunLoop<TValue>(bindings: SckBindings, pending: Promise<TValue>): Promise<TValue> {
	if (!isMainThread) {
		return await pending;
	}
	let settled = false;
	const service = (): void => {
		if (settled) return;
		bindings.serviceMainRunLoop(MAIN_RUN_LOOP_SLICE_MILLISECONDS);
		setImmediate(service);
	};
	setImmediate(service);
	try {
		return await pending;
	} finally {
		settled = true;
	}
}

function takeWindowBytes(
	bindings: SckBindings,
	windowId: number,
	bytesPointer: Buffer | null,
	byteLength: number,
): Buffer {
	if (byteLength === SCK_ERR_MASKED) {
		throw new CaptureMaskedError(windowId);
	}
	if (bytesPointer === null || byteLength <= 0) {
		throw new Error(`Native ScreenCaptureKit window capture failed for window ${windowId}`);
	}
	try {
		const decoded: ArrayLike<number> = koffi.decode(bytesPointer, "uint8_t", byteLength);
		return Buffer.from(decoded);
	} finally {
		bindings.freeBytes(bytesPointer);
	}
}

export interface ProcessAudioLevel {
	readonly rms: number;
	readonly peak: number;
	readonly samples: number;
}

/**
 * Listens to one process's audio output for `durationMs` through a CoreAudio process tap (macOS Audio Capture
 * permission) and returns its level; null when the native library is unavailable. Throws when the tap fails.
 */
export async function measureProcessAudioViaSck(pid: number, durationMs: number): Promise<ProcessAudioLevel | null> {
	const bindings = tryLoadSckitBindings();
	if (bindings === null) return null;
	const rms: [number] = [0];
	const peak: [number] = [0];
	const samples: [number | bigint] = [0];
	// The tap listens for the whole duration: run it on koffi's worker thread so the server keeps answering meanwhile.
	const code = await new Promise<number>((resolve, reject) => {
		bindings.measureProcessAudio.async(pid, durationMs, rms, peak, samples, (error: unknown, result: unknown) => {
			if (error !== null && error !== undefined) reject(error instanceof Error ? error : new Error(String(error)));
			else resolve(Number(result));
		});
	});
	if (code !== SCK_OK) {
		throw new Error(`process audio tap failed: ${describeSckError(code)} (code ${code})`);
	}
	return { rms: rms[0], peak: peak[0], samples: Number(samples[0]) };
}

function describeSckError(code: number): string {
	switch (code) {
		case SCK_ERR_NO_SHAREABLE_CONTENT:
			return "no shareable content available";
		case SCK_ERR_NO_DISPLAY:
			return "no display matched";
		case SCK_ERR_CAPTURE_FAILED:
			return "ScreenCaptureKit capture failed";
		case SCK_ERR_ENCODE_FAILED:
			return "PNG encode failed";
		case SCK_ERR_INVALID_ARGS:
			return "invalid arguments";
		case SCK_ERR_TIMEOUT:
			return "ScreenCaptureKit timed out";
		default:
			return "unknown SCK error";
	}
}
