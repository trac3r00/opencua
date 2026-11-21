import { afterEach, describe, expect, it } from "bun:test";
import { copyForMatch, defined } from "@opencua/test-support";
import { createHarness, jsonPayload, jsonText, observe } from "./protocol-client-harness.js";
import type { Effect } from "./protocol-test-harness.js";

interface MutationCase {
	readonly name: string;
	readonly arguments: Record<string, unknown>;
	readonly expected: Effect;
}
const cases: readonly MutationCase[] = [
	{
		name: "click",
		arguments: { app: "Finder", element_index: "9" },
		expected: { kind: "performAction", pid: 1234, id: 9, action: "AXPress" },
	},
	{
		name: "click",
		arguments: { app: "Finder", x: 250, y: 200 },
		expected: { kind: "click", point: { x: 800, y: 550 } },
	},
	{
		name: "perform_secondary_action",
		arguments: { app: "Finder", element_index: "9", action: "AXShowMenu" },
		expected: { kind: "performAction", pid: 1234, id: 9, action: "AXShowMenu" },
	},
	{
		name: "set_value",
		arguments: { app: "Finder", element_index: "9", value: "abc" },
		expected: { kind: "setValue", pid: 1234, id: 9, value: "abc" },
	},
	{
		name: "select_text",
		arguments: { app: "Finder", element_index: "9", text: "abc" },
		expected: { kind: "selectText", pid: 1234, id: 9 },
	},
	{
		name: "drag",
		arguments: { app: "Finder", from_x: 0, from_y: 0, to_x: 250, to_y: 200 },
		expected: { kind: "drag", options: { from: { x: 300, y: 150 }, to: { x: 800, y: 550 } } },
	},
	{
		name: "scroll",
		arguments: { app: "Finder", element_index: "9", direction: "down" },
		expected: { kind: "performAction", pid: 1234, id: 9, action: "AXScrollDownByPage" },
	},
	{
		name: "type_text",
		arguments: { app: "Finder", text: "hello" },
		expected: { kind: "type", text: "hello" },
	},
	{
		name: "press_keys",
		arguments: { app: "Finder", keys: ["super+k"] },
		expected: { kind: "key", key: "k" },
	},
	// One combo as a plain string, the way agents most often write it.
	{
		name: "press_keys",
		arguments: { app: "Finder", keys: "super+k" },
		expected: { kind: "key", key: "k" },
	},
];

let closeHarness: (() => Promise<void>) | undefined;

afterEach(async () => {
	if (closeHarness !== undefined) {
		await closeHarness();
		closeHarness = undefined;
	}
});

describe("mutation routing #given every mutation tool #when token state varies #then dispatch requires one observed token", () => {
	it.each(cases)("guards and routes $name", async (testCase) => {
		const harness = await createHarness();
		closeHarness = harness.close;

		const missing = await harness.client.callTool({ name: testCase.name, arguments: testCase.arguments });
		const unobserved = await harness.client.callTool({
			name: testCase.name,
			arguments: { ...testCase.arguments, observation_token: "not-issued" },
		});
		expect(missing.isError).toBe(true);
		expect(unobserved.isError).toBe(true);
		expect(inputEffects(harness.computer.effects)).toEqual([]);

		const token = await observe(harness);
		const accepted = await harness.client.callTool({
			name: testCase.name,
			arguments: { ...testCase.arguments, observation_token: token },
		});
		const payload = jsonPayload(accepted);

		expect(accepted.isError).not.toBe(true);
		expect(inputEffects(harness.computer.effects)).toEqual([testCase.expected]);
		expect(payload).toMatchObject({
			actionDispatched: true,
			observationStatus: "changed",
			paused: false,
			needsExplicitObservation: false,
		});
		expect(payload["observation_token"]).toEqual(expect.any(String));
		expect(harness.computer.stateOptions.at(-1)).toEqual({
			...(testCase.name === "set_value" ? {} : { diffOnly: true, maxElements: 250 }),
			requireWindow: true,
			includeScreenshot: false,
		});
		expect(payload["treeOmitted"]).toBe(true);
		expect(payload["elements"]).toBeUndefined();

		const replay = await harness.client.callTool({
			name: testCase.name,
			arguments: { ...testCase.arguments, observation_token: token },
		});
		expect(replay.isError).toBe(true);
		expect(inputEffects(harness.computer.effects)).toEqual([testCase.expected]);
	});
});

describe("post-action payload #given a mutation #when the caller asks for the full tree #then the complete accessibility state is returned", () => {
	it("includes the tree only on request", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;
		const token = await observe(harness);

		const result = await harness.client.callTool({
			name: "click",
			arguments: { app: "Finder", observation_token: token, element_index: "9", full_state: true },
		});
		const payload = jsonPayload(result);

		expect(payload["elements"]).toHaveLength(3);
		expect(payload["treeOmitted"]).toBeUndefined();
		expect(harness.computer.stateOptions.at(-1)).toEqual({ requireWindow: true, includeScreenshot: false });
	});
});

