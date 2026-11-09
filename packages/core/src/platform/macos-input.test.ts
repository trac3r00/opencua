import { beforeEach, describe, expect, it } from "bun:test";
import { vi } from "@opencua/test-support";

interface TestWindow {
	readonly id: number;
	readonly owner: {
		readonly processId: number;
	};
	readonly bounds: {
		readonly x: number;
		readonly y: number;
		readonly width: number;
		readonly height: number;
	};
}

const coreGraphicsMock = vi.hoisted(() => ({
	getCurrentCursorPosition: vi.fn(() => ({ x: 1, y: 2 })),
	postKeyboardEvent: vi.fn(),
	postMouseEvent: vi.fn(),
	postScrollEvent: vi.fn(),
	postUnicodeText: vi.fn(),
	warpCursorPosition: vi.fn(),
}));

const windowMock = vi.hoisted(() => ({
	openWindows: vi.fn<() => Promise<readonly TestWindow[]>>(() => Promise.resolve([])),
}));

const skyLightMock = vi.hoisted(() => {
	const targetPsn = Buffer.alloc(8, 2);
	const focusToken = { previousPsn: Buffer.alloc(8, 1), targetPsn };
	const state = { frontProcess: targetPsn };
	return {
		beginFocusWithoutRaise: vi.fn(() => focusToken),
		focusToken,
		frontProcessSerialNumber: vi.fn(() => state.frontProcess),
		processSerialNumbersMatch: (left: Buffer, right: Buffer) => left.equals(right),
		restoreFrontProcessNoWindows: vi.fn(() => true),
		state,
		targetPsn,
	};
});

vi.mock("get-windows", () => ({ openWindows: windowMock.openWindows }));
vi.mock("./macos-ffi/lock-screen.js", () => ({ isScreenLocked: () => false }));
// Attended clicks activate their app; the fake keeps that off the real desktop.
const actualWorkspace = { ...(await import("./macos-ffi/workspace.js")) };
vi.mock("./macos-ffi/workspace.js", () => ({ ...actualWorkspace, activateApplication: vi.fn(() => true) }));
vi.mock("./macos-ffi/skylight.js", () => ({
	// Background gestures first ask whether the target sits behind the person's app; here it is frontmost.
	focusGuardFor: () => null,
	setProcessAppActive: vi.fn(),
	beginFocusWithoutRaise: skyLightMock.beginFocusWithoutRaise,
	frontProcessSerialNumber: skyLightMock.frontProcessSerialNumber,
	processSerialNumbersMatch: skyLightMock.processSerialNumbersMatch,
	restoreFrontProcessNoWindows: skyLightMock.restoreFrontProcessNoWindows,
}));
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

const { runInInputScope } = await import("../computer/input-scope.js");
const { setOnscreenWindowIdsSourceForTesting } = await import("./macos-input.js");
const { setOpenWindowsSourceForTesting } = await import("./macos-open-windows.js");
// The in-process WindowServer listing is pinned away so the get-windows fixtures above stay authoritative.
setOpenWindowsSourceForTesting(() => undefined);

