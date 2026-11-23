import { beforeEach, describe, expect, it } from "bun:test";
import { vi } from "@opencua/test-support";

const accessibilityMock = vi.hoisted(() => ({
	focusedElementInWebArea: vi.fn(() => false),
	focusedWindowIdForPid: vi.fn<(pid: number) => number | undefined>(),
	focusedWindowIsModal: vi.fn(() => false),
	focusedWindowShowsFilePanel: vi.fn(() => false),
	raiseWindowInApp: vi.fn<(pid: number, windowId: number) => boolean>(() => true),
	windowTitlesForPid: vi.fn<(pid: number) => ReadonlyMap<number, string>>(() => new Map()),
}));

const coreGraphicsMock = vi.hoisted(() => ({
	getCurrentCursorPosition: vi.fn(() => ({ x: 1, y: 2 })),
	postKeyboardEvent: vi.fn(),
	postMouseEvent: vi.fn(),
	postScrollEvent: vi.fn(),
	postUnicodeText: vi.fn(),
	warpCursorPosition: vi.fn(),
}));

vi.mock("./macos-ffi/accessibility.js", () => accessibilityMock);
vi.mock("./macos-ffi/lock-screen.js", () => ({ isScreenLocked: () => false }));
const skyLightMock = vi.hoisted(() => ({
	focusGuardFor: vi.fn<() => { readonly previousPsn: Buffer; readonly targetPsn: Buffer } | null>(() => null),
	setProcessAppActive: vi.fn<(psn: Buffer, windowId: number, active: boolean) => boolean>(() => true),
}));