describe("post-action payload #given a mutation that changes many controls #when the answer is compact #then it stays bounded", () => {
	it("bounds the diff and counts what it left out instead of echoing a screen-sized diff", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;
		const token = await observe(harness);
		harness.computer.syntheticRowCount = 300;

		const result = await harness.client.callTool({
			name: "click",
			arguments: { app: "Finder", observation_token: token, element_index: "9" },
		});
		const text = jsonText(result);
		const payload = jsonPayload(result);

		expect(payload["elements"]).toBeUndefined();
		expect(payload["axChangesOmitted"]).toMatchObject({ added: 275 });
		expect(copyForMatch(payload["axChanges"])).toMatchObject({ added: expect.any(Array) });
		expect((payload["axChanges"] as { added: unknown[] }).added).toHaveLength(25);
		expect(text.length).toBeLessThan(6000);
	});
});

describe("target validation #given a token observation #when ids, coordinates, or app differ #then input is rejected", () => {
	it.each([
		{ name: "click", arguments: { app: "Finder", element_index: "10" } },
		{ name: "set_value", arguments: { app: "Finder", element_index: "10", value: "x" } },
		{ name: "perform_secondary_action", arguments: { app: "Finder", element_index: "10", action: "AXShowMenu" } },
		{ name: "select_text", arguments: { app: "Finder", element_index: "10", text: "x" } },
		{ name: "scroll", arguments: { app: "Finder", element_index: "10", direction: "down" } },
		{ name: "click", arguments: { app: "Finder", x: 500, y: 0 } },
		{ name: "click", arguments: { app: "Finder", x: -1, y: 0 } },
		{ name: "click", arguments: { app: "Finder", x: 0, y: -1 } },
		{ name: "drag", arguments: { app: "Finder", from_x: 0, from_y: 0, to_x: 0, to_y: 400 } },
	])("rejects invalid target for $name", async (testCase) => {
		const harness = await createHarness();
		closeHarness = harness.close;
		const token = await observe(harness);

		const result = await harness.client.callTool({
			name: testCase.name,
			arguments: { ...testCase.arguments, observation_token: token },
		});
		const replay = await harness.client.callTool({
			name: "type_text",
			arguments: { app: "Finder", observation_token: token, text: "must not dispatch" },
		});

		expect(result.isError).toBe(true);
		expect(replay.isError).toBe(true);
		expect(inputEffects(harness.computer.effects)).toEqual([]);
		expect(harness.computer.preflightExpected).toEqual([]);
	});

	it("accepts the last in-bounds coordinate and maps only through the captured viewport", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;
		const token = await observe(harness);

		await harness.client.callTool({
			name: "click",
			arguments: { app: "Finder", observation_token: token, x: 499, y: 399 },
		});

		expect(inputEffects(harness.computer.effects)).toEqual([{ kind: "click", point: { x: 1298, y: 948 } }]);
	});

	it("consumes a valid token before rejecting an app mismatch", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;
		const token = await observe(harness);

		const mismatch = await harness.client.callTool({
			name: "type_text",
			arguments: { app: "Other", observation_token: token, text: "wrong target" },
		});
		const replay = await harness.client.callTool({
			name: "type_text",
			arguments: { app: "Finder", observation_token: token, text: "replay" },
		});

		expect(mismatch.isError).toBe(true);
		expect(replay.isError).toBe(true);
		expect(inputEffects(harness.computer.effects)).toEqual([]);
	});
});

describe("native preflight #given recorded metadata #when policy revokes input #then metadata is preserved and no action occurs", () => {
	it("passes the immutable observation unchanged and rejects revocation", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;
		const token = await observe(harness);
		const before = harness.computer.getInputObservation(1234);
		harness.computer.preflightResult = { ok: false, reason: "app-not-approved" };

		const result = await harness.client.callTool({
			name: "press_keys",
			arguments: { app: "Finder", observation_token: token, keys: ["Return"] },
		});

		expect(result.isError).toBe(true);
		expect(jsonPayload(result)).toMatchObject({
			actionDispatched: false,
			effect: "refused",
			reason: "app-not-approved",
			escalation: { target: "human", reason: "needs_user" },
			paused: true,
		});
		expect(harness.computer.preflightExpected).toEqual([defined(before)]);
		expect(harness.computer.getInputObservation(1234)).toBe(before);
		expect(inputEffects(harness.computer.effects)).toEqual([]);
	});
});

function inputEffects(effects: readonly Effect[]): readonly Effect[] {
	return effects.filter((effect) => effect.kind !== "close");
}
