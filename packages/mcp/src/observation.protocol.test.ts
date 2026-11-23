import { afterEach, describe, expect, it } from "bun:test";
import { copyForMatch, vi } from "@opencua/test-support";
import { createHarness, jsonPayload, observe } from "./protocol-client-harness.js";

let closeHarness: (() => Promise<void>) | undefined;

afterEach(async () => {
	vi.unstubAllEnvs();
	if (closeHarness !== undefined) {
		await closeHarness();
		closeHarness = undefined;
	}
});

describe("post-action observation #given dispatched input #when capture outcome varies #then continuation pauses honestly", () => {
	it("pauses without a token when AX status is unavailable and explicit observation recovers", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;
		harness.computer.postActionSummary = undefined;
		const token = await observe(harness);

		const action = await harness.client.callTool({
			name: "set_value",
			arguments: { app: "Finder", observation_token: token, element_index: "9", value: "abc" },
		});
		const payload = jsonPayload(action);
		const replay = await harness.client.callTool({
			name: "set_value",
			arguments: { app: "Finder", observation_token: token, element_index: "9", value: "replay" },
		});
		const recoveredToken = await observe(harness);

		expect(payload).toMatchObject({
			actionDispatched: true,
			observationStatus: "unavailable",
			paused: true,
			needsExplicitObservation: true,
		});
		expect(payload).not.toHaveProperty("observation_token");
		expect(replay.isError).toBe(true);
		expect(typeof recoveredToken).toBe("string");
	});

	it("continues with a fresh token when the AX tree is unchanged, so no extra observation is needed", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;
		harness.computer.postActionSummary = { added: 0, removed: 0, changed: 0 };
		const token = await observe(harness);

		const action = await harness.client.callTool({
			name: "set_value",
			arguments: { app: "Finder", observation_token: token, element_index: "9", value: "abc" },
		});
		const payload = jsonPayload(action);
		const replay = await harness.client.callTool({
			name: "set_value",
			arguments: { app: "Finder", observation_token: token, element_index: "9", value: "replay" },
		});
		const next = await harness.client.callTool({
			name: "set_value",
			arguments: {
				app: "Finder",
				observation_token: payload["observation_token"],
				element_index: "9",
				value: "next",
			},
		});

		expect(payload).toMatchObject({ actionDispatched: true, observationStatus: "unchanged", paused: false });
		expect(typeof payload["observation_token"]).toBe("string");
		expect(replay.isError).toBe(true);
		expect(next.isError).not.toBe(true);
	});

	it.each([
		{ delivery: "background" as const, continues: true },
		{ delivery: "attended" as const, continues: false },
	])(
		"continues=$continues after acting on a window that is not frontmost under $delivery delivery",
		async ({ delivery, continues }) => {
			const harness = await createHarness();
			closeHarness = harness.close;
			harness.computer.delivery = delivery;
			harness.computer.frontmost = false;
			const token = await observe(harness);

			const payload = jsonPayload(
				await harness.client.callTool({
					name: "press_keys",
					arguments: { app: "Finder", observation_token: token, keys: ["Return"] },
				}),
			);

			expect(typeof payload["observation_token"] === "string").toBe(continues);
			expect(payload["paused"]).toBe(!continues);
		},
	);

	it("sends elements as tab-separated rows when element_format is table", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;

		const payload = jsonPayload(
			await harness.client.callTool({
				name: "get_app_state",
				arguments: { app: "Finder", element_format: "table", include_screenshot: false },
			}),
		);

		expect(payload["elements"]).toBeUndefined();
		expect(payload["element_columns"]).toBe("id\trole\tlabel\tvalue\tframe(x,y,w,h)\tactions\tchildren");
		expect(payload["element_rows"]).toContain("9\tButton\tOpen\t\t10,20,30,40\tPress\t");
		expect(typeof payload["observation_token"]).toBe("string");
	});

	it("reports measured capture timing with an injected clock", async () => {
		vi.stubEnv("OPENCUA_TIMING", "1");
		const clock = vi.spyOn(performance, "now");
		let now = 0;
		clock.mockImplementation(() => {
			now += 6;
			return now;
		});
		const harness = await createHarness();
		closeHarness = harness.close;

		const payload = jsonPayload(
			await harness.client.callTool({
				name: "get_app_state",
				arguments: { app: "Finder", include_screenshot: false },
			}),
		);

		expect(payload["timing_ms"]).toMatchObject({ capture: 6 });
		expect(payload["timing_ms"]).toMatchObject({ total: expect.any(Number), handler: expect.any(Number) });
		clock.mockRestore();
	});

	it("still reports server timing without capture when collection is disabled", async () => {
		vi.stubEnv("OPENCUA_TIMING", "0");
		const harness = await createHarness();
		closeHarness = harness.close;

		const payload = jsonPayload(
			await harness.client.callTool({
				name: "get_app_state",
				arguments: { app: "Finder", include_screenshot: false },
			}),
		);

		expect(copyForMatch(payload["timing_ms"])).toMatchObject({
			total: expect.any(Number),
			handler: expect.any(Number),
		});
		expect(payload["timing_ms"]).not.toHaveProperty("capture");
	});

	it("pauses when post-action context changes even if the AX tree changed", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;
		harness.computer.windowIdAfterAction = 72;
		const token = await observe(harness);

		const result = await harness.client.callTool({
			name: "press_keys",
			arguments: { app: "Finder", observation_token: token, keys: ["Return"] },
		});
		const payload = jsonPayload(result);

		expect(payload).toMatchObject({
			observationStatus: "context-changed",
			paused: true,
			needsExplicitObservation: true,
		});
		expect(payload).not.toHaveProperty("observation_token");
	});

	it("returns a machine-readable paused error when strict post-read fails, then permits explicit recovery", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;
		const token = await observe(harness);
		harness.computer.stateError = new Error("window capture failed");

		const result = await harness.client.callTool({
			name: "type_text",
			arguments: { app: "Finder", observation_token: token, text: "sent" },
		});
		const payload = jsonPayload(result);
		const stale = await harness.client.callTool({
			name: "type_text",
			arguments: { app: "Finder", observation_token: token, text: "again" },
		});
		const recoveredToken = await observe(harness);

		expect(payload).toMatchObject({
			actionDispatched: true,
			observationStatus: "error",
			paused: true,
			needsExplicitObservation: true,
			error: "window capture failed",
		});
		expect(payload["timing_ms"]).toMatchObject({ total: expect.any(Number) });
		expect(stale.isError).toBe(true);
		expect(typeof recoveredToken).toBe("string");
	});

	it("does not mint a token after an input error or retry the input", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;
		const token = await observe(harness);
		harness.computer.inputError = new Error("input dispatch failed");

		const failed = await harness.client.callTool({
			name: "press_keys",
			arguments: { app: "Finder", observation_token: token, keys: ["Return"] },
		});
		const replay = await harness.client.callTool({
			name: "press_keys",
			arguments: { app: "Finder", observation_token: token, keys: ["Return"] },
		});

		expect(failed.isError).toBe(true);
		expect(replay.isError).toBe(true);
		expect(harness.computer.effects.filter((effect) => effect.kind === "key")).toEqual([]);
		expect(harness.computer.stateOptions).toHaveLength(1);
	});
});

