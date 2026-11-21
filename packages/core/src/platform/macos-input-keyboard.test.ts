import { beforeEach, describe, expect, it } from "bun:test";
import { vi } from "@opencua/test-support";

const coreGraphicsMock = vi.hoisted(() => ({
	getCurrentCursorPosition: vi.fn(() => ({ x: 1, y: 2 })),
	postKeyboardEvent: vi.fn(),
	postMouseEvent: vi.fn(),
	postScrollEvent: vi.fn(),
	postUnicodeText: vi.fn(),
	warpCursorPosition: vi.fn(),
}));

const overlayMock = vi.hoisted(() => ({
	set: vi.fn(),
	highlight: vi.fn(),
	setMode: vi.fn(),
	hide: vi.fn(),
	close: vi.fn(),
}));

vi.mock("./macos-ffi/lock-screen.js", () => ({ isScreenLocked: () => false }));
// Attended keys activate their app; the fake keeps that off the real desktop.
const actualWorkspace = { ...(await import("./macos-ffi/workspace.js")) };
vi.mock("./macos-ffi/workspace.js", () => ({ ...actualWorkspace, activateApplication: vi.fn(() => true) }));
vi.mock("./macos-ffi/coregraphics.js", () => ({
	K_CG_EVENT_FLAG_MASK_ALTERNATE: 0x00080000,
	K_CG_EVENT_FLAG_MASK_COMMAND: 0x00100000,
	K_CG_EVENT_FLAG_MASK_CONTROL: 0x00040000,
	K_CG_EVENT_FLAG_MASK_SHIFT: 0x00020000,
	getCurrentCursorPosition: coreGraphicsMock.getCurrentCursorPosition,
	postKeyboardEvent: coreGraphicsMock.postKeyboardEvent,
	postMouseEvent: coreGraphicsMock.postMouseEvent,
	postScrollEvent: coreGraphicsMock.postScrollEvent,
	postUnicodeText: coreGraphicsMock.postUnicodeText,
	warpCursorPosition: coreGraphicsMock.warpCursorPosition,
}));

