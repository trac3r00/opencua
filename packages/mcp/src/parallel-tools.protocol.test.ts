import { afterEach, describe, expect, it } from "bun:test";
import { currentCursorIdentity, currentInputScope } from "@opencua/core";
import { createHarness, jsonPayload, observe } from "./protocol-client-harness.js";
import { Deferred } from "./protocol-test-harness.js";

let closeHarness: (() => Promise<void>) | undefined;

afterEach(async () => {
	if (closeHarness !== undefined) {
		await closeHarness();
		closeHarness = undefined;
	}
});

describe("observe_apps #given two approved apps #when both are observed in one call #then each answers with its own token", () => {
	it("#given one missing app #when targets are resolved #then retains the other app's observation", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;

		const result = await harness.client.callTool({
			name: "observe_apps",
			arguments: { apps: ["Finder", "Missing"] },
		});

		expect(result.isError).not.toBe(true);
		expect(jsonPayload(result)).toMatchObject({
			apps: [
				{ app: "Finder", ok: true, result: { observation_token: expect.any(String) } },
				{ app: "Missing", ok: false },
			],
		});
	});

	it("returns one entry per app, text-only by default", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;

		const result = await harness.client.callTool({ name: "observe_apps", arguments: { apps: ["Finder", "Other"] } });

		expect(result.isError).not.toBe(true);
		expect(jsonPayload(result)).toMatchObject({
			apps: [
				{ app: "Finder", ok: true, result: { observation_token: expect.any(String) } },
				{ app: "Other", ok: true, result: { observation_token: expect.any(String) } },
			],
		});
		expect(harness.computer.stateOptions.every((options) => options?.includeScreenshot === false)).toBe(true);
		expect(jsonPayload(result)).toMatchObject({
			apps: [{ result: { element_rows: expect.any(Array) } }, { result: { element_rows: expect.any(Array) } }],
		});
	});
});

describe("run_parallel #given batches for two apps #when they run in one call #then both apps are driven", () => {
	it("keeps distinct virtual cursors while independent input lanes overlap", async () => {
		const harness = await createHarness();
		harness.computer.delivery = "background";
		const entered = new Deferred<void>();
		const finish = new Deferred<void>();
		const cursors = new Map<number | undefined, string | undefined>();
		let running: Promise<unknown> | undefined;
		try {
			const finderToken = await observe(harness, "Finder");
			const otherToken = await observe(harness, "Other");
			harness.computer.inputGate = async () => {
				cursors.set(currentInputScope()?.target?.pid, currentCursorIdentity());
				if (cursors.size === 2) entered.resolve();
				await finish.promise;
			};
			running = harness.client.callTool({
				name: "run_parallel",
				arguments: {
					batches: [
						{ app: "Finder", observation_token: finderToken, steps: [{ type: "type_text", text: "one" }] },
						{ app: "Other", observation_token: otherToken, steps: [{ type: "type_text", text: "two" }] },
					],
				},
			});
			const deadline = AbortSignal.timeout(2_000);
			await Promise.race([
				entered.promise,
				new Promise<never>((_resolve, reject) => {
					deadline.addEventListener("abort", () => reject(new Error("parallel lanes did not overlap")), {
						once: true,
					});
				}),
			]);
			expect(cursors.get(1234)).toEqual(expect.any(String));
			expect(cursors.get(5678)).toEqual(expect.any(String));
			expect(cursors.get(1234)).not.toBe(cursors.get(5678));
		} finally {
			finish.resolve();
			try {
				const result = await running;
				if (result !== undefined)
					expect(jsonPayload(result)).toMatchObject({
						batches: [{ ok: true }, { ok: true }],
					});
			} finally {
				await harness.close();
			}
		}
	});

	it("#given PID aliases #when batches overlap #then refuses before dispatch and preserves the token", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;
		harness.computer.delivery = "background";
		const token = await observe(harness, "Finder");

		const result = await harness.client.callTool({
			name: "run_parallel",
			arguments: {
				batches: [
					{ app: "Finder", observation_token: token, steps: [{ type: "type_text", text: "never" }] },
					{ app: "1234", observation_token: token, steps: [{ type: "type_text", text: "never" }] },
				],
			},
		});

		expect(result.isError).toBe(true);
		expect(harness.computer.effects).toEqual([]);
		const valid = await harness.client.callTool({
			name: "run_steps",
			arguments: {
				app: "Finder",
				observation_token: token,
				steps: [{ type: "set_value", element_index: "20", value: "still valid" }],
			},
		});
		expect(valid.isError).not.toBe(true);
		expect(harness.computer.effects).toEqual([{ kind: "setValue", pid: 1234, id: 20, value: "still valid" }]);
	});

	it("#given observation aliases #when requested together #then issues no immediately stale tokens", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;

		const result = await harness.client.callTool({
			name: "observe_apps",
			arguments: { apps: ["Finder", "1234"] },
		});

		expect(result.isError).toBe(true);
		expect(harness.computer.stateOptions).toEqual([]);
	});

	it("dispatches each batch to its own app and answers per batch", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;
		harness.computer.delivery = "background";
		const finderToken = await observe(harness, "Finder");
		const otherToken = await observe(harness, "Other");

		const result = await harness.client.callTool({
			name: "run_parallel",
			arguments: {
				batches: [
					{
						app: "Finder",
						observation_token: finderToken,
						steps: [{ type: "set_value", element_index: "20", value: "f" }],
					},
					{
						app: "Other",
						observation_token: otherToken,
						steps: [{ type: "set_value", element_index: "20", value: "o" }],
					},
				],
			},
		});

		expect(harness.computer.effects).toContainEqual({ kind: "setValue", pid: 1234, id: 20, value: "f" });
		expect(harness.computer.effects).toContainEqual({ kind: "setValue", pid: 5678, id: 20, value: "o" });
		expect(jsonPayload(result)).toMatchObject({
			batches: [
				{ app: "Finder", ok: true, result: { runSteps: { completed: 1 } } },
				{ app: "Other", ok: true, result: { runSteps: { completed: 1 } } },
			],
		});
	});

	it("reports a batch with a stale token without stopping the other", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;
		harness.computer.delivery = "background";
		const finderToken = await observe(harness, "Finder");

		const result = await harness.client.callTool({
			name: "run_parallel",
			arguments: {
				batches: [
					{
						app: "Finder",
						observation_token: finderToken,
						steps: [{ type: "set_value", element_index: "20", value: "f" }],
					},
					{ app: "Other", observation_token: "not-a-token", steps: [{ type: "type_text", text: "never" }] },
				],
			},
		});

		expect(result.isError).not.toBe(true);
		expect(harness.computer.effects).toContainEqual({ kind: "setValue", pid: 1234, id: 20, value: "f" });
		expect(harness.computer.effects.some((effect) => effect.kind === "type")).toBe(false);
		expect(jsonPayload(result)).toMatchObject({
			batches: [
				{ app: "Finder", ok: true },
				{ app: "Other", ok: false },
			],
		});
	});

	it("refuses two batches for the same app", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;
		const token = await observe(harness, "Finder");

		const result = await harness.client.callTool({
			name: "run_parallel",
			arguments: {
				batches: [
					{ app: "Finder", observation_token: token, steps: [{ type: "type_text", text: "a" }] },
					{ app: "Finder", observation_token: token, steps: [{ type: "type_text", text: "b" }] },
				],
			},
		});

		expect(result.isError).toBe(true);
		expect(harness.computer.effects.filter((effect) => effect.kind !== "close")).toEqual([]);
	});
});
