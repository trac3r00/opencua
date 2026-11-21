import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { vi } from "@opencua/test-support";

type ExecFileCallback = (error: Error | null, stdout: string | Buffer, stderr: string) => void;

const TARGET_PID = 42729;
const WINDOW_ID = 8337;
const SHOWN = { x: 740, y: 400, width: 230, height: 408 };

/**
 * The desktop as attended delivery sees it. Activating the app alone leaves the person on the covering app's Space,
 * while raising the app's window switches to the window's Space and lists it on screen. While a Space switch slides,
 * the WindowServer lists the window shifted along x; `slidingReads` counts the listings still taken mid-slide.
 */
const desktop = vi.hoisted(() => ({
	activated: false,
	raised: false,
	/** The window is on the current Space from the start. */
	listed: false,
	slidingReads: 0,
	/** Where the window really is once no slide is in progress. */
	settled: { x: 740, y: 400, width: 230, height: 408 },
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
		if (!desktop.listed && !desktop.raised) return [];
		const sliding = desktop.slidingReads > 0;
		if (sliding) desktop.slidingReads -= 1;
		const bounds = sliding ? { x: 1556, y: 400, width: 230, height: 408 } : desktop.settled;
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
	focusedCaretFrame: () => undefined,
	extractAccessibilityTree: () => ({
		axAvailable: true,
		truncated: false,
		walkKey: "calculator",
		elements: [
			{ id: 0, role: "AXWindow", label: "Calculator", value: null, frame: SHOWN, actions: [], children: [] },
		],
	}),
	focusedWindowIdsForObservationPid: () => ({ focusedWindowId: 8337, sheetOwnerWindowId: undefined }),
	// An app keeps its own key window while that window sits on another Space.
	focusedWindowIdForPid: () => 8337,
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
const coreGraphicsMock = vi.hoisted(() => ({
	getCurrentCursorPosition: vi.fn(() => ({ x: 863, y: 553 })),
	postKeyboardEvent: vi.fn(),
	postMouseEvent: vi.fn(),
	postScrollEvent: vi.fn(),
	postUnicodeText: vi.fn(),
	warpCursorPosition: vi.fn(),
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
const { AppApprovalStore } = await import("../permission/app-approval.js");
const { setRunningApplicationLookupForTesting } = await import("./app-list.js");
const { NOOP_POINTER_OVERLAY } = await import("./macos-ffi/cursor-overlay.js");
const { setFocusedFrameSourceForTesting, setKeyboardWindowFocuserForTesting, setOnscreenWindowIdsSourceForTesting } =
	await import("./macos-input.js");
const { setOpenWindowsSourceForTesting } = await import("./macos-open-windows.js");
const { MacOSHostComputer } = await import("./macos.js");
const { setSystemPromptWindowSourceForTesting } = await import("./system-prompts.js");

type Delivery = "attended" | "background";

function computerFor(delivery: Delivery): InstanceType<typeof MacOSHostComputer> {
	return new MacOSHostComputer({
		delivery,
		overlay: NOOP_POINTER_OVERLAY,
		appApproval: new AppApprovalStore(["com.apple.calculator"]),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	desktop.activated = false;
	desktop.raised = false;
	desktop.listed = false;
	desktop.slidingReads = 0;
	desktop.settled = SHOWN;
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
	setOnscreenWindowIdsSourceForTesting(() => (desktop.raised || desktop.listed ? [WINDOW_ID] : []));
	setFocusedFrameSourceForTesting(() => undefined);
	setKeyboardWindowFocuserForTesting(async () => undefined);
});

afterEach(() => {
	setAttendedHostDelivery(false);
});

describe("#given attended delivery and an app whose window sits on a Space activation alone does not switch to #when it is observed #then its window is raised and observed", () => {
	it("raises the app's focused window after activating it, as attended input does", async () => {
		const computer = computerFor("attended");

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

describe("#given attended delivery and a Space switch still sliding the window #when it is observed #then the observation records where the window comes to rest", () => {
	it("records the settled bounds, not the mid-slide listing", async () => {
		desktop.listed = true;
		desktop.slidingReads = 1;
		const computer = computerFor("attended");

		const state = await computer.getAppState(TARGET_PID, {
			settleMs: 0,
			requireWindow: true,
			includeScreenshot: false,
		});

		expect(state.windowBounds).toEqual(SHOWN);
		expect(computer.getInputObservation(TARGET_PID)?.windowBounds).toEqual(SHOWN);
		await computer.close();
	});
});

describe("#given an observed window and a Space switch sliding it when input is checked #when the window guard runs #then attended waits out the slide and background stays strict", () => {
	async function observedThenSliding(delivery: Delivery) {
		desktop.listed = true;
		const computer = computerFor(delivery);
		await computer.getAppState(TARGET_PID, { settleMs: 0, requireWindow: true, includeScreenshot: false });
		const observation = computer.getInputObservation(TARGET_PID);
		if (observation === undefined) throw new Error("expected an input observation");
		desktop.slidingReads = 1;
		return { computer, observation };
	}

	it("attended: allows the same window once the slide puts it back at the observed bounds", async () => {
		const { computer, observation } = await observedThenSliding("attended");

		expect(await computer.preflightInput(observation)).toEqual({ ok: true });
		await computer.close();
	});

	it("attended: still refuses a window that really moved", async () => {
		const { computer, observation } = await observedThenSliding("attended");
		desktop.settled = { ...SHOWN, x: 900 };

		expect(await computer.preflightInput(observation)).toEqual({ ok: false, reason: "window-bounds-changed" });
		await computer.close();
	});

	it("background: refuses the mid-slide bounds as before", async () => {
		const { computer, observation } = await observedThenSliding("background");

		expect(await computer.preflightInput(observation)).toEqual({ ok: false, reason: "window-bounds-changed" });
		await computer.close();
	});
});

describe("#given attended delivery and an observed window another app's activation moved off the current Space #when keys are typed into it #then it is brought forward and takes them", () => {
	it("raises the observed off-Space window and types through the HID tap", async () => {
		desktop.listed = true;
		const computer = computerFor("attended");
		await computer.getAppState(TARGET_PID, { settleMs: 0, requireWindow: true, includeScreenshot: false });
		desktop.listed = false;
		setOpenWindowsSourceForTesting(
			() => undefined,
			() => (desktop.raised ? [] : [{ id: WINDOW_ID, owner: { processId: TARGET_PID }, bounds: SHOWN }]),
		);

		await runInInputScope({ target: { pid: TARGET_PID, windowId: WINDOW_ID } }, async () => {
			await computer.type("8");
		});

		expect(foregroundMock.raiseWindowInApp).toHaveBeenCalledWith(TARGET_PID, WINDOW_ID);
		expect(coreGraphicsMock.postUnicodeText.mock.calls.map(([text, pid]) => [text, pid])).toEqual([["8", undefined]]);
		await computer.close();
	});
});
