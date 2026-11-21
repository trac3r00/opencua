import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { vi } from "@opencua/test-support";

import type { MacOSWindowInfo } from "./macos-window-target.js";

const TARGET = {
	id: 72,
	bounds: { x: 600, y: 200, width: 500, height: 400 },
	owner: { processId: 1234, name: "TextEdit" },
	title: "Other Space",
	layer: 0,
};
const CURRENT = { ...TARGET, id: 11 };
const listedOnscreen: MacOSWindowInfo = CURRENT;
const listedTarget: MacOSWindowInfo = TARGET;
const listedCurrent: MacOSWindowInfo = CURRENT;

const native = vi.hoisted(() => ({
	focusedWindowIdForPid: vi.fn<(pid: number) => number | undefined>(() => undefined),
	windowMinimizedForPid: vi.fn<(pid: number, id: number) => boolean | undefined>(() => false),
	postKeyboardEvent: vi.fn(),
	postMouseEvent: vi.fn(),
	postScrollEvent: vi.fn(),
	postUnicodeText: vi.fn(),
	getCurrentCursorPosition: vi.fn(() => ({ x: 1, y: 2 })),
	raiseWindowInApp: vi.fn(() => true),
	setProcessAppActive: vi.fn(() => true),
	focusGuardFor: vi.fn<() => { readonly previousPsn: Buffer; readonly targetPsn: Buffer } | null>(() => null),
	watchFocusSteal: vi.fn(),
	listedWindows: [] as Array<{
		id: number;
		ownerPid: number;
		layer: number;
		ownerName: string;
		title: string;
		bounds: { x: number; y: number; width: number; height: number };
	}>,
	onscreenWindows: [] as Array<typeof TARGET>,
}));
vi.mock("./macos-ffi/window-list.js", () => ({
	listOnscreenWindows: vi.fn(() =>
		native.onscreenWindows.map((window) => ({ id: window.id, ownerPid: 1234, layer: 0 })),
	),
	listWindows: vi.fn((options?: { onScreenOnly?: boolean }) => {
		if (options?.onScreenOnly === false) {
			return native.listedWindows;
		}
		return native.onscreenWindows.map((window) => ({
			id: window.id,
			ownerPid: 1234,
			layer: 0,
			ownerName: "TextEdit",
			title: window.title,
			bounds: window.bounds,
		}));
	}),
}));

vi.mock("./macos-ffi/accessibility.js", () => ({
	focusedCaretFrame: () => undefined,
	focusedElementInWebArea: vi.fn(() => false),
	focusedWindowIdForPid: native.focusedWindowIdForPid,
	focusedWindowIsModal: vi.fn(() => false),
	focusedWindowShowsFilePanel: vi.fn(() => false),
	raiseWindowInApp: native.raiseWindowInApp,
	windowMinimizedForPid: native.windowMinimizedForPid,
	windowIdsAtScreenPoint: vi.fn(() => undefined),
	windowTitlesForPid: vi.fn(() => new Map()),
}));
vi.mock("./macos-ffi/coregraphics.js", () => ({
	K_CG_EVENT_FLAG_MASK_ALTERNATE: 0x00080000,
	K_CG_EVENT_FLAG_MASK_COMMAND: 0x00100000,
	K_CG_EVENT_FLAG_MASK_CONTROL: 0x00040000,
	K_CG_EVENT_FLAG_MASK_SHIFT: 0x00020000,
	getCurrentCursorPosition: native.getCurrentCursorPosition,
	postKeyboardEvent: native.postKeyboardEvent,
	postMouseEvent: native.postMouseEvent,
	postScrollEvent: native.postScrollEvent,
	postUnicodeText: native.postUnicodeText,
	warpCursorPosition: vi.fn(),
}));
vi.mock("./macos-ffi/lock-screen.js", () => ({ isScreenLocked: () => false }));
vi.mock("./macos-ffi/skylight.js", () => ({
	focusGuardFor: native.focusGuardFor,
	frontProcessSerialNumber: vi.fn(() => null),
	setProcessAppActive: native.setProcessAppActive,
}));

const { runInInputScope } = await import("../computer/input-scope.js");
const { setOnscreenWindowIdsSourceForTesting } = await import("./macos-input.js");

const noSleep = { acquire: vi.fn(), release: vi.fn() };

beforeEach(() => {
	vi.clearAllMocks();
	setOnscreenWindowIdsSourceForTesting(() => [11]);
	native.listedWindows = [TARGET, CURRENT].map((window) => ({
		id: window.id,
		ownerPid: window.owner.processId,
		layer: 0,
		ownerName: window.owner.name,
		title: window.title,
		bounds: window.bounds,
	}));
	native.onscreenWindows = [CURRENT];
	native.windowMinimizedForPid.mockReturnValue(false);
});

