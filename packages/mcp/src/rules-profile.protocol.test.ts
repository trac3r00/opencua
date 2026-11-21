import { afterEach, describe, expect, it } from "bun:test";

import { createHarness, jsonPayload, observe } from "./protocol-client-harness.js";
import { FakeGuardedComputer } from "./protocol-test-harness.js";
import { parseRulesProfile } from "./rules-profile.js";

let closeHarness: (() => Promise<void>) | undefined;

afterEach(async () => {
	if (closeHarness !== undefined) {
		await closeHarness();
		closeHarness = undefined;
	}
});

async function runBatch(rules: unknown, pace?: "verified" | "fast"): Promise<Record<string, unknown>> {
	const profile = parseRulesProfile(rules);
	const harness = await createHarness(new FakeGuardedComputer(), undefined, undefined, {
		serverOptions: { rulesProfile: () => profile },
	});
	closeHarness = harness.close;
	const token = await observe(harness);
	const result = await harness.client.callTool({
		name: "run_steps",
		arguments: {
			app: "Finder",
			observation_token: token,
			steps: [{ type: "set_value", element_index: "20", value: "ready" }],
			...(pace === undefined ? {} : { pace }),
		},
	});
	expect(result.isError).not.toBe(true);
	return jsonPayload(result);
}

describe("#given an app rule for batch pace #when a batch names no pace #then the rule decides it", () => {
	it("runs fast when the app's rule says fast", async () => {
		const payload = await runBatch({ apps: { Finder: { pace: "fast" } } });

		expect(payload["runSteps"]).toMatchObject({ pace: "fast" });
	});

	it("keeps the verified default for apps without a rule", async () => {
		const payload = await runBatch({ apps: { Safari: { pace: "fast" } } });

		expect(payload["runSteps"]).not.toHaveProperty("pace");
	});

	it("lets a pace named in the call win over the rule", async () => {
		const payload = await runBatch({ apps: { Finder: { pace: "fast" } } }, "verified");

		expect(payload["runSteps"]).not.toHaveProperty("pace");
	});
});
