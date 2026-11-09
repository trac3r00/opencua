import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { vi } from "@opencua/test-support";

type ExecFileCallback = (error: Error | null, stdout: string | Buffer, stderr: string) => void;

const TARGET_PID = 63214;
const TEXT_AREA = { x: 100, y: 200, width: 586, height: 282 };

/** Whether the target app was brought forward: until then none of its windows is on this Space. */
const desktop = vi.hoisted(() => ({ activated: false }));

const childProcessMock = vi.hoisted(() => ({
	execFile: vi.fn((_file: string, _args: readonly string[], _options: unknown, callback: ExecFileCallback) => {
		callback(
			null,
			JSON.stringify([{ name: "TextEdit", bundleId: "com.apple.TextEdit", pid: 63214, isActive: false }]),
			"",
		);
	}),
}));
const windowMock = vi.hoisted(() => ({
	openWindows: vi.fn(async () =>
		desktop.activated
			? [
					{
						id: 99,
						title: "Untitled",
						owner: { processId: 63214 },
						bounds: { x: 100, y: 100, width: 600, height: 400 },
					},
				]
			: [],
	),
}));
const foregroundMock = vi.hoisted(() => ({
	activateApplication: vi.fn((_pid: number) => {
		desktop.activated = true;
		return true;
	}),
}));
const coreGraphicsMock = vi.hoisted(() => ({
	getCurrentCursorPosition: vi.fn(() => ({ x: 863, y: 553 })),
	postKeyboardEvent: vi.fn(),
	postMouseEvent: vi.fn(),
	postScrollEvent: vi.fn(),
	postUnicodeText: vi.fn(),
	warpCursorPosition: vi.fn(),
}));

vi.mock("node:child_process", () => ({ execFile: childProcessMock.execFile }));
vi.mock("get-windows", () => ({ openWindows: windowMock.openWindows }));
vi.mock("./macos-ffi/window-list.js", () => ({ listWindows: () => [], listOnscreenWindows: () => [] }));
vi.mock("./macos-ffi/lock-screen.js", () => ({ isScreenLocked: () => false }));
vi.mock("./macos-ffi/screenshot.js", () => ({
	captureDisplayImage: vi.fn(),
	captureWindowImage: vi.fn(),
	captureWindowImageAsync: vi.fn(),
	getMainDisplayId: () => 1,
	getMainDisplayLogicalSize: () => ({ width: 1920, height: 1080 }),
	getMainDisplayNativePixelSize: () => ({ width: 1920, height: 1080 }),
	screenCaptureAllowed: () => true,
}));
vi.mock("./macos-ffi/accessibility.js", () => ({
	extractAccessibilityTree: () => ({
		axAvailable: true,
		truncated: false,
		walkKey: "text-area",
		elements: [{ id: 2, role: "AXTextArea", label: null, value: "", frame: TEXT_AREA, actions: [], children: [] }],
	}),
	focusedWindowIdsForObservationPid: () => ({ focusedWindowId: undefined, sheetOwnerWindowId: undefined }),
	focusedWindowIdForPid: () => (desktop.activated ? 99 : undefined),
	focusedWindowIsModal: () => false,
	focusedWindowShowsFilePanel: () => false,
	focusedElementFrame: () => undefined,
	raiseWindowInApp: () => true,
	windowMinimizedForPid: () => false,
	windowTitlesForPid: () => new Map(),
	releaseAccessibilitySnapshot: vi.fn(),
	accessibilitySnapshotPids: () => [],
	releaseSnapshotsForExitedPids: () => 0,
	currentObservationKey: () => "0:test",
}));
vi.mock("./macos-ffi/skylight.js", () => ({
	// Null once the target is the front process, as the native guard reports.
	focusGuardFor: () => (desktop.activated ? null : { previousPsn: Buffer.alloc(8, 1), targetPsn: Buffer.alloc(8, 2) }),
	frontProcessSerialNumber: () => Buffer.alloc(8, desktop.activated ? 2 : 1),
	setProcessAppActive: vi.fn(() => true),
}));
const actualWorkspace = { ...(await import("./macos-ffi/workspace.js")) };
vi.mock("./macos-ffi/workspace.js", () => ({
	...actualWorkspace,
	activateApplication: foregroundMock.activateApplication,
}));
vi.mock("./macos-ffi/coregraphics.js", () => ({
	K_CG_EVENT_FLAG_MASK_ALTERNATE: 0x00080000,
	K_CG_EVENT_FLAG_MASK_COMMAND: 0x00100000,
	K_CG_EVENT_FLAG_MASK_CONTROL: 0x00040000,
	K_CG_EVENT_FLAG_MASK_SHIFT: 0x00020000,
	...coreGraphicsMock,
}));

