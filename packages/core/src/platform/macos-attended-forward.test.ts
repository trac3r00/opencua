import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { vi } from "@opencua/test-support";

type ExecFileCallback = (error: Error | null, stdout: string | Buffer, stderr: string) => void;

const TARGET_PID = 42729;
const WINDOW_ID = 8337;
const SHOWN = { x: 740, y: 400, width: 230, height: 408 };
/** Where the live WindowServer reported Calculator while another app was in front: off the only (2560-wide) display. */
const PARKED = { x: 3361, y: 400, width: 230, height: 408 };

/**
 * The desktop as attended observation sees it: activating the app alone leaves the person on the covering app's
 * Space, while raising the app's window switches to the window's Space and puts it on screen.
 */
const desktop = vi.hoisted(() => ({
	activated: false,
	raised: false,
	/** The window is listed on screen but parked off every display until its app comes forward. */
	parked: false,
}));

const childProcessMock = vi.hoisted(() => ({
	execFile: vi.fn((_file: string, _args: readonly string[], _options: unknown, callback: ExecFileCallback) => {
		callback(
			null,
			JSON.stringify([{ name: "Calculator", bundleId: "com.apple.calculator", pid: 42729, isActive: false }]),
			"",
		);
	}),
}));
const windowMock = vi.hoisted(() => ({
	openWindows: vi.fn(async () => {
		const shown = { x: 740, y: 400, width: 230, height: 408 };
		const parked = { x: 3361, y: 400, width: 230, height: 408 };
		if (!desktop.parked && !desktop.raised) return [];
		const bounds = desktop.parked && !desktop.raised ? parked : shown;
		return [{ id: 8337, title: "Calculator", owner: { processId: 42729 }, bounds }];
	}),
}));
const foregroundMock = vi.hoisted(() => ({
	activateApplication: vi.fn((_pid: number) => {
		desktop.activated = true;
		return true;
	}),
	raiseWindowInApp: vi.fn((_pid: number, _windowId: number) => {
		desktop.raised = true;
		return true;
	}),
}));

vi.mock("node:child_process", () => ({ execFile: childProcessMock.execFile }));
vi.mock("get-windows", () => ({ openWindows: windowMock.openWindows }));
vi.mock("./macos-ffi/window-list.js", () => ({ listWindows: () => [], listOnscreenWindows: () => [] }));
vi.mock("./macos-ffi/lock-screen.js", () => ({ isScreenLocked: () => false }));
vi.mock("./macos-ffi/display-list.js", () => ({
	onlineDisplayInfo: () => [{ id: 2, isMain: true, x: 0, y: 0, width: 2560, height: 1440, scaleFactor: 1 }],
}));
vi.mock("./macos-ffi/screenshot.js", () => ({
	captureDisplayImage: vi.fn(),
	captureWindowImage: vi.fn(),
	captureWindowImageAsync: vi.fn(),
	getMainDisplayId: () => 2,
	getMainDisplayLogicalSize: () => ({ width: 2560, height: 1440 }),
	getMainDisplayNativePixelSize: () => ({ width: 2560, height: 1440 }),
	screenCaptureAllowed: () => true,
}));
vi.mock("./macos-ffi/accessibility.js", () => ({
	extractAccessibilityTree: () => ({
		axAvailable: true,
		truncated: false,
		walkKey: "calculator",
		elements: [
			{ id: 0, role: "AXWindow", label: "Calculator", value: null, frame: SHOWN, actions: [], children: [] },
		],
	}),
	focusedWindowIdsForObservationPid: () => ({ focusedWindowId: 8337, sheetOwnerWindowId: undefined }),
	focusedWindowIdForPid: () => (desktop.raised ? 8337 : undefined),
	focusedWindowIsModal: () => false,
	focusedWindowShowsFilePanel: () => false,
	focusedElementFrame: () => undefined,
	raiseWindowInApp: foregroundMock.raiseWindowInApp,
	windowMinimizedForPid: () => false,
	windowTitlesForPid: () => new Map(),
	releaseAccessibilitySnapshot: vi.fn(),
	accessibilitySnapshotPids: () => [],
	releaseSnapshotsForExitedPids: () => 0,
	currentObservationKey: () => "0:test",
}));
vi.mock("./macos-ffi/skylight.js", () => ({
	focusGuardFor: () => (desktop.activated ? null : { previousPsn: Buffer.alloc(8, 1), targetPsn: Buffer.alloc(8, 2) }),
	frontProcessSerialNumber: () => Buffer.alloc(8, desktop.activated ? 2 : 1),
	setProcessAppActive: vi.fn(() => true),
}));
const actualWorkspace = { ...(await import("./macos-ffi/workspace.js")) };
vi.mock("./macos-ffi/workspace.js", () => ({
	...actualWorkspace,
	activateApplication: foregroundMock.activateApplication,
}));