describe("strict explicit observation #given no visible capture #when get_app_state fails #then no token exists", () => {
	it("denies subsequent input and records requireWindow", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;
		harness.computer.stateError = new Error("window missing");

		const observation = await harness.client.callTool({
			name: "get_app_state",
			arguments: { profile: "full", app: "Finder" },
		});
		const mutation = await harness.client.callTool({
			name: "click",
			arguments: { app: "Finder", observation_token: "invented", x: 1, y: 1 },
		});

		expect(observation.isError).toBe(true);
		expect(mutation.isError).toBe(true);
		expect(harness.computer.stateOptions).toEqual([{ requireWindow: true }]);
		expect(harness.computer.effects.filter((effect) => effect.kind !== "close")).toEqual([]);
	});

	it("keeps diff_only opt-in while requiring a target window", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;

		const first = await harness.client.callTool({
			name: "get_app_state",
			arguments: { profile: "full", app: "Finder", diff_only: false },
		});
		const second = await harness.client.callTool({
			name: "get_app_state",
			arguments: { profile: "full", app: "Finder", diff_only: true },
		});

		expect(jsonPayload(first)["elements"]).toEqual(expect.any(Array));
		expect(harness.computer.stateOptions).toEqual([{ requireWindow: true }, { diffOnly: true, requireWindow: true }]);
		expect(jsonPayload(second)["observation_token"]).toEqual(expect.any(String));
	});
});
