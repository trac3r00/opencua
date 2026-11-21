import { afterEach, describe, expect, it } from "bun:test";
import { vi } from "@opencua/test-support";

const state = vi.hoisted(() => ({ front: Buffer.alloc(8, 2) }));
vi.mock("./macos-ffi/coregraphics.js", () => ({
	getCurrentCursorPosition: () => ({ x: 4, y: 5 }),
	warpCursorPosition: vi.fn(),
}));
vi.mock("./macos-ffi/skylight.js", () => ({
	beginFocusWithoutRaise: () => ({ previousPsn: Buffer.alloc(8, 1), targetPsn: state.front }),
	frontProcessSerialNumber: () => state.front,
	processSerialNumbersMatch: (left: Buffer, right: Buffer) => left.equals(right),
	restoreFrontProcessNoWindows: vi.fn(),
}));

const timingKeys = [
	"OPENCUA_GESTURE_FOCUS_SETTLE_MS",
	"OPENCUA_GESTURE_HOVER_MS",
	"OPENCUA_GESTURE_PRIMER_TO_CLICK_MS",
	"OPENCUA_GESTURE_CLICK_DRAIN_MS",
] as const;

// The suite runner may set these for every file in a worker; each case leaves them as it found them.
const initialTiming = timingKeys.map((key) => [key, process.env[key]] as const);

afterEach(() => {
	for (const [key, value] of initialTiming) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("#given unset gesture timing variables #when reading timing getters #then lowered defaults are returned", () => {
	it("returns each documented default", async () => {
		// The suite runner lowers these for speed; this case reads the defaults behind them.
		for (const key of timingKeys) delete process.env[key];
		const timing = await import("./macos-targeted-gesture.js");
		expect([
			timing.gestureFocusSettleMilliseconds(),
			timing.gestureHoverMilliseconds(),
			timing.gesturePrimerToClickMilliseconds(),
			timing.gestureClickDrainMilliseconds(),
		]).toEqual([25, 15, 40, 25]);
	});
});

describe("#given gesture timing environment values #when parsing them #then invalid values default and zero is retained", () => {
	it.each([
		["0", 0],
		["abc", 25],
		["-3", 25],
		["  ", 25],
		["40", 40],
	])("parses %j as %i", async (value, expected) => {
		process.env["OPENCUA_GESTURE_FOCUS_SETTLE_MS"] = value;
		const { gestureFocusSettleMilliseconds } = await import("./macos-targeted-gesture.js");
		expect(gestureFocusSettleMilliseconds()).toBe(expected);
	});
});

describe("#given target focus observations #when deciding engagement #then only a front and key target avoids it", () => {
	it.each([
		[false, false, true],
		[false, true, true],
		[true, false, true],
		[true, true, false],
	])("maps front=%s focused=%s to %s", async (front, focused, expected) => {
		const { needsActivationEngagement } = await import("./macos-targeted-gesture.js");
		expect(
			needsActivationEngagement({
				frontProcessMatchesTarget: front,
				focusedWindowMatchesTarget: focused,
			}),
		).toBe(expected);
	});
});

describe("#given a focus-leased gesture #when sleeping is injected #then only nonzero waits are recorded in order", () => {
	it("skips zero waits and keeps the fixed primer gap", async () => {
		process.env["OPENCUA_GESTURE_FOCUS_SETTLE_MS"] = "0";
		process.env["OPENCUA_GESTURE_HOVER_MS"] = "0";
		process.env["OPENCUA_GESTURE_PRIMER_TO_CLICK_MS"] = "40";
		process.env["OPENCUA_GESTURE_CLICK_DRAIN_MS"] = "0";
		const { runFocusLeasedGesture } = await import("./macos-targeted-gesture.js");
		const waits: number[] = [];
		const post = vi.fn(async (_kind: string) => undefined);
		await runFocusLeasedGesture(
			{ id: 1, bounds: { x: 0, y: 0, width: 10, height: 10 } },
			{ x: 2, y: 3 },
			post,
			async () => undefined,
			{
				sleep: async (milliseconds) => {
					waits.push(milliseconds);
				},
			},
		);
		expect(waits).toEqual([1, 40]);
		expect(post.mock.calls.map(([kind]) => kind)).toEqual(["move", "down", "up"]);
	});
});