describe("#given MacOSInputController keyboard input", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("#when pressing a key with hold milliseconds #then releases after the hold duration", async () => {
		// given
		vi.useFakeTimers();
		const { MacOSInputController } = await import("./macos-input.js");
		const controller = new MacOSInputController(undefined, undefined, undefined, undefined, "attended");

		// when
		const pressing = controller.pressKey("t", { holdMilliseconds: 250 });
		await vi.advanceTimersByTimeAsync(249);

		// then
		expect(coreGraphicsMock.postKeyboardEvent).toHaveBeenCalledTimes(1);
		expect(coreGraphicsMock.postKeyboardEvent).toHaveBeenNthCalledWith(1, {
			keyCode: 17,
			keyDown: true,
			flags: 0,
			text: undefined,
			targetPid: undefined,
			targetWindow: undefined,
		});

		await vi.advanceTimersByTimeAsync(1);
		await pressing;

		expect(coreGraphicsMock.postKeyboardEvent).toHaveBeenNthCalledWith(2, {
			keyCode: 17,
			keyDown: false,
			flags: 0,
			text: undefined,
			targetPid: undefined,
			targetWindow: undefined,
		});
		expect(vi.getTimerCount()).toBe(0);
		controller.close();
		vi.useRealTimers();
	});

	it("#when typing one character #then shows keyboard feedback at the virtual cursor", async () => {
		const { MacOSInputController } = await import("./macos-input.js");
		const controller = new MacOSInputController(undefined, overlayMock, undefined, undefined, "attended");

		await controller.typeText("x");

		expect(overlayMock.setMode).toHaveBeenCalledWith("keyboard", undefined);
		expect(overlayMock.set).toHaveBeenCalledWith({ x: 1, y: 2 }, undefined);
		expect(coreGraphicsMock.warpCursorPosition).not.toHaveBeenCalled();
		controller.close();
	});

	it("#when pressing a key chord #then shows keyboard feedback at the virtual cursor", async () => {
		const { MacOSInputController } = await import("./macos-input.js");
		const controller = new MacOSInputController(undefined, overlayMock, undefined, undefined, "attended");

		await controller.pressKey("a", { modifiers: ["cmd"] });

		expect(overlayMock.setMode).toHaveBeenCalledWith("keyboard", undefined);
		expect(overlayMock.set).toHaveBeenCalledWith({ x: 1, y: 2 }, undefined);
		expect(coreGraphicsMock.warpCursorPosition).not.toHaveBeenCalled();
		controller.close();
	});

	it("#given two windows of one app #when typing into the observed one #then that window is made the app's focused window first", async () => {
		// given
		const { MacOSInputController, setKeyboardWindowFocuserForTesting, setOnscreenWindowIdsSourceForTesting } =
			await import("./macos-input.js");
		const focused: Array<readonly [number, number]> = [];
		setKeyboardWindowFocuserForTesting(async (pid, windowId) => {
			focused.push([pid, windowId]);
		});
		setOnscreenWindowIdsSourceForTesting(() => [11, 12]);
		const window = (id: number) => ({
			id,
			bounds: { x: 0, y: 0, width: 400, height: 300 },
			owner: { processId: 42 },
		});
		const controller = new MacOSInputController(42);
		await controller.rememberTargetWindow(42, 12, [window(11), window(12)]);

		// when
		await controller.pressKey("a", { modifiers: ["cmd"] });
		await controller.typeText("x");

		// then
		expect(focused).toEqual([
			[42, 12],
			[42, 12],
		]);
		expect(coreGraphicsMock.postUnicodeText).toHaveBeenCalledWith("x", 42, expect.objectContaining({ id: 12 }));
		controller.close();
	});

	it("#given a background web field #when pressing cmd+v #then the clipboard text is typed, and elsewhere cmd+v stays a key press", async () => {
		// given
		const {
			MacOSInputController,
			setBackgroundPasteForTesting,
			setFocusStealWatcherForTesting,
			setKeyboardWindowFocuserForTesting,
			setOnscreenWindowIdsSourceForTesting,
		} = await import("./macos-input.js");
		let webField = true;
		setBackgroundPasteForTesting(
			() => webField,
			() => "pasted",
		);
		setFocusStealWatcherForTesting(() => undefined);
		setKeyboardWindowFocuserForTesting(async () => undefined);
		setOnscreenWindowIdsSourceForTesting(() => [12]);
		const window = { id: 12, bounds: { x: 0, y: 0, width: 400, height: 300 }, owner: { processId: 42 } };
		const noSleep = { acquire: () => undefined, release: () => undefined };
		const overlay = { ...overlayMock };
		const controller = new MacOSInputController(42, overlay, () => false, noSleep, "background");
		await controller.rememberTargetWindow(42, 12, [window]);

		// when
		await controller.pressKey("v", { modifiers: ["cmd"] });
		webField = false;
		await controller.pressKey("v", { modifiers: ["cmd"] });

		// then
		expect(coreGraphicsMock.postUnicodeText.mock.calls.map((call) => call[0]).join("")).toBe("pasted");
		expect(coreGraphicsMock.postKeyboardEvent).toHaveBeenCalledTimes(2);
		expect(overlay.setMode).toHaveBeenCalledWith("keyboard", 42);
		expect(overlay.set).toHaveBeenCalled();
		expect(coreGraphicsMock.warpCursorPosition).not.toHaveBeenCalled();
		setBackgroundPasteForTesting(
			() => false,
			() => undefined,
		);
		controller.close();
	});

	it("#given an open Save panel #when typing and pressing keys #then events go to the panel's service process", async () => {
		// given
		const {
			MacOSInputController,
			setKeyboardPidResolverForTesting,
			setKeyboardWindowFocuserForTesting,
			setOnscreenWindowIdsSourceForTesting,
		} = await import("./macos-input.js");
		setKeyboardWindowFocuserForTesting(async () => undefined);
		setKeyboardPidResolverForTesting((pid) => (pid === 42 ? 4242 : pid));
		setOnscreenWindowIdsSourceForTesting(() => [12]);
		const window = { id: 12, bounds: { x: 0, y: 0, width: 400, height: 300 }, owner: { processId: 42 } };
		const controller = new MacOSInputController(42);
		await controller.rememberTargetWindow(42, 12, [window]);

		// when
		await controller.typeText("a");
		await controller.pressKey("Return");

		// then
		expect(coreGraphicsMock.postUnicodeText).toHaveBeenCalledWith("a", 4242, expect.objectContaining({ id: 12 }));
		expect(coreGraphicsMock.postKeyboardEvent).toHaveBeenCalledWith(expect.objectContaining({ targetPid: 4242 }));
		setKeyboardPidResolverForTesting((pid) => pid);
		controller.close();
	});

	it("#given background delivery #when pressing a key #then the focus-steal watcher sees the target window, and attended delivery skips it", async () => {
		// given
		const {
			MacOSInputController,
			setAttendedForegroundForTesting,
			setFocusStealWatcherForTesting,
			setKeyboardWindowFocuserForTesting,
			setOnscreenWindowIdsSourceForTesting,
		} = await import("./macos-input.js");
		// Attended input goes to the app in front; the test must not depend on what this machine has in front.
		setAttendedForegroundForTesting(() => ({ appInFront: true, windowFocused: true }));
		const watched: number[] = [];
		setFocusStealWatcherForTesting((window) => {
			watched.push(window.id);
		});
		setKeyboardWindowFocuserForTesting(async () => undefined);
		setOnscreenWindowIdsSourceForTesting(() => [12]);
		const window = { id: 12, bounds: { x: 0, y: 0, width: 400, height: 300 }, owner: { processId: 42 } };
		const noSleep = { acquire: () => undefined, release: () => undefined };
		const background = new MacOSInputController(42, undefined, () => false, noSleep, "background");
		const attended = new MacOSInputController(42, undefined, () => false, noSleep, "attended");
		await background.rememberTargetWindow(42, 12, [window]);
		await attended.rememberTargetWindow(42, 12, [window]);

		// when
		await background.pressKey("g", { modifiers: ["shift", "cmd"] });
		// The background path may also watch while it tells an app behind the person's that it is active (that depends on
		// which app this machine has in front), so each delivery is checked on its own.
		const watchedInBackground = watched.splice(0);
		await attended.pressKey("g", { modifiers: ["shift", "cmd"] });

		// then
		expect(watchedInBackground.length).toBeGreaterThan(0);
		expect(new Set(watchedInBackground)).toEqual(new Set([12]));
		expect(watched).toEqual([]);
		background.close();
		attended.close();
		setAttendedForegroundForTesting(undefined);
	});

	it("#when a key is posted to a target app #then the controller remembers when, so typing can wait for it", async () => {
		// given
		const { MacOSInputController, setKeyboardWindowFocuserForTesting, setOnscreenWindowIdsSourceForTesting } =
			await import("./macos-input.js");
		setKeyboardWindowFocuserForTesting(async () => undefined);
		setOnscreenWindowIdsSourceForTesting(() => [21]);
		const controller = new MacOSInputController(77);
		await controller.rememberTargetWindow(77, 21, [
			{ id: 21, bounds: { x: 0, y: 0, width: 400, height: 300 }, owner: { processId: 77 } },
		]);
		expect(controller.lastKeyboardInputAt(77)).toBeUndefined();

		// when
		const before = performance.now();
		await controller.pressKey("a", { modifiers: ["cmd"] });

		// then
		expect(controller.lastKeyboardInputAt(77)).toBeGreaterThanOrEqual(before);
		expect(controller.lastKeyboardInputAt(78)).toBeUndefined();
		controller.close();
	});
});