vi.mock("./macos-ffi/skylight.js", () => ({
	focusGuardFor: skyLightMock.focusGuardFor,
	frontProcessSerialNumber: () => null,
	setProcessAppActive: skyLightMock.setProcessAppActive,
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
const { setFocusStealWatcherForTesting, setOnscreenWindowIdsSourceForTesting } = await import("./macos-input.js");
setFocusStealWatcherForTesting(() => undefined);
const { setOpenWindowsSourceForTesting } = await import("./macos-open-windows.js");

const A_TXT = { id: 71, bounds: { x: 100, y: 100, width: 600, height: 400 } };
const B_TXT = { id: 72, bounds: { x: 140, y: 130, width: 600, height: 400 } };

// Two documents of one app, untitled in the WindowServer listing, as a process without Screen Recording sees them.
setOpenWindowsSourceForTesting(() =>
	[A_TXT, B_TXT].map((window) => ({
		id: window.id,
		owner: { processId: 1234, name: "TextEdit" },
		title: "",
		bounds: window.bounds,
		layer: 0,
	})),
);

async function controllerOnB() {
	const { MacOSInputController } = await import("./macos-input.js");
	const controller = new MacOSInputController(
		1234,
		undefined,
		() => false,
		{ acquire: vi.fn(), release: vi.fn() },
		"background",
	);
	await controller.rememberTargetWindow(1234, B_TXT.id);
	return controller;
}

describe("#given keys or a window command for b.txt while the app's focused window is another one", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		setOnscreenWindowIdsSourceForTesting(() => [A_TXT.id, B_TXT.id]);
		accessibilityMock.windowTitlesForPid.mockReturnValue(
			new Map([
				[A_TXT.id, "a.txt"],
				[B_TXT.id, "b.txt"],
			]),
		);
	});

	it("#when another document has focus #then keys are refused without raising b.txt", async () => {
		accessibilityMock.focusedWindowIdForPid.mockReturnValue(A_TXT.id);
		const controller = await controllerOnB();

		try {
			await expect(controller.pressKey("a")).rejects.toThrow("refusing to raise");
			expect(accessibilityMock.raiseWindowInApp).not.toHaveBeenCalled();
			expect(coreGraphicsMock.postKeyboardEvent).not.toHaveBeenCalled();
		} finally {
			controller.close();
		}
	});

	it("#when a window command is aimed at b.txt #then it is refused without raising or invoking the command", async () => {
		accessibilityMock.focusedWindowIdForPid.mockReturnValue(A_TXT.id);
		const controller = await controllerOnB();
		const command = vi.fn(async () => undefined);
		try {
			await expect(controller.withWindowCommand(1234, B_TXT, () => false, command)).rejects.toThrow(
				"refusing to raise",
			);
			expect(accessibilityMock.raiseWindowInApp).not.toHaveBeenCalled();
			expect(command).not.toHaveBeenCalled();
		} finally {
			controller.close();
		}
	});

	it("#when the focused window is an untitled helper of b.txt's own interaction #then nothing is raised over it", async () => {
		accessibilityMock.focusedWindowIdForPid.mockReturnValue(75);
		const controller = await controllerOnB();

		await controller.pressKey("Return");

		expect(accessibilityMock.raiseWindowInApp).not.toHaveBeenCalled();
		controller.close();
	});

	it("#when b.txt already has focus #then nothing is raised", async () => {
		accessibilityMock.focusedWindowIdForPid.mockReturnValue(B_TXT.id);
		const controller = await controllerOnB();

		await controller.pressKey("a");

		expect(accessibilityMock.raiseWindowInApp).not.toHaveBeenCalled();
		controller.close();
	});

	it("#when an observed window is bound but an unrelated modal has focus #then no keyboard event is posted", async () => {
		accessibilityMock.focusedWindowIdForPid.mockReturnValue(A_TXT.id);
		accessibilityMock.focusedWindowIsModal.mockReturnValue(true);
		const controller = await controllerOnB();
		try {
			await expect(
				runInInputScope({ target: { pid: 1234, windowId: B_TXT.id } }, () => controller.pressKey("Return")),
			).rejects.toThrow();
			expect(coreGraphicsMock.postKeyboardEvent).not.toHaveBeenCalled();
		} finally {
			accessibilityMock.focusedWindowIsModal.mockReturnValue(false);
			controller.close();
		}
	});

	it("#when the observed window has verified focus #then bound keyboard input is delivered", async () => {
		accessibilityMock.focusedWindowIdForPid.mockReturnValue(B_TXT.id);
		const controller = await controllerOnB();
		try {
			await runInInputScope({ target: { pid: 1234, windowId: B_TXT.id } }, () => controller.pressKey("Return"));
			expect(coreGraphicsMock.postKeyboardEvent).toHaveBeenCalledWith(
				expect.objectContaining({ targetPid: 1234, targetWindow: B_TXT }),
			);
		} finally {
			controller.close();
		}
	});

	it("#when a bound window command faces an unrelated modal #then the command is never invoked", async () => {
		accessibilityMock.focusedWindowIdForPid.mockReturnValue(A_TXT.id);
		accessibilityMock.focusedWindowIsModal.mockReturnValue(true);
		const controller = await controllerOnB();
		const command = vi.fn(async () => undefined);
		try {
			await expect(
				runInInputScope({ target: { pid: 1234, windowId: B_TXT.id } }, () =>
					controller.withWindowCommand(1234, B_TXT, () => false, command),
				),
			).rejects.toThrow();
			expect(command).not.toHaveBeenCalled();
		} finally {
			accessibilityMock.focusedWindowIsModal.mockReturnValue(false);
			controller.close();
		}
	});

	it.each([undefined, 75])(
		"#when bound keyboard focus is unknown or an unverified helper (%s) #then no text reaches the process",
		async (focusedId) => {
			accessibilityMock.focusedWindowIdForPid.mockReturnValue(focusedId);
			const controller = await controllerOnB();
			try {
				await expect(
					runInInputScope({ target: { pid: 1234, windowId: B_TXT.id } }, () => controller.typeText("marker")),
				).rejects.toThrow("observed keyboard target");
				expect(coreGraphicsMock.postUnicodeText).not.toHaveBeenCalled();
			} finally {
				controller.close();
			}
		},
	);

	it("#when another document owns focus under a bound observation #then neither raising nor key delivery occurs", async () => {
		accessibilityMock.focusedWindowIdForPid.mockReturnValue(A_TXT.id);
		const controller = await controllerOnB();
		try {
			await expect(
				runInInputScope({ target: { pid: 1234, windowId: B_TXT.id } }, () => controller.pressKey("a")),
			).rejects.toThrow("refusing to raise");
			expect(accessibilityMock.raiseWindowInApp).not.toHaveBeenCalled();
			expect(coreGraphicsMock.postKeyboardEvent).not.toHaveBeenCalled();
		} finally {
			controller.close();
		}
	});
});

