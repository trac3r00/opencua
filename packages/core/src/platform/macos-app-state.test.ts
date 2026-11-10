import { beforeEach, describe, expect, it } from "bun:test";
import { vi } from "@opencua/test-support";

type ExecFileCallback = (error: Error | null, stdout: string | Buffer, stderr: string) => void;
type ExecFileMock = (
	file: string,
	args: readonly string[],
	options: { readonly encoding?: BufferEncoding; readonly timeout?: number },
	callback: ExecFileCallback,
) => void;

const childProcessMock = vi.hoisted(() => ({ execFile: vi.fn<ExecFileMock>() }));
vi.mock("node:child_process", () => ({ execFile: childProcessMock.execFile }));

type TestWindow = {
	id: number;
	title?: string;
	owner: { processId: number };
	bounds: { x: number; y: number; width: number; height: number };
};
const windowMock = vi.hoisted(() => ({
	openWindows: vi.fn<() => Promise<readonly TestWindow[]>>(() => Promise.resolve([])),
}));
vi.mock("get-windows", () => ({ openWindows: windowMock.openWindows }));
const windowListMock = vi.hoisted(() => ({
	listWindows: vi.fn(() => [
		{
			id: 99,
			ownerPid: 1234,
			layer: 0,
			ownerName: "Finder",
			title: "Documents",
			bounds: { x: 300, y: 150, width: 2560, height: 1600 },
		},
	]),
	listOnscreenWindows: vi.fn(() => []),
}));
vi.mock("./macos-ffi/window-list.js", () => windowListMock);

const accessibilityMock = vi.hoisted(() => ({
	extractAccessibilityTree: vi.fn(),
	focusedWindowIdsForObservationPid: vi.fn<
		() => { readonly focusedWindowId: number | undefined; readonly sheetOwnerWindowId: number | undefined }
	>(() => ({ focusedWindowId: undefined, sheetOwnerWindowId: undefined })),
	releaseAccessibilitySnapshot: vi.fn(),
	accessibilitySnapshotPids: vi.fn<() => readonly number[]>(() => []),
	releaseSnapshotsForExitedPids: vi.fn<() => number>(() => 0),
	currentObservationKey: vi.fn(() => "0:test"),
	performActionByIndex: vi.fn(),
	pressElementAtScreenPoint: vi.fn(),
	setValueByIndex: vi.fn(),
	typeIntoFocusedAXElement: vi.fn(),
	windowTitlesForPid: vi.fn<() => ReadonlyMap<number, string>>(() => new Map()),
}));

const screenshotMock = vi.hoisted(() => ({
	captureDisplayImage: vi.fn(),
	getMainDisplayId: vi.fn(() => 1),
	captureWindowImage: vi.fn(),
	captureWindowImageAsync: async (...args: unknown[]): Promise<unknown> => screenshotMock.captureWindowImage(...args),
	getMainDisplayLogicalSize: vi.fn(),
	getMainDisplayNativePixelSize: vi.fn(),
	screenCaptureAllowed: vi.fn(() => true),
}));
vi.mock("./macos-ffi/screenshot.js", () => screenshotMock);
vi.mock("./macos-ffi/accessibility.js", () => accessibilityMock);
vi.mock("./macos-ffi/lock-screen.js", () => ({ isScreenLocked: () => false }));

const { MacOSInputController, setOnscreenWindowIdsSourceForTesting } = await import("./macos-input.js");
const { observedWindowForPid, setOpenWindowsSourceForTesting } = await import("./macos-open-windows.js");
const { AppApprovalStore } = await import("../permission/app-approval.js");
const { setRunningApplicationLookupForTesting } = await import("./app-list.js");
const displayList = await import("./macos-ffi/display-list.js");
const { MacOSHostComputer } = await import("./macos.js");
const { setSystemPromptWindowSourceForTesting } = await import("./system-prompts.js");
// The in-process WindowServer listings, current-Space and all-Spaces, are pinned away so the get-windows fixtures
// above stay authoritative; background observation then keeps that proven current-Space inventory.
setOpenWindowsSourceForTesting(
	() => undefined,
	() => undefined,
);

import type { AccessibilityTreeOptions } from "./macos-ffi/accessibility.js";

// The live window server would leak this Mac's real dialogs into the fixtures; pin an empty screen.
setSystemPromptWindowSourceForTesting(() => []);

/** Forces the AppleScript application-list fallback so the execFile fixtures stay authoritative. */
const unavailableNativeLookup = {
	getRunningApplications: (): never => {
		throw new Error("native application lookup is unavailable in this test");
	},
	findRunningApplication: (): never => {
		throw new Error("native application lookup is unavailable in this test");
	},
};

const TARGET_PID = 1234;
const WINDOW_BOUNDS = { x: 300, y: 150, width: 2560, height: 1600 };

function fakePng(width: number, height: number): Buffer {
	const data = globalThis.Buffer.alloc(24);
	data.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	data.writeUInt32BE(width, 16);
	data.writeUInt32BE(height, 20);
	return data;
}

