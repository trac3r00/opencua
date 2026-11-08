import { beforeEach, describe, expect, it } from "bun:test";
import { vi } from "@opencua/test-support";

type ExecFileCallback = (error: Error | null, stdout: string | Buffer, stderr: string) => void;
type ExecFileMock = (
	file: string,
	args: readonly string[],
	options: { readonly encoding?: BufferEncoding; readonly timeout?: number },
	callback: ExecFileCallback,
) => void;

const captureMocks = vi.hoisted(() => ({
	captureWindowImage: vi.fn(),
	execFile: vi.fn<ExecFileMock>(),
}));

vi.mock("node:child_process", () => ({
	execFile: captureMocks.execFile,
}));

vi.mock("./macos-ffi/screenshot.js", () => ({
	captureDisplayImage: vi.fn(),
	captureDisplayRegionImage: vi.fn(),
	captureWindowImage: captureMocks.captureWindowImage,
	captureWindowImageAsync: async (...args: unknown[]): Promise<unknown> => captureMocks.captureWindowImage(...args),
	getMainDisplayId: vi.fn(),
	getMainDisplayLogicalSize: vi.fn(),
	getMainDisplayNativePixelSize: vi.fn(),
	screenCaptureAllowed: vi.fn(() => true),
}));

const { captureMacOSScreenshot, classifyCaptureFailure } = await import("./macos.js");

function createFakePng(): Buffer {
	const data = Buffer.alloc(24);
	data.write("\u0089PNG\r\n\u001a\n", 0, "latin1");
	data.writeUInt32BE(1920, 16);
	data.writeUInt32BE(1080, 20);
	return data;
}

beforeEach(() => {
	captureMocks.captureWindowImage.mockReset();
	captureMocks.execFile.mockReset();
});

describe("#given window adapter error text #when classifying failures #then native NULL is transient", () => {
	it.each([
		["libsckit.dylib not found (looked in /native/libsckit.dylib)", "unavailable"],
		["Screen Recording permission is not granted to the process", "unavailable"],
		["Native ScreenCaptureKit window capture failed for window 42", "transient"],
		["unexpected adapter error", "unavailable"],
	] as const)("classifies %s as %s", (message, expected) => {
		expect(classifyCaptureFailure(new Error(message))).toBe(expected);
	});
});

describe("#given transient native capture failure #when immediate retry succeeds #then CLI is skipped", () => {
	it("retries capture exactly once and returns the native image", async () => {
		const image = createFakePng();
		captureMocks.captureWindowImage.mockImplementationOnce(() => {
			throw new Error("Native ScreenCaptureKit window capture failed for window 42");
		});
		captureMocks.captureWindowImage.mockReturnValueOnce({ data: image });

		await expect(captureMacOSScreenshot({ width: 1920, height: 1080 }, 42)).resolves.toBe(image);

		expect(captureMocks.captureWindowImage).toHaveBeenCalledTimes(2);
		expect(captureMocks.execFile).not.toHaveBeenCalled();
	});
});

describe("#given unavailable native capture #when capturing a window #then CLI fallback runs", () => {
	it("uses the existing shell pipeline", async () => {
		const image = createFakePng();
		captureMocks.execFile.mockImplementationOnce((file, args, options, callback) => {
			void file;
			void args;
			void options;
			callback(null, image, "");
		});
		captureMocks.captureWindowImage.mockImplementationOnce(() => {
			throw new Error("libsckit.dylib not found (looked in /native/libsckit.dylib)");
		});

		await expect(captureMacOSScreenshot({ width: 1920, height: 1080 }, 42)).resolves.toBe(image);
		expect(captureMocks.captureWindowImage).toHaveBeenCalledTimes(1);
		expect(captureMocks.execFile).toHaveBeenCalledTimes(1);
		expect(captureMocks.execFile).toHaveBeenCalledWith(
			"sh",
			expect.arrayContaining(["opencua-screenshot", "1920", "1080"]),
			expect.objectContaining({ encoding: "buffer", timeout: 10_000 }),
			expect.any(Function),
		);
	});
});

describe("#given repeated transient native failure #when retry also fails #then classified error skips CLI", () => {
	it("throws the original failure with the transient classification", async () => {
		const failure = "Native ScreenCaptureKit window capture failed for window 42";
		captureMocks.captureWindowImage.mockImplementation(() => {
			throw new Error(failure);
		});

		await expect(captureMacOSScreenshot({ width: 1920, height: 1080 }, 42)).rejects.toThrow(
			`window capture failed (transient): ${failure}`,
		);
		expect(captureMocks.captureWindowImage).toHaveBeenCalledTimes(2);
		expect(captureMocks.execFile).not.toHaveBeenCalled();
	});
});

describe("#given unknown native capture failure #when capturing a window #then old CLI fallback runs", () => {
	it("uses the existing shell pipeline without retrying native capture", async () => {
		const image = createFakePng();
		captureMocks.captureWindowImage.mockImplementationOnce(() => {
			throw new Error("unexpected adapter error");
		});
		captureMocks.execFile.mockImplementationOnce((_file, _args, _options, callback) => {
			callback(null, image, "");
		});

		await expect(captureMacOSScreenshot({ width: 1920, height: 1080 }, 42)).resolves.toBe(image);
		expect(captureMocks.captureWindowImage).toHaveBeenCalledTimes(1);
		expect(captureMocks.execFile).toHaveBeenCalledTimes(1);
	});
});
