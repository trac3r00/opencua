import { beforeEach, describe, expect, it } from "bun:test";
import { vi } from "@opencua/test-support";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

type SckitMode = "load-fails" | "supported";

const koffiMock = vi.hoisted(() => {
	const state: { mode: "load-fails" | "supported" } = { mode: "load-fails" };
	const pngBytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	const nativeBytes = { type: "native-bytes" };
	const pendingCapture: { complete: (() => void) | undefined } = { complete: undefined };

	const sckitFunctions = {
		sck_capture_main_display_png: vi.fn(
			(
				width: number,
				height: number,
				outBytes: [object | null],
				outLen: [number],
				outWidth: [number],
				outHeight: [number],
			) => {
				outBytes[0] = nativeBytes;
				outLen[0] = pngBytes.length;
				outWidth[0] = width;
				outHeight[0] = height;
				return 0;
			},
		),
		sckit_capture_window: Object.assign(
			vi.fn(() => null),
			{
				// Like ScreenCaptureKit under Node: the capture calls back only once the main run loop has been serviced.
				async: vi.fn((...args: unknown[]) => {
					const outLen = args[5] as [number];
					const done = args[6] as (error: unknown, result: object | null) => void;
					pendingCapture.complete = () => {
						outLen[0] = pngBytes.length;
						done(null, nativeBytes);
					};
				}),
			},
		),
		sck_service_main_run_loop: vi.fn(() => {
			const complete = pendingCapture.complete;
			pendingCapture.complete = undefined;
			complete?.();
		}),
		sck_free: vi.fn(),
		sck_invalidate_cache: vi.fn(),
	};
	const coreGraphicsFunctions = {
		CGMainDisplayID: vi.fn(() => 1),
		CGDisplayCreateImage: vi.fn(() => ({ type: "cg-image" })),
		CGImageGetWidth: vi.fn(() => 2880),
		CGImageGetHeight: vi.fn(() => 1800),
	};
	const imageIOFunctions = {
		CGImageDestinationCreateWithData: vi.fn(() => ({ type: "image-destination" })),
		CGImageDestinationAddImage: vi.fn(),
		CGImageDestinationFinalize: vi.fn(() => true),
	};
	const coreFoundationFunctions = {
		CFStringCreateWithCString: vi.fn(() => ({ type: "cf-string" })),
		CFDictionaryCreateMutable: vi.fn(() => ({ type: "cf-dictionary" })),
		CFNumberCreate: vi.fn(() => ({ type: "cf-number" })),
		CFDataCreateMutable: vi.fn(() => ({ type: "cf-data" })),
		CFDataGetLength: vi.fn(() => pngBytes.length),
		CFDataGetBytes: vi.fn((_data: object, _range: object, buffer: Buffer) => {
			Buffer.from(pngBytes).copy(buffer);
		}),
	};

	function functionsFor(path: string): Readonly<Record<string, unknown>> {
		if (path.endsWith("/CoreGraphics")) {
			return coreGraphicsFunctions;
		}
		if (path.endsWith("/ImageIO")) {
			return imageIOFunctions;
		}
		if (path.endsWith("/CoreFoundation")) {
			return coreFoundationFunctions;
		}
		return {};
	}

	function library(functions: Readonly<Record<string, unknown>>) {
		return { func: vi.fn((name: string) => functions[name] ?? vi.fn()), symbol: vi.fn() };
	}

	return {
		state,
		sckitFunctions,
		coreGraphicsFunctions,
		module: {
			load: vi.fn((path: string) => {
				if (!path.endsWith("libsckit.dylib")) {
					return library(functionsFor(path));
				}
				if (state.mode === "load-fails") {
					throw new Error(
						`dlopen(${path}, 0x0002): tried: '${path}' (mach-o file, but is an incompatible architecture (have 'arm64', need 'x86_64'))`,
					);
				}
				return library(sckitFunctions);
			}),
			struct: vi.fn((name: string) => ({ type: "struct", name })),
			pointer: vi.fn((name: unknown) => ({ type: "pointer", name })),
			opaque: vi.fn(() => ({ type: "opaque" })),
			out: vi.fn((type: unknown) => ({ type: "out", inner: type })),
			decode: vi.fn((_pointer: object, _type: string, length: number) => pngBytes.slice(0, length)),
		},
	};
});

vi.mock("koffi", () => koffiMock.module);

async function loadCaptureModules(mode: SckitMode) {
	koffiMock.state.mode = mode;
	vi.resetModules();
	const sckit = await import("./sckit.js");
	const screenshot = await import("./screenshot.js");
	return { sckit, screenshot };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("#given libsckit.dylib cannot be loaded (no slice for this CPU) #when the screen is captured #then the CoreGraphics fallback answers", () => {
	it("reports the load error and captures the main display through CoreGraphics", async () => {
		const { sckit, screenshot } = await loadCaptureModules("load-fails");

		const shot = screenshot.captureDisplayImage(1, 1440, 900, "png", 100);

		expect(sckit.isSckitAvailable()).toBe(false);
		expect(sckit.getSckitLoadError()).toMatch(/incompatible architecture/);
		expect(sckit.captureMainDisplayPngViaSck(1440, 900)).toBeNull();
		expect([...shot.data.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
		expect(shot).toMatchObject({ width: 1440, height: 900 });
		expect(koffiMock.coreGraphicsFunctions.CGDisplayCreateImage).toHaveBeenCalledWith(1);
	});

	it("throws on window capture with the load error, which sends the caller to screencapture", async () => {
		const { screenshot } = await loadCaptureModules("load-fails");

		expect(() => screenshot.captureWindowImage(42, 800, 600, "png", 100)).toThrow(
			/window capture is unavailable: .*incompatible architecture/,
		);
	});
});

describe("#given the library loads and the screenshot API exists #when the main display is captured #then ScreenCaptureKit answers", () => {
	it("captures through the native library without touching CoreGraphics", async () => {
		const { sckit, screenshot } = await loadCaptureModules("supported");

		const shot = screenshot.captureDisplayImage(1, 1440, 900, "png", 100);

		expect(sckit.isSckitAvailable()).toBe(true);
		expect(sckit.getSckitLoadError()).toBe("");
		expect([...shot.data.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
		expect(koffiMock.sckitFunctions.sck_capture_main_display_png).toHaveBeenCalledTimes(1);
		expect(koffiMock.coreGraphicsFunctions.CGDisplayCreateImage).not.toHaveBeenCalled();
	});
});

describe("#given a window capture whose completion needs the main run loop #when it is awaited on the main thread #then the run loop is serviced until it settles", () => {
	it("resolves with the captured bytes instead of waiting forever", async () => {
		const { sckit } = await loadCaptureModules("supported");

		const data = await sckit.captureWindowViaSckAsync(42, 800, 600, "png", 100);

		expect([...(data ?? Buffer.alloc(0)).subarray(0, 8)]).toEqual(PNG_SIGNATURE);
		expect(koffiMock.sckitFunctions.sck_service_main_run_loop).toHaveBeenCalled();
	});
});