afterEach(() => {
	setOnscreenWindowIdsSourceForTesting(() => []);
});

async function makeController(delivery: "background" | "attended" = "background") {
	const { MacOSInputController, setKeyboardWindowFocuserForTesting, setFocusStealWatcherForTesting } = await import(
		"./macos-input.js"
	);
	setKeyboardWindowFocuserForTesting(vi.fn(async () => undefined));
	setFocusStealWatcherForTesting(native.watchFocusSteal);
	return new MacOSInputController(1234, undefined, () => false, noSleep, delivery, true);
}

describe("#given an explicitly observed window on another Space", () => {
	it("#when clicking in background #then posts directly to that window without activation or raising", async () => {
		const controller = await makeController();
		try {
			await expect(controller.rememberTargetWindow(1234, TARGET.id, [listedOnscreen])).resolves.toMatchObject({
				id: TARGET.id,
			});
			await runInInputScope({ target: { pid: 1234, windowId: TARGET.id } }, () =>
				controller.click({ x: 650, y: 250 }),
			);

			expect(native.postMouseEvent).toHaveBeenCalledWith(
				expect.objectContaining({ targetPid: 1234, targetWindow: expect.objectContaining({ id: TARGET.id }) }),
			);
			expect(native.setProcessAppActive).not.toHaveBeenCalled();
			expect(native.raiseWindowInApp).not.toHaveBeenCalled();
		} finally {
			controller.close();
		}
	});

	it("#when typing without verified app focus #then refuses without focusing or posting keys", async () => {
		const controller = await makeController();
		try {
			await controller.rememberTargetWindow(1234, TARGET.id, [listedOnscreen]);

			await expect(
				runInInputScope({ target: { pid: 1234, windowId: TARGET.id } }, () => controller.typeText("x")),
			).rejects.toThrow(/already be the app's verified focused window/);

			expect(native.raiseWindowInApp).not.toHaveBeenCalled();
			expect(native.setProcessAppActive).not.toHaveBeenCalled();
			expect(native.postUnicodeText).not.toHaveBeenCalled();
			expect(native.postKeyboardEvent).not.toHaveBeenCalled();
			expect(native.watchFocusSteal).not.toHaveBeenCalled();
		} finally {
			controller.close();
		}
	});

	it("#when the off-Space window is verified focused #then typing and key events keep its exact target", async () => {
		native.focusedWindowIdForPid.mockReturnValue(TARGET.id);
		const controller = await makeController();
		try {
			native.postUnicodeText.mockImplementationOnce(() => {
				expect(native.watchFocusSteal).toHaveBeenCalledWith(expect.objectContaining({ id: TARGET.id }));
			});
			await runInInputScope({ target: { pid: 1234, windowId: TARGET.id } }, () => controller.typeText("xy"));
			await runInInputScope({ target: { pid: 1234, windowId: TARGET.id } }, () => controller.pressKey("Return"));

			expect(native.postUnicodeText).toHaveBeenNthCalledWith(
				1,
				"x",
				1234,
				expect.objectContaining({ id: TARGET.id }),
			);
			expect(native.postUnicodeText).toHaveBeenNthCalledWith(
				2,
				"y",
				1234,
				expect.objectContaining({ id: TARGET.id }),
			);
			expect(native.postKeyboardEvent).toHaveBeenNthCalledWith(
				1,
				expect.objectContaining({ targetPid: 1234, targetWindow: expect.objectContaining({ id: TARGET.id }) }),
			);
			expect(native.postKeyboardEvent).toHaveBeenNthCalledWith(
				2,
				expect.objectContaining({ targetPid: 1234, targetWindow: expect.objectContaining({ id: TARGET.id }) }),
			);
			expect(native.focusedWindowIdForPid).toHaveBeenCalledWith(1234);
			expect(native.setProcessAppActive).not.toHaveBeenCalled();
			expect(native.raiseWindowInApp).not.toHaveBeenCalled();
		} finally {
			controller.close();
		}
	});

	it("#when scrolling an explicitly observed off-Space window #then wheel events keep its exact target", async () => {
		const controller = await makeController();
		try {
			await runInInputScope({ target: { pid: 1234, windowId: TARGET.id } }, () =>
				controller.scroll({ direction: "down", amount: 5 }),
			);

			expect(native.postScrollEvent).toHaveBeenCalled();
			for (const [event] of native.postScrollEvent.mock.calls) {
				expect(event).toEqual(
					expect.objectContaining({
						targetPid: 1234,
						targetWindow: expect.objectContaining({ id: TARGET.id }),
					}),
				);
			}
			expect(native.setProcessAppActive).not.toHaveBeenCalled();
			expect(native.raiseWindowInApp).not.toHaveBeenCalled();
		} finally {
			controller.close();
		}
	});

	it("#when minimized state is true or unknown #then refuses the off-Space target", async () => {
		for (const minimized of [true, undefined] as const) {
			native.windowMinimizedForPid.mockReturnValue(minimized);
			const controller = await makeController();
			try {
				await expect(controller.rememberTargetWindow(1234, TARGET.id)).resolves.toBeUndefined();
			} finally {
				controller.close();
			}
		}
	});

	it("#when a remembered window closes #then refuses unbound input rather than posting elsewhere", async () => {
		const controller = await makeController();
		try {
			await controller.rememberTargetWindow(1234, CURRENT.id, [listedTarget, listedCurrent]);
			native.onscreenWindows = [];
			setOnscreenWindowIdsSourceForTesting(() => []);
			native.listedWindows = [];
			await expect(controller.pressKey("a")).rejects.toThrow(/remembered window 11 is unavailable/);

			expect(native.postKeyboardEvent).not.toHaveBeenCalled();
		} finally {
			controller.close();
		}
	});

	it("#when a window command targets an off-Space document #then the app is told it is active, never raised or primed, and told so no longer on release", async () => {
		native.focusedWindowIdForPid.mockReturnValue(TARGET.id);
		const targetPsn = Buffer.alloc(8, 2);
		native.focusGuardFor.mockReturnValue({ previousPsn: Buffer.alloc(8, 1), targetPsn });
		const controller = await makeController();
		const command = vi.fn(async (held: boolean) => {
			expect(native.watchFocusSteal).toHaveBeenCalledWith(expect.objectContaining({ id: TARGET.id }));
			expect(native.setProcessAppActive).toHaveBeenLastCalledWith(targetPsn, TARGET.id, true);
			return held;
		});
		try {
			await expect(controller.withWindowCommand(1234, TARGET, () => true, command)).resolves.toBe(true);
			expect(native.raiseWindowInApp).not.toHaveBeenCalled();
			expect(native.postMouseEvent).not.toHaveBeenCalled();
		} finally {
			controller.close();
		}
		expect(native.setProcessAppActive).toHaveBeenLastCalledWith(targetPsn, TARGET.id, false);
		native.focusGuardFor.mockReturnValue(null);
	});

	it("#when an off-Space command target is not focused #then refuses without calling the command", async () => {
		native.focusedWindowIdForPid.mockReturnValue(CURRENT.id);
		const controller = await makeController();
		const command = vi.fn(async () => undefined);
		try {
			await expect(controller.withWindowCommand(1234, TARGET, () => true, command)).rejects.toThrow(
				/not the app's verified focused window/,
			);
			expect(command).not.toHaveBeenCalled();
			expect(native.raiseWindowInApp).not.toHaveBeenCalled();
			expect(native.setProcessAppActive).not.toHaveBeenCalled();
		} finally {
			controller.close();
		}
	});

	it("#when the window is missing or owned by another process #then refuses without posting", async () => {
		const controller = await makeController();
		try {
			const listed = (window: typeof TARGET, ownerPid = window.owner.processId, ownerName = window.owner.name) => ({
				id: window.id,
				ownerPid,
				layer: 0,
				ownerName,
				title: window.title,
				bounds: window.bounds,
			});
			native.listedWindows = [listed(CURRENT)];
			await expect(controller.rememberTargetWindow(1234, TARGET.id)).resolves.toBeUndefined();
			native.listedWindows = [listed(TARGET, 5678, "Other"), listed(CURRENT)];
			await expect(controller.rememberTargetWindow(1234, TARGET.id)).resolves.toBeUndefined();

			await expect(
				runInInputScope({ target: { pid: 1234, windowId: TARGET.id } }, () => controller.click({ x: 650, y: 250 })),
			).rejects.toThrow(/unavailable on this Space/);
			expect(native.postMouseEvent).not.toHaveBeenCalled();
		} finally {
			controller.close();
		}
	});

	it("#when the same absent window is requested by attended delivery #then keeps current-Space refusal", async () => {
		const controller = await makeController("attended");
		try {
			await expect(controller.rememberTargetWindow(1234, TARGET.id)).resolves.toBeUndefined();
			expect(native.windowMinimizedForPid).not.toHaveBeenCalled();
			expect(native.postMouseEvent).not.toHaveBeenCalled();
		} finally {
			controller.close();
		}
	});
});