describe("#given an app behind the person's whose key window is another document", () => {
	const behind = { previousPsn: Buffer.alloc(8, 1), targetPsn: Buffer.alloc(8, 2) };

	beforeEach(() => {
		vi.clearAllMocks();
		setOnscreenWindowIdsSourceForTesting(() => [A_TXT.id, B_TXT.id]);
		accessibilityMock.focusedWindowIsModal.mockReturnValue(false);
		accessibilityMock.windowTitlesForPid.mockReturnValue(
			new Map([
				[A_TXT.id, "a.txt"],
				[B_TXT.id, "b.txt"],
			]),
		);
		skyLightMock.focusGuardFor.mockReturnValue(behind);
	});

	it("#when keys are bound to b.txt #then b.txt is named key without a raise and the keys reach it", async () => {
		let focused = A_TXT.id;
		accessibilityMock.focusedWindowIdForPid.mockImplementation(() => focused);
		skyLightMock.setProcessAppActive.mockImplementation((_psn, windowId, active) => {
			if (active) focused = windowId;
			return true;
		});
		const controller = await controllerOnB();
		try {
			await runInInputScope({ target: { pid: 1234, windowId: B_TXT.id } }, () => controller.pressKey("a"));
			expect(skyLightMock.setProcessAppActive).toHaveBeenCalledWith(behind.targetPsn, B_TXT.id, true);
			expect(accessibilityMock.raiseWindowInApp).not.toHaveBeenCalled();
			expect(coreGraphicsMock.postKeyboardEvent).toHaveBeenCalledWith(
				expect.objectContaining({ targetPid: 1234, targetWindow: B_TXT }),
			);
		} finally {
			controller.close();
		}
	});

	it("#when a window command is aimed at b.txt #then it runs after b.txt is named key", async () => {
		let focused = A_TXT.id;
		accessibilityMock.focusedWindowIdForPid.mockImplementation(() => focused);
		skyLightMock.setProcessAppActive.mockImplementation((_psn, windowId, active) => {
			if (active) focused = windowId;
			return true;
		});
		const controller = await controllerOnB();
		const command = vi.fn(async () => "ran");
		try {
			await expect(controller.withWindowCommand(1234, B_TXT, () => false, command)).resolves.toBe("ran");
			expect(accessibilityMock.raiseWindowInApp).not.toHaveBeenCalled();
		} finally {
			controller.close();
		}
	});

	it("#when the app moves its key window away after an earlier call #then the next call names b.txt again", async () => {
		let focused = A_TXT.id;
		accessibilityMock.focusedWindowIdForPid.mockImplementation(() => focused);
		skyLightMock.setProcessAppActive.mockImplementation((_psn, windowId, active) => {
			if (active) focused = windowId;
			return true;
		});
		const controller = await controllerOnB();
		try {
			await runInInputScope({ target: { pid: 1234, windowId: B_TXT.id } }, () => controller.pressKey("a"));
			focused = A_TXT.id; // a popup or the other document took the key window between calls
			await runInInputScope({ target: { pid: 1234, windowId: B_TXT.id } }, () => controller.pressKey("b"));
			const named = skyLightMock.setProcessAppActive.mock.calls.filter(
				([, windowId, active]) => windowId === B_TXT.id && active,
			);
			expect(named.length).toBe(2);
			expect(coreGraphicsMock.postKeyboardEvent.mock.calls.filter(([event]) => event.keyDown).length).toBe(2);
		} finally {
			controller.close();
		}
	});

	it("#when the app moves its key window away between two clicks on b.txt #then the second click names b.txt again", async () => {
		let focused = A_TXT.id;
		accessibilityMock.focusedWindowIdForPid.mockImplementation(() => focused);
		skyLightMock.setProcessAppActive.mockImplementation((_psn, windowId, active) => {
			if (active) focused = windowId;
			return true;
		});
		const { setScreenLayoutSourceForTesting } = await import("./macos-input.js");
		setScreenLayoutSourceForTesting(() => ({
			displays: [{ x: 0, y: 0, width: 1920, height: 1080 }],
			windows: [A_TXT.bounds, B_TXT.bounds],
		}));
		const controller = await controllerOnB();
		try {
			await runInInputScope({ target: { pid: 1234, windowId: B_TXT.id } }, () =>
				controller.click({ x: 720, y: 500 }),
			);
			focused = A_TXT.id;
			await runInInputScope({ target: { pid: 1234, windowId: B_TXT.id } }, () =>
				controller.click({ x: 720, y: 500 }),
			);
			const named = skyLightMock.setProcessAppActive.mock.calls.filter(
				([, windowId, active]) => windowId === B_TXT.id && active,
			);
			expect(named.length).toBe(2);
		} finally {
			controller.close();
		}
	});

	it.each([
		["outside b.txt (an extension popup over another window)", { x: 900, y: 700, width: 300, height: 300 }, 1],
		["inside b.txt (a rename field or popover of its own)", { x: 200, y: 200, width: 100, height: 40 }, 0],
		["that has just closed (no longer listed)", undefined, 1],
	])(
		"#when an untitled window %s holds the key #then b.txt is named key %s time(s)",
		async (_name, bounds, expected) => {
			const POPUP = 75;
			let focused = POPUP;
			accessibilityMock.focusedWindowIdForPid.mockImplementation(() => focused);
			skyLightMock.setProcessAppActive.mockImplementation((_psn, windowId, active) => {
				if (active) focused = windowId;
				return true;
			});
			setOpenWindowsSourceForTesting(() =>
				[A_TXT, B_TXT, ...(bounds === undefined ? [] : [{ id: POPUP, bounds }])].map((window) => ({
					id: window.id,
					owner: { processId: 1234, name: "TextEdit" },
					title: "",
					bounds: window.bounds,
					layer: 0,
				})),
			);
			const controller = await controllerOnB();
			try {
				await runInInputScope({ target: { pid: 1234, windowId: B_TXT.id } }, () =>
					controller.pressKey("a").catch(() => undefined),
				);
				const named = skyLightMock.setProcessAppActive.mock.calls.filter(
					([, windowId, active]) => windowId === B_TXT.id && active,
				);
				expect(named.length).toBe(expected);
			} finally {
				controller.close();
			}
		},
	);

	it("#when the app never reports b.txt as key #then the keys are refused and nothing is posted", async () => {
		accessibilityMock.focusedWindowIdForPid.mockReturnValue(A_TXT.id);
		const controller = await controllerOnB();
		try {
			await expect(
				runInInputScope({ target: { pid: 1234, windowId: B_TXT.id } }, () => controller.pressKey("a")),
			).rejects.toThrow("refusing to raise");
			expect(coreGraphicsMock.postKeyboardEvent).not.toHaveBeenCalled();
		} finally {
			controller.close();
		}
	});

	it("#when the app is the person's front app #then its key window is left alone and keys are refused", async () => {
		skyLightMock.focusGuardFor.mockReturnValue(null);
		accessibilityMock.focusedWindowIdForPid.mockReturnValue(A_TXT.id);
		const controller = await controllerOnB();
		try {
			await expect(controller.pressKey("a")).rejects.toThrow("refusing to raise");
			expect(skyLightMock.setProcessAppActive).not.toHaveBeenCalled();
		} finally {
			controller.close();
		}
	});
});