beforeEach(() => {
	setOpenWindowsSourceForTesting(
		() => undefined,
		() => undefined,
	);
	vi.spyOn(displayList, "onlineDisplayInfo").mockReturnValue([
		{ id: 2, x: 0, y: 0, width: 2560, height: 1440, scaleFactor: 1, isMain: true },
	]);
	setRunningApplicationLookupForTesting(unavailableNativeLookup);
	childProcessMock.execFile.mockReset();
	windowMock.openWindows.mockReset();
	setOnscreenWindowIdsSourceForTesting(() => [42, 99]);
	accessibilityMock.extractAccessibilityTree.mockReset();
	accessibilityMock.focusedWindowIdsForObservationPid
		.mockReset()
		.mockReturnValue({ focusedWindowId: undefined, sheetOwnerWindowId: undefined });
	accessibilityMock.performActionByIndex.mockReset();
	accessibilityMock.releaseAccessibilitySnapshot.mockReset();
	screenshotMock.captureDisplayImage.mockReset();
	screenshotMock.getMainDisplayLogicalSize.mockReset();
	screenshotMock.getMainDisplayNativePixelSize.mockReset();
	screenshotMock.getMainDisplayLogicalSize.mockReturnValue({ width: 1920, height: 1080 });
	screenshotMock.getMainDisplayNativePixelSize.mockReturnValue({ width: 3840, height: 2160 });
	screenshotMock.captureDisplayImage.mockReturnValue({ data: fakePng(1920, 1080), width: 1920, height: 1080 });

	windowMock.openWindows.mockResolvedValue([{ id: 99, owner: { processId: TARGET_PID }, bounds: WINDOW_BOUNDS }]);
	// Mirrors the real contract: element ids belong to one exact walk, so the key reflects
	// the window scope, menu-bar choice and element budget the caller asked for.
	accessibilityMock.extractAccessibilityTree.mockImplementation(
		(_pid: number, options?: AccessibilityTreeOptions) => ({
			axAvailable: true,
			truncated: false,
			walkKey: JSON.stringify([
				options?.windowId ?? null,
				options?.includeMenuBar === true,
				options?.maxElements ?? 2000,
			]),
			elements: [
				{
					id: 5,
					role: "AXButton",
					label: "Open",
					value: null,
					frame: { x: 800, y: 550, width: 200, height: 160 },
					actions: ["AXPress"],
					children: [],
				},
			],
		}),
	);
	// First execFile call: getRunningMacOSApps (osascript JXA). Second: window screenshot (sh).
	childProcessMock.execFile.mockImplementationOnce((_file, _args, _options, callback) => {
		callback(
			null,
			JSON.stringify([{ name: "Finder", bundleId: "com.apple.finder", pid: TARGET_PID, isActive: true }]),
			"",
		);
	});
	childProcessMock.execFile.mockImplementationOnce((_file, _args, _options, callback) => {
		// The sips step would resize to 1280x800; mirror that in the returned png header.
		callback(null, fakePng(2560, 1600), "");
	});
});

describe("#given one observation #when the driver resolves its target window and its inventory #then it enumerates the window list once", () => {
	it("uses the matched accessibility title when WindowServer does not expose one", async () => {
		accessibilityMock.extractAccessibilityTree.mockReturnValue({
			axAvailable: true,
			truncated: false,
			walkKey: "scoped-window-99",
			windowTitle: "Private folder",
			elements: [],
		});
		const computer = new MacOSHostComputer();

		const state = await computer.getAppState(TARGET_PID, { settleMs: 0, includeScreenshot: false });

		expect(state.windowTitle).toBe("Private folder");
	});

	it("calls the window enumeration once per observation instead of once per consumer", async () => {
		windowMock.openWindows.mockClear();
		windowMock.openWindows.mockResolvedValue([
			{ id: 99, title: "Documents", owner: { processId: TARGET_PID }, bounds: WINDOW_BOUNDS },
			{
				id: 101,
				title: "Left display",
				owner: { processId: TARGET_PID },
				bounds: { x: -1800, y: 100, width: 1200, height: 700 },
			},
		]);
		const computer = new MacOSHostComputer();

		const state = await computer.getAppState(TARGET_PID, { settleMs: 0 });

		expect(state.windowId).toBe(99);
		expect(windowMock.openWindows.mock.calls.length).toBe(1);
	});

	it("associates a global-bounds window with its display without changing its bounds", async () => {
		const displayList = await import("./macos-ffi/display-list.js");
		const display = vi.spyOn(displayList, "onlineDisplayInfo");
		display.mockReturnValue([
			{ id: 1, isMain: true, x: 0, y: 0, width: 2500, height: 1080, scaleFactor: 2 },
			{ id: 2, x: 1500, y: -500, width: 2560, height: 2000, scaleFactor: 1 },
			{ id: 3, x: -1920, y: 0, width: 1920, height: 1080, scaleFactor: 1 },
		]);
		windowMock.openWindows.mockResolvedValue([
			{ id: 99, title: "Documents", owner: { processId: TARGET_PID }, bounds: WINDOW_BOUNDS },
			{
				id: 101,
				title: "Left display",
				owner: { processId: TARGET_PID },
				bounds: { x: -1800, y: 100, width: 1200, height: 700 },
			},
		]);
		const originalLogical = screenshotMock.getMainDisplayLogicalSize.getMockImplementation();
		const originalNative = screenshotMock.getMainDisplayNativePixelSize.getMockImplementation();
		screenshotMock.getMainDisplayLogicalSize.mockReturnValue({ width: 1920, height: 1080 });
		screenshotMock.getMainDisplayNativePixelSize.mockReturnValue({ width: 3840, height: 2160 });
		try {
			const state = await new MacOSHostComputer({ delivery: "background" }).getAppState(TARGET_PID, {
				settleMs: 0,
				includeScreenshot: false,
			});

			expect(state.display).toEqual({
				id: 1,
				isMain: true,
				x: 0,
				y: 0,
				width: 2500,
				height: 1080,
				scaleFactor: 2,
			});
			expect(state.displays).toHaveLength(3);
			expect(state.windowDisplayId).toBe(1);
			expect(state.windowDisplayIds).toEqual([1, 2]);
			expect(state.windowBounds).toEqual(WINDOW_BOUNDS);
			expect(state.display.id).toBe(1);
			expect(state.displays?.map((entry) => [entry.id, entry.x, entry.y])).toEqual([
				[1, 0, 0],
				[2, 1500, -500],
				[3, -1920, 0],
			]);
			const candidates = state.windowCandidates?.map((window) => ({
				id: window.id,
				displayId: window.displayId,
				displayIds: window.displayIds,
				bounds: window.bounds,
			}));
			expect(candidates).toContainEqual({
				id: 101,
				displayId: 3,
				displayIds: [3],
				bounds: { x: -1800, y: 100, width: 1200, height: 700 },
			});
		} finally {
			display.mockRestore();
			windowMock.openWindows.mockResolvedValue([
				{ id: 99, title: "Documents", owner: { processId: TARGET_PID }, bounds: WINDOW_BOUNDS },
			]);
			if (originalLogical !== undefined) {
				screenshotMock.getMainDisplayLogicalSize.mockImplementation(originalLogical);
			}
			if (originalNative !== undefined) {
				screenshotMock.getMainDisplayNativePixelSize.mockImplementation(originalNative);
			}
		}
	});
});

