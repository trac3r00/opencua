import { beforeEach, describe, expect, it } from "bun:test";
import { vi } from "@opencua/test-support";

type ExecFileCallback = (error: Error | null, stdout: string | Buffer, stderr: string) => void;
type ExecFileMock = (
	file: string,
	args: readonly string[],
	options: { readonly encoding?: BufferEncoding; readonly timeout?: number },
	callback: ExecFileCallback,
) => void;

const childProcessMock = vi.hoisted(() => ({
	execFile: vi.fn<ExecFileMock>(),
}));

const sckitMock = vi.hoisted(() => ({
	captureWindowImage: vi.fn<() => never>(() => {
		throw new Error("libsckit.dylib not found (looked in /native/libsckit.dylib)");
	}),
}));

vi.mock("node:child_process", () => ({
	execFile: childProcessMock.execFile,
}));

// The real adapter would attempt a live ScreenCaptureKit capture; pin it to the classified
// unavailable class so the CLI-fallback routing stays provable under the retry contract.
const actualScreenshot = { ...(await import("./macos-ffi/screenshot.js")) };
vi.mock("./macos-ffi/screenshot.js", () => ({
	...actualScreenshot,
	captureWindowImage: sckitMock.captureWindowImage,
	captureWindowImageAsync: async () => sckitMock.captureWindowImage(),
}));

const { parseRunningApps } = await import("./app-list.js");
const { parseImageDimensions, parsePngDimensions } = await import("./image-format.js");
const { captureMacOSScreenshot, getMacOSLogicalScreenSize, parseSystemProfilerLogicalScreenSize } = await import(
	"./macos.js"
);

function createFakePng(): Buffer {
	const data = globalThis.Buffer.alloc(24);
	data.write("\u0089PNG\r\n\u001a\n", 0, "latin1");
	data.writeUInt32BE(1920, 16);
	data.writeUInt32BE(1080, 20);
	return data;
}

beforeEach(() => {
	childProcessMock.execFile.mockReset();
});

function mockExecFileStdout(stdout: string): void {
	childProcessMock.execFile.mockImplementationOnce((file, args, options, callback) => {
		void file;
		void args;
		void options;
		callback(null, stdout, "");
	});
}

function mockExecFileBuffer(stdout: Buffer): void {
	childProcessMock.execFile.mockImplementationOnce((file, args, options, callback) => {
		void file;
		void args;
		void options;
		callback(null, stdout, "");
	});
}

function mockExecFileError(error: Error): void {
	childProcessMock.execFile.mockImplementationOnce((file, args, options, callback) => {
		void file;
		void args;
		void options;
		callback(error, "", "");
	});
}

describe("#given macos screenshot capture returns a png buffer", () => {
	describe("#when dimensions are parsed from the screenshot bytes", () => {
		it("#then parses dimensions from the png IHDR chunk", async () => {
			const fakePng = createFakePng();

			const result = parsePngDimensions(fakePng);

			expect(result.width).toBe(1920);
			expect(result.height).toBe(1080);
		});
	});
});

describe("#given window-targeted screenshot capture #when a windowId is provided #then screencapture -l runs via shell", () => {
	it("returns the captured png bytes and routes through the CLI shell script", async () => {
		const fakePng = createFakePng();
		mockExecFileBuffer(fakePng);

		const result = await captureMacOSScreenshot({ width: 1920, height: 1080 }, 42);

		expect(result).toBe(fakePng);
		expect(childProcessMock.execFile).toHaveBeenCalledWith(
			"sh",
			expect.arrayContaining(["opencua-screenshot", "1920", "1080"]),
			expect.objectContaining({ encoding: "buffer" }),
			expect.any(Function),
		);
		const shellArgs = childProcessMock.execFile.mock.calls[0]?.[1];
		expect(Array.isArray(shellArgs)).toBe(true);
		const script = (shellArgs as readonly string[])[1];
		expect(script).toContain("screencapture -x -o -l 42");
	});
});

describe("#given Finder desktop bounds #when resolving macOS screen size #then logical points are returned", () => {
	it("uses osascript bounds before system_profiler", async () => {
		mockExecFileStdout("0, 0, 1512, 982\n");

		const size = await getMacOSLogicalScreenSize();

		expect(size).toEqual({ width: 1512, height: 982 });
		expect(childProcessMock.execFile).toHaveBeenCalledTimes(1);
		expect(childProcessMock.execFile).toHaveBeenCalledWith(
			"osascript",
			["-e", 'tell application "Finder" to get bounds of window of desktop'],
			expect.objectContaining({ timeout: 2000 }),
			expect.any(Function),
		);
	});
});

describe("#given Finder bounds fail #when resolving macOS screen size #then system_profiler UI Looks like is used", () => {
	it("falls back to logical display metadata", async () => {
		mockExecFileError(new Error("Automation permission denied"));
		mockExecFileStdout(`
Graphics/Displays:
    Displays:
        Built-in Liquid Retina Display:
          Resolution: 3024 x 1964 Retina
          UI Looks like: 1512 x 982 @ 2x
`);

		const size = await getMacOSLogicalScreenSize();

		expect(size).toEqual({ width: 1512, height: 982 });
		expect(childProcessMock.execFile).toHaveBeenCalledTimes(2);
		expect(childProcessMock.execFile).toHaveBeenLastCalledWith(
			"system_profiler",
			["SPDisplaysDataType"],
			expect.objectContaining({ timeout: 10_000 }),
			expect.any(Function),
		);
	});
});

describe("#given Retina system_profiler without UI Looks like #when resolving screen size #then physical pixels are halved", () => {
	it("uses the Retina scale heuristic", async () => {
		mockExecFileError(new Error("osascript timeout"));
		mockExecFileStdout("Resolution: 5120 x 2880 Retina\n");

		const size = await getMacOSLogicalScreenSize();

		expect(size).toEqual({ width: 2560, height: 1440 });
	});
});

describe("#given a non-Retina system_profiler resolution #when parsing logical size #then returns it unchanged", () => {
	it("keeps non-Retina dimensions", () => {
		const size = parseSystemProfilerLogicalScreenSize("Resolution: 1920 x 1080\n");

		expect(size).toEqual({ width: 1920, height: 1080 });
	});
});

describe("#given image bytes #when parsing dimensions by format #then PNG and JPEG are both handled", () => {
	it("reads PNG IHDR dimensions", () => {
		expect(parseImageDimensions(createFakePng())).toEqual({ width: 1920, height: 1080 });
	});

	it("reads JPEG start-of-frame dimensions", () => {
		const jpeg = globalThis.Buffer.from([
			0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03,
		]);
		expect(parseImageDimensions(jpeg)).toEqual({ width: 800, height: 600 });
	});
});

describe("#given JXA application process output #when parsing running apps #then maps app metadata", () => {
	it("returns sorted running app records", () => {
		const apps = parseRunningApps(
			JSON.stringify([
				{ name: "Safari", bundleId: "com.apple.Safari", pid: 42, isActive: true },
				{ name: "Finder", bundleId: "com.apple.finder", pid: 7, isActive: false },
			]),
		);

		expect(apps).toEqual([
			{ name: "Finder", bundleId: "com.apple.finder", pid: 7, isActive: false, isRunning: true, path: "" },
			{ name: "Safari", bundleId: "com.apple.Safari", pid: 42, isActive: true, isRunning: true, path: "" },
		]);
	});
});
