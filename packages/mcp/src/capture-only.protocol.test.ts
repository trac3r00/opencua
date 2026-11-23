import { afterEach, describe, expect, it } from "bun:test";
import { createHarness, jsonPayload, observe } from "./protocol-client-harness.js";

let closeHarness: (() => Promise<void>) | undefined;

afterEach(async () => {
	if (closeHarness !== undefined) {
		await closeHarness();
		closeHarness = undefined;
	}
});

function imageBlocks(result: unknown): readonly unknown[] {
	if (typeof result !== "object" || result === null || !("content" in result) || !Array.isArray(result.content)) {
		throw new Error("tool result content must be an array");
	}
	return result.content.filter(
		(item: unknown) => typeof item === "object" && item !== null && "type" in item && item.type === "image",
	);
}

describe("capture-only observation #given a caller that already holds the tree #when it skips the tree #then the answer is pixels only and authorizes no element action", () => {
	it("returns the image and no elements, issues no token, refuses a stale element action, and recovers on a fresh tree", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;
		const heldToken = await observe(harness);

		const captureOnly = await harness.client.callTool({
			name: "get_app_state",
			arguments: { profile: "full", app: "Finder", include_accessibility_tree: false },
		});
		const payload = jsonPayload(captureOnly);

		expect(imageBlocks(captureOnly)).toHaveLength(1);
		expect(payload["elements"]).toBeUndefined();
		expect(payload["treeSkipped"]).toBe(true);
		expect(payload).not.toHaveProperty("observation_token");
		expect(harness.computer.stateOptions.at(-1)).toMatchObject({
			includeAccessibilityTree: false,
			requireWindow: true,
		});

		const refused = await harness.client.callTool({
			name: "click",
			arguments: { app: "Finder", observation_token: heldToken, element_index: "9" },
		});
		expect(refused.isError).toBe(true);

		const freshToken = await observe(harness);
		const authorized = await harness.client.callTool({
			name: "click",
			arguments: { app: "Finder", observation_token: freshToken, element_index: "9" },
		});
		expect(authorized.isError).toBeFalsy();
	});

	it("forwards the caller's settle_ms so the cheap path skips the settle wait too", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;

		await harness.client.callTool({
			name: "get_app_state",
			arguments: { profile: "full", app: "Finder", include_accessibility_tree: false, settle_ms: 0 },
		});

		expect(harness.computer.stateOptions.at(-1)).toMatchObject({
			includeAccessibilityTree: false,
			settleMs: 0,
		});
	});

	it("resolves profile fast to a screenshot-free, unsettled, capped semantic observation", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;

		const result = await harness.client.callTool({
			name: "get_app_state",
			arguments: { app: "Finder", profile: "fast" },
		});

		expect(imageBlocks(result)).toHaveLength(0);
		expect(harness.computer.stateOptions.at(-1)).toMatchObject({
			includeScreenshot: false,
			settleMs: 0,
			maxElements: 250,
		});
	});

	it("resolves profile visual to an image-only observation", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;

		const result = await harness.client.callTool({
			name: "get_app_state",
			arguments: { app: "Finder", profile: "visual" },
		});

		expect(imageBlocks(result)).toHaveLength(1);
		expect(harness.computer.stateOptions.at(-1)).toMatchObject({
			includeScreenshot: true,
			includeAccessibilityTree: false,
		});
	});
});