describe("#given an injected overlay #when observing in background #then the drawn marker shows what is being read", () => {
	it("highlights the observed window while retaining the observed window and elements", async () => {
		const overlay = {
			set: vi.fn(),
			track: vi.fn(),
			highlight: vi.fn(),
			setMode: vi.fn(),
			hide: vi.fn(),
			close: vi.fn(),
		};
		const computer = new MacOSHostComputer({ delivery: "background", overlay });
		try {
			const state = await computer.getAppState(TARGET_PID, { settleMs: 0, includeScreenshot: false });

			expect(state.windowId).toBe(99);
			expect(state.elements).not.toHaveLength(0);
			// Background cues are on by default: observing highlights the read region on the drawn marker.
			expect(overlay.highlight).toHaveBeenCalled();
		} finally {
			await computer.close();
		}
	});
});

describe("#given background cues disabled #when observing #then nothing is drawn", () => {
	it("#when background cues are disabled #then observing draws nothing", async () => {
		const previous = process.env["OPENCUA_CURSOR_BACKGROUND_CUES"];
		process.env["OPENCUA_CURSOR_BACKGROUND_CUES"] = "off";
		try {
			const overlay2 = {
				set: vi.fn(),
				track: vi.fn(),
				highlight: vi.fn(),
				setMode: vi.fn(),
				hide: vi.fn(),
				close: vi.fn(),
			};
			const computer2 = new MacOSHostComputer({ delivery: "background", overlay: overlay2 });
			try {
				await computer2.getAppState(TARGET_PID, { settleMs: 0, includeScreenshot: false });
				expect(overlay2.highlight).not.toHaveBeenCalled();
				expect(overlay2.setMode).not.toHaveBeenCalled();
				expect(overlay2.set).not.toHaveBeenCalled();
			} finally {
				await computer2.close();
			}
		} finally {
			if (previous === undefined) {
				Reflect.deleteProperty(process.env, "OPENCUA_CURSOR_BACKGROUND_CUES");
			} else {
				process.env["OPENCUA_CURSOR_BACKGROUND_CUES"] = previous;
			}
		}
	});
});

describe("#given OPENCUA_CURSOR #when the host decides whether to draw the agent cursor #then only an explicit off disables it", () => {
	it.each([
		[undefined, true],
		["on", true],
		["off", false],
		["0", false],
		["FALSE", false],
		["no", false],
	])("OPENCUA_CURSOR=%s -> %s", async (value, enabled) => {
		const { agentCursorEnabled } = await import("./macos.js");
		expect(agentCursorEnabled(value === undefined ? {} : { OPENCUA_CURSOR: value })).toBe(enabled);
	});
});

describe("#given a locked Mac #when get_app_state is asked for #then it stops with the unlock request before reading anything", () => {
	it("refuses without enumerating windows", async () => {
		windowMock.openWindows.mockClear();
		const computer = new MacOSHostComputer({ isLocked: () => true });

		await expect(computer.getAppState(TARGET_PID, { settleMs: 0 })).rejects.toThrow(/Mac is locked/);
		expect(windowMock.openWindows).not.toHaveBeenCalled();
	});
});

describe("#given default host options #when the host is constructed #then input delivery stays in background", () => {
	it("uses background delivery unless attended is asked for", () => {
		expect(new MacOSHostComputer().delivery).toBe("background");
	});
});

describe("#given a window that appears just after the first look #when a window is required #then the observation waits for it", () => {
	it("observes the window once the window server lists it", async () => {
		windowMock.openWindows.mockReset();
		windowMock.openWindows
			.mockResolvedValueOnce([])
			.mockResolvedValue([{ id: 99, title: "Documents", owner: { processId: TARGET_PID }, bounds: WINDOW_BOUNDS }]);
		const computer = new MacOSHostComputer({ delivery: "background" });

		const state = await computer.getAppState(TARGET_PID, { settleMs: 0, requireWindow: true });

		expect(state.windowId).toBe(99);
	});
});

describe("#given a window capture that fails transiently twice #when get_app_state runs #then it degrades to an accessibility-only state", () => {
	it("returns the elements and the reason instead of failing the observation", async () => {
		screenshotMock.captureWindowImage.mockImplementation(() => {
			throw new Error("Native ScreenCaptureKit window capture failed for window 99");
		});
		const computer = new MacOSHostComputer();
		try {
			const state = await computer.getAppState(TARGET_PID, { settleMs: 0, requireWindow: true });

			expect(state.screenshotUnavailable).toBe("window-capture-failed");
			expect(state.elements.map((element) => element.id)).toEqual([5]);
			expect(computer.getInputObservation(TARGET_PID)).toBeDefined();
		} finally {
			screenshotMock.captureWindowImage.mockReset();
			await computer.close();
		}
	});
});