describe("#given MacOSInputController target routing", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		windowMock.openWindows.mockResolvedValue([]);
		setOnscreenWindowIdsSourceForTesting(() => [77, 88, 99]);
		skyLightMock.beginFocusWithoutRaise.mockReturnValue(skyLightMock.focusToken);
	});

	it("#when clicking with a target pid and no visible window #then refuses unsafe public pid fallback", async () => {
		// given
		const { MacOSInputController } = await import("./macos-input.js");
		const controller = new MacOSInputController(1234, undefined, undefined, undefined, "attended");

		// when/then
		await expect(controller.click({ x: 500, y: 300 })).rejects.toThrow(
			"targeted pointer input requires get_app_state or a visible target window",
		);

		expect(coreGraphicsMock.postMouseEvent).not.toHaveBeenCalled();
		controller.close();
	});

	it("#when clicking without a target pid #then keeps the existing CoreGraphics global path", async () => {
		// given
		const { MacOSInputController } = await import("./macos-input.js");
		const controller = new MacOSInputController(undefined, undefined, undefined, undefined, "attended");

		// when
		await controller.click({ x: 10, y: 20 }, "right");

		// then
		expect(coreGraphicsMock.postMouseEvent).toHaveBeenCalledWith({
			kind: "move",
			position: { x: 10, y: 20 },
			button: "left",
			clickState: undefined,
			targetPid: undefined,
		});
		expect(coreGraphicsMock.postMouseEvent).toHaveBeenCalledWith({
			kind: "down",
			position: { x: 10, y: 20 },
			button: "right",
			clickState: 1,
			targetPid: undefined,
		});
		expect(coreGraphicsMock.postMouseEvent).toHaveBeenCalledWith({
			kind: "up",
			position: { x: 10, y: 20 },
			button: "right",
			clickState: 1,
			targetPid: undefined,
		});
		expect(skyLightMock.beginFocusWithoutRaise).not.toHaveBeenCalled();
		expect(skyLightMock.restoreFrontProcessNoWindows).not.toHaveBeenCalled();
		expect(coreGraphicsMock.postMouseEvent).not.toHaveBeenCalledWith(
			expect.objectContaining({ position: { x: -1, y: -1 } }),
		);
		controller.close();
	});

	it("#when scrolling with a target pid and no remembered window #then refuses unsafe public pid fallback", async () => {
		// given
		const { MacOSInputController } = await import("./macos-input.js");
		const controller = new MacOSInputController(4321);

		// when/then
		await expect(controller.scroll({ direction: "down", amount: 2 })).rejects.toThrow(
			"targeted scroll input requires get_app_state, a visible target window, or a prior pointer action",
		);

		expect(coreGraphicsMock.postScrollEvent).not.toHaveBeenCalled();
		controller.close();
	});

	it("#when get_app_state has remembered a target window #then keyboard and scroll reuse that app session", async () => {
		// given
		windowMock.openWindows.mockResolvedValue([
			{
				id: 77,
				owner: { processId: 9876 },
				bounds: { x: 100, y: 200, width: 300, height: 240 },
			},
		]);
		const { MacOSInputController } = await import("./macos-input.js");
		const controller = new MacOSInputController(9876);

		// when
		await controller.rememberTargetWindow(9876);
		await controller.typeText("Hello");
		await controller.pressKey("l", { modifiers: ["command"] });
		await controller.scroll({ direction: "down", amount: 2 });

		// then
		const targetWindow = { id: 77, bounds: { x: 100, y: 200, width: 300, height: 240 } };
		expect(coreGraphicsMock.postUnicodeText).toHaveBeenCalledTimes(5);
		expect(coreGraphicsMock.postUnicodeText).toHaveBeenNthCalledWith(1, "H", 9876, targetWindow);
		expect(coreGraphicsMock.postUnicodeText).toHaveBeenNthCalledWith(5, "o", 9876, targetWindow);
		expect(coreGraphicsMock.postKeyboardEvent).toHaveBeenNthCalledWith(1, {
			keyCode: 37,
			keyDown: true,
			flags: 0x00100000,
			text: undefined,
			targetPid: 9876,
			targetWindow,
		});
		expect(coreGraphicsMock.postKeyboardEvent).toHaveBeenNthCalledWith(2, {
			keyCode: 37,
			keyDown: false,
			flags: 0x00100000,
			text: undefined,
			targetPid: 9876,
			targetWindow,
		});
		expect(coreGraphicsMock.postScrollEvent).toHaveBeenCalledWith({
			deltaX: 0,
			deltaY: -2,
			targetPid: 9876,
			targetWindow,
			position: { x: 250, y: 320 },
		});
		controller.close();
	});

	it("#when a target pid has a visible window #then keyboard input lazily primes that app session", async () => {
		// given
		windowMock.openWindows.mockResolvedValue([
			{
				id: 88,
				owner: { processId: 9876 },
				bounds: { x: 20, y: 40, width: 300, height: 240 },
			},
		]);
		const { MacOSInputController } = await import("./macos-input.js");
		const controller = new MacOSInputController(9876);

		// when
		await controller.pressKey("l", { modifiers: ["command"] });

		// then
		const targetWindow = { id: 88, bounds: { x: 20, y: 40, width: 300, height: 240 } };
		expect(coreGraphicsMock.postKeyboardEvent).toHaveBeenNthCalledWith(1, {
			keyCode: 37,
			keyDown: true,
			flags: 0x00100000,
			text: undefined,
			targetPid: 9876,
			targetWindow,
		});
		controller.close();
	});

	it("#when typing with a target pid and no remembered window #then refuses unsafe public pid fallback", async () => {
		// given
		const { MacOSInputController } = await import("./macos-input.js");
		const controller = new MacOSInputController(9876);

		// when/then
		await expect(controller.typeText("Hello")).rejects.toThrow(
			"targeted keyboard input requires get_app_state, a visible target window, or a prior pointer action",
		);
		expect(coreGraphicsMock.postUnicodeText).not.toHaveBeenCalled();
		controller.close();
	});

	it("#when clicking #then the virtual pointer overlay tracks the click and getCursorPosition reports it", async () => {
		// given
		windowMock.openWindows.mockResolvedValue([
			{ id: 99, owner: { processId: 1234 }, bounds: { x: 10, y: 20, width: 300, height: 200 } },
		]);
		const overlay = {
			set: vi.fn(),
			track: vi.fn(),
			highlight: vi.fn(),
			setMode: vi.fn(),
			hide: vi.fn(),
			close: vi.fn(),
		};
		const { MacOSInputController } = await import("./macos-input.js");
		const controller = new MacOSInputController(1234, overlay, undefined, undefined, "attended");

		// when
		await controller.click({ x: 50, y: 70 });

		// then
		expect(overlay.set).toHaveBeenCalledWith({ x: 50, y: 70 }, 1234);
		expect(controller.getCursorPosition()).toEqual({ x: 50, y: 70 });
		controller.close();
		expect(overlay.close).toHaveBeenCalledOnce();
	});

	it("#when clicking and moving under background delivery #then the drawn marker follows and cues clicks", async () => {
		// given
		windowMock.openWindows.mockResolvedValue([
			{ id: 99, owner: { processId: 1234 }, bounds: { x: 10, y: 20, width: 300, height: 200 } },
		]);
		const overlay = {
			set: vi.fn(),
			track: vi.fn(),
			highlight: vi.fn(),
			setMode: vi.fn(),
			hide: vi.fn(),
			close: vi.fn(),
		};
		const { MacOSInputController } = await import("./macos-input.js");
		const controller = new MacOSInputController(
			1234,
			overlay,
			() => false,
			{ acquire: vi.fn(), release: vi.fn() },
			"background",
		);

		// when
		await controller.click({ x: 50, y: 70 });
		await controller.move({ x: 60, y: 80 });

		// then
		expect(overlay.set).toHaveBeenCalledWith({ x: 50, y: 70 }, 1234);
		expect(overlay.track).toHaveBeenCalledWith({ x: 60, y: 80 }, 1234);
		expect(overlay.setMode).toHaveBeenCalledWith("click", 1234);
		expect(overlay.highlight).not.toHaveBeenCalled();
		expect(overlay.hide).not.toHaveBeenCalled();
		expect(controller.getCursorPosition()).toEqual({ x: 60, y: 80 });
		expect(coreGraphicsMock.postMouseEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				targetPid: 1234,
				targetWindow: { id: 99, bounds: { x: 10, y: 20, width: 300, height: 200 } },
			}),
		);
		controller.close();
	});

	it("#given background cues are off #when clicking #then no overlay command is emitted", async () => {
		windowMock.openWindows.mockResolvedValue([
			{ id: 99, owner: { processId: 1234 }, bounds: { x: 10, y: 20, width: 300, height: 200 } },
		]);
		const previous = process.env["OPENCUA_CURSOR_BACKGROUND_CUES"];
		process.env["OPENCUA_CURSOR_BACKGROUND_CUES"] = " Off ";
		const overlay = {
			set: vi.fn(),
			track: vi.fn(),
			highlight: vi.fn(),
			setMode: vi.fn(),
			hide: vi.fn(),
			close: vi.fn(),
		};
		const { MacOSInputController } = await import("./macos-input.js");
		const controller = new MacOSInputController(1234, overlay, undefined, undefined, "background");
		await controller.click({ x: 50, y: 70 });
		expect(overlay.set).not.toHaveBeenCalled();
		expect(overlay.setMode).not.toHaveBeenCalled();
		controller.close();
		if (previous === undefined) process.env["OPENCUA_CURSOR_BACKGROUND_CUES"] = undefined;
		else process.env["OPENCUA_CURSOR_BACKGROUND_CUES"] = previous;
	});

	it("#given background cue delivery #when scrolling typing and dragging #then each action cues its drawn marker", async () => {
		windowMock.openWindows.mockResolvedValue([
			{ id: 99, owner: { processId: 1234 }, bounds: { x: 10, y: 20, width: 300, height: 200 } },
		]);
		const overlay = {
			set: vi.fn(),
			track: vi.fn(),
			highlight: vi.fn(),
			setMode: vi.fn(),
			setScrollMode: vi.fn(),
			keyPress: vi.fn(),
			hide: vi.fn(),
			close: vi.fn(),
		};
		const { MacOSInputController } = await import("./macos-input.js");
		const controller = new MacOSInputController(1234, overlay, undefined, undefined, "background");
		await controller.scroll({ direction: "left", amount: 1 });
		await controller.typeText("x");
		await controller.drag({ from: { x: 40, y: 60 }, to: { x: 80, y: 100 }, duration: 0 });

		expect(overlay.setScrollMode).toHaveBeenCalledWith("left", 1234);
		expect(overlay.setMode).toHaveBeenCalledWith("keyboard", 1234);
		expect(overlay.keyPress).toHaveBeenCalledWith(1234);
		expect(overlay.setMode).toHaveBeenCalledWith("drag", 1234);
		expect(overlay.track).toHaveBeenCalled();
		controller.close();
	});

	it("#when an action runs #then it holds a display-sleep assertion and releases it on close", async () => {
		// given
		windowMock.openWindows.mockResolvedValue([
			{ id: 99, owner: { processId: 1234 }, bounds: { x: 10, y: 20, width: 300, height: 200 } },
		]);
		const displaySleep = { acquire: vi.fn(), release: vi.fn() };
		const { MacOSInputController } = await import("./macos-input.js");
		const controller = new MacOSInputController(
			1234,
			{ set: vi.fn(), highlight: vi.fn(), setMode: vi.fn(), hide: vi.fn(), close: vi.fn() },
			() => false,
			displaySleep,
		);

		// when
		await controller.click({ x: 50, y: 70 });
		controller.close();

		// then
		expect(displaySleep.acquire).toHaveBeenCalled();
		expect(displaySleep.release).toHaveBeenCalledOnce();
	});

	it("#when the screen is locked #then input is refused and no event is posted", async () => {
		// given
		windowMock.openWindows.mockResolvedValue([
			{ id: 99, owner: { processId: 1234 }, bounds: { x: 10, y: 20, width: 300, height: 200 } },
		]);
		const { MacOSInputController } = await import("./macos-input.js");
		const controller = new MacOSInputController(
			1234,
			{ set: vi.fn(), highlight: vi.fn(), setMode: vi.fn(), hide: vi.fn(), close: vi.fn() },
			() => true,
		);

		// when/then
		await expect(controller.click({ x: 50, y: 70 })).rejects.toThrow(/Mac is locked/);
		expect(coreGraphicsMock.postMouseEvent).not.toHaveBeenCalled();
		controller.close();
	});

	it("#when no action has happened #then getCursorPosition seeds from the real cursor", async () => {
		// given
		const { MacOSInputController } = await import("./macos-input.js");
		const controller = new MacOSInputController(1234, {
			set: vi.fn(),
			highlight: vi.fn(),
			setMode: vi.fn(),
			hide: vi.fn(),
			close: vi.fn(),
		});

		// when/then
		expect(controller.getCursorPosition()).toEqual({ x: 1, y: 2 });
		controller.close();
	});

	it("#when two app scopes move #then each cursor position remains independent", async () => {
		windowMock.openWindows.mockResolvedValue([
			{ id: 99, owner: { processId: 1234 }, bounds: { x: 10, y: 20, width: 300, height: 200 } },
			{ id: 88, owner: { processId: 5678 }, bounds: { x: 400, y: 20, width: 300, height: 200 } },
		]);
		const { MacOSInputController } = await import("./macos-input.js");
		const controller = new MacOSInputController(undefined, undefined, undefined, undefined, "background");

		await runInInputScope({ target: { pid: 1234 } }, () => controller.move({ x: 50, y: 70 }));
		await runInInputScope({ target: { pid: 5678 } }, () => controller.move({ x: 450, y: 70 }));
		const first = await runInInputScope({ target: { pid: 1234 } }, async () => controller.getCursorPosition());
		const second = await runInInputScope({ target: { pid: 5678 } }, async () => controller.getCursorPosition());

		expect(first).toEqual({ x: 50, y: 70 });
		expect(second).toEqual({ x: 450, y: 70 });
		controller.close();
	});
});

