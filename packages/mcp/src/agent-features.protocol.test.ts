import { afterEach, describe, expect, it } from "bun:test";
import { createHarness, jsonPayload, observe } from "./protocol-client-harness.js";
import { FakeGuardedComputer } from "./protocol-test-harness.js";

let closeHarness: (() => Promise<void>) | undefined;
afterEach(async () => {
	await closeHarness?.();
	closeHarness = undefined;
});

describe("agent-facing errors and refs", () => {
	it("#given invalid SDK arguments #when calling a tool #then errors have machine-readable recovery fields", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;
		const result = await harness.client.callTool({ name: "get_app_state", arguments: {} });
		expect(result.isError).toBe(true);
		expect(jsonPayload(result)).toMatchObject({
			ok: false,
			code: "INVALID_ARGUMENT",
			retry: "never",
			disposition: { retry: "never" },
			suggestion: expect.any(String),
		});
	});

	it("#given an unknown tool #when calling through MCP #then SDK failures use the same envelope", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;
		const result = await harness.client.callTool({ name: "no_such_tool", arguments: {} });
		expect(jsonPayload(result)).toMatchObject({ ok: false, code: "INVALID_ARGUMENT", retry: "never" });
	});

	it("#given a native failure #when observing #then the agent is told nothing was sent and may observe again", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;
		harness.computer.stateError = new Error("capture failed");
		const result = await harness.client.callTool({ name: "get_app_state", arguments: { app: "Finder" } });
		expect(jsonPayload(result)).toMatchObject({
			ok: false,
			error: "capture failed",
			code: "TOOL_ERROR",
			retry: "safe",
		});
		// A mutation's unexplained failure still leaves delivery unknown.
		const token = await observe(harness);
		harness.computer.stateError = undefined;
		harness.computer.inputError = new Error("post failed");
		const click = await harness.client.callTool({
			name: "click",
			arguments: { app: "Finder", observation_token: token, x: 10, y: 10 },
		});
		expect(jsonPayload(click)).toMatchObject({ ok: false, retry: "unsafe" });
	});

	it("#given a human stop refusal #when dispatch is attempted #then automatic retry is forbidden", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;
		const token = await observe(harness);
		harness.computer.preflightResult = { ok: false, reason: "app-not-approved" };
		const result = await harness.client.callTool({
			name: "set_value",
			arguments: { app: "Finder", observation_token: token, element_index: "20", value: "x" },
		});
		expect(jsonPayload(result)).toMatchObject({
			code: "APP_NOT_APPROVED",
			retry: "never",
			actionDispatched: false,
			reason: "app-not-approved",
		});
		expect(harness.computer.effects).toEqual([]);
	});

	it.each(["json", "table"])(
		"#given %s observation output #when using its scoped ref #then the original element is dispatched",
		async (element_format) => {
			const harness = await createHarness();
			closeHarness = harness.close;
			const state = jsonPayload(
				await harness.client.callTool({
					name: "get_app_state",
					arguments: { app: "Finder", element_format, include_screenshot: false },
				}),
			);
			const result = await harness.client.callTool({
				name: "set_value",
				arguments: {
					app: "Finder",
					observation_token: state["observation_token"],
					element_index: `@${state["observation_token"]}:e20`,
					value: "updated",
				},
			});
			expect(state["element_refs"]).toMatchObject({ 20: `@${state["observation_token"]}:e20` });
			expect(result.isError).not.toBe(true);
			expect(harness.computer.effects).toContainEqual({ kind: "setValue", pid: 1234, id: 20, value: "updated" });
		},
	);

	it("#given an old ref and a fresh token #when acting #then STALE_REF prevents any input", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;
		const oldToken = await observe(harness);
		const freshToken = await observe(harness);
		const result = await harness.client.callTool({
			name: "set_value",
			arguments: {
				app: "Finder",
				observation_token: freshToken,
				element_index: `@${oldToken}:e20`,
				value: "wrong",
			},
		});
		expect(result.isError).toBe(true);
		expect(jsonPayload(result)).toMatchObject({ ok: false, code: "STALE_REF", retry: "safe" });
		expect(harness.computer.effects).toEqual([]);
		expect(harness.computer.preflightExpected).toEqual([]);
	});

	it("#given a replaced observation token #when reusing numeric ids #then legacy calls also report STALE_REF", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;
		const oldToken = await observe(harness);
		await observe(harness);
		const result = await harness.client.callTool({
			name: "set_value",
			arguments: { app: "Finder", observation_token: oldToken, element_index: "20", value: "wrong" },
		});
		expect(jsonPayload(result)).toMatchObject({ code: "STALE_REF", retry: "safe", actionDispatched: false });
		expect(harness.computer.effects).toEqual([]);
	});

	it.each(["set_fields", "run_steps"] as const)(
		"#given scoped refs in %s #when dispatching nested targets #then batch validation resolves the same snapshot",
		async (name) => {
			const harness = await createHarness();
			closeHarness = harness.close;
			const token = await observe(harness);
			const update = { element_index: `@${token}:e20`, value: "batch value" };
			const result = await harness.client.callTool({
				name,
				arguments: {
					app: "Finder",
					observation_token: token,
					...(name === "set_fields" ? { updates: [update] } : { steps: [{ type: "set_value", ...update }] }),
				},
			});
			expect(result.isError).not.toBe(true);
			expect(harness.computer.effects).toContainEqual({
				kind: "setValue",
				pid: 1234,
				id: 20,
				value: "batch value",
			});
		},
	);

	it("#given input succeeds but observation fails #when returning through MCP #then replay is explicitly unsafe", async () => {
		const computer = new FakeGuardedComputer();
		const setValue = computer.setValue.bind(computer);
		computer.setValue = async (pid, id, value) => {
			await setValue(pid, id, value);
			computer.stateError = new Error("outcome unavailable");
		};
		const harness = await createHarness(computer);
		closeHarness = harness.close;
		const token = await observe(harness);
		const result = await harness.client.callTool({
			name: "set_value",
			arguments: { app: "Finder", observation_token: token, element_index: "20", value: "delivered" },
		});
		expect(result.isError).toBe(true);
		expect(jsonPayload(result)).toMatchObject({
			ok: false,
			code: "POST_ACTION_ERROR",
			retry: "unsafe",
			actionDispatched: true,
		});
		expect(computer.effects).toContainEqual({ kind: "setValue", pid: 1234, id: 20, value: "delivered" });
	});

	it("#given find results #when resolving a target #then matches expose snapshot refs", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;
		const state = jsonPayload(
			await harness.client.callTool({
				name: "find_elements",
				arguments: { app: "Finder", query: { label: "Open" } },
			}),
		);
		expect(state["element_refs"]).toMatchObject({ 9: `@${state["observation_token"]}:e9` });
	});
});

