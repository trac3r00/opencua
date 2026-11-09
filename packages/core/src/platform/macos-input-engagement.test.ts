import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { vi } from "@opencua/test-support";
import type { Point } from "../types/index.js";

const window = { id: 99, bounds: { x: 0, y: 0, width: 500, height: 500 } };
const native = vi.hoisted(() => {
	const targetPsn = Buffer.alloc(8, 2);
	return {
		targetPsn,
		front: targetPsn,
		focused: 99,
		cursor: { x: 0, y: 0 },
		post: vi.fn<(event: { readonly kind: string; readonly position: Point }) => void>(),
		wheel: vi.fn<(event: { readonly deltaY: number }) => void>(),
		warp: vi.fn(),
	};
});

vi.mock("node:timers/promises", () => ({ setTimeout: () => Promise.resolve() }));
vi.mock("./macos-ffi/accessibility.js", () => ({
	focusedWindowIdForPid: () => native.focused,
}));
vi.mock("./macos-ffi/skylight.js", () => ({
	beginFocusWithoutRaise: () => ({ previousPsn: Buffer.alloc(8, 1), targetPsn: native.targetPsn }),
	frontProcessSerialNumber: () => native.front,
	processSerialNumbersMatch: (left: Buffer, right: Buffer) => left.equals(right),
	restoreFrontProcessNoWindows: () => true,
	focusGuardFor: () => null,
}));
vi.mock("./macos-ffi/coregraphics.js", () => ({
	getCurrentCursorPosition: () => native.cursor,
	warpCursorPosition: native.warp,
	postMouseEvent: native.post,
	postScrollEvent: native.wheel,
	K_CG_EVENT_FLAG_MASK_ALTERNATE: 0x00080000,
	K_CG_EVENT_FLAG_MASK_COMMAND: 0x00100000,
	K_CG_EVENT_FLAG_MASK_CONTROL: 0x00040000,
	K_CG_EVENT_FLAG_MASK_SHIFT: 0x00020000,
}));

const { MacOSInputController, setOnscreenWindowIdsSourceForTesting } = await import("./macos-input.js");
const { setOpenWindowsSourceForTesting } = await import("./macos-open-windows.js");
const { needsActivationEngagement, runFocusLeasedGesture } = await import("./macos-targeted-gesture.js");

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
	native.front = native.targetPsn;
	native.focused = 99;
	native.cursor = { x: 0, y: 0 };
	native.post.mockImplementation((event) => {
		if (event.kind === "move") native.cursor = event.position;
	});
	setOpenWindowsSourceForTesting(() => [{ ...window, owner: { processId: 1234 } }]);
	setOnscreenWindowIdsSourceForTesting(() => [99]);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

describe("#given focus engagement state", () => {
	it.each([
		[false, false, true],
		[false, true, true],
		[true, false, true],
		[true, true, false],
	])("#when front matches %s and window matches %s #then engagement is %s", (front, focused, expected) => {
		expect(needsActivationEngagement({ frontProcessMatchesTarget: front, focusedWindowMatchesTarget: focused })).toBe(
			expected,
		);
	});

	it.each([
		[true, 99, 1234, false],
		[false, 99, 1234, true],
		[true, 98, 1234, true],
		[false, 98, 1234, true],
		[true, 99, undefined, true],
	])(
		"#when front is %s window is %s and pid is %s #then primer engagement is %s",
		async (front, focused, targetPid, engage) => {
			native.front = front ? native.targetPsn : Buffer.alloc(8, 1);
			native.focused = focused;
			const post = vi.fn(async () => undefined);
			const body = vi.fn(async () => undefined);
			const wait = vi.fn(async (_milliseconds: number) => undefined);
			vi.stubEnv("OPENCUA_GESTURE_FOCUS_SETTLE_MS", "31");
			vi.stubEnv("OPENCUA_GESTURE_HOVER_MS", "17");
			vi.stubEnv("OPENCUA_GESTURE_PRIMER_TO_CLICK_MS", "43");
			vi.stubEnv("OPENCUA_GESTURE_CLICK_DRAIN_MS", "29");
			await runFocusLeasedGesture(window, { x: 100, y: 100 }, post, body, {
				sleep: wait,
				...(targetPid === undefined ? {} : { targetPid }),
			});
			expect(post.mock.calls.length).toBe(engage ? 3 : 1);
			expect(wait.mock.calls.map(([milliseconds]) => milliseconds)).toEqual(engage ? [31, 17, 1, 43, 29] : [17, 29]);
			expect(body).toHaveBeenCalledOnce();
		},
	);
});

describe("#given attended click travel", () => {
	it.each(["click", "doubleClick"] as const)(
		"#when motion-enabled %s travels over eight points #then eased moves precede the click without cursor restoration",
		async (action) => {
			const controller = new MacOSInputController(1234, undefined, () => false, undefined, "attended", false, true);
			try {
				const completion = controller[action]({ x: 100, y: 100 });
				await vi.runAllTimersAsync();
				await completion;
				const events = native.post.mock.calls.map(([event]) => event);
				const moves = events.filter((event) => event.kind === "move");
				expect(moves.length).toBeGreaterThan(2);
				expect(moves.at(-1)?.position).toEqual({ x: 100, y: 100 });
				expect(events.findIndex((event) => event.kind === "down")).toBe(moves.length);
				expect(native.warp).not.toHaveBeenCalled();
			} finally {
				controller.close();
			}
		},
	);

	it.each([
		["attended", false, 100, 1],
		["attended", true, 8, 1],
		["background", true, 100, 0],
	] as const)(
		"#when delivery %s motion %s travels %s points #then posts only %s hover moves",
		async (delivery, enabled, x, moves) => {
			const controller = new MacOSInputController(1234, undefined, () => false, undefined, delivery, false, enabled);
			try {
				const completion = controller.click({ x, y: 0 });
				await vi.runAllTimersAsync();
				await completion;
				expect(native.post.mock.calls.filter(([event]) => event.kind === "move")).toHaveLength(moves);
			} finally {
				controller.close();
			}
		},
	);

	it("#when scrolling while posting takes time #then one clock absorbs posting latency and retains exact units", async () => {
		vi.spyOn(performance, "now").mockImplementation(() => Date.now());
		native.wheel.mockImplementation(() => vi.advanceTimersByTime(7));
		const controller = new MacOSInputController(1234, undefined, () => false, undefined, "attended", false);
		try {
			const started = Date.now();
			const completion = controller.scroll({ direction: "down", amount: 20 });
			await vi.runAllTimersAsync();
			await completion;
			// One clock: scheduled spacing (14 ms per event index) absorbs the fake posting latency
			// (7 ms per wheel post) instead of accumulating; the schedule is derived from the plan.
			const events = native.wheel.mock.calls.length;
			expect(Date.now() - started).toBe((events - 1) * 14 + 7);
			expect(native.wheel.mock.calls.map(([event]) => event.deltaY).reduce((sum, delta) => sum + delta, 0)).toBe(
				-20,
			);
		} finally {
			controller.close();
			vi.restoreAllMocks();
		}
	});
});