describe("#given no Screen Recording permission #when get_app_state is asked for an image #then it observes without capturing", () => {
	it("returns the elements and the reason, and never starts a capture that would raise the permission prompt", async () => {
		screenshotMock.screenCaptureAllowed.mockReturnValue(false);
		const capturesBefore = screenshotMock.captureWindowImage.mock.calls.length;
		const subprocessesBefore = childProcessMock.execFile.mock.calls.length;
		try {
			const computer = new MacOSHostComputer();

			const state = await computer.getAppState(TARGET_PID, { settleMs: 0 });

			expect(state.screenshotUnavailable).toBe("screen-recording-permission");
			expect(state.screenshotBase64).toBe("");
			expect(state.elements.map((element) => element.id)).toEqual([5]);
			// Neither the in-process capture nor the screencapture fallback ran; only the app lookup did.
			expect(screenshotMock.captureWindowImage.mock.calls.length).toBe(capturesBefore);
			expect(childProcessMock.execFile.mock.calls.length - subprocessesBefore).toBe(1);
		} finally {
			screenshotMock.screenCaptureAllowed.mockReturnValue(true);
		}
	});
});

describe("#given a macOS permission prompt over the screen #when get_app_state observes an app #then the observation names it", () => {
	it("reports the prompt that the app's own tree cannot show", async () => {
		setSystemPromptWindowSourceForTesting(() => [
			{
				id: 17196,
				ownerPid: 1752,
				layer: 0,
				ownerName: "universalAccessAuthWarn",
				title: "Screen Recording",
				bounds: { x: 700, y: 300, width: 520, height: 220 },
			},
		]);
		try {
			const computer = new MacOSHostComputer();

			const state = await computer.getAppState(TARGET_PID, { settleMs: 0, includeScreenshot: false });

			expect(state.systemPrompts?.map((prompt) => [prompt.owner, prompt.kind])).toEqual([
				["universalAccessAuthWarn", "permission"],
			]);
		} finally {
			setSystemPromptWindowSourceForTesting(() => []);
		}
	});
});

describe("#given a target window #when get_app_state captures it #then the screenshot is sized to the window aspect", () => {
	it("captures the window at full fidelity up to the 2560 long-edge cap, not the full screen", async () => {
		const computer = new MacOSHostComputer({ delivery: "background" });

		const state = await computer.getAppState(TARGET_PID, { settleMs: 0 });

		// WINDOW_BOUNDS is 2560x1600, which fits the raised 2560 cap uncapped.
		expect(state.screenshotWidth).toBe(2560);
		expect(state.screenshotHeight).toBe(1600);
		expect(state.windowBounds).toEqual(WINDOW_BOUNDS);
	});
});

describe("#given an observed hidden window without an AX root #when its native title is listed #then the observation reports that exact title", () => {
	it("uses the matched WindowServer title when accessibility has no root", async () => {
		windowMock.openWindows.mockResolvedValue([
			{ id: 42, title: "Other window", owner: { processId: TARGET_PID }, bounds: WINDOW_BOUNDS },
		]);
		const hiddenWindows = () => [
			{
				id: 99,
				title: "Untitled",
				owner: { processId: TARGET_PID },
				bounds: WINDOW_BOUNDS,
			},
		];
		setOpenWindowsSourceForTesting(hiddenWindows, hiddenWindows);
		accessibilityMock.extractAccessibilityTree.mockReturnValue({
			axAvailable: false,
			truncated: false,
			walkKey: "hidden-window-99",
			elements: [],
		});
		const computer = new MacOSHostComputer();

		const state = await computer.getAppState(TARGET_PID, {
			settleMs: 0,
			includeScreenshot: false,
			windowId: 99,
		});

		expect(state.windowId).toBe(99);
		expect(state.windowTitle).toBe("Untitled");
		expect(state.axAvailable).toBe(false);
		expect(state.elements).toEqual([]);
		expect(observedWindowForPid(TARGET_PID, 99)?.title).toBe("Untitled");
		setOpenWindowsSourceForTesting(
			() => undefined,
			() => undefined,
		);
	});
});

describe("#given this process lacks Accessibility trust #when an app is observed #then the state says why it holds no elements", () => {
	it("carries the walk's accessibility-permission reason", async () => {
		accessibilityMock.extractAccessibilityTree.mockReturnValue({
			axAvailable: false,
			axUnavailable: "accessibility-permission",
			truncated: false,
			walkKey: "untrusted",
			elements: [],
		});

		const state = await new MacOSHostComputer().getAppState(TARGET_PID, { settleMs: 0, includeScreenshot: false });

		expect(state.axAvailable).toBe(false);
		expect(state.axUnavailable).toBe("accessibility-permission");
	});
});

