import { describe, expect, it } from "bun:test";
import { readGpuCapture } from "./gpu-capture.js";
import { createWindowsHostComputer } from "./index.js";
import { WindowsHostError, type WindowsTransport } from "./transport.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
const output = (fields: Record<string, unknown>) =>
	JSON.stringify({ width: 640, height: 480, png: PNG.toString("base64"), ...fields });

describe("#given OpenCuaCapture output #when read #then a PNG comes back or the caller falls back to PrintWindow", () => {
	it("returns the PNG, falls back on exit 3 and 4, and rejects everything malformed", () => {
		expect(readGpuCapture(0, output({}))).toEqual({ data: PNG, width: 640, height: 480, mimeType: "image/png" });
		expect(readGpuCapture(3, "")).toBe("fallback");
		expect(readGpuCapture(4, "")).toBe("fallback");
		for (const [code, text] of [
			[1, output({})],
			[0, "{"],
			[0, output({ width: 0 })],
			[0, output({ height: 1.5 })],
			[0, output({ png: 5 })],
			[0, output({ png: Buffer.from("GIF89a").toString("base64") })],
			[0, "null"],
		] as const) {
			expect(() => readGpuCapture(code, text)).toThrow(WindowsHostError);
		}
	});
});

describe("#given a GPU capture runner #when the Windows backend takes a screenshot #then it uses the observed window's handle first", () => {
	it("captures by HWND and only asks the helper's PrintWindow when the runner falls back", async () => {
		const methods: string[] = [];
		const transport: WindowsTransport = {
			generation: 1,
			request: async (method) => {
				methods.push(method);
				if (method === "snapshot") {
					return {
						app: "A",
						bundleId: "A.exe",
						pid: 7,
						frontmost: false,
						axAvailable: true,
						elements: [],
						screenshotBase64: "",
						screenshotWidth: 1,
						screenshotHeight: 1,
						display: { width: 1, height: 1, scaleFactor: 1 },
						observationKey: "snapshot-1",
						screenshotMimeType: "image/png",
						elementsTruncated: false,
						treeSkipped: false,
						windowTitle: "A",
						windowCandidates: [],
						windowId: 4242,
						windowBounds: { x: 0, y: 0, width: 640, height: 480 },
					};
				}
				return { data: PNG.toString("base64"), width: 1, height: 1, mimeType: "image/png" };
			},
			close: async () => {},
		};
		const handles: number[] = [];
		let exitCode = 0;
		const computer = createWindowsHostComputer({
			transport,
			gpuCapture: async (hwnd) => {
				handles.push(hwnd);
				return { exitCode, stdout: exitCode === 0 ? output({}) : "" };
			},
		});
		computer.setTarget(7);
		await computer.getAppState();
		expect((await computer.screenshot()).width).toBe(640);
		expect(handles).toEqual([4242]);
		expect(methods).toEqual(["snapshot"]);
		exitCode = 3;
		expect((await computer.screenshot()).width).toBe(1);
		expect(methods).toEqual(["snapshot", "screenshot"]);
		await computer.close();
	});
});