const { setAttendedHostDelivery } = await import("../computer/host-interaction-policy.js");
const { runInInputScope } = await import("../computer/input-scope.js");
const { setRunningApplicationLookupForTesting } = await import("./app-list.js");
const { NOOP_POINTER_OVERLAY } = await import("./macos-ffi/cursor-overlay.js");
const { setFocusedFrameSourceForTesting, setKeyboardWindowFocuserForTesting, setOnscreenWindowIdsSourceForTesting } =
	await import("./macos-input.js");
const { setOpenWindowsSourceForTesting } = await import("./macos-open-windows.js");
const { MacOSHostComputer } = await import("./macos.js");
const { setSystemPromptWindowSourceForTesting } = await import("./system-prompts.js");

beforeEach(() => {
	vi.clearAllMocks();
	desktop.activated = false;
	// The in-process WindowServer listings are pinned away so the get-windows fixture stays authoritative.
	setOpenWindowsSourceForTesting(
		() => undefined,
		() => undefined,
	);
	setSystemPromptWindowSourceForTesting(() => []);
	setRunningApplicationLookupForTesting({
		getRunningApplications: (): never => {
			throw new Error("native application lookup is unavailable in this test");
		},
		findRunningApplication: (): never => {
			throw new Error("native application lookup is unavailable in this test");
		},
	});
	setOnscreenWindowIdsSourceForTesting(() => (desktop.activated ? [99] : []));
	setKeyboardWindowFocuserForTesting(async () => undefined);
	setFocusedFrameSourceForTesting(() => undefined);
});

afterEach(() => {
	setAttendedHostDelivery(false);
});

describe("#given attended delivery and an app with no window on this Space #when it is observed and then driven #then it comes forward and takes real input", () => {
	it("activates the app to observe its window, then clicks the text area and types through the HID tap", async () => {
		const computer = new MacOSHostComputer({ delivery: "attended", overlay: NOOP_POINTER_OVERLAY });

		const state = await computer.getAppState(TARGET_PID, {
			settleMs: 0,
			requireWindow: true,
			includeScreenshot: false,
		});
		await runInInputScope({ target: { pid: TARGET_PID, windowId: 99 } }, async () => {
			await computer.click({ x: TEXT_AREA.x + TEXT_AREA.width / 2, y: TEXT_AREA.y + TEXT_AREA.height / 2 });
			await computer.type("hello");
		});

		expect(state.windowId).toBe(99);
		expect(foregroundMock.activateApplication).toHaveBeenCalledWith(TARGET_PID);
		expect(
			coreGraphicsMock.postMouseEvent.mock.calls.map(([event]) => [event.kind, event.position, event.targetPid]),
		).toEqual([
			["move", { x: 393, y: 341 }, undefined],
			["down", { x: 393, y: 341 }, undefined],
			["up", { x: 393, y: 341 }, undefined],
		]);
		expect(coreGraphicsMock.postUnicodeText.mock.calls.map(([text, pid]) => [text, pid])).toEqual([
			["h", undefined],
			["e", undefined],
			["l", undefined],
			["l", undefined],
			["o", undefined],
		]);
		await computer.close();
	});
});

describe("#given background delivery and a window that appears on a later look #when it is observed #then the app is never brought forward", () => {
	it("waits for the window without activating the app", async () => {
		windowMock.openWindows.mockImplementationOnce(async () => []);
		desktop.activated = true;
		const computer = new MacOSHostComputer({ delivery: "background", overlay: NOOP_POINTER_OVERLAY });

		const state = await computer.getAppState(TARGET_PID, {
			settleMs: 0,
			requireWindow: true,
			includeScreenshot: false,
		});

		expect(state.windowId).toBe(99);
		expect(foregroundMock.activateApplication).not.toHaveBeenCalled();
		await computer.close();
	});
});