describe("#given an app with several windows #when the observation resolves a target #then it names the window and lists the alternatives", () => {
	it("scopes to the app's focused window and reports every candidate", async () => {
		windowMock.openWindows.mockResolvedValue([
			{ id: 99, title: "Documents", owner: { processId: TARGET_PID }, bounds: WINDOW_BOUNDS },
			{
				id: 42,
				title: "Downloads",
				owner: { processId: TARGET_PID },
				bounds: { x: 0, y: 0, width: 400, height: 300 },
			},
		]);
		accessibilityMock.focusedWindowIdsForObservationPid.mockReturnValue({
			focusedWindowId: 42,
			sheetOwnerWindowId: undefined,
		});
		const computer = new MacOSHostComputer({ delivery: "background" });

		const state = await computer.getAppState(TARGET_PID, { settleMs: 0 });

		expect(state.windowId).toBe(42);
		expect(state.windowTitle).toBe("Downloads");
		expect(state.windowCandidates?.map((candidate) => candidate.id)).toEqual([99, 42]);
		expect(accessibilityMock.focusedWindowIdsForObservationPid).toHaveBeenCalledWith(TARGET_PID);
	});

	it("uses the focused sheet's listed AXWindow owner for default observation", async () => {
		windowMock.openWindows.mockResolvedValue([
			{
				id: 99,
				title: "Presentation",
				owner: { processId: TARGET_PID },
				bounds: WINDOW_BOUNDS,
			},
			{
				id: 42,
				title: "Save",
				owner: { processId: TARGET_PID },
				bounds: { x: 1333, y: 721, width: 370, height: 182 },
			},
		]);
		accessibilityMock.focusedWindowIdsForObservationPid.mockReturnValue({
			focusedWindowId: 42,
			sheetOwnerWindowId: 99,
		});
		screenshotMock.captureWindowImage.mockClear();
		const computer = new MacOSHostComputer({ delivery: "background" });

		const state = await computer.getAppState(TARGET_PID, { settleMs: 0 });

		expect(state.windowId).toBe(99);
		expect(state.windowBounds).toEqual(WINDOW_BOUNDS);
		expect(accessibilityMock.extractAccessibilityTree).toHaveBeenCalledWith(TARGET_PID, { windowId: 99 });
		expect(screenshotMock.captureWindowImage.mock.calls[0]?.[0]).toBe(99);
	});

	it("names every candidate by the title the app reports when the WindowServer withholds titles", async () => {
		windowMock.openWindows.mockResolvedValue([
			{ id: 99, owner: { processId: TARGET_PID }, bounds: WINDOW_BOUNDS },
			{ id: 42, owner: { processId: TARGET_PID }, bounds: { x: 0, y: 0, width: 400, height: 300 } },
		]);
		accessibilityMock.focusedWindowIdsForObservationPid.mockReturnValue({
			focusedWindowId: 42,
			sheetOwnerWindowId: undefined,
		});
		accessibilityMock.windowTitlesForPid.mockReturnValueOnce(
			new Map([
				[99, "a.txt"],
				[42, "b.txt"],
			]),
		);
		const computer = new MacOSHostComputer({ delivery: "background" });

		const state = await computer.getAppState(TARGET_PID, { settleMs: 0 });

		expect(state.windowCandidates?.map((candidate) => [candidate.id, candidate.title])).toEqual([
			[99, "a.txt"],
			[42, "b.txt"],
		]);
		expect(state.windowTitle).toBe("b.txt");
	});

	it("honors an explicitly requested window id over the focused window", async () => {
		windowMock.openWindows.mockResolvedValue([
			{ id: 99, owner: { processId: TARGET_PID }, bounds: WINDOW_BOUNDS },
			{ id: 42, owner: { processId: TARGET_PID }, bounds: { x: 1333, y: 721, width: 370, height: 182 } },
		]);
		accessibilityMock.focusedWindowIdsForObservationPid.mockReturnValue({
			focusedWindowId: 42,
			sheetOwnerWindowId: 99,
		});
		screenshotMock.captureWindowImage.mockClear();
		const computer = new MacOSHostComputer({ delivery: "background" });

		const state = await computer.getAppState(TARGET_PID, { settleMs: 0, windowId: 42 });

		expect(state.windowId).toBe(42);
		expect(accessibilityMock.focusedWindowIdsForObservationPid).not.toHaveBeenCalled();
		expect(accessibilityMock.extractAccessibilityTree).toHaveBeenCalledWith(TARGET_PID, { windowId: 42 });
		expect(screenshotMock.captureWindowImage.mock.calls[0]?.[0]).toBe(42);
	});

	it("reports no candidates when the app has a single window", async () => {
		const computer = new MacOSHostComputer({ delivery: "background" });

		const state = await computer.getAppState(TARGET_PID, { settleMs: 0 });

		expect(state.windowId).toBe(99);
		expect(state.windowCandidates).toBeUndefined();
	});
});

describe("#given two get_app_state calls #when the second runs #then it reports an AX change summary", () => {
	it("omits the summary on the first call and includes it on the second", async () => {
		childProcessMock.execFile.mockReset();
		for (let call = 0; call < 2; call += 1) {
			childProcessMock.execFile.mockImplementationOnce((_file, _args, _options, callback) => {
				callback(
					null,
					JSON.stringify([{ name: "Finder", bundleId: "com.apple.finder", pid: TARGET_PID, isActive: true }]),
					"",
				);
			});
			childProcessMock.execFile.mockImplementationOnce((_file, _args, _options, callback) => {
				callback(null, fakePng(2560, 1600), "");
			});
		}
		const computer = new MacOSHostComputer({ delivery: "background" });

		const first = await computer.getAppState(TARGET_PID, { settleMs: 0 });
		const second = await computer.getAppState(TARGET_PID, { settleMs: 0 });

		expect(first.axChangeSummary).toBeUndefined();
		expect(second.axChangeSummary).toEqual({ added: 0, removed: 0, changed: 0 });
	});

	it("omits the diff when the previous walk used a different scope", async () => {
		childProcessMock.execFile.mockReset();
		for (let call = 0; call < 2; call += 1) {
			childProcessMock.execFile.mockImplementationOnce((_file, _args, _options, callback) => {
				callback(
					null,
					JSON.stringify([{ name: "Finder", bundleId: "com.apple.finder", pid: TARGET_PID, isActive: true }]),
					"",
				);
			});
			childProcessMock.execFile.mockImplementationOnce((_file, _args, _options, callback) => {
				callback(null, fakePng(2560, 1600), "");
			});
		}
		const computer = new MacOSHostComputer({ delivery: "background" });

		await computer.getAppState(TARGET_PID, { settleMs: 0, includeMenuBar: true });
		const afterScopeChange = await computer.getAppState(TARGET_PID, { settleMs: 0 });

		expect(afterScopeChange.axChangeSummary).toBeUndefined();
		expect(afterScopeChange.axChanges).toBeUndefined();
	});

	it("exposes the element-level diff on the second call", async () => {
		childProcessMock.execFile.mockReset();
		for (let call = 0; call < 2; call += 1) {
			childProcessMock.execFile.mockImplementationOnce((_file, _args, _options, callback) => {
				callback(
					null,
					JSON.stringify([{ name: "Finder", bundleId: "com.apple.finder", pid: TARGET_PID, isActive: true }]),
					"",
				);
			});
			childProcessMock.execFile.mockImplementationOnce((_file, _args, _options, callback) => {
				callback(null, fakePng(2560, 1600), "");
			});
		}
		const baseElement = {
			id: 5,
			role: "AXButton",
			label: "Open",
			value: null,
			frame: { x: 800, y: 550, width: 200, height: 160 },
			actions: ["AXPress"],
			children: [],
		};
		accessibilityMock.extractAccessibilityTree
			.mockReturnValueOnce({ axAvailable: true, elements: [baseElement] })
			.mockReturnValue({
				axAvailable: true,
				elements: [
					baseElement,
					{ ...baseElement, id: 6, label: "New", frame: { x: 100, y: 100, width: 50, height: 50 } },
				],
			});
		const computer = new MacOSHostComputer();

		const first = await computer.getAppState(TARGET_PID, { settleMs: 0 });
		const second = await computer.getAppState(TARGET_PID, { settleMs: 0 });

		expect(first.axChanges).toBeUndefined();
		expect(second.axChanges?.added.map((element) => element.label)).toEqual(["New"]);
		expect(second.axChanges?.removed).toEqual([]);
		expect(second.axChanges?.changed).toEqual([]);
	});
});

