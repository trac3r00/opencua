import { afterEach, describe, expect, it } from "bun:test";
import type { TopLevelWindow } from "@opencua/core";
import { createHarness, jsonPayload, observe } from "./protocol-client-harness.js";
import { type Effect, FakeGuardedComputer } from "./protocol-test-harness.js";
import { MAX_RUN_STEPS } from "./tool-schemas.js";

function window(title: string): TopLevelWindow {
	return { id: 4, ownerPid: 1234, ownerName: "Finder", title, bounds: { x: 0, y: 0, width: 800, height: 600 } };
}

let closeHarness: (() => Promise<void>) | undefined;

afterEach(async () => {
	if (closeHarness !== undefined) {
		await closeHarness();
		closeHarness = undefined;
	}
});

describe("run_steps #given an observed app #when a batch mixes element and input steps #then each step dispatches in order", () => {
	it("runs every step and reports per-step dispatch with a continuation token", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;
		const token = await observe(harness);

		const result = await harness.client.callTool({
			name: "run_steps",
			arguments: {
				app: "Finder",
				observation_token: token,
				steps: [
					{ type: "set_value", element_index: "20", value: "alpha" },
					{ type: "click", element_index: "9" },
					{ type: "type_text", text: "hello" },
					{ type: "press_keys", keys: ["return"] },
				],
			},
		});
		const payload = jsonPayload(result);

		expect(result.isError).not.toBe(true);
		expect(inputEffects(harness.computer.effects)).toEqual([
			{ kind: "setValue", pid: 1234, id: 20, value: "alpha" },
			{ kind: "performAction", pid: 1234, id: 9, action: "AXPress" },
			{ kind: "type", text: "hello" },
			{ kind: "key", key: "return" },
		]);
		expect(payload["runSteps"]).toMatchObject({
			requested: 4,
			completed: 4,
			stoppedEarly: false,
			steps: [
				{ step: 0, type: "set_value", input_dispatched: true, status: "dispatched" },
				{ step: 1, type: "click", input_dispatched: true, status: "dispatched" },
				{ step: 2, type: "type_text", input_dispatched: true, status: "dispatched" },
				{ step: 3, type: "press_keys", input_dispatched: true, status: "dispatched" },
			],
		});
		expect(payload["observation_token"]).toEqual(expect.any(String));
	});

	it("dispatches power steps through the same ordered batch", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;
		const token = await observe(harness);

		const result = await harness.client.callTool({
			name: "run_steps",
			arguments: {
				app: "Finder",
				observation_token: token,
				steps: [
					{ type: "invoke_menu", path: ["File", "New Tab"] },
					{ type: "clipboard_write", text: "copied" },
				],
			},
		});
		const payload = jsonPayload(result);

		expect(result.isError).not.toBe(true);
		expect(inputEffects(harness.computer.effects)).toEqual([
			{ kind: "invokeMenu", pid: 1234, path: ["File", "New Tab"] },
			{ kind: "clipboardWrite", input: { type: "text", text: "copied" } },
		]);
		expect(payload["runSteps"]).toMatchObject({ requested: 2, completed: 2, stoppedEarly: false });
	});
});

