import { afterEach, describe, expect, it } from "bun:test";
import { createHarness, jsonPayload, observe } from "./protocol-client-harness.js";
import { Deferred, type Effect, FakeGuardedComputer } from "./protocol-test-harness.js";

let closeHarness: (() => Promise<void>) | undefined;

afterEach(async () => {
	await closeHarness?.();
	closeHarness = undefined;
});

function inputEffects(computer: FakeGuardedComputer): readonly Effect[] {
	return computer.effects.filter((effect) => effect.kind !== "close");
}

function record(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("expected an object payload");
	}
	return Object.fromEntries(Object.entries(value));
}

describe("run_hands #given background delivery #when keyboard and pointer lanes are gated #then both start before either finishes", () => {
	it("overlaps the lanes and reports the measured overlap", async () => {
		const computer = new FakeGuardedComputer();
		computer.delivery = "background";
		const harness = await createHarness(computer);
		closeHarness = harness.close;
		const token = await observe(harness);

		const starts: string[] = [];
		const typeStarted = new Deferred<void>();
		const clickStarted = new Deferred<void>();
		const release = new Deferred<void>();
		computer.inputGate = async (effect) => {
			if (effect.kind === "type") {
				starts.push("type");
				typeStarted.resolve(undefined);
				await release.promise;
			}
			if (effect.kind === "click") {
				starts.push("click");
				clickStarted.resolve(undefined);
				await release.promise;
			}
		};

		const pending = harness.client.callTool({
			name: "run_hands",
			arguments: {
				app: "Finder",
				observation_token: token,
				keyboard: [{ type: "type_text", text: "hello" }],
				pointer: [{ type: "click", x: 10, y: 20 }],
			},
		});
		await Promise.all([typeStarted.promise, clickStarted.promise]);
		// overlap_ms reports elapsed time while both lanes run; hold them for a real interval so it cannot round to zero.
		await new Promise((resolve) => setTimeout(resolve, 5));
		release.resolve(undefined);
		const result = await pending;
		const payload = jsonPayload(result);
		const hands = record(payload["hands"]);

		expect(starts).toEqual(expect.arrayContaining(["type", "click"]));
		expect(hands["policy"]).toBe("auto");
		expect(Number(hands["overlap_ms"])).toBeGreaterThan(0);
		expect(hands["lanes"]).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ hand: "right", lane: "keyboard", status: "completed" }),
				expect.objectContaining({ hand: "left", lane: "pointer", status: "completed" }),
			]),
		);
		expect(inputEffects(computer)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "type", text: "hello" }),
				expect.objectContaining({ kind: "click" }),
			]),
		);
		expect(typeof payload["observation_token"]).toBe("string");
	}, 2_000);
});

describe("run_hands #given attended delivery #when the lanes share focus #then the scheduler serializes them", () => {
	it("does not start the pointer lane until the keyboard lane finishes", async () => {
		const computer = new FakeGuardedComputer();
		computer.delivery = "attended";
		const harness = await createHarness(computer);
		closeHarness = harness.close;
		const token = await observe(harness);

		const starts: string[] = [];
		const typeStarted = new Deferred<void>();
		const release = new Deferred<void>();
		computer.inputGate = async (effect) => {
			if (effect.kind === "type") {
				starts.push("type");
				typeStarted.resolve(undefined);
				await release.promise;
			}
			if (effect.kind === "click") {
				starts.push("click");
			}
		};

		const pending = harness.client.callTool({
			name: "run_hands",
			arguments: {
				app: "Finder",
				observation_token: token,
				keyboard: [{ type: "type_text", text: "hello" }],
				pointer: [{ type: "click", x: 10, y: 20 }],
			},
		});
		await typeStarted.promise;
		expect(starts).toEqual(["type"]);
		release.resolve(undefined);
		const payload = jsonPayload(await pending);
		const hands = record(payload["hands"]);

		expect(starts).toEqual(["type", "click"]);
		expect(Number(hands["overlap_ms"])).toBe(0);
	}, 2_000);
});

