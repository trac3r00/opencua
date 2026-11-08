import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { vi } from "@opencua/test-support";
import { createHarness, observe } from "./protocol-client-harness.js";
import type { Effect } from "./protocol-test-harness.js";
import { compactStepSchema, compactStepsSchema, parseRunSteps, runStepSchema } from "./tool-schemas.js";

/** Budgets for the serialized tools/list answer, so tool-list bloat cannot creep back. */
const LEAN_BUDGET_BYTES = 10_500;
// Measured revisions of the 32,000 cap: run_hands + get_tool_usage (34,556 bytes on 2026-10-25), then the named
// cursor-owner fields on manage_workers (36,097 bytes on 2026-10-31), then the single `surface` tool for opencua-owned
// windows (36,978 bytes on 2026-11-04), then the click `context` flag for windows several cursors share (37,078 bytes on
// 2026-11-04), then the per-worker `region` on manage_workers assignments (37,381 bytes on 2026-11-07), the
// surface `listen` op (37,459 bytes on 2026-11-07), then `surface` pointers (one page pointer per cursor) and the
// built-in opencua:board (37,617 bytes on 2026-11-08). The full list still omits the repeated per-type step schema.
const FULL_BUDGET_BYTES = 37_700;

let closeHarness: (() => Promise<void>) | undefined;

beforeEach(() => {
	vi.stubEnv("OPENCUA_BROWSER", "off");
});

afterEach(async () => {
	vi.unstubAllEnvs();
	if (closeHarness !== undefined) {
		await closeHarness();
		closeHarness = undefined;
	}
});

function inputEffects(effects: readonly Effect[]): readonly Effect[] {
	return effects.filter((effect) => effect.kind !== "close");
}

function errorText(result: unknown): string {
	if (typeof result !== "object" || result === null || !("content" in result) || !Array.isArray(result.content)) {
		throw new Error("tool result content must be an array");
	}
	return result.content
		.map((item: unknown) =>
			typeof item === "object" && item !== null && "text" in item && typeof item.text === "string" ? item.text : "",
		)
		.join("\n");
}

describe("tools/list #given each toolset profile #when serialized #then it stays within its byte budget", () => {
	it("keeps the lean list within budget", async () => {
		const harness = await createHarness(undefined, undefined, undefined, {
			serverOptions: { toolset: "lean", iphone: false },
		});
		closeHarness = harness.close;

		const bytes = Buffer.byteLength(JSON.stringify(await harness.client.listTools()));

		expect(bytes).toBeLessThanOrEqual(LEAN_BUDGET_BYTES);
	});

	it("keeps the full list within budget", async () => {
		const harness = await createHarness(undefined, undefined, undefined, {
			serverOptions: { toolset: "full", iphone: false },
		});
		closeHarness = harness.close;

		const bytes = Buffer.byteLength(JSON.stringify(await harness.client.listTools()));

		expect(bytes).toBeLessThanOrEqual(FULL_BUDGET_BYTES);
	});
});

describe("compact step schema #given the published run_steps and run_parallel schemas #when listed #then one flat step covers every step type", () => {
	it("lists every strict step type once and does not repeat fields per type", async () => {
		const harness = await createHarness(undefined, undefined, undefined, {
			serverOptions: { toolset: "full", iphone: false },
		});
		closeHarness = harness.close;
		const tools = new Map((await harness.client.listTools()).tools.map((tool) => [tool.name, tool]));

		const strictTypes = runStepSchema.options.map((option) => option.shape.type.value).sort();
		const compactTypes = [...compactStepSchema.shape.type.options].sort();
		expect(compactTypes).toEqual(strictTypes);

		const stepsSchema = tools.get("run_steps")?.inputSchema.properties?.["steps"];
		expect(JSON.stringify(stepsSchema)).not.toContain("oneOf");
		expect(JSON.stringify(stepsSchema)).not.toContain('anyOf":[{"type":"object"');
		// The step shape is published once, on run_steps: run_parallel and run_worker refer to it.
		expect(JSON.stringify(stepsSchema).split('"click_count":{').length - 1).toBe(1);
		expect(JSON.stringify(tools.get("run_parallel")?.inputSchema)).not.toContain('"click_count"');
		expect(JSON.stringify(tools.get("run_worker")?.inputSchema)).not.toContain('"click_count"');
	});

	it("keeps a click's context flag through the compact step, so a shared window can re-apply the pick", () => {
		const [step] = parseRunSteps(
			compactStepsSchema.parse([{ type: "click", x: 1, y: 2, context: true }]),
			"run_steps",
		);

		expect(step).toMatchObject({ type: "click", context: true });
	});
});

