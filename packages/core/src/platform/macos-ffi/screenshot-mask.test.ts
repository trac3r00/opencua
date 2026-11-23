import { beforeEach, describe, expect, it } from "bun:test";
import { vi } from "@opencua/test-support";

const windows = vi.hoisted(() => ({
	list: vi.fn<() => readonly { id: number; ownerPid: number; ownerName: string }[] | undefined>(),
}));

vi.mock("./window-list.js", () => ({ listWindows: windows.list }));
vi.mock("./workspace.js", () => ({ findRunningApplication: () => undefined }));

const { assertWindowCaptureNotMasked } = await import("./screenshot.js");
const { CaptureMaskedError } = await import("../capture-mask.js");

beforeEach(() => {
	windows.list.mockReset();
});

describe("#given the screencapture fallback for one window #when masking is checked", () => {
	it("#when the window list cannot be read #then nothing is captured", () => {
		windows.list.mockReturnValue(undefined);

		expect(() => assertWindowCaptureNotMasked(7)).toThrow("window list could not be read");
	});

	it("#when the window belongs to an authentication prompt #then the capture is masked", () => {
		windows.list.mockReturnValue([{ id: 7, ownerPid: 70, ownerName: "SecurityAgent" }]);

		expect(() => assertWindowCaptureNotMasked(7)).toThrow(CaptureMaskedError);
	});

	it("#when the window belongs to an ordinary app #then the capture goes ahead", () => {
		windows.list.mockReturnValue([{ id: 7, ownerPid: 70, ownerName: "Notes" }]);

		expect(() => assertWindowCaptureNotMasked(7)).not.toThrow();
	});
});