describe("#given diff_only mode #when a prior snapshot exists #then the full tree is omitted and only the diff returned", () => {
	it("returns the full tree on the first call and only axChanges on the second", async () => {
		childProcessMock.execFile.mockReset();
		for (let call = 0; call < 2; call += 1) {
			childProcessMock.execFile.mockImplementationOnce((_file, _args, _options, callback) => {
				callback(
					null,
					JSON.stringify([{ name: "Finder", bundleId: "com.apple.finder", pid: TARGET_PID, isActive: true }]),
					"",
				);
			});
			childProcessMock.execFile.mockImplementationOnce((_file, _args, _options, callback) => {
				callback(null, fakePng(2560, 1600), "");
			});
		}
		const computer = new MacOSHostComputer();

		const first = await computer.getAppState(TARGET_PID, { settleMs: 0, diffOnly: true });
		const second = await computer.getAppState(TARGET_PID, { settleMs: 0, diffOnly: true });

		// First call: no prior snapshot, so the full tree is always returned.
		expect(first.elements.length).toBeGreaterThan(0);
		// Second call: diff_only omits the full tree and returns only the diff.
		expect(second.elements).toEqual([]);
		expect(second.axChanges).toBeDefined();
		expect(second.axChangeSummary).toBeDefined();
		expect(second.contentKind).toBeDefined();
	});
});

describe("#given an app-approval store #when an app is not approved #then get_app_state is refused until approved", () => {
	it("refuses an unapproved app and proceeds once approved for the session", async () => {
		const appsJson = JSON.stringify([
			{ name: "Finder", bundleId: "com.apple.finder", pid: TARGET_PID, isActive: true },
		]);
		childProcessMock.execFile.mockReset();
		childProcessMock.execFile.mockImplementationOnce((_file, _args, _options, callback) =>
			callback(null, appsJson, ""),
		);
		childProcessMock.execFile.mockImplementationOnce((_file, _args, _options, callback) =>
			callback(null, appsJson, ""),
		);
		childProcessMock.execFile.mockImplementationOnce((_file, _args, _options, callback) =>
			callback(null, fakePng(2560, 1600), ""),
		);
		const approval = new AppApprovalStore([]);
		const computer = new MacOSHostComputer({ appApproval: approval });

		await expect(computer.getAppState(TARGET_PID, { settleMs: 0 })).rejects.toThrow(/needs your approval/);

		approval.approveForSession("com.apple.finder");
		const state = await computer.getAppState(TARGET_PID, { settleMs: 0 });
		expect(state.app).toBe("Finder");
	});
});

describe("#given a call helper #when only FaceTime is approved #then helper approval is still required", () => {
	it("keeps helper identity and refuses main-app approval inheritance", async () => {
		const helper = {
			name: "FaceTimeNotificationExtension",
			bundleId: "com.apple.FaceTime.FaceTimeNotificationExtension",
			pid: TARGET_PID,
			isActive: false,
			path: "/System/Library/ExtensionKit/Extensions/FaceTimeNotificationExtension.appex",
		};
		setRunningApplicationLookupForTesting({
			getRunningApplications: () => [helper],
			findRunningApplication: () => helper,
		});
		const approval = new AppApprovalStore(["com.apple.FaceTime"]);
		const computer = new MacOSHostComputer({ appApproval: approval });

		await expect(computer.getAppState(TARGET_PID, { settleMs: 0, includeScreenshot: false })).rejects.toThrow(
			/needs your approval/,
		);

		approval.approveForSession(helper.bundleId);
		const state = await computer.getAppState(TARGET_PID, { settleMs: 0, includeScreenshot: false });
		expect(state.bundleId).toBe(helper.bundleId);
		expect(state.pid).toBe(TARGET_PID);
		expect(state.windowId).toBe(99);
	});
});

describe("#given a URL blocklist #when a browser is on a blocked URL #then get_app_state is refused", () => {
	it("refuses Safari on a blocklisted URL", async () => {
		childProcessMock.execFile.mockReset();
		childProcessMock.execFile.mockImplementationOnce((_file, _args, _options, callback) =>
			callback(
				null,
				JSON.stringify([{ name: "Safari", bundleId: "com.apple.Safari", pid: TARGET_PID, isActive: true }]),
				"",
			),
		);
		childProcessMock.execFile.mockImplementationOnce((_file, _args, _options, callback) =>
			callback(null, "https://banking.example.com/login\n", ""),
		);
		const computer = new MacOSHostComputer({ urlBlocklist: ["*banking*"] });

		await expect(computer.getAppState(TARGET_PID, { settleMs: 0 })).rejects.toThrow(
			/not allowed on the current browser URL/,
		);
	});
});