describe("run_steps #given a link the target app handles #when open_url and wait_for run in one batch #then the app opens it and the batch waits for its window", () => {
	it("opens the URL in the target app, then waits for the window it opened", async () => {
		const computer = new FakeGuardedComputer();
		// The meeting window exists only once the link was handed over, so the wait cannot pass on a stale window.
		const harness = await createHarness(computer, async () =>
			computer.effects.some((effect) => effect.kind === "openUrl")
				? [window("Documents"), window("Staff Meeting")]
				: [window("Documents")],
		);
		closeHarness = harness.close;
		const token = await observe(harness);

		const result = await harness.client.callTool({
			name: "run_steps",
			arguments: {
				app: "Finder",
				observation_token: token,
				steps: [
					{ type: "open_url", url: "zoommtg://zoom.us/join?action=join&confno=123" },
					{ type: "wait_for", window_title: "Staff Meeting", timeout_ms: 500 },
				],
			},
		});
		const payload = jsonPayload(result);

		expect(result.isError).not.toBe(true);
		expect(inputEffects(harness.computer.effects)).toEqual([
			{ kind: "openUrl", pid: 1234, url: "zoommtg://zoom.us/join?action=join&confno=123" },
		]);
		expect(payload["runSteps"]).toMatchObject({
			requested: 2,
			completed: 1,
			stoppedEarly: false,
			steps: [
				{ step: 0, type: "open_url", input_dispatched: true, status: "dispatched" },
				{ step: 1, type: "wait_for", status: "satisfied" },
			],
		});
	});

	it("refuses a blocked URL before any earlier step of the batch dispatches", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;
		const token = await observe(harness);

		const result = await harness.client.callTool({
			name: "run_steps",
			arguments: {
				app: "Finder",
				observation_token: token,
				steps: [
					{ type: "type_text", text: "x" },
					{ type: "open_url", url: "blocked://anything" },
				],
			},
		});

		expect(result.isError).toBe(true);
		expect(jsonPayload(result)).toMatchObject({ actionDispatched: false, reason: "url-blocked" });
		expect(inputEffects(harness.computer.effects)).toEqual([]);
	});

	it("rejects a URL without a scheme before dispatching any step", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;
		const token = await observe(harness);

		const result = await harness.client.callTool({
			name: "run_steps",
			arguments: {
				app: "Finder",
				observation_token: token,
				steps: [
					{ type: "type_text", text: "x" },
					{ type: "open_url", url: "zoom.us/join" },
				],
			},
		});

		expect(result.isError).toBe(true);
		expect(inputEffects(harness.computer.effects)).toEqual([]);
	});
});

describe("run_steps #given an expect block #when the batch finishes #then the outcome is verified in the same call", () => {
	it("confirms the written value against the post-batch observation", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;
		const token = await observe(harness);

		const payload = jsonPayload(
			await harness.client.callTool({
				name: "run_steps",
				arguments: {
					app: "Finder",
					observation_token: token,
					steps: [{ type: "set_value", element_index: "20", value: "alpha" }],
					expect: { checks: [{ element_index: "20", value: "alpha" }] },
				},
			}),
		);

		expect(payload["verification"]).toMatchObject({
			verified: true,
			checks: [{ check: 'element 20 value is "alpha"', verified: true, actual: 'value "alpha"' }],
		});
		expect(payload["effect"]).toBe("confirmed");
	});

	it("checks a window title through the window probe", async () => {
		const harness = await createHarness(undefined, async () => [window("Documents")]);
		closeHarness = harness.close;
		const token = await observe(harness);

		const payload = jsonPayload(
			await harness.client.callTool({
				name: "run_steps",
				arguments: {
					app: "Finder",
					observation_token: token,
					steps: [{ type: "click", element_index: "9" }],
					expect: { window_title: "Documents" },
				},
			}),
		);

		expect(payload["verification"]).toMatchObject({
			verified: true,
			checks: [{ check: 'a window titled "Documents" is open', verified: true, actual: "Documents" }],
		});
	});

	it("reports an unmet expectation instead of claiming success", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;
		const token = await observe(harness);

		const payload = jsonPayload(
			await harness.client.callTool({
				name: "run_steps",
				arguments: {
					app: "Finder",
					observation_token: token,
					steps: [{ type: "set_value", element_index: "20", value: "alpha" }],
					expect: { checks: [{ element_index: "20", value: "sent" }] },
				},
			}),
		);

		expect(payload["verification"]).toMatchObject({
			verified: false,
			checks: [{ check: 'element 20 value is "sent"', verified: false, actual: 'value "alpha"' }],
		});
	});
});

describe("run_steps #given a step that cannot dispatch #when the batch reaches it #then it stops and reports progress", () => {
	it("stops at the failed step and dispatches nothing after it", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;
		const token = await observe(harness);

		const result = await harness.client.callTool({
			name: "run_steps",
			arguments: {
				app: "Finder",
				observation_token: token,
				steps: [
					{ type: "set_value", element_index: "20", value: "alpha" },
					{ type: "press_keys", keys: ["bogus+key"] },
					{ type: "set_value", element_index: "21", value: "beta" },
				],
			},
		});
		const payload = jsonPayload(result);

		expect(inputEffects(harness.computer.effects)).toEqual([{ kind: "setValue", pid: 1234, id: 20, value: "alpha" }]);
		expect(payload["runSteps"]).toMatchObject({
			requested: 3,
			completed: 1,
			stoppedEarly: true,
			steps: [
				{ step: 0, type: "set_value", input_dispatched: true, status: "dispatched" },
				{
					step: 1,
					type: "press_keys",
					input_dispatched: false,
					status: "failed",
					reason: expect.stringContaining("unsupported key modifier"),
				},
			],
		});
	});
});