describe("#given background delivery #when a targeted pointer action runs #then the user focus and cursor are left alone", () => {
	it("posts to the window without leasing focus or moving the cursor", async () => {
		windowMock.openWindows.mockResolvedValue([
			{ id: 99, owner: { processId: 1234 }, bounds: { x: 10, y: 20, width: 300, height: 200 } },
		]);
		const { MacOSInputController } = await import("./macos-input.js");
		const controller = new MacOSInputController(1234, undefined, undefined, undefined, "background");

		await controller.click({ x: 50, y: 70 });

		const targetWindow = { id: 99, bounds: { x: 10, y: 20, width: 300, height: 200 } };
		expect(skyLightMock.beginFocusWithoutRaise).not.toHaveBeenCalled();
		expect(skyLightMock.restoreFrontProcessNoWindows).not.toHaveBeenCalled();
		expect(coreGraphicsMock.warpCursorPosition).not.toHaveBeenCalled();
		expect(coreGraphicsMock.postMouseEvent).toHaveBeenCalledWith(
			expect.objectContaining({ targetPid: 1234, targetWindow }),
		);
		controller.close();
	});

	it("posts a drag to the window without leasing focus", async () => {
		windowMock.openWindows.mockResolvedValue([
			{ id: 99, owner: { processId: 1234 }, bounds: { x: 10, y: 20, width: 300, height: 200 } },
		]);
		const { MacOSInputController } = await import("./macos-input.js");
		const controller = new MacOSInputController(1234, undefined, undefined, undefined, "background");

		await controller.drag({
			from: { x: 40, y: 60 },
			waypoints: [
				{ x: 80, y: 100 },
				{ x: 110, y: 130 },
			],
			to: { x: 140, y: 160 },
			button: "right",
			duration: 0,
			modifiers: ["shift"],
		});

		expect(skyLightMock.beginFocusWithoutRaise).not.toHaveBeenCalled();
		expect(coreGraphicsMock.warpCursorPosition).not.toHaveBeenCalled();
		const dragEvents = coreGraphicsMock.postMouseEvent.mock.calls
			.map(([event]) => event)
			.filter(({ button }) => button === "right");
		expect(dragEvents.map(({ kind }) => kind)).toEqual(["down", "drag", "drag", "drag", "up"]);
		expect(dragEvents.every(({ button, flags }) => button === "right" && flags === 0x00020000)).toBe(true);
		expect(dragEvents[0]).toMatchObject({ position: { x: 40, y: 60 } });
		expect(dragEvents.at(-1)).toMatchObject({ position: { x: 140, y: 160 } });
		controller.close();
	});
});

