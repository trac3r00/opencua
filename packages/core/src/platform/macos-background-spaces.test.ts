import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { vi } from "@opencua/test-support";

import type { InputObservation } from "../computer/guarded-interface.js";

const fixture = vi.hoisted(() => ({
	currentWindows: [
		{
			id: 10,
			owner: { processId: 1234, name: "Fixture App" },
			title: "Current Space",
			bounds: { x: 0, y: 0, width: 400, height: 300 },
		},
	],
	allSpaceWindows: [
		{
			id: 10,
			owner: { processId: 1234, name: "Fixture App" },
			title: "Current Space",
			bounds: { x: 0, y: 0, width: 400, height: 300 },
		},
		{
			id: 20,
			owner: { processId: 1234, name: "Fixture App" },
			title: "Other Space",
			bounds: { x: 500, y: 40, width: 800, height: 600 },
		},
	],
	openWindowsForTargeting: vi.fn(async (_sources?: unknown, options?: { readonly includeOffscreen?: boolean }) =>
		options?.includeOffscreen === true ? fixture.allSpaceWindows : fixture.currentWindows,
	),
	minimizedStatus: undefined as boolean | undefined,
	focusedWindowId: undefined as number | undefined,
	extractAccessibilityTree: vi.fn(() => ({
		axAvailable: true,
		truncated: false,
		walkKey: "background-space-fixture",
		windowTitle: "Other Space",
		elements: [],
	})),
	captureWindowImage: vi.fn((..._args: unknown[]) => ({ data: fakePng(800, 600), width: 800, height: 600 })),
}));

vi.mock("./macos-open-windows.js", () => ({
	openWindowsForTargeting: fixture.openWindowsForTargeting,
}));
vi.mock("./macos-window-target-fallback.js", () => ({
	selectSystemEventsTargetWindow: vi.fn(async () => undefined),
}));
vi.mock("./macos-ffi/accessibility.js", () => ({
	focusedCaretFrame: () => undefined,
	currentObservationKey: vi.fn(() => "0:background-space-test"),
	accessibilitySnapshotPids: vi.fn<() => readonly number[]>(() => []),
	releaseSnapshotsForExitedPids: vi.fn<() => number>(() => 0),
	elementFrameByIndex: vi.fn(),
	extractAccessibilityTree: fixture.extractAccessibilityTree,
	focusedElementFrame: vi.fn(),
	focusedWindowIdForPid: vi.fn(() => fixture.focusedWindowId),
	focusedWindowIdsForObservationPid: vi.fn(() => ({
		focusedWindowId: fixture.focusedWindowId,
		sheetOwnerWindowId: undefined,
	})),
	focusedWindowIsModal: vi.fn(() => false),
	focusedWindowShowsFilePanel: vi.fn(() => false),
	isWebElementByIndex: vi.fn(() => false),
	performActionByIndex: vi.fn(),
	pressElementAtScreenPoint: vi.fn(),
	rebaselineObservedElement: vi.fn(),
	releaseAccessibilitySnapshot: vi.fn(),
	relocatedElementFrame: vi.fn(),
	scrollToVisibleByIndex: vi.fn(() => false),
	selectAllInFocusedTextElement: vi.fn(() => false),
	selectTextByIndex: vi.fn(),
	setValueByIndex: vi.fn(),
	typeIntoFocusedAXElement: vi.fn(() => false),
	windowMinimizedForPid: vi.fn(() => fixture.minimizedStatus),
	windowTitlesForPid: vi.fn(() => new Map()),
}));
vi.mock("./macos-ffi/screenshot.js", () => ({
	captureDisplayImage: vi.fn(() => ({ data: fakePng(1440, 900), width: 1440, height: 900 })),
	captureDisplayRegionImage: vi.fn(),
	captureWindowImage: fixture.captureWindowImage,
	captureWindowImageAsync: async (...args: unknown[]) => fixture.captureWindowImage(...args),
	getMainDisplayId: vi.fn(() => 1),
	getMainDisplayLogicalSize: vi.fn(() => ({ width: 1440, height: 900 })),
	getMainDisplayNativePixelSize: vi.fn(() => ({ width: 2880, height: 1800 })),
	screenCaptureAllowed: vi.fn(() => true),
}));
vi.mock("./macos-ffi/lock-screen.js", () => ({ isScreenLocked: () => false }));
vi.mock("./macos-ffi/cursor-overlay.js", () => ({
	NOOP_POINTER_OVERLAY: {
		state: async () => null,
		set: () => undefined,
		track: () => undefined,
		highlight: () => undefined,
		setMode: () => undefined,
		setScrollMode: () => undefined,
		keyPress: () => undefined,
		hide: () => undefined,
		close: () => undefined,
	},
	createCursorOverlay: vi.fn(),
}));