describe("run_steps #given a step the strict schema refuses #when the call arrives #then nothing dispatches and the error names the step", () => {
	it("refuses an out-of-range wait_for timeout and names its index, without running the valid step before it", async () => {
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
					{ type: "wait_for", target: { label: "Note" }, timeout_ms: 60_000 },
				],
			},
		});

		expect(result.isError).toBe(true);
		expect(errorText(result)).toContain("steps[1] (wait_for)");
		expect(errorText(result)).toContain("timeout_ms");
		expect(inputEffects(harness.computer.effects)).toEqual([]);
	});

	it("refuses a step missing the field its type requires", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;
		const token = await observe(harness);

		const result = await harness.client.callTool({
			name: "run_steps",
			arguments: {
				app: "Finder",
				observation_token: token,
				steps: [{ type: "set_value", element_index: "20" }],
			},
		});

		expect(result.isError).toBe(true);
		expect(errorText(result)).toContain("steps[0] (set_value)");
		expect(inputEffects(harness.computer.effects)).toEqual([]);
	});

	it("refuses a click that names its element both ways", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;
		const token = await observe(harness);

		const result = await harness.client.callTool({
			name: "run_steps",
			arguments: {
				app: "Finder",
				observation_token: token,
				steps: [{ type: "click", element_index: "9", target: { label: "Open" } }],
			},
		});

		expect(result.isError).toBe(true);
		expect(inputEffects(harness.computer.effects)).toEqual([]);
	});

	it("refuses an unknown step type and a bad enum value before dispatch", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;
		const token = await observe(harness);

		const unknownType = await harness.client.callTool({
			name: "run_steps",
			arguments: { app: "Finder", observation_token: token, steps: [{ type: "teleport" }] },
		});
		const badButton = await harness.client.callTool({
			name: "run_steps",
			arguments: {
				app: "Finder",
				observation_token: token,
				steps: [{ type: "click", element_index: "9", mouse_button: "back" }],
			},
		});

		expect(unknownType.isError).toBe(true);
		expect(badButton.isError).toBe(true);
		expect(inputEffects(harness.computer.effects)).toEqual([]);
	});

	it("still runs a valid step sent through the compact schema", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;
		const token = await observe(harness);

		const result = await harness.client.callTool({
			name: "run_steps",
			arguments: {
				app: "Finder",
				observation_token: token,
				steps: [{ type: "set_value", target: { role: "textfield", label: "Note" }, value: "hello" }],
			},
		});

		expect(result.isError).not.toBe(true);
		expect(inputEffects(harness.computer.effects)).toEqual([{ kind: "setValue", pid: 1234, id: 20, value: "hello" }]);
	});
});

describe("run_parallel #given a batch with an invalid step #when the call arrives #then no batch dispatches", () => {
	it("refuses the whole call and names the batch and step", async () => {
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
						steps: [{ type: "wait_for", target: { label: "Note" }, timeout_ms: 60_000 }],
					},
				],
			},
		});

		expect(result.isError).toBe(true);
		expect(errorText(result)).toContain("batches[1].steps[0] (wait_for)");
		expect(inputEffects(harness.computer.effects)).toEqual([]);
	});

	it("still drives every batch when all steps are valid", async () => {
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

		expect(result.isError).not.toBe(true);
		expect(harness.computer.effects).toContainEqual({ kind: "setValue", pid: 1234, id: 20, value: "f" });
		expect(harness.computer.effects).toContainEqual({ kind: "setValue", pid: 5678, id: 20, value: "o" });
	});
});
