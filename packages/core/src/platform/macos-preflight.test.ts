import { beforeEach, describe, expect, it } from "bun:test";
import { vi, whenSettled } from "@opencua/test-support";
import type { InputDelivery } from "./macos-input.js";

interface TestWindow {
	readonly id: number;
	readonly owner: { readonly processId: number };
	readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

/** Forces the AppleScript application-list fallback so the fixtures below stay authoritative. */
const unavailableNativeLookup = {
	getRunningApplications: (): never => {
		throw new Error("native application lookup is unavailable in this test");
	},
	findRunningApplication: (): never => {
		throw new Error("native application lookup is unavailable in this test");
	},
};

type ExecFileCallback = (error: Error | null, stdout: string | Buffer, stderr: string) => void;
type ExecFileMock = (
	file: string,
	args: readonly string[],
	options: { readonly encoding?: BufferEncoding; readonly timeout?: number },
	callback: ExecFileCallback,
) => void;

const runtime = vi.hoisted(() => ({
	apps: [{ name: "Finder", bundleId: "com.apple.finder", pid: 1234, isActive: true }],
	browserUrl: "https://example.com/",
	browserUrlError: undefined as Error | undefined,
	screenshotError: undefined as Error | undefined,
}));

const childProcessMock = vi.hoisted(() => ({ execFile: vi.fn<ExecFileMock>() }));
const windowMock = vi.hoisted(() => ({ openWindows: vi.fn<() => Promise<readonly TestWindow[]>>() }));
const windowListMock = vi.hoisted(() => ({ listWindows: vi.fn<() => readonly object[]>() }));
const accessibilityMock = vi.hoisted(() => ({
	extractAccessibilityTree: vi.fn(),
	focusedWindowIdForPid: vi.fn(() => undefined),
	focusedWindowIdsForObservationPid: vi.fn(() => ({
		focusedWindowId: undefined,
		sheetOwnerWindowId: undefined,
	})),
	releaseAccessibilitySnapshot: vi.fn(),
	accessibilitySnapshotPids: vi.fn<() => readonly number[]>(() => []),
	releaseSnapshotsForExitedPids: vi.fn<() => number>(() => 0),
	currentObservationKey: vi.fn(() => "0:test"),
	performActionByIndex: vi.fn(),
	pressElementAtScreenPoint: vi.fn(),
	setValueByIndex: vi.fn(),
	typeIntoFocusedAXElement: vi.fn(),
}));
const screenshotMock = vi.hoisted(() => ({
	assertWindowCaptureNotMasked: vi.fn(),
	captureDisplayImage: vi.fn(),
	getMainDisplayId: vi.fn(() => 1),
	captureWindowImage: vi.fn<() => { readonly data: Buffer }>(),
	captureWindowImageAsync: async (): Promise<{ readonly data: Buffer }> => screenshotMock.captureWindowImage(),
	getMainDisplayLogicalSize: vi.fn(),
	getMainDisplayNativePixelSize: vi.fn(),
	screenCaptureAllowed: vi.fn(() => true),
}));

vi.mock("node:child_process", () => ({ execFile: childProcessMock.execFile }));
vi.mock("get-windows", () => ({ openWindows: windowMock.openWindows }));
vi.mock("./macos-ffi/window-list.js", () => ({
	listWindows: windowListMock.listWindows,
	listOnscreenWindows: vi.fn(() => []),
}));
vi.mock("./macos-ffi/accessibility.js", () => accessibilityMock);
vi.mock("./macos-ffi/lock-screen.js", () => ({ isScreenLocked: () => false }));
vi.mock("./macos-ffi/screenshot.js", () => screenshotMock);

const { InputInterrupted, runInInputScope } = await import("../computer/input-scope.js");
const { setRunningApplicationLookupForTesting } = await import("./app-list.js");
const coregraphics = await import("./macos-ffi/coregraphics.js");
const skylight = await import("./macos-ffi/skylight.js");
const { setOnscreenWindowIdsSourceForTesting } = await import("./macos-input.js");
const { setOpenWindowsSourceForTesting } = await import("./macos-open-windows.js");
const { AppApprovalStore } = await import("../permission/app-approval.js");
const { setAttendedHostDelivery } = await import("../computer/host-interaction-policy.js");
const { NOOP_POINTER_OVERLAY } = await import("./macos-ffi/cursor-overlay.js");
const { MacOSHostComputer } = await import("./macos.js");
// The in-process WindowServer listing is pinned away so the get-windows fixtures above stay authoritative.
setOpenWindowsSourceForTesting(() => undefined);

import type { InputObservation } from "../computer/guarded-interface.js";

const TARGET_PID = 1234;
const BUNDLE_ID = "com.apple.finder";
const WINDOW_BOUNDS = { x: 100, y: 50, width: 800, height: 600 };
/** How long getAppState waits for a required window to appear before refusing (macos.ts). */
const WINDOW_APPEAR_WAIT_MILLISECONDS = 3_000;

function fakePng(width = 800, height = 600): Buffer {
	const data = globalThis.Buffer.alloc(24);
	data.write("\u0089PNG\r\n\u001a\n", 0, "latin1");
	data.writeUInt32BE(width, 16);
	data.writeUInt32BE(height, 20);
	return data;
}

function deferred<T>(): {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
} {
	let resolvePromise: ((value: T) => void) | undefined;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve(value: T): void {
			if (resolvePromise === undefined) {
				throw new Error("deferred promise was not initialized");
			}
			resolvePromise(value);
		},
	};
}

