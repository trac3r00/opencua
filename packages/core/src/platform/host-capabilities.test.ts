import { describe, expect, it, mock } from "bun:test";

// Fakes only: no framework is loaded and no permission is read from this Mac.
mock.module("./macos-ffi/koffi.js", () => ({
	koffi: {
		load: () => ({
			func: (name: string) =>
				name === "AXIsProcessTrusted"
					? () => {
							throw new Error("AXIsProcessTrusted: symbol not found");
						}
					: () => 0,
		}),
	},
}));
mock.module("./macos-ffi/lock-screen.js", () => ({ isScreenLocked: () => false, sessionOnConsole: () => true }));
mock.module("./macos-ffi/screenshot.js", () => ({
	getMainDisplayLogicalSize: () => ({ width: 1512, height: 982 }),
	getMainDisplayNativePixelSize: () => ({ width: 3024, height: 1964 }),
	screenCaptureAllowed: () => true,
}));

const { probeHostCapabilities } = await import("./host-capabilities.js");

describe("#given a permission binding that throws #when host capabilities are probed #then the error travels with the false", () => {
	it("reports Accessibility as not granted with the binding's error, and the readable permissions without one", () => {
		const { permissions } = probeHostCapabilities();

		expect(permissions).toEqual({
			accessibility: false,
			screenRecording: true,
			inputMonitoring: true,
			errors: { accessibility: "AXIsProcessTrusted: symbol not found" },
		});
	});
});