describe("run_hands #given a vision lane #when the capture is gated #then it runs while the keyboard lane waits", () => {
	it("returns the concurrent capture and lets the input finish", async () => {
		const computer = new FakeGuardedComputer();
		computer.delivery = "background";
		const harness = await createHarness(computer);
		closeHarness = harness.close;
		const token = await observe(harness);

		const visionStarted = new Deferred<void>();
		const releaseVision = new Deferred<void>();
		let visionResolved = false;
		computer.stateGate = releaseVision;
		computer.onStateCall = () => {
			if (!visionResolved) {
				visionResolved = true;
				visionStarted.resolve(undefined);
			}
		};
		computer.inputGate = async (effect) => {
			if (effect.kind === "type") {
				await visionStarted.promise;
			}
		};

		const pending = harness.client.callTool({
			name: "run_hands",
			arguments: {
				app: "Finder",
				observation_token: token,
				keyboard: [{ type: "type_text", text: "hello" }],
				vision: { include_screenshot: true },
			},
		});
		await visionStarted.promise;
		releaseVision.resolve(undefined);
		const result = await pending;
		const payload = jsonPayload(result);
		const hands = record(payload["hands"]);
		const vision = record(hands["vision"]);

		expect(vision["captured"]).toBe(true);
		expect(vision["bytes"]).toBeGreaterThan(0);
		expect(result.content).toContainEqual({
			type: "image",
			data: Buffer.from("png-bytes").toString("base64"),
			mimeType: "image/png",
		});
		expect(inputEffects(computer)).toEqual([expect.objectContaining({ kind: "type", text: "hello" })]);
	}, 2_000);
});

describe("run_hands #given attended delivery #when overlap=always #then the shared focus resource is refused before dispatch", () => {
	it("returns an error and sends no input", async () => {
		const computer = new FakeGuardedComputer();
		computer.delivery = "attended";
		const harness = await createHarness(computer);
		closeHarness = harness.close;
		const token = await observe(harness);

		const result = await harness.client.callTool({
			name: "run_hands",
			arguments: {
				app: "Finder",
				observation_token: token,
				keyboard: [{ type: "type_text", text: "hello" }],
				pointer: [{ type: "click", x: 10, y: 20 }],
				overlap: "always",
			},
		});

		expect(result.isError).toBe(true);
		expect(inputEffects(computer)).toEqual([]);
	});
});

describe("run_hands #given the stop switch #when it flips during a lane #then no later step is dispatched", () => {
	it("stops the keyboard lane between steps and reports a partial outcome", async () => {
		let stopped = false;
		const stopSwitch = {
			status: () =>
				stopped
					? {
							stopped: true as const,
							stoppedAt: new Date(0).toISOString(),
							reason: "test stop",
							source: "api" as const,
						}
					: { stopped: false as const },
		};
		const computer = new FakeGuardedComputer();
		computer.delivery = "attended";
		const harness = await createHarness(computer, undefined, undefined, { stopSwitch });
		closeHarness = harness.close;
		const token = await observe(harness);

		computer.inputGate = async (effect) => {
			if (effect.kind === "type") {
				stopped = true;
			}
		};

		const payload = jsonPayload(
			await harness.client.callTool({
				name: "run_hands",
				arguments: {
					app: "Finder",
					observation_token: token,
					keyboard: [
						{ type: "type_text", text: "first" },
						{ type: "type_text", text: "second" },
					],
					pointer: [{ type: "click", x: 10, y: 20 }],
				},
			}),
		);
		const hands = record(payload["hands"]);
		const lanes = hands["lanes"];

		expect(inputEffects(computer)).toEqual([expect.objectContaining({ kind: "type", text: "first" })]);
		expect(payload["effect"]).toBe("partial");
		expect(lanes).toEqual([
			expect.objectContaining({
				lane: "keyboard",
				status: "failed",
				error: expect.stringContaining("stopped"),
			}),
			expect.objectContaining({
				lane: "pointer",
				status: "failed",
				steps: [],
				error: expect.stringContaining("stopped"),
			}),
		]);
	});
});

