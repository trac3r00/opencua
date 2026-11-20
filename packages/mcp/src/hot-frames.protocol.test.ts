import { afterEach, describe, expect, it } from "bun:test";
import type { HotFrameWorker } from "@opencua/core";
import { HotFrameSource } from "@opencua/core";
import { vi } from "@opencua/test-support";
import { createHarness, jsonPayload } from "./protocol-client-harness.js";
import { FakeGuardedComputer } from "./protocol-test-harness.js";

let closeHarness: (() => Promise<void>) | undefined;

afterEach(async () => {
	await closeHarness?.();
	closeHarness = undefined;
	vi.useRealTimers();
});

interface TestWorker extends HotFrameWorker {
	deliver(message: unknown): void;
}

function fakeWorker(): TestWorker {
	const listeners = new Map<string, (payload?: unknown) => void>();
	let terminated = false;
	return {
		on: (event, callback) => {
			listeners.set(event, callback as (payload?: unknown) => void);
		},
		postMessage: () => undefined,
		terminate: async () => {
			terminated = true;
			return undefined;
		},
		deliver: (message) => {
			if (!terminated) {
				listeners.get("message")?.(message);
			}
		},
	};
}

describe("#given an engaged hot frame source #when a vision call needs pixels #then it answers from the warm frame without a capture read", () => {
	it("serves the latest frame and labels its age", async () => {
		const worker = fakeWorker();
		// The warm-frame path, not the 300 ms default window: the stale fallback has its own test below.
		const hotFrames = new HotFrameSource({ spawnWorker: () => worker, maxAgeMs: 60_000 });
		hotFrames.start(1234, 71, { width: 1000, height: 800 });
		const jpeg = Buffer.from("warm-jpeg-bytes");
		worker.deliver({ type: "frame", bytes: new Uint8Array(jpeg), width: 1000, height: 800, hash: "warm-frame" });

		const computer = new FakeGuardedComputer();
		computer.delivery = "background";
		const harness = await createHarness(computer, undefined, undefined, {
			serverOptions: { hotFramesSource: hotFrames },
		});
		closeHarness = harness.close;
		const state = jsonPayload(
			await harness.client.callTool({ name: "get_app_state", arguments: { app: "Finder", window_id: 71 } }),
		);
		const token = state["observation_token"];
		if (typeof token !== "string") {
			throw new Error("observation did not return a token");
		}
		const readsBefore = computer.stateOptions.length;

		const result = await harness.client.callTool({
			name: "run_hands",
			arguments: {
				app: "Finder",
				observation_token: token,
				vision: { include_screenshot: true },
				outcome: "live",
			},
		});
		const payload = jsonPayload(result);
		const hands =
			payload["hands"] !== undefined && typeof payload["hands"] === "object" && payload["hands"] !== null
				? Object.fromEntries(Object.entries(payload["hands"]))
				: {};
		const vision = hands["vision"];

		expect(vision).toEqual(
			expect.objectContaining({
				captured: true,
				source: "hot",
				width: 1000,
				height: 800,
				bytes: jpeg.byteLength,
				frame_age_ms: expect.any(Number),
			}),
		);
		expect(result.content).toContainEqual({
			type: "image",
			data: jpeg.toString("base64"),
			mimeType: "image/jpeg",
		});
		expect(computer.stateOptions.length).toBe(readsBefore + 1);
		hotFrames.dispose();
	});

	it("falls back to the live capture when no warm frame exists", async () => {
		const hotFrames = new HotFrameSource({ spawnWorker: () => fakeWorker() });
		const computer = new FakeGuardedComputer();
		computer.delivery = "background";
		const harness = await createHarness(computer, undefined, undefined, {
			serverOptions: { hotFramesSource: hotFrames },
		});
		closeHarness = harness.close;
		const state = jsonPayload(
			await harness.client.callTool({ name: "get_app_state", arguments: { app: "Finder", window_id: 71 } }),
		);
		const token = state["observation_token"];
		if (typeof token !== "string") {
			throw new Error("observation did not return a token");
		}
		const readsBefore = computer.stateOptions.length;

		const result = await harness.client.callTool({
			name: "run_hands",
			arguments: {
				app: "Finder",
				observation_token: token,
				vision: { include_screenshot: true },
				outcome: "live",
			},
		});
		const payload = jsonPayload(result);
		const hands =
			payload["hands"] !== undefined && typeof payload["hands"] === "object" && payload["hands"] !== null
				? Object.fromEntries(Object.entries(payload["hands"]))
				: {};

		expect(hands["vision"]).toEqual(expect.objectContaining({ captured: true, source: "live" }));
		expect(computer.stateOptions.length).toBe(readsBefore + 2);
		hotFrames.dispose();
	});
});

