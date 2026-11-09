import { beforeEach, describe, expect, it } from "bun:test";
import { vi } from "@opencua/test-support";

interface TestWindow {
	readonly id: number;
	readonly owner: { readonly processId: number };
	readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
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

/** Which app is in front: the person's (1) until the target (2) is activated. */
const front = vi.hoisted(() => ({ psn: 1, comesForward: true }));

const foregroundMock = vi.hoisted(() => ({
	activateApplication: vi.fn((_pid: number) => {
		if (front.comesForward) front.psn = 2;
		return front.comesForward;
	}),
	raiseWindowInApp: vi.fn((_pid: number, _windowId: number) => true),
	focusedWindowIdForPid: vi.fn((_pid: number): number | undefined => undefined),
}));

vi.mock("get-windows", () => ({ openWindows: windowMock.openWindows }));
vi.mock("./macos-ffi/lock-screen.js", () => ({ isScreenLocked: () => false }));
vi.mock("./macos-ffi/skylight.js", () => ({
	// Null once the target is the front process, as the native guard reports.
	focusGuardFor: () =>
		front.psn === 2 ? null : { previousPsn: Buffer.alloc(8, front.psn), targetPsn: Buffer.alloc(8, 2) },
	frontProcessSerialNumber: () => Buffer.alloc(8, front.psn),
	setProcessAppActive: vi.fn(() => true),
}));
vi.mock("./macos-ffi/workspace.js", () => ({ activateApplication: foregroundMock.activateApplication }));
const actualAccessibility = { ...(await import("./macos-ffi/accessibility.js")) };
vi.mock("./macos-ffi/accessibility.js", () => ({
	...actualAccessibility,
	focusedWindowIdForPid: foregroundMock.focusedWindowIdForPid,
	raiseWindowInApp: foregroundMock.raiseWindowInApp,
}));
vi.mock("./macos-ffi/coregraphics.js", () => ({
	K_CG_EVENT_FLAG_MASK_ALTERNATE: 0x00080000,
	K_CG_EVENT_FLAG_MASK_COMMAND: 0x00100000,
	K_CG_EVENT_FLAG_MASK_CONTROL: 0x00040000,
	K_CG_EVENT_FLAG_MASK_SHIFT: 0x00020000,
	...coreGraphicsMock,
}));

const { InputInterrupted, runInInputScope } = await import("../computer/input-scope.js");
const {
	MacOSInputController,
	setFocusedFrameSourceForTesting,
	setKeyboardWindowFocuserForTesting,
	setOnscreenWindowIdsSourceForTesting,
} = await import("./macos-input.js");
const { setOpenWindowsSourceForTesting } = await import("./macos-open-windows.js");
// The in-process WindowServer listing is pinned away so the get-windows fixtures above stay authoritative.
setOpenWindowsSourceForTesting(() => undefined);

const TARGET_PID = 1234;
const WINDOW: TestWindow = {
	id: 99,
	owner: { processId: TARGET_PID },
	bounds: { x: 10, y: 20, width: 300, height: 200 },
};

function mouseEvents(): readonly unknown[][] {
	return coreGraphicsMock.postMouseEvent.mock.calls.map(([event]) => [
		event.kind,
		event.position,
		event.clickState,
		event.targetPid,
		event.targetWindow,
	]);
}

function firstCall(order: readonly number[]): number {
	const first = order[0];
	if (first === undefined) throw new Error("expected a call");
	return first;
}

function attended(): InstanceType<typeof MacOSInputController> {
	return new MacOSInputController(TARGET_PID, undefined, undefined, undefined, "attended");
}

describe("#given attended delivery and a target app behind the person's", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		front.psn = 1;
		front.comesForward = true;
		foregroundMock.focusedWindowIdForPid.mockReturnValue(undefined);
		setOnscreenWindowIdsSourceForTesting(() => [10, 20, 99]);
		setKeyboardWindowFocuserForTesting(async () => undefined);
		setFocusedFrameSourceForTesting(() => undefined);
		windowMock.openWindows.mockResolvedValue([WINDOW]);
	});

	it("#when clicking #then the app is activated and its window raised before HID events move the real pointer", async () => {
		const controller = attended();

		await controller.click({ x: 50, y: 70 });

		expect(foregroundMock.activateApplication).toHaveBeenCalledWith(TARGET_PID);
		expect(foregroundMock.raiseWindowInApp).toHaveBeenCalledWith(TARGET_PID, 99);
		expect(mouseEvents()).toEqual([
			["move", { x: 50, y: 70 }, undefined, undefined, undefined],
			["down", { x: 50, y: 70 }, 1, undefined, undefined],
			["up", { x: 50, y: 70 }, 1, undefined, undefined],
		]);
		expect(firstCall(foregroundMock.activateApplication.mock.invocationCallOrder)).toBeLessThan(
			firstCall(coreGraphicsMock.postMouseEvent.mock.invocationCallOrder),
		);
		controller.close();
	});

	it("#when the app has several windows #then the window containing the click is the one raised", async () => {
		windowMock.openWindows.mockResolvedValue([
			{ id: 10, owner: { processId: TARGET_PID }, bounds: { x: 0, y: 0, width: 200, height: 160 } },
			{ id: 20, owner: { processId: TARGET_PID }, bounds: { x: 400, y: 300, width: 300, height: 220 } },
		]);
		const controller = attended();

		await controller.click({ x: 450, y: 340 });

		expect(foregroundMock.raiseWindowInApp).toHaveBeenCalledWith(TARGET_PID, 20);
		controller.close();
	});

	it("#when double-clicking and dragging #then every event goes through the HID tap", async () => {
		const controller = attended();

		await controller.doubleClick({ x: 50, y: 70 });
		await controller.drag({ from: { x: 50, y: 70 }, to: { x: 90, y: 110 }, duration: 0 });

		expect(mouseEvents()).toEqual([
			["move", { x: 50, y: 70 }, undefined, undefined, undefined],
			["down", { x: 50, y: 70 }, 1, undefined, undefined],
			["up", { x: 50, y: 70 }, 1, undefined, undefined],
			["down", { x: 50, y: 70 }, 2, undefined, undefined],
			["up", { x: 50, y: 70 }, 2, undefined, undefined],
			["move", { x: 50, y: 70 }, undefined, undefined, undefined],
			["down", { x: 50, y: 70 }, 1, undefined, undefined],
			["drag", { x: 90, y: 110 }, 1, undefined, undefined],
			["up", { x: 90, y: 110 }, 1, undefined, undefined],
		]);
		controller.close();
	});

	it("#when typing and pressing a key #then the app comes forward and the keys go through the HID tap", async () => {
		const controller = attended();
		await controller.rememberTargetWindow(TARGET_PID, 99, [WINDOW]);

		await controller.typeText("hi");
		await controller.pressKey("t");

		expect(foregroundMock.activateApplication).toHaveBeenCalledWith(TARGET_PID);
		expect(coreGraphicsMock.postUnicodeText.mock.calls.map(([text, pid]) => [text, pid])).toEqual([
			["h", undefined],
			["i", undefined],
		]);
		expect(coreGraphicsMock.postKeyboardEvent.mock.calls.map(([event]) => [event.keyDown, event.targetPid])).toEqual([
			[true, undefined],
			[false, undefined],
		]);
		controller.close();
	});

	it("#when the app is already frontmost with that window key #then it is not activated again", async () => {
		front.psn = 2;
		foregroundMock.focusedWindowIdForPid.mockReturnValue(99);
		const controller = attended();

		await controller.click({ x: 50, y: 70 });

		expect(foregroundMock.activateApplication).not.toHaveBeenCalled();
		expect(mouseEvents()).toHaveLength(3);
		controller.close();
	});

	it("#when the app does not come forward #then nothing is posted, since it would reach the person's app", async () => {
		front.comesForward = false;
		const controller = attended();

		await expect(controller.click({ x: 50, y: 70 })).rejects.toThrow(/could not bring app 1234 to the front/);

		expect(coreGraphicsMock.postMouseEvent).not.toHaveBeenCalled();
		controller.close();
	});

	it("#when the stop switch is on #then nothing is activated or posted", async () => {
		const controller = attended();

		await expect(
			runInInputScope({ target: { pid: TARGET_PID }, interruption: () => "stopped by the person" }, () =>
				controller.click({ x: 50, y: 70 }),
			),
		).rejects.toBeInstanceOf(InputInterrupted);

		expect(foregroundMock.activateApplication).not.toHaveBeenCalled();
		expect(coreGraphicsMock.postMouseEvent).not.toHaveBeenCalled();
		controller.close();
	});
});