function approvedComputer(
	options: {
		readonly urlBlocklist?: readonly string[];
		readonly delivery?: InputDelivery;
	} = {},
): InstanceType<typeof MacOSHostComputer> {
	return new MacOSHostComputer({
		appApproval: new AppApprovalStore([BUNDLE_ID]),
		overlay: NOOP_POINTER_OVERLAY,
		...options,
	});
}

async function observe(computer: InstanceType<typeof MacOSHostComputer>, diffOnly = false): Promise<InputObservation> {
	await computer.getAppState(TARGET_PID, { settleMs: 0, diffOnly, requireWindow: true });
	const observation = computer.getInputObservation(TARGET_PID);
	if (observation === undefined) {
		throw new Error("expected an input observation after successful getAppState");
	}
	return observation;
}

beforeEach(() => {
	runtime.apps = [{ name: "Finder", bundleId: BUNDLE_ID, pid: TARGET_PID, isActive: true }];
	runtime.browserUrl = "https://example.com/";
	runtime.browserUrlError = undefined;
	runtime.screenshotError = undefined;
	// This suite feeds the application list through the AppleScript path, so the native
	// NSWorkspace lookup is declared unavailable and the documented fallback runs.
	setRunningApplicationLookupForTesting(unavailableNativeLookup);

	childProcessMock.execFile.mockReset();
	childProcessMock.execFile.mockImplementation((file, args, _options, callback) => {
		if (file === "osascript" && args.includes("JavaScript")) {
			callback(null, JSON.stringify(runtime.apps), "");
			return;
		}
		if (file === "osascript") {
			if (runtime.browserUrlError !== undefined) {
				callback(runtime.browserUrlError, "", "");
				return;
			}
			callback(null, `${runtime.browserUrl}\n`, "");
			return;
		}
		if (file === "sh") {
			if (runtime.screenshotError !== undefined) {
				callback(runtime.screenshotError, "", "");
				return;
			}
			callback(null, fakePng(), "");
			return;
		}
		callback(new Error(`unexpected executable: ${file}`), "", "");
	});

	windowMock.openWindows.mockReset();
	setOnscreenWindowIdsSourceForTesting(() => [42, 99]);
	windowMock.openWindows.mockResolvedValue([{ id: 99, owner: { processId: TARGET_PID }, bounds: WINDOW_BOUNDS }]);
	windowListMock.listWindows.mockReset();
	windowListMock.listWindows.mockImplementation(() => [
		{ id: 99, ownerPid: TARGET_PID, layer: 0, bounds: WINDOW_BOUNDS },
	]);
	accessibilityMock.extractAccessibilityTree.mockReset();
	accessibilityMock.extractAccessibilityTree.mockReturnValue({
		axAvailable: true,
		elements: [
			{
				id: 5,
				role: "AXButton",
				label: "Open",
				value: null,
				frame: { x: 150, y: 100, width: 100, height: 40 },
				actions: ["AXPress"],
				children: [],
			},
			{
				id: 7,
				role: "",
				label: null,
				value: null,
				frame: { x: 0, y: 0, width: 0, height: 0 },
				actions: [],
				children: [],
			},
			{
				id: 9,
				role: "AXTextField",
				label: "Name",
				value: "",
				frame: { x: 150, y: 160, width: 200, height: 40 },
				actions: [],
				children: [],
			},
		],
	});
	accessibilityMock.releaseAccessibilitySnapshot.mockReset();
	screenshotMock.captureDisplayImage.mockReset();
	screenshotMock.captureDisplayImage.mockReturnValue({ data: fakePng(), width: 800, height: 600 });
	screenshotMock.captureWindowImage.mockReset();
	screenshotMock.captureWindowImage.mockReturnValue({ data: fakePng() });
	screenshotMock.getMainDisplayLogicalSize.mockReset();
	screenshotMock.getMainDisplayLogicalSize.mockReturnValue({ width: 1440, height: 900 });
	screenshotMock.getMainDisplayNativePixelSize.mockReset();
	screenshotMock.getMainDisplayNativePixelSize.mockReturnValue({ width: 2880, height: 1800 });
});

