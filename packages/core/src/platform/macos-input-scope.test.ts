import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { defined, vi } from "@opencua/test-support";

const coreGraphicsMock = vi.hoisted(() => ({
	getCurrentCursorPosition: vi.fn(() => ({ x: 1, y: 2 })),
	postKeyboardEvent: vi.fn(),
	postMouseEvent: vi.fn(),
	postScrollEvent: vi.fn(),
	postUnicodeText: vi.fn(),
	warpCursorPosition: vi.fn(),
}));
const focusMock = vi.hoisted(() => ({
	beginFocusWithoutRaise: vi.fn(),
	setProcessAppActive: vi.fn(() => false),
}));

vi.mock("./macos-ffi/lock-screen.js", () => ({ isScreenLocked: () => false }));
vi.mock("./macos-ffi/window-list.js", () => ({
	listWindows: vi.fn(() => []),
	listOnscreenWindows: vi.fn(() => []),
}));
vi.mock("./macos-ffi/coregraphics.js", () => ({
	K_CG_EVENT_FLAG_MASK_ALTERNATE: 0x00080000,
	K_CG_EVENT_FLAG_MASK_COMMAND: 0x00100000,
	K_CG_EVENT_FLAG_MASK_CONTROL: 0x00040000,
	K_CG_EVENT_FLAG_MASK_SHIFT: 0x00020000,
	...coreGraphicsMock,
}));
// The target sits behind the person's app in every case here, and is never told it is active.
vi.mock("./macos-ffi/skylight.js", () => ({
	focusGuardFor: () => null,
	setProcessAppActive: focusMock.setProcessAppActive,
	beginFocusWithoutRaise: focusMock.beginFocusWithoutRaise,
	frontProcessSerialNumber: vi.fn(() => null),
	processSerialNumbersMatch: () => false,
	restoreFrontProcessNoWindows: vi.fn(() => true),
}));

const { currentCursorIdentity, withCursorIdentity } = await import("../computer/cursor-scope.js");
const { InputInterrupted, runInInputScope } = await import("../computer/input-scope.js");
const accessibility = await import("./macos-ffi/accessibility.js");
const { NOOP_POINTER_OVERLAY } = await import("./macos-ffi/cursor-overlay.js");
const {
	MacOSInputController,
	setFocusStealWatcherForTesting,
	setKeyboardPidResolverForTesting,
	setKeyboardWindowFocuserForTesting,
	setOnscreenWindowIdsSourceForTesting,
	setPointWindowIdsForTesting,
} = await import("./macos-input.js");
const { setOpenWindowsSourceForTesting } = await import("./macos-open-windows.js");
const ownedSurfaces = await import("./owned-surfaces.js");

import type { InputScope } from "../computer/input-scope.js";

const NO_SLEEP = { acquire: () => undefined, release: () => undefined };

/** Two documents of app 42, window 11 in front and overlapping window 12; app 77 has window 21. */
const FRONT = { id: 11, bounds: { x: 0, y: 0, width: 400, height: 300 }, owner: { processId: 42 } };
const BEHIND = { id: 12, bounds: { x: 100, y: 100, width: 400, height: 300 }, owner: { processId: 42 } };
const OTHER_APP = { id: 21, bounds: { x: 600, y: 0, width: 300, height: 200 }, owner: { processId: 77 } };
const window12 = { id: 12, bounds: BEHIND.bounds };
const window21 = { id: 21, bounds: OTHER_APP.bounds };
const focusedWindows = new Map<number, number>();

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
	let resolvePromise: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve(): void {
			resolvePromise?.();
		},
	};
}

function backgroundController(): InstanceType<typeof MacOSInputController> {
	return new MacOSInputController(undefined, NOOP_POINTER_OVERLAY, () => false, NO_SLEEP, "background");
}

/** Background cue rendering is env-gated at construction; some tests need the legacy silent behavior. */
function withBackgroundCuesDisabled<T>(run: () => T): T {
	const previous = process.env["OPENCUA_CURSOR_BACKGROUND_CUES"];
	process.env["OPENCUA_CURSOR_BACKGROUND_CUES"] = "off";
	try {
		return run();
	} finally {
		if (previous === undefined) {
			Reflect.deleteProperty(process.env, "OPENCUA_CURSOR_BACKGROUND_CUES");
		} else {
			process.env["OPENCUA_CURSOR_BACKGROUND_CUES"] = previous;
		}
	}
}