describe("run_steps #given stale element ids #when the tree moved on #then the batch stops instead of acting blind", () => {
	it("skips a step whose element vanished from the fresh observation", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;
		const token = await observe(harness);
		harness.computer.hiddenElementIds.add(21);

		const result = await harness.client.callTool({
			name: "run_steps",
			arguments: {
				app: "Finder",
				observation_token: token,
				steps: [
					{ type: "set_value", element_index: "20", value: "alpha" },
					{ type: "set_value", element_index: "21", value: "beta" },
					{ type: "type_text", text: "never" },
				],
			},
		});
		const payload = jsonPayload(result);

		expect(inputEffects(harness.computer.effects)).toEqual([{ kind: "setValue", pid: 1234, id: 20, value: "alpha" }]);
		expect(payload["runSteps"]).toMatchObject({
			requested: 3,
			completed: 1,
			stoppedEarly: true,
			steps: [
				{ step: 0, type: "set_value", input_dispatched: true, status: "dispatched" },
				{
					step: 1,
					type: "set_value",
					input_dispatched: false,
					status: "skipped",
					reason: expect.stringContaining("not present"),
				},
			],
		});
	});

	it("skips a step whose element changed identity after the observation", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;
		const token = await observe(harness);
		harness.computer.elementLabelOverrides.set(21, "Archived status");

		const result = await harness.client.callTool({
			name: "run_steps",
			arguments: {
				app: "Finder",
				observation_token: token,
				steps: [
					{ type: "set_value", element_index: "20", value: "alpha" },
					{ type: "set_value", element_index: "21", value: "beta" },
				],
			},
		});
		const payload = jsonPayload(result);

		expect(inputEffects(harness.computer.effects)).toEqual([{ kind: "setValue", pid: 1234, id: 20, value: "alpha" }]);
		expect(payload["runSteps"]).toMatchObject({
			steps: [
				{ step: 0, status: "dispatched" },
				{ step: 1, status: "skipped", reason: expect.stringContaining("not the observed control") },
			],
		});
	});
});

describe("run_steps #given invalid input #when the call arrives #then it is refused before any input dispatches", () => {
	it("rejects a step that names an element never observed and consumes the token", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;
		const token = await observe(harness);

		const result = await harness.client.callTool({
			name: "run_steps",
			arguments: {
				app: "Finder",
				observation_token: token,
				steps: [{ type: "set_value", element_index: "10", value: "alpha" }],
			},
		});
		const replay = await harness.client.callTool({
			name: "run_steps",
			arguments: {
				app: "Finder",
				observation_token: token,
				steps: [{ type: "set_value", element_index: "20", value: "alpha" }],
			},
		});

		expect(result.isError).toBe(true);
		expect(replay.isError).toBe(true);
		expect(inputEffects(harness.computer.effects)).toEqual([]);
	});

	it("rejects a clipboard_write step without exactly one value", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;
		const token = await observe(harness);

		const result = await harness.client.callTool({
			name: "run_steps",
			arguments: {
				app: "Finder",
				observation_token: token,
				steps: [{ type: "clipboard_write", text: "a", file_path: "/tmp/b" }],
			},
		});

		expect(result.isError).toBe(true);
		expect(inputEffects(harness.computer.effects)).toEqual([]);
	});

	it("rejects an unbounded step list before dispatching input", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;
		const token = await observe(harness);

		const result = await harness.client.callTool({
			name: "run_steps",
			arguments: {
				app: "Finder",
				observation_token: token,
				steps: Array.from({ length: MAX_RUN_STEPS + 1 }, () => ({ type: "type_text", text: "x" })),
			},
		});

		expect(result.isError).toBe(true);
		expect(inputEffects(harness.computer.effects)).toEqual([]);
	});
});

function inputEffects(effects: readonly Effect[]): readonly Effect[] {
	return effects.filter((effect) => effect.kind !== "close");
}