describe("MacOSHostComputer input observations", () => {
	it("#given default background drag suspended on window lookup #when closed #then no native input resumes", async () => {
		const computer = approvedComputer();
		await observe(computer);
		const queryStarted = deferred<void>();
		const windowQuery = deferred<readonly TestWindow[]>();
		const postMouse = vi.spyOn(coregraphics, "postMouseEvent").mockImplementation(() => undefined);
		const focusGuard = vi.spyOn(skylight, "focusGuardFor").mockReturnValue(null);
		windowMock.openWindows.mockImplementationOnce(() => {
			queryStarted.resolve();
			return windowQuery.promise;
		});
		const drag = runInInputScope({ target: { pid: TARGET_PID, windowId: 99 } }, () =>
			computer.drag({ from: { x: 150, y: 100 }, to: { x: 200, y: 150 }, duration: 0 }),
		);
		const result = drag.then(
			() => undefined,
			(error: unknown) => error,
		);
		try {
			await queryStarted.promise;
			await computer.close();
			windowQuery.resolve([{ id: 99, owner: { processId: TARGET_PID }, bounds: WINDOW_BOUNDS }]);

			expect(await result).toBeInstanceOf(InputInterrupted);
			expect(postMouse).not.toHaveBeenCalled();
		} finally {
			windowQuery.resolve([{ id: 99, owner: { processId: TARGET_PID }, bounds: WINDOW_BOUNDS }]);
			await result;
			await computer.close();
			postMouse.mockRestore();
			focusGuard.mockRestore();
		}
	});

	it("authorizes the full normalized id set while excluding raw nodes pruned from model output", async () => {
		const computer = approvedComputer();
		const firstState = await computer.getAppState(TARGET_PID, { settleMs: 0, requireWindow: true });
		const first = computer.getInputObservation(TARGET_PID);
		if (first === undefined) {
			throw new Error("expected first input observation");
		}
		const secondState = await computer.getAppState(TARGET_PID, {
			settleMs: 0,
			diffOnly: true,
			requireWindow: true,
		});
		const second = computer.getInputObservation(TARGET_PID);

		expect(firstState.elements.map((element) => element.id)).toEqual([5, 9]);
		expect(secondState.elements).toEqual([]);
		expect(second).toEqual({
			generation: first.generation + 1,
			pid: TARGET_PID,
			bundleId: BUNDLE_ID,
			windowId: 99,
			windowBounds: WINDOW_BOUNDS,
			screenshotViewport: { width: 800, height: 600, bounds: WINDOW_BOUNDS },
			observedElementIds: new Set([5, 9]),
		});
	});

	it("keeps getInputObservation as a pure getter with no native reads", async () => {
		const computer = approvedComputer();
		const expected = await observe(computer);
		const appReads = childProcessMock.execFile.mock.calls.length;
		const windowReads = windowMock.openWindows.mock.calls.length;
		const axReads = accessibilityMock.extractAccessibilityTree.mock.calls.length;

		expect(computer.getInputObservation(TARGET_PID)).toBe(expected);
		expect(computer.getInputObservation(9999)).toBeUndefined();
		expect(childProcessMock.execFile).toHaveBeenCalledTimes(appReads);
		expect(windowMock.openWindows).toHaveBeenCalledTimes(windowReads);
		expect(accessibilityMock.extractAccessibilityTree).toHaveBeenCalledTimes(axReads);
	});

	it("does not create an observation for the low-level full-display fallback", async () => {
		windowMock.openWindows.mockResolvedValue([]);
		const computer = approvedComputer();

		await computer.getAppState(TARGET_PID, { settleMs: 0 });

		expect(computer.getInputObservation(TARGET_PID)).toBeUndefined();
		expect(screenshotMock.captureDisplayImage).toHaveBeenCalledOnce();
	});

	it("requires a visible window before guarded capture and invalidates the prior observation", async () => {
		const computer = approvedComputer();
		await observe(computer);
		windowMock.openWindows.mockResolvedValue([]);
		const screenshotReads = childProcessMock.execFile.mock.calls.filter(([file]) => file === "sh").length;
		const axReads = accessibilityMock.extractAccessibilityTree.mock.calls.length;

		// getAppState waits a bounded real time for the window to appear; fake the clock so that wait is not real.
		vi.useFakeTimers();
		try {
			const pending = computer.getAppState(TARGET_PID, { settleMs: 0, requireWindow: true });
			const refusal = whenSettled(pending, (settled) => expect(settled).rejects.toThrow(/visible target window/i));
			await vi.advanceTimersByTimeAsync(WINDOW_APPEAR_WAIT_MILLISECONDS);
			await refusal;
		} finally {
			vi.useRealTimers();
		}

		expect(childProcessMock.execFile.mock.calls.filter(([file]) => file === "sh")).toHaveLength(screenshotReads);
		expect(screenshotMock.captureDisplayImage).not.toHaveBeenCalled();
		expect(accessibilityMock.extractAccessibilityTree).toHaveBeenCalledTimes(axReads);
		expect(computer.getInputObservation(TARGET_PID)).toBeUndefined();
	});

	it.each(["empty", "error"] as const)(
		"fails a strict guarded browser read before capture when URL lookup returns %s",
		async (failure) => {
			runtime.apps = [{ name: "Safari", bundleId: "com.apple.Safari", pid: TARGET_PID, isActive: true }];
			runtime.browserUrl = "";
			runtime.browserUrlError = failure === "error" ? new Error("Apple Events denied") : undefined;
			const computer = new MacOSHostComputer({
				appApproval: new AppApprovalStore(["com.apple.Safari"]),
				urlBlocklist: ["*blocked.example*"],
				overlay: NOOP_POINTER_OVERLAY,
			});

			await expect(computer.getAppState(TARGET_PID, { settleMs: 0, requireWindow: true })).rejects.toThrow(
				/browser URL/i,
			);

			expect(childProcessMock.execFile.mock.calls.filter(([file]) => file === "sh")).toHaveLength(0);
			expect(screenshotMock.captureDisplayImage).not.toHaveBeenCalled();
			expect(accessibilityMock.extractAccessibilityTree).not.toHaveBeenCalled();
		},
	);

	it("invalidates an observation when a later capture fails and on close", async () => {
		const computer = approvedComputer();
		await observe(computer);
		runtime.screenshotError = new Error("capture failed");
		screenshotMock.captureWindowImage.mockImplementationOnce(() => {
			throw new Error("libsckit.dylib not found");
		});

		await expect(computer.getAppState(TARGET_PID, { settleMs: 0, requireWindow: true })).rejects.toThrow(
			"capture failed",
		);
		expect(computer.getInputObservation(TARGET_PID)).toBeUndefined();

		runtime.screenshotError = undefined;
		await observe(computer);
		await computer.close();
		expect(computer.getInputObservation(TARGET_PID)).toBeUndefined();
		expect(accessibilityMock.releaseAccessibilitySnapshot).toHaveBeenCalledWith(TARGET_PID);
	});
});