function boundTo(pid: number, windowId: number, interruption?: () => string | undefined): InputScope {
	return interruption === undefined ? { target: { pid, windowId } } : { target: { pid, windowId }, interruption };
}

beforeEach(() => {
	vi.clearAllMocks();
	focusedWindows.clear();
	vi.spyOn(accessibility, "focusedWindowIdForPid").mockImplementation((pid) => focusedWindows.get(pid));
	coreGraphicsMock.postKeyboardEvent.mockImplementation(() => undefined);
	coreGraphicsMock.postMouseEvent.mockImplementation(() => undefined);
	coreGraphicsMock.postUnicodeText.mockImplementation(() => undefined);
	setOpenWindowsSourceForTesting(() => [FRONT, BEHIND, OTHER_APP]);
	setOnscreenWindowIdsSourceForTesting(() => [11, 12, 21]);
	setKeyboardWindowFocuserForTesting(async (pid, windowId) => {
		focusedWindows.set(pid, windowId);
	});
	setKeyboardPidResolverForTesting((pid) => pid);
	setFocusStealWatcherForTesting(() => undefined);
	setPointWindowIdsForTesting(() => undefined);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("#given a pointer bound to an observed window #when moving or dragging #then its path stays spatially scoped", () => {
	it("#given unscoped feedback #when a new identity starts #then it never inherits that pointer position", () => {
		const controller = backgroundController();
		try {
			const initial = controller.getCursorPosition();
			controller.showPointer({ x: 987, y: 654 }, false);

			expect(withCursorIdentity("new-session", () => controller.getCursorPosition())).toEqual(initial);
			expect(controller.getCursorPosition()).toEqual({ x: 987, y: 654 });
		} finally {
			controller.close();
		}
	});

	it.each(["background", "attended"] as const)(
		"#when explicit feedback names a PID under another scope in %s #then position belongs to that PID and identity",
		async (delivery) => {
			const set = vi.fn();
			const setMode = vi.fn();
			const controller = new MacOSInputController(
				42,
				{ ...NOOP_POINTER_OVERLAY, set, setMode },
				() => false,
				NO_SLEEP,
				delivery,
			);
			const initial = controller.getCursorPosition();
			await withCursorIdentity("explicit", async () => {
				await runInInputScope(boundTo(42, 12), async () => {
					controller.showPointer({ x: 650, y: 50 }, true, 77);
					controller.showScrollPointer({ x: 660, y: 60 }, 77);
					expect(controller.getCursorPosition()).toEqual(initial);
				});
				await runInInputScope(boundTo(77, 21), async () => {
					expect(controller.getCursorPosition()).toEqual({ x: 660, y: 60 });
				});
			});
			await runInInputScope(boundTo(77, 21), async () => {
				expect(controller.getCursorPosition()).toEqual(initial);
			});
			// Background cue rendering is on by default now, so the drawn marker feedback matches attended.
			expect(set).toHaveBeenNthCalledWith(1, { x: 650, y: 50 }, 77);
			expect(set).toHaveBeenNthCalledWith(2, { x: 660, y: 60 }, 77);
			expect(setMode.mock.calls).toEqual([
				["pointer", 77],
				["click", 77],
				["scroll", 77],
			]);
			controller.close();
		},
	);

	it("#when background actions request cursor modes with background cues disabled #then all injected feedback stays silent", () => {
		withBackgroundCuesDisabled(() => {
			const set = vi.fn();
			const setMode = vi.fn();
			const controller = new MacOSInputController(
				42,
				{ ...NOOP_POINTER_OVERLAY, set, setMode },
				() => false,
				NO_SLEEP,
				"background",
			);
			controller.showPointer({ x: 650, y: 50 }, true, 77);
			controller.showScrollPointer({ x: 660, y: 60 }, 77);
			expect(set).not.toHaveBeenCalled();
			expect(setMode).not.toHaveBeenCalled();
			controller.close();
		});
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_VALUE])(
		"#when a drag duration is %s #then rejects before native input or activation",
		async (duration) => {
			const controller = backgroundController();
			await expect(
				runInInputScope(boundTo(42, 12), () =>
					controller.drag({ from: { x: 150, y: 150 }, to: { x: 350, y: 250 }, duration }),
				),
			).rejects.toThrow(RangeError);
			expect(coreGraphicsMock.postMouseEvent).not.toHaveBeenCalled();
			expect(focusMock.setProcessAppActive).not.toHaveBeenCalled();
			controller.close();
		},
	);

	it("moves through paced intermediate points and tracks the overlay without touching the real cursor", async () => {
		vi.useFakeTimers();
		const set = vi.fn();
		const track = vi.fn();
		const controller = new MacOSInputController(
			undefined,
			{ ...NOOP_POINTER_OVERLAY, set, track },
			() => false,
			NO_SLEEP,
			"background",
		);
		const initialMove = runInInputScope(boundTo(42, 12), () => controller.move({ x: 150, y: 150 }));
		await vi.runAllTimersAsync();
		await initialMove;
		coreGraphicsMock.postMouseEvent.mockClear();
		track.mockClear();

		const moving = runInInputScope(boundTo(42, 12), () => controller.move({ x: 350, y: 250 }));
		await vi.runAllTimersAsync();
		await moving;

		const positions = coreGraphicsMock.postMouseEvent.mock.calls.map(([event]) => event.position);
		expect(positions.length).toBeGreaterThan(2);
		expect(positions[0]).not.toEqual({ x: 350, y: 250 });
		expect(positions.at(-1)).toEqual({ x: 350, y: 250 });
		// Background cues are on by default: the drawn marker follows every paced sample.
		expect(track.mock.calls.map(([point]) => point)).toEqual(positions);
		expect(set).not.toHaveBeenCalled();
		expect(await runInInputScope(boundTo(42, 12), async () => controller.getCursorPosition())).toEqual({
			x: 350,
			y: 250,
		});
		expect(positions.every((point) => point.x >= 150 && point.x <= 350 && point.y >= 150 && point.y <= 250)).toBe(
			true,
		);
		expect(coreGraphicsMock.warpCursorPosition).not.toHaveBeenCalled();
		controller.close();
	});

	it("rejects an unobserved drag destination before pressing the button", async () => {
		const controller = backgroundController();

		await expect(
			runInInputScope(boundTo(42, 12), () => controller.drag({ from: { x: 150, y: 150 }, to: { x: 650, y: 50 } })),
		).rejects.toThrow("outside the observed window");

		expect(coreGraphicsMock.postMouseEvent).not.toHaveBeenCalled();
		controller.close();
	});

	it("rejects an out-of-window waypoint even when both endpoints are observed", async () => {
		const controller = backgroundController();

		await expect(
			runInInputScope(boundTo(42, 12), () =>
				controller.drag({
					from: { x: 150, y: 150 },
					waypoints: [{ x: 650, y: 50 }],
					to: { x: 350, y: 250 },
				}),
			),
		).rejects.toThrow("drag waypoint is outside the target window");

		expect(coreGraphicsMock.postMouseEvent).not.toHaveBeenCalled();
		controller.close();
	});

	it("delivers the exact wheel amount at the scroll cursor rather than rounding each step independently", async () => {
		vi.useFakeTimers();
		const set = vi.fn();
		const setMode = vi.fn();
		const highlight = vi.fn();
		const track = vi.fn();
		const controller = new MacOSInputController(
			undefined,
			{ ...NOOP_POINTER_OVERLAY, set, setMode, highlight, track },
			() => false,
			NO_SLEEP,
			"background",
		);
		const scrolling = runInInputScope(boundTo(42, 12), () =>
			controller.scroll({ direction: "down", amount: 10, position: { x: 200, y: 200 } }),
		);
		await vi.runAllTimersAsync();
		await scrolling;

		expect(coreGraphicsMock.postScrollEvent.mock.calls.reduce((sum, [event]) => sum + event.deltaY, 0)).toBe(-10);
		expect(
			coreGraphicsMock.postScrollEvent.mock.calls.every(
				([event]) => event.position.x === 200 && event.position.y === 200,
			),
		).toBe(true);
		// Background cues are on by default: the drawn marker shows the scroll cue at the scroll position.
		expect(setMode).toHaveBeenCalledWith("scroll", 42);
		expect(set).toHaveBeenCalledWith({ x: 200, y: 200 }, 42);
		expect(track).not.toHaveBeenCalled();
		expect(highlight).not.toHaveBeenCalled();
		expect(await runInInputScope(boundTo(42, 12), async () => controller.getCursorPosition())).toEqual({
			x: 200,
			y: 200,
		});
		controller.close();
	});

	it("#when background actions request cursor modes with background cues disabled #then all injected feedback stays silent", () => {
		withBackgroundCuesDisabled(() => {
			const set = vi.fn();
			const track = vi.fn();
			const setMode = vi.fn();
			const highlight = vi.fn();
			const controller = new MacOSInputController(
				undefined,
				{ ...NOOP_POINTER_OVERLAY, set, track, setMode, highlight },
				() => false,
				NO_SLEEP,
				"background",
			);

			controller.showPointer({ x: 175, y: 125 }, true);
			controller.showScrollPointer({ x: 200, y: 200 });
			controller.showThinking();

			expect(set).not.toHaveBeenCalled();
			expect(track).not.toHaveBeenCalled();
			expect(setMode).not.toHaveBeenCalled();
			expect(highlight).not.toHaveBeenCalled();
			expect(controller.getCursorPosition()).toEqual({ x: 200, y: 200 });
			controller.close();
		});
	});

	it("#when background actions request cursor modes with cues enabled by default #then pointer and scroll show on the drawn marker while thinking stays silent", () => {
		const set = vi.fn();
		const track = vi.fn();
		const setMode = vi.fn();
		const highlight = vi.fn();
		const controller = new MacOSInputController(
			undefined,
			{ ...NOOP_POINTER_OVERLAY, set, track, setMode, highlight },
			() => false,
			NO_SLEEP,
			"background",
		);

		controller.showPointer({ x: 175, y: 125 }, true);
		controller.showScrollPointer({ x: 200, y: 200 });
		controller.showThinking();

		expect(set).toHaveBeenNthCalledWith(1, { x: 175, y: 125 }, undefined);
		expect(set).toHaveBeenNthCalledWith(2, { x: 200, y: 200 }, undefined);
		expect(setMode.mock.calls).toEqual([
			["pointer", undefined],
			["click", undefined],
			["scroll", undefined],
		]);
		expect(controller.getCursorPosition()).toEqual({ x: 200, y: 200 });
		controller.close();
	});

	it("#when attended actions request cursor feedback #then the injected overlay remains visible", async () => {
		const set = vi.fn();
		const setMode = vi.fn();
		const controller = new MacOSInputController(
			undefined,
			{ ...NOOP_POINTER_OVERLAY, set, setMode },
			() => false,
			NO_SLEEP,
			"attended",
		);

		controller.showPointer({ x: 175, y: 125 }, true);

		expect(set).toHaveBeenCalledWith({ x: 175, y: 125 }, undefined);
		expect(setMode).toHaveBeenNthCalledWith(1, "pointer", undefined);
		expect(setMode).toHaveBeenNthCalledWith(2, "click", undefined);
		controller.close();
	});

	it("#when two async cursor identities interleave #then logical positions and injected overlay stay distinct", async () => {
		const set = vi.fn();
		const controller = new MacOSInputController(
			undefined,
			{ ...NOOP_POINTER_OVERLAY, set },
			() => false,
			NO_SLEEP,
			"attended",
		);
		const original = controller.getCursorPosition();
		const firstStarted = deferred();
		const resumeFirst = deferred();
		const first = withCursorIdentity("first", async () => {
			controller.showPointer({ x: 101, y: 102 }, false);
			firstStarted.resolve();
			await resumeFirst.promise;
			expect(currentCursorIdentity()).toBe("first");
			return controller.getCursorPosition();
		});
		await firstStarted.promise;

		const second = await withCursorIdentity("second", async () => {
			controller.showPointer({ x: 201, y: 202 }, false);
			await Promise.resolve();
			return controller.getCursorPosition();
		});
		resumeFirst.resolve();

		expect(await first).toEqual({ x: 101, y: 102 });
		expect(second).toEqual({ x: 201, y: 202 });
		expect(controller.getCursorPosition()).toEqual(original);
		expect(set.mock.calls.map(([point]) => point)).toEqual([
			{ x: 101, y: 102 },
			{ x: 201, y: 202 },
		]);
		controller.close();
	});
});

describe("#given input calls for two apps that overlap #when one waits mid-call #then every event keeps its own app and window", () => {
	it("#when typing for one app is parked on its window focus while another app is typed into and clicked #then no event crosses over", async () => {
		// given
		const controller = backgroundController();
		const firstParked = deferred();
		const releaseFirst = deferred();
		setKeyboardWindowFocuserForTesting(async (pid, windowId) => {
			if (pid === 42) {
				firstParked.resolve();
				await releaseFirst.promise;
			}
			focusedWindows.set(pid, windowId);
		});

		// when
		const first = runInInputScope(boundTo(42, 12), () => controller.typeText("ab"));
		await firstParked.promise;
		await runInInputScope(boundTo(77, 21), async () => {
			await controller.typeText("xy");
			await controller.click({ x: 650, y: 50 });
		});
		releaseFirst.resolve();
		await first;

		// then
		expect(coreGraphicsMock.postUnicodeText.mock.calls).toEqual([
			["x", 77, window21],
			["y", 77, window21],
			["a", 42, window12],
			["b", 42, window12],
		]);
		expect(
			coreGraphicsMock.postMouseEvent.mock.calls.map(([event]) => [event.targetPid, event.targetWindow]),
		).toEqual([
			[77, window21],
			[77, window21],
		]);
		controller.close();
	});
});

describe("#given two background app lanes #when one drag is parked #then the other app progresses independently", () => {
	it("completes the second pid drag before the first pid drag is released", async () => {
		vi.useFakeTimers();
		const controller = backgroundController();
		const first = runInInputScope(boundTo(42, 12), () =>
			controller.drag({ from: { x: 350, y: 150 }, to: { x: 400, y: 200 }, duration: 32 }),
		);
		await vi.advanceTimersByTimeAsync(0);
		const second = runInInputScope(boundTo(77, 21), () =>
			controller.drag({ from: { x: 650, y: 50 }, to: { x: 700, y: 100 }, duration: 0 }),
		);
		await vi.advanceTimersByTimeAsync(0);
		const completedPids = coreGraphicsMock.postMouseEvent.mock.calls
			.filter(([event]) => event.kind === "up")
			.map(([event]) => event.targetPid);
		expect(completedPids).toContain(77);
		expect(completedPids).not.toContain(42);
		await vi.runAllTimersAsync();
		await Promise.all([first, second]);
		controller.close();
	});
});

describe("#given an observed hidden window #when its exact background scope clicks #then it targets that window without raising it", () => {
	it("resolves the pid and window from the full observed inventory", async () => {
		const controller = backgroundController();
		const hiddenWindow = { id: 55, bounds: { x: 800, y: 400, width: 300, height: 200 } };
		setOpenWindowsSourceForTesting(
			() => [FRONT, OTHER_APP],
			() => [FRONT, OTHER_APP, { ...hiddenWindow, owner: { processId: 42 } }],
		);
		vi.spyOn(accessibility, "windowMinimizedForPid").mockReturnValue(false);
		setOnscreenWindowIdsSourceForTesting(() => [11, 21]);

		await runInInputScope(boundTo(42, hiddenWindow.id), () => controller.click({ x: 850, y: 450 }));

		expect(
			coreGraphicsMock.postMouseEvent.mock.calls.map(([event]) => [event.targetPid, event.targetWindow]),
		).toEqual([
			[42, hiddenWindow],
			[42, hiddenWindow],
		]);
		expect(coreGraphicsMock.warpCursorPosition).not.toHaveBeenCalled();
		expect(focusMock.beginFocusWithoutRaise).not.toHaveBeenCalled();
		expect(focusMock.setProcessAppActive).not.toHaveBeenCalled();
		controller.close();
	});
});

describe("#given two gestures for one background app #when the first drag is parked #then the next click waits", () => {
	it("posts the queued click only after releasing the drag", async () => {
		vi.useFakeTimers();
		const controller = backgroundController();
		const drag = runInInputScope(boundTo(42, 12), () =>
			controller.drag({ from: { x: 350, y: 150 }, to: { x: 400, y: 200 }, duration: 32 }),
		);
		await vi.advanceTimersByTimeAsync(0);
		const click = runInInputScope(boundTo(42, 12), () => controller.click({ x: 400, y: 200 }));
		await vi.advanceTimersByTimeAsync(0);

		const beforeRelease = coreGraphicsMock.postMouseEvent.mock.calls.map(([event]) => event);
		expect(beforeRelease.some((event) => event.kind === "down" && event.position.x === 400)).toBe(false);

		await vi.runAllTimersAsync();
		await Promise.all([drag, click]);
		const samePidEvents = coreGraphicsMock.postMouseEvent.mock.calls
			.map(([event]) => event)
			.filter((event) => event.targetPid === 42);
		expect(samePidEvents.map((event) => event.kind)).toEqual(["down", "drag", "drag", "up", "down", "up"]);
		controller.close();
	});
});

describe("#given an opencua-owned surface #when two cursors act on it #then neither waits for the other's gesture", () => {
	it("posts the second cursor's click while the first cursor's drag is still held", async () => {
		vi.useFakeTimers();
		vi.spyOn(ownedSurfaces, "isOwnedSurfacePid").mockImplementation((pid) => pid === 42);
		const controller = backgroundController();
		const drag = withCursorIdentity("painter-1", () =>
			runInInputScope(boundTo(42, 12), () =>
				controller.drag({ from: { x: 350, y: 150 }, to: { x: 400, y: 200 }, duration: 32 }),
			),
		);
		await vi.advanceTimersByTimeAsync(0);
		const click = withCursorIdentity("painter-2", () =>
			runInInputScope(boundTo(42, 12), () => controller.click({ x: 380, y: 180 })),
		);
		await vi.advanceTimersByTimeAsync(0);

		const beforeRelease = coreGraphicsMock.postMouseEvent.mock.calls.map(([event]) => event);
		expect(beforeRelease.some((event) => event.kind === "down" && event.position.x === 380)).toBe(true);
		expect(beforeRelease.some((event) => event.kind === "up" && event.position.x === 400)).toBe(false);

		await vi.runAllTimersAsync();
		await Promise.all([drag, click]);
		controller.close();
	});
});

describe("#given background delivery #when input has no target app #then nothing is posted at all", () => {
	it("#when every kind of input is tried without a target #then each is refused before any event goes out", async () => {
		// given
		const controller = backgroundController();
		const nowhere = { x: 5, y: 5 };

		// when / then
		await expect(controller.typeText("x")).rejects.toThrow("background delivery cannot type without a target app");
		await expect(controller.pressKey("a")).rejects.toThrow(
			"background delivery cannot press keys without a target app",
		);
		await expect(controller.click(nowhere)).rejects.toThrow("background delivery cannot click without a target app");
		await expect(controller.doubleClick(nowhere)).rejects.toThrow("cannot double click without a target app");
		await expect(controller.drag({ from: nowhere, to: { x: 9, y: 9 } })).rejects.toThrow("cannot drag");
		await expect(controller.scroll({ direction: "down", amount: 3 })).rejects.toThrow("cannot scroll");
		await expect(controller.move(nowhere)).rejects.toThrow("cannot move the pointer");
		// A scope that only carries a stop check names no app either.
		await expect(runInInputScope({ interruption: () => undefined }, () => controller.typeText("x"))).rejects.toThrow(
			"without a target app",
		);

		expect(coreGraphicsMock.postKeyboardEvent).not.toHaveBeenCalled();
		expect(coreGraphicsMock.postUnicodeText).not.toHaveBeenCalled();
		expect(coreGraphicsMock.postMouseEvent).not.toHaveBeenCalled();
		expect(coreGraphicsMock.postScrollEvent).not.toHaveBeenCalled();
		controller.close();
	});
});

describe("#given a stop arrives while input is going out #when the call is mid-way #then nothing more goes out but held input is released", () => {
	it("#when the stop comes after the third character #then the rest of the text is never typed", async () => {
		// given
		const controller = backgroundController();
		let stopped = false;
		coreGraphicsMock.postUnicodeText.mockImplementation(() => {
			stopped = coreGraphicsMock.postUnicodeText.mock.calls.length >= 3;
		});

		// when
		const typing = runInInputScope(
			boundTo(42, 12, () => (stopped ? "the user stopped computer use" : undefined)),
			() => controller.typeText("abcdefgh"),
		);

		// then
		await expect(typing).rejects.toThrow(new InputInterrupted("the user stopped computer use"));
		expect(coreGraphicsMock.postUnicodeText.mock.calls.map(([text]) => text)).toEqual(["a", "b", "c"]);
		controller.close();
	});

	it("#when the stop comes during a long key hold #then the key is released early and the next key never goes down", async () => {
		// given
		vi.useFakeTimers();
		const controller = backgroundController();
		let stopped = false;
		coreGraphicsMock.postKeyboardEvent.mockImplementation((event: { readonly keyDown: boolean }) => {
			stopped = stopped || event.keyDown;
		});
		const scope = boundTo(42, 12, () => (stopped ? "stopped" : undefined));

		// when
		const holding = runInInputScope(scope, () => controller.pressKey("a", { holdMilliseconds: 10_000 })).then(
			() => "completed",
			(error: unknown) => error,
		);
		await vi.advanceTimersByTimeAsync(50);
		const held = await holding;
		const next = await runInInputScope(scope, () => controller.pressKey("b")).then(
			() => "completed",
			(error: unknown) => error,
		);

		// then
		expect(held).toEqual(new InputInterrupted("stopped"));
		expect(next).toEqual(new InputInterrupted("stopped"));
		expect(coreGraphicsMock.postKeyboardEvent.mock.calls.map(([event]) => [event.keyCode, event.keyDown])).toEqual([
			[0, true],
			[0, false],
		]);
		expect(vi.getTimerCount()).toBe(0);
		controller.close();
	});

	it("#when the stop comes between drag steps #then the button is released where the pointer is and no move follows", async () => {
		// given
		const controller = backgroundController();
		let stopped = false;
		coreGraphicsMock.postMouseEvent.mockImplementation(() => {
			const moves = coreGraphicsMock.postMouseEvent.mock.calls.filter(([posted]) => posted.kind === "drag").length;
			stopped = stopped || moves >= 2;
		});

		// when
		const dragging = runInInputScope(
			boundTo(42, 12, () => (stopped ? "stopped" : undefined)),
			() => controller.drag({ from: { x: 150, y: 150 }, to: { x: 450, y: 350 }, duration: 160 }),
		);

		// then
		await expect(dragging).rejects.toThrow(new InputInterrupted("stopped"));
		const posted = coreGraphicsMock.postMouseEvent.mock.calls.map(([event]) => event);
		expect(posted.map((event) => event.kind)).toEqual(["down", "drag", "drag", "up"]);
		expect(posted[3]?.position).toEqual(posted[2]?.position);
		const lastPosition = await runInInputScope(boundTo(42, 12), async () => controller.getCursorPosition());
		expect(lastPosition).toEqual(posted[2]?.position);
		controller.close();
	});

	it("#when background drag samples post with cues enabled by default #then the logical pointer follows and the drawn marker shows the drag cue", async () => {
		const overlay = { set: vi.fn(), highlight: vi.fn(), setMode: vi.fn(), hide: vi.fn(), close: vi.fn() };
		const controller = new MacOSInputController(undefined, overlay, () => false, NO_SLEEP, "background");
		const positions: Array<{ readonly x: number; readonly y: number }> = [];
		coreGraphicsMock.postMouseEvent.mockImplementation(({ kind, position, targetPid, flags }) => {
			if (kind === "drag") {
				positions.push(position);
				expect(targetPid).toBe(42);
				expect(flags).toBe(0x00020000);
			}
		});

		await runInInputScope(boundTo(42, 12), () =>
			controller.drag({
				from: { x: 150, y: 150 },
				waypoints: [{ x: 250, y: 250 }],
				to: { x: 450, y: 350 },
				duration: 0,
				button: "right",
				modifiers: ["shift"],
			}),
		);

		expect(positions.length).toBeGreaterThan(1);
		expect(overlay.set).toHaveBeenCalled();
		expect(overlay.setMode).toHaveBeenCalledWith("drag", 42);
		expect(await runInInputScope(boundTo(42, 12), async () => controller.getCursorPosition())).toEqual(
			defined(positions.at(-1)),
		);
		const dragEvents = coreGraphicsMock.postMouseEvent.mock.calls
			.map(([event]) => event)
			.filter((event) => event.kind === "drag");
		expect(dragEvents.every((event) => event.button === "right")).toBe(true);
		expect(dragEvents.every((event) => event.flags === 0x00020000)).toBe(true);
		controller.close();
	});
});

describe("#given two overlapping windows of one app #when input is bound to the window behind #then it never reaches the window in front", () => {
	const covered = { x: 150, y: 150 };

	it("#when an unbound click lands where the windows overlap #then it goes to the app's front window there, as before", async () => {
		const controller = backgroundController();

		await runInInputScope({ target: { pid: 42 } }, () => controller.click(covered));

		expect(coreGraphicsMock.postMouseEvent.mock.calls.map(([event]) => event.targetWindow.id)).toEqual([11, 11]);
		controller.close();
	});

	it("#when a bound click lands where the front window covers the bound one #then the event is addressed to the bound window", async () => {
		const controller = backgroundController();
		setPointWindowIdsForTesting(() => [11]);

		await runInInputScope(boundTo(42, 12), () => controller.click(covered));

		expect(
			coreGraphicsMock.postMouseEvent.mock.calls.map(([event]) => [event.targetPid, event.targetWindow]),
		).toEqual([
			[42, window12],
			[42, window12],
		]);
		controller.close();
	});

	it("#when the covering window is a sheet of the bound window #then the sheet takes the click", async () => {
		const controller = backgroundController();
		setPointWindowIdsForTesting(() => [11, 12]);

		await runInInputScope(boundTo(42, 12), () => controller.click(covered));

		expect(coreGraphicsMock.postMouseEvent.mock.calls.map(([event]) => event.targetWindow.id)).toEqual([11, 11]);
		controller.close();
	});

	it("#when the point is outside the bound window, or the bound window is gone #then the click is refused unsent", async () => {
		const controller = backgroundController();

		await expect(runInInputScope(boundTo(42, 12), () => controller.click({ x: 50, y: 50 }))).rejects.toThrow(
			"is outside the observed window 12",
		);
		await expect(runInInputScope(boundTo(42, 13), () => controller.click(covered))).rejects.toThrow(
			"the observed window 13 is unavailable on this Space",
		);
		await expect(runInInputScope(boundTo(42, 13), () => controller.typeText("x"))).rejects.toThrow(
			"the observed window 13 is unavailable on this Space",
		);

		expect(coreGraphicsMock.postMouseEvent).not.toHaveBeenCalled();
		expect(coreGraphicsMock.postUnicodeText).not.toHaveBeenCalled();
		controller.close();
	});

	it("#when keys are bound to the window behind #then that window is focused in its app and takes the keys", async () => {
		const controller = backgroundController();
		const focused: Array<readonly [number, number]> = [];
		setKeyboardWindowFocuserForTesting(async (pid, windowId) => {
			focused.push([pid, windowId]);
			focusedWindows.set(pid, windowId);
		});
		// The app last took pointer input in its front window; the bound keys must not follow it there.
		await runInInputScope({ target: { pid: 42 } }, () => controller.click({ x: 50, y: 50 }));

		await runInInputScope(boundTo(42, 12), () => controller.typeText("k"));

		expect(focused).toEqual([[42, 12]]);
		expect(coreGraphicsMock.postUnicodeText.mock.calls).toEqual([["k", 42, window12]]);
		controller.close();
	});
});