describe("run_hands #given chunks #when the first chunk's lanes are gated #then they overlap and the next chunk waits for them", () => {
	it("runs chunk 0's keyboard and pointer at once, then chunk 1, and reports each chunk", async () => {
		const computer = new FakeGuardedComputer();
		computer.delivery = "background";
		const harness = await createHarness(computer);
		closeHarness = harness.close;
		const token = await observe(harness);

		const typeStarted = new Deferred<void>();
		const clickStarted = new Deferred<void>();
		const release = new Deferred<void>();
		computer.inputGate = async (effect) => {
			if (effect.kind === "type" && effect.text === "first") {
				typeStarted.resolve(undefined);
				await release.promise;
			}
			if (effect.kind === "click") {
				clickStarted.resolve(undefined);
				await release.promise;
			}
		};

		const pending = harness.client.callTool({
			name: "run_hands",
			arguments: {
				app: "Finder",
				observation_token: token,
				chunks: [
					{ keyboard: [{ type: "type_text", text: "first" }], pointer: [{ type: "click", x: 10, y: 20 }] },
					{ keyboard: [{ type: "type_text", text: "second" }] },
				],
			},
		});
		await Promise.all([typeStarted.promise, clickStarted.promise]);
		expect(inputEffects(computer).map((effect) => effect.kind)).not.toContain("type");
		release.resolve(undefined);
		const payload = jsonPayload(await pending);
		const hands = record(payload["hands"]);

		const effects = inputEffects(computer);
		expect(effects.at(-1)).toEqual(expect.objectContaining({ kind: "type", text: "second" }));
		expect(effects).toHaveLength(3);
		expect(hands["chunks"]).toEqual([
			expect.objectContaining({ chunk: 0, status: "completed", lanes: ["keyboard", "pointer"] }),
			expect.objectContaining({ chunk: 1, status: "completed", lanes: ["keyboard"] }),
		]);
		expect(hands["lanes"]).toEqual([
			expect.objectContaining({ lane: "keyboard", chunk: 0, status: "completed" }),
			expect.objectContaining({ lane: "pointer", chunk: 0, status: "completed" }),
			expect.objectContaining({ lane: "keyboard", chunk: 1, status: "completed" }),
		]);
		expect(typeof payload["observation_token"]).toBe("string");
	}, 2_000);
});

describe("run_hands #given chunks #when a chunk's capture is still running #then the next chunk's input does not wait for it", () => {
	it("types chunk 1 while chunk 0's vision lane is held", async () => {
		const computer = new FakeGuardedComputer();
		computer.delivery = "background";
		const harness = await createHarness(computer);
		closeHarness = harness.close;
		const token = await observe(harness);

		const releaseVision = new Deferred<void>();
		const secondTyped = new Deferred<void>();
		computer.stateGate = releaseVision;
		computer.inputGate = async (effect) => {
			if (effect.kind === "type" && effect.text === "second") {
				secondTyped.resolve(undefined);
			}
		};

		const pending = harness.client.callTool({
			name: "run_hands",
			arguments: {
				app: "Finder",
				observation_token: token,
				chunks: [
					{ keyboard: [{ type: "type_text", text: "first" }], vision: { include_screenshot: true } },
					{ keyboard: [{ type: "type_text", text: "second" }] },
				],
			},
		});
		// Only a run that starts chunk 1 before chunk 0's capture finishes can reach this point.
		await secondTyped.promise;
		releaseVision.resolve(undefined);
		const result = await pending;
		const hands = record(jsonPayload(result)["hands"]);
		const chunks = hands["chunks"];

		expect(chunks).toEqual([
			expect.objectContaining({
				chunk: 0,
				status: "completed",
				vision: expect.objectContaining({ captured: true }),
			}),
			expect.objectContaining({ chunk: 1, status: "completed" }),
		]);
		expect(result.content).toContainEqual({
			type: "image",
			data: Buffer.from("png-bytes").toString("base64"),
			mimeType: "image/png",
		});
	}, 2_000);
});