describe("clipboard content clearing", () => {
	it("#given clipboard content #when clearing with a current token #then only an empty-text clipboard write occurs", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;
		const token = await observe(harness);
		const result = await harness.client.callTool({
			name: "clipboard_clear",
			arguments: { app: "Finder", observation_token: token },
		});
		expect(result.isError).not.toBe(true);
		expect(harness.computer.effects).toEqual([{ kind: "clipboardWrite", input: { type: "text", text: "" } }]);
		expect(jsonPayload(result)["clipboardClear"]).toMatchObject({ overwritten: true, writtenType: "text" });
	});

	it("#given a consumed token #when clearing clipboard #then existing content is untouched", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;
		const token = await observe(harness);
		await observe(harness);
		const result = await harness.client.callTool({
			name: "clipboard_clear",
			arguments: { app: "Finder", observation_token: token },
		});
		expect(jsonPayload(result)).toMatchObject({ code: "STALE_REF" });
		expect(harness.computer.effects).toEqual([]);
	});

	it("#given a clipboard backend failure #when clearing #then the MCP error envelope survives", async () => {
		const computer = Object.assign(new FakeGuardedComputer(), {
			writeClipboard: () => {
				throw new Error("pasteboard unavailable");
			},
		});
		const harness = await createHarness(computer);
		closeHarness = harness.close;
		const token = await observe(harness);
		const result = await harness.client.callTool({
			name: "clipboard_clear",
			arguments: { app: "Finder", observation_token: token },
		});
		expect(jsonPayload(result)).toMatchObject({ ok: false, code: "TOOL_ERROR", retry: "unsafe" });
	});

	it.each(["full", "lean"] as const)(
		"#given the %s toolset #when discovering clipboard clear #then registration matches the desktop profile",
		async (toolset) => {
			const harness = await createHarness(undefined, undefined, undefined, { serverOptions: { toolset } });
			closeHarness = harness.close;
			const tools = await harness.client.listTools();
			expect(tools.tools.some((tool) => tool.name === "clipboard_clear")).toBe(toolset === "full");
		},
	);
});