describe("#given a fresh app session #when get_app_state runs #then it highlights the window once", () => {
	it("fires the capture-start highlight on the first windowed call only", async () => {
		const overlay = { set: vi.fn(), highlight: vi.fn(), setMode: vi.fn(), hide: vi.fn(), close: vi.fn() };
		const appsJson = JSON.stringify([
			{ name: "Finder", bundleId: "com.apple.finder", pid: TARGET_PID, isActive: true },
		]);
		childProcessMock.execFile.mockReset();
		for (let call = 0; call < 2; call += 1) {
			childProcessMock.execFile.mockImplementationOnce((_file, _args, _options, callback) =>
				callback(null, appsJson, ""),
			);
			childProcessMock.execFile.mockImplementationOnce((_file, _args, _options, callback) =>
				callback(null, fakePng(2560, 1600), ""),
			);
		}
		const computer = new MacOSHostComputer({ overlay, delivery: "background" });

		await computer.getAppState(TARGET_PID, { settleMs: 0 });
		await computer.getAppState(TARGET_PID, { settleMs: 0 });

		expect(overlay.highlight).toHaveBeenCalledTimes(1);
		expect(overlay.highlight).toHaveBeenCalledWith(WINDOW_BOUNDS, TARGET_PID);
	});
});

describe("#given a noisy accessibility tree #when get_app_state runs #then non-descriptive nodes are pruned", () => {
	it("drops AXUnknown noise while keeping descriptive elements", async () => {
		accessibilityMock.extractAccessibilityTree.mockReturnValue({
			axAvailable: true,
			elements: [
				{
					id: 5,
					role: "AXButton",
					label: "Open",
					value: null,
					frame: { x: 800, y: 550, width: 200, height: 160 },
					actions: ["AXPress"],
					children: [],
				},
				{
					id: 6,
					role: "AXUnknown",
					label: null,
					value: null,
					frame: { x: 0, y: 0, width: 0, height: 0 },
					actions: [],
					children: [],
				},
			],
		});
		const computer = new MacOSHostComputer({ delivery: "background" });

		const state = await computer.getAppState(TARGET_PID, { settleMs: 0 });

		expect(state.elements.map((element) => element.id)).toEqual([5]);
		await computer.performAction(TARGET_PID, state.elements[0]?.id ?? -1, "AXPress");
		expect(accessibilityMock.performActionByIndex).toHaveBeenCalledWith(TARGET_PID, 5, "AXPress");
	});
});

describe("#given a known app #when get_app_state runs #then it includes the app-specific instruction playbook", () => {
	it("attaches Clock instructions for com.apple.clock", async () => {
		childProcessMock.execFile.mockReset();
		childProcessMock.execFile.mockImplementationOnce((_file, _args, _options, callback) => {
			callback(
				null,
				JSON.stringify([{ name: "Clock", bundleId: "com.apple.clock", pid: TARGET_PID, isActive: true }]),
				"",
			);
		});
		childProcessMock.execFile.mockImplementationOnce((_file, _args, _options, callback) => {
			callback(null, fakePng(2560, 1600), "");
		});
		const computer = new MacOSHostComputer();

		const state = await computer.getAppState(TARGET_PID, { settleMs: 0 });

		expect(state.appInstructions).toContain("World Clock");
	});
});

describe("#given a Retina display #when get_app_state runs #then it reports display geometry and backing scale", () => {
	it("includes the logical display size and scale factor", async () => {
		const computer = new MacOSHostComputer();

		const state = await computer.getAppState(TARGET_PID, { settleMs: 0 });

		expect(state.display).toMatchObject({ width: 2560, height: 1440, scaleFactor: 1, id: 2, isMain: true });
	});
});

describe("#given a window-scoped screenshot #when get_app_state returns the tree #then frames share the screenshot pixel space", () => {
	it("remaps global accessibility frames into screenshot pixels", async () => {
		const computer = new MacOSHostComputer();

		const state = await computer.getAppState(TARGET_PID, { settleMs: 0 });

		// scale = 2560/2560 = 1.0; origin offset = window (300,150).
		expect(state.elements[0]?.frame).toEqual({ x: 500, y: 400, width: 200, height: 160 });
		// id and actions are preserved so element_index clicks still work.
		expect(state.elements[0]?.id).toBe(5);
		expect(state.elements[0]?.actions).toEqual(["AXPress"]);
	});
});

describe("#given a prior get_app_state #when reading the screenshot viewport #then it maps pixels onto the window", () => {
	it("exposes the stored viewport for the target pid", async () => {
		const computer = new MacOSHostComputer();
		await computer.getAppState(TARGET_PID, { settleMs: 0 });

		const viewport = await computer.getScreenshotViewport(TARGET_PID);

		expect(viewport).toEqual({ windowBounds: WINDOW_BOUNDS, screenshotWidth: 2560, screenshotHeight: 1600 });
	});
});

describe("#given no prior get_app_state #when reading the screenshot viewport #then it derives one from the current window", () => {
	it("derives the viewport from the live target window", async () => {
		const computer = new MacOSHostComputer();

		const viewport = await computer.getScreenshotViewport(TARGET_PID);

		expect(viewport).toEqual({ windowBounds: WINDOW_BOUNDS, screenshotWidth: 2560, screenshotHeight: 1600 });
	});

	it("returns undefined when the target app has no visible window", async () => {
		windowMock.openWindows.mockResolvedValue([]);
		const computer = new MacOSHostComputer();

		expect(await computer.getScreenshotViewport(TARGET_PID)).toBeUndefined();
	});
});

describe("#given no target window #when get_app_state captures the full display #then frames stay in global space", () => {
	it("leaves accessibility frames unscaled and reports no window bounds", async () => {
		windowMock.openWindows.mockResolvedValue([]);
		const computer = new MacOSHostComputer();

		const state = await computer.getAppState(TARGET_PID, { settleMs: 0 });

		expect(state.windowBounds).toBeUndefined();
		expect(state.elements[0]?.frame).toEqual({ x: 800, y: 550, width: 200, height: 160 });
		expect(state.screenshotWidth).toBe(1920);
		expect(await computer.getScreenshotViewport(TARGET_PID)).toBeUndefined();
	});
});

