import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { vi } from "@opencua/test-support";

const PID = 4242;
const WINDOW = { id: 31, bounds: { x: 100, y: 100, width: 600, height: 400 }, owner: { processId: 4242 }, layer: 0 };

const bindings = vi.hoisted(() => ({
	postToHidEventTap: vi.fn(),
	warpCursorPosition: vi.fn(),
	event: () => ({}),
}));
const skyLight = vi.hoisted(() => ({
	postSkyLightEventToPid: vi.fn(),
	postAuthenticatedSkyLightEventToPid: vi.fn((_pid: number, ..._rest: unknown[]) => true),
	postCoreGraphicsEventToWindowOwner: vi.fn(() => true),
	postBackgroundEventRecordToWindowOwner: vi.fn(() => true),
	setProcessAppActive: vi.fn((_psn: unknown, _windowId: unknown, _active: unknown) => true),
}));

// The real coregraphics.ts runs on top of these: only the native bindings underneath it are fakes.
vi.mock("./macos-ffi/coregraphics-bindings.js", () => ({
	createCursorEvent: bindings.event,
	createKeyboardEvent: bindings.event,
	createMouseEvent: bindings.event,
	createScrollEvent: bindings.event,
	getLocation: () => ({ x: 4527, y: 293 }),
	postToHidEventTap: bindings.postToHidEventTap,
	setEventType: vi.fn(),
	setFlags: vi.fn(),
	setIntegerValueField: vi.fn(),
	setLocation: vi.fn(),
	setUnicodeString: vi.fn(),
	stampEvent: vi.fn(),
	warpCursorPosition: bindings.warpCursorPosition,
}));
vi.mock("./macos-ffi/appkit.js", () => ({ createNSEventBackedMouseEvent: bindings.event }));
vi.mock("./macos-ffi/corefoundation.js", () => ({ cfRelease: vi.fn() }));
vi.mock("./macos-ffi/skylight.js", () => ({
	...skyLight,
	setSkyLightIntegerField: vi.fn(),
	setSkyLightWindowLocation: vi.fn(),
	// The target sits behind the person's app, so clicks and drags tell it it is active and prime it first.
	focusGuardFor: () => ({ previousPsn: Buffer.alloc(8, 1), targetPsn: Buffer.alloc(8, 2) }),
	frontProcessSerialNumber: () => Buffer.alloc(8, 1),
}));
vi.mock("./macos-ffi/window-list.js", () => ({ listWindows: () => [], listOnscreenWindows: () => [] }));
vi.mock("./macos-ffi/lock-screen.js", () => ({ isScreenLocked: () => false }));
vi.mock("./macos-ffi/accessibility.js", () => ({
	focusedElementFrame: () => undefined,
	focusedElementInWebArea: () => false,
	focusedWindowIdForPid: () => 31,
	focusedWindowIsModal: () => false,
	focusedWindowShowsFilePanel: () => false,
	raiseWindowInApp: vi.fn(() => true),
	windowIdsAtScreenPoint: () => undefined,
	windowMinimizedForPid: () => false,
	windowTitlesForPid: () => new Map(),
}));

const { runInInputScope } = await import("../computer/input-scope.js");
const {
	MacOSInputController,
	setFocusStealWatcherForTesting,
	setKeyboardWindowFocuserForTesting,
	setOnscreenWindowIdsSourceForTesting,
	setScreenLayoutSourceForTesting,
} = await import("./macos-input.js");
const { setOpenWindowsSourceForTesting } = await import("./macos-open-windows.js");

beforeEach(() => {
	vi.clearAllMocks();
	setOpenWindowsSourceForTesting(() => [WINDOW]);
	setOnscreenWindowIdsSourceForTesting(() => [31]);
	setScreenLayoutSourceForTesting(() => ({
		displays: [{ x: 0, y: 0, width: 1920, height: 1080 }],
		windows: [WINDOW.bounds],
	}));
	setKeyboardWindowFocuserForTesting(async () => undefined);
	setFocusStealWatcherForTesting(() => undefined);
});

afterEach(() => {
	setOpenWindowsSourceForTesting(undefined);
	setOnscreenWindowIdsSourceForTesting(() => []);
});

describe("#given background delivery #when the agent clicks, drags and scrolls a target app #then the real cursor is never touched", () => {
	it("posts every pointer event to the target process and never warps the pointer or posts to the HID tap", async () => {
		const controller = new MacOSInputController(PID, undefined, () => false, undefined, "background", true, true);
		try {
			await runInInputScope({ target: { pid: PID, windowId: 31 } }, async () => {
				await controller.click({ x: 200, y: 200 });
				await controller.doubleClick({ x: 220, y: 220 });
				await controller.drag({ from: { x: 200, y: 200 }, to: { x: 400, y: 300 }, duration: 0 });
				await controller.scroll({ direction: "down", amount: 40, position: { x: 300, y: 300 } });
				await controller.move({ x: 500, y: 350 });
			});
		} finally {
			controller.close();
		}

		expect(bindings.warpCursorPosition).not.toHaveBeenCalled();
		expect(bindings.postToHidEventTap).not.toHaveBeenCalled();
		expect(skyLight.postSkyLightEventToPid.mock.calls.length).toBeGreaterThan(5);
		expect(skyLight.postSkyLightEventToPid.mock.calls.every(([pid]) => pid === PID)).toBe(true);
	});
});

describe("#given background delivery #when the agent only types into a target app #then the app is told it is active before any key", () => {
	it("tells the app its window is active, posts keys to the process, and never raises, warps or posts to the HID tap", async () => {
		const order: string[] = [];
		skyLight.setProcessAppActive.mockImplementation((_psn: unknown, windowId: unknown, active: unknown) => {
			order.push(`active:${String(windowId)}:${String(active)}`);
			return true;
		});
		skyLight.postSkyLightEventToPid.mockImplementation(() => {
			order.push("key");
		});
		skyLight.postAuthenticatedSkyLightEventToPid.mockImplementation(() => {
			order.push("key");
			return true;
		});
		const controller = new MacOSInputController(PID, undefined, () => false, undefined, "background", true, true);
		try {
			await runInInputScope({ target: { pid: PID, windowId: 31 } }, async () => {
				await controller.typeText("hi");
			});
		} finally {
			controller.close();
		}

		expect(order[0]).toBe("active:31:true");
		expect(order.filter((entry) => entry === "key").length).toBeGreaterThan(0);
		expect(bindings.warpCursorPosition).not.toHaveBeenCalled();
		expect(bindings.postToHidEventTap).not.toHaveBeenCalled();
		expect(skyLight.postAuthenticatedSkyLightEventToPid.mock.calls.every(([pid]) => pid === PID)).toBe(true);
		expect(skyLight.postSkyLightEventToPid.mock.calls.every(([pid]) => pid === PID)).toBe(true);
	});
});