describe("MacOSHostComputer preflightInput", () => {
	it("#given no app restriction #when observing a named app #then preflight authorizes its observed context", async () => {
		const computer = new MacOSHostComputer({
			appApproval: new AppApprovalStore(),
			overlay: NOOP_POINTER_OVERLAY,
		});
		const expected = await observe(computer);

		expect(await computer.preflightInput(expected)).toEqual({ ok: true });
	});

	it("#given default app authorization #when observation is replaced #then stale context remains refused", async () => {
		const computer = new MacOSHostComputer({
			appApproval: new AppApprovalStore(),
			overlay: NOOP_POINTER_OVERLAY,
		});
		const expected = await observe(computer);
		await observe(computer);

		expect(await computer.preflightInput(expected)).toEqual({ ok: false, reason: "observation-replaced" });
	});

	it("approves an unchanged, approved current context using read-only queries", async () => {
		const computer = approvedComputer();
		const expected = await observe(computer);

		expect(await computer.preflightInput(expected)).toEqual({ ok: true });
	});

	it("rejects approval revoked after the observation", async () => {
		const approval = new AppApprovalStore([BUNDLE_ID]);
		const computer = new MacOSHostComputer({ appApproval: approval, overlay: NOOP_POINTER_OVERLAY });
		const expected = await observe(computer);
		approval.deny(BUNDLE_ID);

		expect(await computer.preflightInput(expected)).toEqual({ ok: false, reason: "app-not-approved" });
	});

	it("re-checks approval after the awaited window query before authorizing", async () => {
		const approval = new AppApprovalStore([BUNDLE_ID]);
		const computer = new MacOSHostComputer({ appApproval: approval, overlay: NOOP_POINTER_OVERLAY });
		const expected = await observe(computer);
		const queryStarted = deferred<void>();
		const windowQuery = deferred<readonly TestWindow[]>();
		windowMock.openWindows.mockImplementationOnce(() => {
			queryStarted.resolve();
			return windowQuery.promise;
		});

		const result = computer.preflightInput(expected);
		await queryStarted.promise;
		approval.deny(BUNDLE_ID);
		windowQuery.resolve([{ id: 99, owner: { processId: TARGET_PID }, bounds: WINDOW_BOUNDS }]);

		expect(await result).toEqual({ ok: false, reason: "app-not-approved" });
	});

	it("re-checks generation after the awaited window query before authorizing", async () => {
		const computer = approvedComputer();
		const expected = await observe(computer);
		const queryStarted = deferred<void>();
		const windowQuery = deferred<readonly TestWindow[]>();
		windowMock.openWindows.mockImplementationOnce(() => {
			queryStarted.resolve();
			return windowQuery.promise;
		});

		const result = computer.preflightInput(expected);
		await queryStarted.promise;
		await observe(computer);
		windowQuery.resolve([{ id: 99, owner: { processId: TARGET_PID }, bounds: WINDOW_BOUNDS }]);

		expect(await result).toEqual({ ok: false, reason: "observation-replaced" });
	});

	it("fails closed when no approval store is configured", async () => {
		const approved = approvedComputer();
		const expected = await observe(approved);
		const unguarded = new MacOSHostComputer({ overlay: NOOP_POINTER_OVERLAY });
		await unguarded.getAppState(TARGET_PID, { settleMs: 0, requireWindow: true });
		const unguardedObservation = unguarded.getInputObservation(TARGET_PID);
		if (unguardedObservation === undefined) {
			throw new Error("expected direct API observation");
		}

		expect(expected.bundleId).toBe(unguardedObservation.bundleId);
		expect(await unguarded.preflightInput(unguardedObservation)).toEqual({
			ok: false,
			reason: "app-not-approved",
		});
	});

	it("approves a target that is not frontmost under attended delivery, which brings the app forward itself", async () => {
		const computer = approvedComputer({ delivery: "attended" });
		try {
			const expected = await observe(computer);
			runtime.apps = [{ name: "Finder", bundleId: BUNDLE_ID, pid: TARGET_PID, isActive: false }];

			expect(await computer.preflightInput(expected)).toEqual({ ok: true });
		} finally {
			setAttendedHostDelivery(false);
			await computer.close();
		}
	});

	it("rejects an app the allowlist no longer approves under attended delivery", async () => {
		const approval = new AppApprovalStore([BUNDLE_ID]);
		const computer = new MacOSHostComputer({
			appApproval: approval,
			delivery: "attended",
			overlay: NOOP_POINTER_OVERLAY,
		});
		try {
			const expected = await observe(computer);
			approval.deny(BUNDLE_ID);

			expect(await computer.preflightInput(expected)).toEqual({ ok: false, reason: "app-not-approved" });
		} finally {
			setAttendedHostDelivery(false);
			await computer.close();
		}
	});

	it("approves a target that is not frontmost when delivery is background", async () => {
		const computer = approvedComputer({ delivery: "background" });
		const expected = await observe(computer);
		runtime.apps = [{ name: "Finder", bundleId: BUNDLE_ID, pid: TARGET_PID, isActive: false }];

		expect(await computer.preflightInput(expected)).toEqual({ ok: true });
	});

	it("still rejects a revoked approval in background delivery when the app is not frontmost", async () => {
		const approval = new AppApprovalStore([BUNDLE_ID]);
		const computer = new MacOSHostComputer({
			appApproval: approval,
			delivery: "background",
			overlay: NOOP_POINTER_OVERLAY,
		});
		const expected = await observe(computer);
		runtime.apps = [{ name: "Finder", bundleId: BUNDLE_ID, pid: TARGET_PID, isActive: false }];
		approval.deny(BUNDLE_ID);

		expect(await computer.preflightInput(expected)).toEqual({ ok: false, reason: "app-not-approved" });
	});

	it("still rejects a changed window in background delivery when the app is not frontmost", async () => {
		const computer = approvedComputer({ delivery: "background" });
		const expected = await observe(computer);
		runtime.apps = [{ name: "Finder", bundleId: BUNDLE_ID, pid: TARGET_PID, isActive: false }];
		windowMock.openWindows.mockResolvedValue([
			{ id: 99, owner: { processId: TARGET_PID }, bounds: { ...WINDOW_BOUNDS, width: 801 } },
		]);
		windowListMock.listWindows.mockImplementation(() => [
			{ id: 99, ownerPid: TARGET_PID, layer: 0, bounds: { ...WINDOW_BOUNDS, width: 801 } },
		]);

		expect(await computer.preflightInput(expected)).toEqual({ ok: false, reason: "window-bounds-changed" });
	});

	it("#given input that does not map screen points #when the same window moved #then it is still allowed", async () => {
		const computer = approvedComputer({ delivery: "background" });
		const expected = await observe(computer);
		windowMock.openWindows.mockResolvedValue([
			{ id: 99, owner: { processId: TARGET_PID }, bounds: { ...WINDOW_BOUNDS, width: 801 } },
		]);
		windowListMock.listWindows.mockImplementation(() => [
			{ id: 99, ownerPid: TARGET_PID, layer: 0, bounds: { ...WINDOW_BOUNDS, width: 801 } },
		]);

		expect(await computer.preflightInput(expected, { requireSameBounds: false })).toEqual({ ok: true });
	});

	it("#given input that does not map screen points #when a different window replaced it #then it is refused", async () => {
		const computer = approvedComputer({ delivery: "background" });
		const expected = await observe(computer);
		windowMock.openWindows.mockResolvedValue([{ id: 100, owner: { processId: TARGET_PID }, bounds: WINDOW_BOUNDS }]);
		windowListMock.listWindows.mockImplementation(() => [
			{ id: 100, ownerPid: TARGET_PID, layer: 0, bounds: WINDOW_BOUNDS },
		]);

		expect(await computer.preflightInput(expected, { requireSameBounds: false })).toEqual({
			ok: false,
			reason: "window-changed",
		});
	});

	it.each([
		[[], "window-missing"],
		[[{ id: 100, owner: { processId: TARGET_PID }, bounds: WINDOW_BOUNDS }], "window-changed"],
		[
			[{ id: 99, owner: { processId: TARGET_PID }, bounds: { ...WINDOW_BOUNDS, width: 801 } }],
			"window-bounds-changed",
		],
	] as const)("rejects changed window context with %s", async (windows, reason) => {
		const computer = approvedComputer();
		const expected = await observe(computer);
		windowMock.openWindows.mockResolvedValue(windows);
		windowListMock.listWindows.mockImplementation(() =>
			windows.map((window) => ({
				id: window.id,
				ownerPid: window.owner.processId,
				layer: 0,
				bounds: window.bounds,
			})),
		);

		expect(await computer.preflightInput(expected)).toEqual({ ok: false, reason });
	});

	it("rejects a URL that becomes blocked after observation", async () => {
		runtime.apps = [{ name: "Safari", bundleId: "com.apple.Safari", pid: TARGET_PID, isActive: true }];
		const approval = new AppApprovalStore(["com.apple.Safari"]);
		const computer = new MacOSHostComputer({
			appApproval: approval,
			urlBlocklist: ["*blocked.example*"],
			overlay: NOOP_POINTER_OVERLAY,
		});
		const expected = await observe(computer);
		runtime.browserUrl = "https://blocked.example/account";

		expect(await computer.preflightInput(expected)).toEqual({ ok: false, reason: "url-blocked" });
	});

	it("fails closed when a configured browser URL cannot be queried", async () => {
		runtime.apps = [{ name: "Safari", bundleId: "com.apple.Safari", pid: TARGET_PID, isActive: true }];
		const computer = new MacOSHostComputer({
			appApproval: new AppApprovalStore(["com.apple.Safari"]),
			urlBlocklist: ["*blocked.example*"],
			overlay: NOOP_POINTER_OVERLAY,
		});
		const expected = await observe(computer);
		runtime.browserUrlError = new Error("Apple Events denied");

		expect(await computer.preflightInput(expected)).toEqual({ ok: false, reason: "url-unavailable" });
	});

	it("rejects an observation replaced by a newer successful read", async () => {
		const computer = approvedComputer();
		const replaced = await observe(computer);
		await observe(computer);

		expect(await computer.preflightInput(replaced)).toEqual({ ok: false, reason: "observation-replaced" });
	});

	it("does not capture, extract AX, or rebind the remembered target while checking", async () => {
		const computer = approvedComputer();
		const expected = await observe(computer);
		const screenshotReads = childProcessMock.execFile.mock.calls.filter(([file]) => file === "sh").length;
		const axReads = accessibilityMock.extractAccessibilityTree.mock.calls.length;
		const rememberTargetWindow = vi.spyOn(computer, "rememberTargetWindow");

		await computer.preflightInput(expected);

		expect(childProcessMock.execFile.mock.calls.filter(([file]) => file === "sh")).toHaveLength(screenshotReads);
		expect(screenshotMock.captureDisplayImage).not.toHaveBeenCalled();
		expect(accessibilityMock.extractAccessibilityTree).toHaveBeenCalledTimes(axReads);
		expect(rememberTargetWindow).not.toHaveBeenCalled();
	});
});