const { setAttendedHostDelivery } = await import("../computer/host-interaction-policy.js");
const { setRunningApplicationLookupForTesting } = await import("./app-list.js");
const { NOOP_POINTER_OVERLAY } = await import("./macos-ffi/cursor-overlay.js");
const { setFocusedFrameSourceForTesting, setOnscreenWindowIdsSourceForTesting } = await import("./macos-input.js");
const { setOpenWindowsSourceForTesting } = await import("./macos-open-windows.js");
const { MacOSHostComputer } = await import("./macos.js");
const { setSystemPromptWindowSourceForTesting } = await import("./system-prompts.js");

beforeEach(() => {
	vi.clearAllMocks();
	desktop.activated = false;
	desktop.raised = false;
	desktop.parked = false;
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
	setOnscreenWindowIdsSourceForTesting(() => (desktop.raised || desktop.parked ? [WINDOW_ID] : []));
	setFocusedFrameSourceForTesting(() => undefined);
});

afterEach(() => {
	setAttendedHostDelivery(false);
});

describe("#given attended delivery and an app whose window sits on a Space activation alone does not switch to #when it is observed #then its window is raised and observed", () => {
	it("raises the app's focused window after activating it, as attended input does", async () => {
		const computer = new MacOSHostComputer({ delivery: "attended", overlay: NOOP_POINTER_OVERLAY });

		const state = await computer.getAppState(TARGET_PID, {
			settleMs: 0,
			requireWindow: true,
			includeScreenshot: false,
		});

		expect(state.windowId).toBe(WINDOW_ID);
		expect(foregroundMock.activateApplication).toHaveBeenCalledWith(TARGET_PID);
		expect(foregroundMock.raiseWindowInApp).toHaveBeenCalledWith(TARGET_PID, WINDOW_ID);
		await computer.close();
	});
});

describe("#given attended delivery and a window parked off every display while its app is not in front #when it is observed #then the observation records where input will find it", () => {
	it("brings the window forward and records its on-display bounds, not the parked ones", async () => {
		desktop.parked = true;
		const computer = new MacOSHostComputer({ delivery: "attended", overlay: NOOP_POINTER_OVERLAY });

		const state = await computer.getAppState(TARGET_PID, {
			settleMs: 0,
			requireWindow: true,
			includeScreenshot: false,
		});

		expect(state.windowBounds).toEqual(SHOWN);
		expect(computer.getInputObservation(TARGET_PID)?.windowBounds).toEqual(SHOWN);
		expect(foregroundMock.raiseWindowInApp).toHaveBeenCalledWith(TARGET_PID, WINDOW_ID);
		await computer.close();
	});
});

describe("#given background delivery and a parked window #when it is observed #then the app is never brought forward", () => {
	it("observes the window where it is listed without activating or raising it", async () => {
		desktop.parked = true;
		const computer = new MacOSHostComputer({ delivery: "background", overlay: NOOP_POINTER_OVERLAY });

		const state = await computer.getAppState(TARGET_PID, {
			settleMs: 0,
			requireWindow: true,
			includeScreenshot: false,
		});

		expect(state.windowBounds).toEqual(PARKED);
		expect(foregroundMock.activateApplication).not.toHaveBeenCalled();
		expect(foregroundMock.raiseWindowInApp).not.toHaveBeenCalled();
		await computer.close();
	});
});
