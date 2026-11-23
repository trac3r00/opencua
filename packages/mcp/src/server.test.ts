import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AppApprovalStore } from "@opencua/core";
import { vi } from "@opencua/test-support";
import { toolNamesFor } from "./mcp-server.js";
import { allowedBundleIdsFromEnvironment } from "./native-policy.js";
import { createHarness, jsonPayload } from "./protocol-client-harness.js";
import type { FakeGuardedComputer } from "./protocol-test-harness.js";

const MUTATION_NAMES = [
	"click",
	"perform_secondary_action",
	"set_value",
	"set_fields",
	"run_steps",
	"run_hands",
	"run_worker",
	"select_text",
	"drag",
	"scroll",
	"type_text",
	"press_keys",
	"invoke_menu",
	"set_window_frame",
	"clipboard_write",
] as const;

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

describe("MCP metadata #given a connected client #when initialized #then the context-first contract is advertised", () => {
	it("publishes instructions, every tool, required mutation tokens, and conservative annotations", async () => {
		const harness = await createHarness(undefined, undefined, undefined, {
			serverOptions: { toolset: "full", iphone: false },
		});
		closeHarness = harness.close;

		const result = await harness.client.listTools();
		const tools = new Map(result.tools.map((tool) => [tool.name, tool]));

		expect(harness.client.getInstructions()).toEqual(expect.any(String));
		expect([...tools.keys()].sort()).toEqual([...toolNamesFor("full", false)].sort());
		expect(tools.get("list_apps")?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
		expect(tools.get("get_app_state")?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
		for (const name of MUTATION_NAMES) {
			expect(tools.get(name)?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
			expect(tools.get(name)?.inputSchema.required).toContain("observation_token");
		}
		expect(tools.get("manage_workers")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
		expect(tools.get("manage_workers")?.inputSchema.required).toContain("op");
		expect(tools.get("manage_workers")?.inputSchema.properties).toHaveProperty("assignments");
		expect(tools.get("manage_workers")?.inputSchema.properties).toHaveProperty("worker_id");
	});
});

describe("native allowlist #given host configuration #when defaults are built #then restrictions are optional and exact", () => {
	it("allows an unset restriction and normalizes configured comma-separated bundle ids", () => {
		const emptyStore = new AppApprovalStore(allowedBundleIdsFromEnvironment(undefined));
		const configuredStore = new AppApprovalStore(
			allowedBundleIdsFromEnvironment(" com.apple.Finder, ,COM.EXAMPLE.Editor "),
		);

		expect(emptyStore.decide("com.apple.finder")).toBe("approved");
		expect(configuredStore.decide("COM.APPLE.FINDER")).toBe("approved");
		expect(configuredStore.decide("com.example.editor")).toBe("approved");
		expect(configuredStore.decide("com.example.other")).toBe("needs-approval");
	});
});

describe("strict observations #given an approved app #when state is requested #then a window-bound token is returned", () => {
	it("returns image and JSON without discarding the first full tree", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;

		const result = await harness.client.callTool({
			name: "get_app_state",
			arguments: { profile: "full", app: "Finder", diff_only: true },
		});
		const payload = jsonPayload(result);

		expect(result.content).toContainEqual({
			type: "image",
			data: Buffer.from("png-bytes").toString("base64"),
			mimeType: "image/png",
		});
		expect(payload["elements"]).toEqual([
			expect.objectContaining({ id: 9 }),
			expect.objectContaining({ id: 20 }),
			expect.objectContaining({ id: 21 }),
		]);
		expect(payload["observation_token"]).toEqual(expect.any(String));
		expect(harness.computer.stateOptions).toEqual([{ diffOnly: true, requireWindow: true }]);
	});

	it("mints no usable token when strict window observation fails", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;
		harness.computer.stateError = new Error("target window missing");

		const observation = await harness.client.callTool({
			name: "get_app_state",
			arguments: { profile: "full", app: "Finder" },
		});
		const mutation = await harness.client.callTool({
			name: "click",
			arguments: { app: "Finder", observation_token: "unobserved", element_index: "9" },
		});

		expect(observation.isError).toBe(true);
		expect(mutation.isError).toBe(true);
		expect(inputEffects(harness.computer)).toEqual([]);
		expect(harness.computer.stateOptions).toEqual([{ requireWindow: true }]);
	});

	it("closes the owned computer once when the server session closes", async () => {
		const harness = await createHarness();
		await harness.close();

		expect(harness.computer.effects).toEqual([{ kind: "close" }]);
	});
});

function inputEffects(computer: FakeGuardedComputer) {
	return computer.effects.filter((effect) => effect.kind !== "close");
}