const { AppApprovalStore } = await import("../permission/app-approval.js");
const { setAttendedHostDelivery } = await import("../computer/host-interaction-policy.js");
const { setRunningApplicationLookupForTesting } = await import("./app-list.js");
const { NOOP_POINTER_OVERLAY } = await import("./macos-ffi/cursor-overlay.js");
const { MacOSInputController, setOnscreenWindowIdsSourceForTesting } = await import("./macos-input.js");
const { MacOSHostComputer } = await import("./macos.js");
const { setSystemPromptWindowSourceForTesting } = await import("./system-prompts.js");

const PID = 1234;
const BUNDLE_ID = "com.example.fixture";
const OFFSPACE_ID = 20;
const OFFSPACE_BOUNDS = { x: 500, y: 40, width: 800, height: 600 };
const app = {
	name: "Fixture App",
	bundleId: BUNDLE_ID,
	pid: PID,
	isActive: false,
	path: "/Applications/Fixture App.app",
};

function fakePng(width: number, height: number): Buffer {
	const data = Buffer.alloc(24);
	data.write("\u0089PNG\r\n\u001a\n", 0, "latin1");
	data.writeUInt32BE(width, 16);
	data.writeUInt32BE(height, 20);
	return data;
}

function approvedBackgroundComputer(
	delivery: "background" | "attended" = "background",
): InstanceType<typeof MacOSHostComputer> {
	return new MacOSHostComputer({
		appApproval: new AppApprovalStore([BUNDLE_ID]),
		delivery,
		overlay: NOOP_POINTER_OVERLAY,
	});
}

async function observeOffSpace(computer: InstanceType<typeof MacOSHostComputer>): Promise<InputObservation> {
	await computer.getAppState(PID, {
		settleMs: 0,
		requireWindow: true,
		windowId: OFFSPACE_ID,
	});
	const observation = computer.getInputObservation(PID);
	if (observation === undefined) {
		throw new Error("expected an input observation for the explicit off-Space window");
	}
	return observation;
}

beforeEach(() => {
	fixture.openWindowsForTargeting.mockClear();
	fixture.minimizedStatus = false;
	fixture.focusedWindowId = undefined;
	fixture.currentWindows = [
		{
			id: 10,
			owner: { processId: 1234, name: "Fixture App" },
			title: "Current Space",
			bounds: { x: 0, y: 0, width: 400, height: 300 },
		},
	];
	fixture.extractAccessibilityTree.mockClear();
	fixture.captureWindowImage.mockClear();
	setRunningApplicationLookupForTesting({
		getRunningApplications: () => [app],
		findRunningApplication: () => app,
	});
	setSystemPromptWindowSourceForTesting(() => []);
	setOnscreenWindowIdsSourceForTesting(() => [10]);
	vi.spyOn(MacOSInputController.prototype, "rememberTargetWindow");
});

afterEach(() => {
	vi.restoreAllMocks();
	setRunningApplicationLookupForTesting(undefined);
	setSystemPromptWindowSourceForTesting(undefined);
});