describe("#given an observation with no bound window #when run_hands needs pixels #then the vision lane takes the refresher's frame for the observed window", () => {
	it("does not race the refresher with its own capture", async () => {
		const worker = fakeWorker();
		const hotFrames = new HotFrameSource({ spawnWorker: () => worker, maxAgeMs: 60_000 });
		hotFrames.start(1234, 71, { width: 1000, height: 800 });
		const jpeg = Buffer.from("refresher-jpeg");
		worker.deliver({ type: "frame", bytes: new Uint8Array(jpeg), width: 1000, height: 800, hash: "refresher" });
		const computer = new FakeGuardedComputer();
		computer.delivery = "background";
		const harness = await createHarness(computer, undefined, undefined, {
			serverOptions: { hotFramesSource: hotFrames },
		});
		closeHarness = harness.close;
		// No window_id: the session binds no window, but the observation still names window 71.
		const state = jsonPayload(await harness.client.callTool({ name: "get_app_state", arguments: { app: "Finder" } }));
		const token = state["observation_token"];
		if (typeof token !== "string") {
			throw new Error("observation did not return a token");
		}
		const readsBefore = computer.stateOptions.length;

		const payload = jsonPayload(
			await harness.client.callTool({
				name: "run_hands",
				arguments: { app: "Finder", observation_token: token, vision: { include_screenshot: true } },
			}),
		);
		const hands =
			payload["hands"] !== undefined && typeof payload["hands"] === "object" && payload["hands"] !== null
				? Object.fromEntries(Object.entries(payload["hands"]))
				: {};

		expect(hands["vision"]).toEqual(expect.objectContaining({ captured: true, source: "hot" }));
		expect(computer.stateOptions.length).toBe(readsBefore);
		hotFrames.dispose();
	});
});

describe("#given the frame source #when frames age or targets move #then it refuses stale pixels", () => {
	it("stops answering once the frame is older than the age budget", () => {
		vi.useFakeTimers();
		const worker = fakeWorker();
		const hotFrames = new HotFrameSource({ spawnWorker: () => worker, maxAgeMs: 100, idleStopMs: 60_000 });
		hotFrames.start(1234, 71, { width: 1000, height: 800 });
		worker.deliver({
			type: "frame",
			bytes: new Uint8Array(Buffer.from("frame")),
			width: 1000,
			height: 800,
			hash: "frame",
		});
		expect(hotFrames.latestFor(1234, 71)).toBeDefined();
		vi.advanceTimersByTime(101);
		expect(hotFrames.latestFor(1234, 71)).toBeUndefined();
		hotFrames.dispose();
	});

	it("stops the refresher after the idle window", () => {
		vi.useFakeTimers();
		const worker = fakeWorker();
		const hotFrames = new HotFrameSource({ spawnWorker: () => worker, idleStopMs: 1_000 });
		hotFrames.start(1234, 71, { width: 1000, height: 800 });
		worker.deliver({
			type: "frame",
			bytes: new Uint8Array(Buffer.from("frame")),
			width: 1000,
			height: 800,
			hash: "frame",
		});
		vi.advanceTimersByTime(1_001);
		expect(hotFrames.latestFor(1234, 71)).toBeUndefined();
		hotFrames.dispose();
	});

	it("retargets without serving the old window's frame", () => {
		const worker = fakeWorker();
		const hotFrames = new HotFrameSource({ spawnWorker: () => worker, idleStopMs: 60_000 });
		hotFrames.start(1234, 71, { width: 1000, height: 800 });
		worker.deliver({
			type: "frame",
			bytes: new Uint8Array(Buffer.from("frame")),
			width: 1000,
			height: 800,
			hash: "frame",
		});
		hotFrames.start(1234, 72, { width: 1000, height: 800 });
		expect(hotFrames.latestFor(1234, 72)).toBeUndefined();
		hotFrames.dispose();
	});
});