describe("#given an accessibility tree that stabilizes #when get_app_state settles #then it stops at stability, not the cap", () => {
	it("polls the tree until it is stable and returns before the settle cap elapses", async () => {
		vi.useFakeTimers();
		try {
			const stableElement = {
				id: 5,
				role: "AXButton",
				label: "Open",
				value: null,
				frame: { x: 800, y: 550, width: 200, height: 160 },
				actions: ["AXPress"],
				children: [],
			};
			// First poll: tree still changing (extra element). Subsequent polls: stable.
			accessibilityMock.extractAccessibilityTree
				.mockReturnValueOnce({
					axAvailable: true,
					elements: [stableElement, { ...stableElement, id: 6, label: "Transient" }],
				})
				.mockReturnValue({ axAvailable: true, elements: [stableElement] });
			const computer = new MacOSHostComputer({ delivery: "background" });

			const statePromise = computer.getAppState(TARGET_PID, { settleMs: 500 });
			// Let the event-driven settle loop run its (short) poll intervals.
			await vi.advanceTimersByTimeAsync(200);

			// Must have finished WITHOUT advancing the full 500ms cap.
			const state = await statePromise;
			expect(state.elements.map((element) => element.id)).toEqual([5]);
			// Event-driven settle polls the tree more than once to confirm stability.
			expect(accessibilityMock.extractAccessibilityTree.mock.calls.length).toBeGreaterThan(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("returns immediately once the tree is already stable instead of sleeping the whole cap", async () => {
		vi.useFakeTimers();
		try {
			const computer = new MacOSHostComputer({ delivery: "background" });

			const statePromise = computer.getAppState(TARGET_PID, { settleMs: 500 });
			// Advance far less than the 500ms cap; a stable tree settles right away.
			await vi.advanceTimersByTimeAsync(120);

			const state = await statePromise;
			expect(state.pid).toBe(TARGET_PID);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("#given an observed AX app #when the host closes #then its retained accessibility snapshot is released", () => {
	it("releases each observed pid", async () => {
		const computer = new MacOSHostComputer({ delivery: "background" });
		await computer.getAppState(TARGET_PID, { settleMs: 0 });

		await computer.close();

		expect(accessibilityMock.releaseAccessibilitySnapshot).toHaveBeenCalledOnce();
		expect(accessibilityMock.releaseAccessibilitySnapshot).toHaveBeenCalledWith(TARGET_PID);
	});
});

describe("#given an inactive observed app #when opening a native menu #then the app is held active only behind the front app", () => {
	it.each([
		["AXPopUpButton", "AXPress"],
		["AXMenuButton", "AXPress"],
		["AXTextArea", "AXShowMenu"],
	])("activates %s for %s before dispatch", async (role, action) => {
		accessibilityMock.extractAccessibilityTree.mockReturnValue({
			axAvailable: true,
			truncated: false,
			walkKey: "popup-window-99",
			elements: [
				{
					id: 5,
					role,
					label: "Menu",
					value: null,
					frame: { x: 800, y: 550, width: 200, height: 160 },
					actions: [action],
					children: [],
				},
			],
		});
		const computer = new MacOSHostComputer({ delivery: "background" });
		await computer.getAppState(TARGET_PID, { settleMs: 0, includeScreenshot: false });
		let held = false;
		const activation = vi
			.spyOn(MacOSInputController.prototype, "withWindowCommand")
			.mockImplementation(async (_pid, _window, wantsActivation, command) => {
				held = wantsActivation();
				try {
					return await command(held);
				} finally {
					held = false;
				}
			});
		accessibilityMock.performActionByIndex.mockImplementation(() => {
			expect(held).toBe(true);
		});
		try {
			await computer.performAction(TARGET_PID, 5, action);
			expect(activation).toHaveBeenCalledWith(
				TARGET_PID,
				{ id: 99, bounds: WINDOW_BOUNDS },
				expect.any(Function),
				expect.any(Function),
			);
			expect(accessibilityMock.performActionByIndex).toHaveBeenCalledWith(TARGET_PID, 5, action);
			expect(held).toBe(false);
		} finally {
			activation.mockRestore();
			await computer.close();
		}
	});
});

describe("#given a window on a secondary display #when get_app_state remaps frames #then negative origins are handled", () => {
	it("offsets frames by the negative window origin", async () => {
		const negativeBounds = { x: -1920, y: -200, width: 960, height: 600 };
		windowMock.openWindows.mockResolvedValue([{ id: 99, owner: { processId: TARGET_PID }, bounds: negativeBounds }]);
		accessibilityMock.extractAccessibilityTree.mockReturnValue({
			axAvailable: true,
			elements: [
				{
					id: 5,
					role: "AXButton",
					label: "Open",
					value: null,
					frame: { x: -1440, y: 100, width: 96, height: 60 },
					actions: ["AXPress"],
					children: [],
				},
			],
		});
		childProcessMock.execFile.mockReset();
		childProcessMock.execFile.mockImplementationOnce((_file, _args, _options, callback) => {
			callback(
				null,
				JSON.stringify([{ name: "Finder", bundleId: "com.apple.finder", pid: TARGET_PID, isActive: true }]),
				"",
			);
		});
		childProcessMock.execFile.mockImplementationOnce((_file, _args, _options, callback) => {
			callback(null, fakePng(960, 600), "");
		});
		const computer = new MacOSHostComputer({ delivery: "background" });

		const state = await computer.getAppState(TARGET_PID, { settleMs: 0 });

		expect(state.windowBounds).toEqual(negativeBounds);
		// scale = 960/960 = 1; offset = -(-1920, -200): (-1440+1920, 100+200).
		expect(state.elements[0]?.frame).toEqual({ x: 480, y: 300, width: 96, height: 60 });
	});
});