describe("#given an explicit window on another Space #when the background host observes it #then identity and bounds stay bound", () => {
	it("preserves current-Space inventory when all-Spaces enumeration fails", async () => {
		const computer = approvedBackgroundComputer();
		fixture.currentWindows.push({
			id: 11,
			owner: { processId: PID, name: "Fixture App" },
			title: "Second current window",
			bounds: { x: 410, y: 0, width: 400, height: 300 },
		});
		fixture.openWindowsForTargeting
			.mockImplementationOnce(async () => fixture.currentWindows)
			.mockRejectedValueOnce(new Error("all-Spaces enumeration unavailable"));
		try {
			const state = await computer.getAppState(PID, {
				settleMs: 0,
				requireWindow: true,
				windowId: 10,
			});
			expect(state.windowCandidates?.map((window) => window.id)).toEqual([10, 11]);
		} finally {
			await computer.close();
		}
	});

	it("tries current-Space windows first, falls back to all-Spaces, and captures the exact id", async () => {
		const computer = approvedBackgroundComputer();
		try {
			const state = await computer.getAppState(PID, {
				settleMs: 0,
				requireWindow: true,
				windowId: OFFSPACE_ID,
			});
			const observation = computer.getInputObservation(PID);

			expect(state.windowId).toBe(OFFSPACE_ID);
			expect(state.windowTitle).toBe("Other Space");
			expect(state.windowBounds).toEqual(OFFSPACE_BOUNDS);
			expect(observation?.windowId).toBe(OFFSPACE_ID);
			expect(observation?.windowBounds).toEqual(OFFSPACE_BOUNDS);
			expect(MacOSInputController.prototype.rememberTargetWindow).toHaveBeenCalledWith(
				PID,
				OFFSPACE_ID,
				fixture.currentWindows,
			);
			expect(state.windowCandidates?.map((window) => window.id)).toEqual([10, OFFSPACE_ID]);
			expect(fixture.captureWindowImage).toHaveBeenCalledWith(OFFSPACE_ID, 800, 600, "jpeg", 72);
			expect(fixture.openWindowsForTargeting.mock.calls[0]).toEqual([]);
			expect(fixture.openWindowsForTargeting.mock.calls[1]?.[1]).toEqual({ includeOffscreen: true });
			expect(await computer.preflightInput(observation ?? failObservation())).toEqual({ ok: true });
		} finally {
			await computer.close();
		}
	});

	it("uses the app-focused off-Space id but never an arbitrary off-Space fallback", async () => {
		const computer = approvedBackgroundComputer();
		try {
			fixture.currentWindows = [];
			fixture.focusedWindowId = OFFSPACE_ID;
			const focused = await computer.getAppState(PID, { settleMs: 0, requireWindow: true });
			expect(focused.windowId).toBe(OFFSPACE_ID);

			fixture.focusedWindowId = undefined;
			const unscoped = await computer.getAppState(PID, {
				settleMs: 0,
				includeScreenshot: false,
			});
			expect(unscoped.windowId).toBeUndefined();
		} finally {
			await computer.close();
		}
	});

	it.each([
		["minimized", true],
		["unknown", undefined],
	] as const)("refuses an off-Space target whose minimized status is %s", async (_name, status) => {
		const computer = approvedBackgroundComputer();
		try {
			fixture.minimizedStatus = false;
			const observation = await observeOffSpace(computer);
			fixture.minimizedStatus = status;

			expect((await computer.preflightInput(observation)).ok).toBe(false);
		} finally {
			await computer.close();
		}
	});
});

describe("#given attended delivery #when the host computer is built #then it queries no window", () => {
	it("does not query the all-Spaces source", async () => {
		const computer = approvedBackgroundComputer("attended");
		try {
			expect(fixture.openWindowsForTargeting).not.toHaveBeenCalled();
		} finally {
			setAttendedHostDelivery(false);
			await computer.close();
		}
	});
});

describe("#given attended delivery #when an observed window leaves the current Space #then input is still allowed", () => {
	it("approves the observed window that another app's activation moved off the current Space", async () => {
		const computer = approvedBackgroundComputer("attended");
		try {
			await computer.getAppState(PID, { settleMs: 0, requireWindow: true, windowId: 10 });
			const observation = computer.getInputObservation(PID) ?? failObservation();
			fixture.currentWindows = [];
			setOnscreenWindowIdsSourceForTesting(() => []);

			expect(await computer.preflightInput(observation)).toEqual({ ok: true });
		} finally {
			setAttendedHostDelivery(false);
			await computer.close();
		}
	});
});

function failObservation(): never {
	throw new Error("expected a captured off-Space input observation");
}