describe("run_hands #given chunks #when a lane fails in the first chunk #then later chunks send nothing", () => {
	it("skips chunk 1 and reports the failure", async () => {
		const computer = new FakeGuardedComputer();
		computer.delivery = "background";
		const harness = await createHarness(computer);
		closeHarness = harness.close;
		const token = await observe(harness);

		computer.inputGate = async (effect) => {
			if (effect.kind === "type" && effect.text === "boom") {
				throw new Error("typing failed");
			}
		};

		const payload = jsonPayload(
			await harness.client.callTool({
				name: "run_hands",
				arguments: {
					app: "Finder",
					observation_token: token,
					chunks: [
						{ keyboard: [{ type: "type_text", text: "boom" }] },
						{ keyboard: [{ type: "type_text", text: "after" }], pointer: [{ type: "click", x: 10, y: 20 }] },
					],
				},
			}),
		);
		const hands = record(payload["hands"]);

		expect(inputEffects(computer).filter((effect) => effect.kind === "click")).toEqual([]);
		expect(inputEffects(computer)).not.toContainEqual(expect.objectContaining({ kind: "type", text: "after" }));
		expect(hands["chunks"]).toEqual([
			expect.objectContaining({ chunk: 0, status: "failed" }),
			{ chunk: 1, status: "skipped", lanes: [], overlap_ms: 0 },
		]);
	}, 2_000);
});

describe("run_hands #given chunks and top-level lanes together #when called #then nothing dispatches", () => {
	it("refuses the call as invalid", async () => {
		const computer = new FakeGuardedComputer();
		const harness = await createHarness(computer);
		closeHarness = harness.close;
		const token = await observe(harness);

		const result = await harness.client.callTool({
			name: "run_hands",
			arguments: {
				app: "Finder",
				observation_token: token,
				keyboard: [{ type: "type_text", text: "top" }],
				chunks: [{ keyboard: [{ type: "type_text", text: "chunk" }] }],
			},
		});

		expect(result.isError).toBe(true);
		expect(inputEffects(computer)).toEqual([]);
	});
});

describe("run_script app.hands #given chunks #when the script runs them #then each chunk's lanes run through run_hands in order", () => {
	it("returns the chunk report to the script", async () => {
		const computer = new FakeGuardedComputer();
		computer.delivery = "background";
		const harness = await createHarness(computer);
		closeHarness = harness.close;

		const payload = jsonPayload(
			await harness.client.callTool({
				name: "run_script",
				arguments: {
					code: `
						const finder = apple.app("Finder");
						await finder.observe();
						const result = await finder.hands({
							chunks: [
								{ keyboard: [{ type: "type_text", text: "one" }], pointer: [{ type: "click", x: 10, y: 20 }] },
								{ keyboard: [{ type: "press_keys", keys: ["return"] }] },
							],
						});
						return result.hands.chunks.map((chunk) => chunk.status);
					`,
				},
			}),
		);

		expect(payload).toMatchObject({ ok: true, value: ["completed", "completed"] });
		const effects = inputEffects(computer);
		expect(effects).toContainEqual(expect.objectContaining({ kind: "type", text: "one" }));
		expect(effects.at(-1)).toEqual(expect.objectContaining({ kind: "key" }));
	});
});

describe("get_tool_usage #given successful and failed calls #when the agent asks for usage #then the counts are truthful", () => {
	it("reports calls, errors, bytes, and per-tool latency without a token", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;
		await observe(harness);
		await harness.client.callTool({
			name: "click",
			arguments: { app: "Finder", observation_token: "stale", element_index: "9" },
		});

		const payload = jsonPayload(await harness.client.callTool({ name: "get_tool_usage", arguments: {} }));
		const byTool = record(payload["by_tool"]);

		expect(payload["calls"]).toBe(2);
		expect(payload["errors"]).toBe(1);
		expect(payload["total_bytes"]).toBeGreaterThan(0);
		expect(payload["p50_ms"]).toEqual(expect.any(Number));
		expect(byTool["get_app_state"]).toEqual(
			expect.objectContaining({ calls: 1, errors: 0, p50_ms: expect.any(Number) }),
		);
		expect(byTool["click"]).toEqual(expect.objectContaining({ calls: 1, errors: 1 }));
	});
});
