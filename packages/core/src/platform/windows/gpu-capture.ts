import { execFile } from "node:child_process";
import type { ScreenshotResult } from "../../computer/interface.js";
import { WindowsHostError } from "./transport.js";

/** Runs OpenCuaCapture (native/windows/OpenCuaCapture) for one window handle. */
export type GpuCaptureRunner = (hwnd: number) => Promise<{ readonly exitCode: number; readonly stdout: string }>;

export function gpuCaptureRunner(executable: string): GpuCaptureRunner {
	return (hwnd) =>
		new Promise((resolve, reject) => {
			execFile(executable, [String(hwnd)], { maxBuffer: 256 * 1024 * 1024, timeout: 10_000 }, (error, stdout) => {
				if (error !== null && typeof error.code !== "number") {
					reject(new WindowsHostError("CAPTURE_FAILED", error.message));
					return;
				}
				resolve({ exitCode: error === null ? 0 : Number(error.code), stdout });
			});
		});
}

/**
 * OpenCuaCapture's result: the PNG, or "fallback" when this Windows build has no
 * Windows.Graphics.Capture (exit 3) or no frame came (exit 4), so the caller uses PrintWindow.
 */
export function readGpuCapture(exitCode: number, stdout: string): ScreenshotResult | "fallback" {
	if (exitCode === 3 || exitCode === 4) return "fallback";
	if (exitCode !== 0) throw new WindowsHostError("CAPTURE_FAILED", `OpenCuaCapture exited ${exitCode}`);
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new WindowsHostError("PROTOCOL", "OpenCuaCapture output is not JSON");
	}
	if (typeof parsed !== "object" || parsed === null)
		throw new WindowsHostError("PROTOCOL", "OpenCuaCapture output is not an object");
	const width = "width" in parsed ? parsed.width : undefined;
	const height = "height" in parsed ? parsed.height : undefined;
	const png = "png" in parsed ? parsed.png : undefined;
	if (
		typeof width !== "number" ||
		typeof height !== "number" ||
		!Number.isSafeInteger(width) ||
		!Number.isSafeInteger(height) ||
		width <= 0 ||
		height <= 0 ||
		typeof png !== "string"
	) {
		throw new WindowsHostError("PROTOCOL", "OpenCuaCapture output lacks width, height or png");
	}
	const data = Buffer.from(png, "base64");
	if (data.length < 8 || data.readUInt32BE(0) !== 0x89504e47)
		throw new WindowsHostError("PROTOCOL", "OpenCuaCapture data is not a PNG");
	return { data, width, height, mimeType: "image/png" };
}