describe("#given background delivery #when an action would need the foreground #then it is refused", () => {
	it("refuses a click with no target app instead of taking over the cursor", async () => {
		const { MacOSInputController } = await import("./macos-input.js");
		coreGraphicsMock.postMouseEvent.mockClear();
		const controller = new MacOSInputController(undefined, undefined, undefined, undefined, "background");

		await expect(controller.click({ x: 500, y: 300 })).rejects.toThrow(/background delivery cannot click/);

		expect(coreGraphicsMock.postMouseEvent).not.toHaveBeenCalled();
		controller.close();
	});

	it("refuses a drag with no target app", async () => {
		const { MacOSInputController } = await import("./macos-input.js");
		const controller = new MacOSInputController(undefined, undefined, undefined, undefined, "background");

		await expect(controller.drag({ from: { x: 1, y: 2 }, to: { x: 3, y: 4 } })).rejects.toThrow(
			/background delivery cannot drag/,
		);
		controller.close();
	});
});

describe("#given the typeText pacing setting #when it is read #then an absent or unusable value keeps the default and a whole number is honored", () => {
	it("returns the default when the setting is absent or not a non-negative whole number", async () => {
		const { typeCharacterDelayMilliseconds } = await import("./macos-input.js");
		const fallback = typeCharacterDelayMilliseconds({});
		expect(typeCharacterDelayMilliseconds({})).toEqual(
			typeCharacterDelayMilliseconds({ OPENCUA_TYPE_CHARACTER_DELAY_MS: "garbage" }),
		);
		expect(typeCharacterDelayMilliseconds({ OPENCUA_TYPE_CHARACTER_DELAY_MS: "-4" })).toEqual(fallback);
		expect(typeCharacterDelayMilliseconds({ OPENCUA_TYPE_CHARACTER_DELAY_MS: "1.5" })).toEqual(fallback);
		expect(fallback).toBe(4);
	});

	it("honors a non-negative whole number, including zero", async () => {
		const { typeCharacterDelayMilliseconds } = await import("./macos-input.js");
		expect(typeCharacterDelayMilliseconds({ OPENCUA_TYPE_CHARACTER_DELAY_MS: "0" })).toBe(0);
		expect(typeCharacterDelayMilliseconds({ OPENCUA_TYPE_CHARACTER_DELAY_MS: "20" })).toBe(20);
		expect(typeCharacterDelayMilliseconds({ OPENCUA_TYPE_CHARACTER_DELAY_MS: " 4 " })).toBe(4);
	});
});
