import { afterEach, describe, expect, it } from "bun:test";
import type { AppState, AppStateOptions, PreflightResult, TopLevelWindow } from "@opencua/core";
import { createHarness, jsonPayload, observe } from "./protocol-client-harness.js";
import { Deferred, FakeGuardedComputer } from "./protocol-test-harness.js";

let closeHarness: (() => Promise<void>) | undefined;

afterEach(async () => {
	await closeHarness?.();
	closeHarness = undefined;
});

describe("#given a one-step pointer lane #when run_hands clicks #then the call keeps one preflight and a capped outcome read", () => {
	it("does not preflight the first lane step a second time", async () => {
		const computer = new FakeGuardedComputer();
		computer.delivery = "background";
		const harness = await createHarness(computer);
		closeHarness = harness.close;
		const token = await observe(harness);
		const readsBefore = computer.stateOptions.length;

		await harness.client.callTool({
			name: "run_hands",
			arguments: {
				app: "Finder",
				observation_token: token,
				pointer: [{ type: "click", element_index: "9" }],
				outcome: "live",
			},
		});

		expect(computer.preflightExpected).toHaveLength(1);
		expect(computer.stateOptions).toHaveLength(readsBefore + 1);
		expect(computer.stateOptions.at(-1)).toMatchObject({
			diffOnly: true,
			maxElements: 250,
			requireWindow: true,
		});
	});
});

describe("#given a two-step pointer lane #when run_hands clicks twice #then only the second step preflights again", () => {
	it("retains the full guard after the first dispatched step", async () => {
		const computer = new FakeGuardedComputer();
		computer.delivery = "background";
		const harness = await createHarness(computer);
		closeHarness = harness.close;
		const token = await observe(harness);

		await harness.client.callTool({
			name: "run_hands",
			arguments: {
				app: "Finder",
				observation_token: token,
				pointer: [
					{ type: "click", element_index: "9" },
					{ type: "click", element_index: "9" },
				],
			},
		});

		expect(computer.preflightExpected).toHaveLength(2);
	});
});

describe("#given a window baseline and a preflight #when run_hands starts #then the baseline listing overlaps the safety gate", () => {
	it("enters both probes before releasing either", async () => {
		const computer = new FakeGuardedComputer();
		computer.delivery = "background";
		const probeEntered = new Deferred<void>();
		const releaseProbe = new Deferred<void>();
		let probeStarted = false;
		const windows: readonly TopLevelWindow[] = [
			{
				id: 71,
				ownerPid: 1234,
				ownerName: "Finder",
				title: "a.txt",
				bounds: { x: 0, y: 0, width: 800, height: 600 },
			},
		];
		const harness = await createHarness(computer, async () => {
			if (!probeStarted) {
				probeStarted = true;
				probeEntered.resolve(undefined);
			}
			await releaseProbe.promise;
			return windows;
		});
		closeHarness = harness.close;
		const token = await observe(harness);
		const preflightEntered = new Deferred<void>();
		const preflightDecision = new Deferred<PreflightResult>();
		computer.preflightEntered = preflightEntered;
		computer.preflightGate = preflightDecision;

		const pending = harness.client.callTool({
			name: "run_hands",
			arguments: {
				app: "Finder",
				observation_token: token,
				pointer: [{ type: "click", element_index: "9" }],
			},
		});
		await Promise.all([probeEntered.promise, preflightEntered.promise]);
		releaseProbe.resolve(undefined);
		preflightDecision.resolve({ ok: true });
		await pending;

		expect(computer.preflightExpected).toHaveLength(1);
	});
});

describe("#given a text-only call #when run_hands types #then it does not probe windows that text cannot change", () => {
	it("keeps the window listing out of the typing path", async () => {
		const computer = new FakeGuardedComputer();
		computer.delivery = "background";
		let probes = 0;
		const harness = await createHarness(computer, async () => {
			probes += 1;
			return [];
		});
		closeHarness = harness.close;
		const token = await observe(harness);

		await harness.client.callTool({
			name: "run_hands",
			arguments: {
				app: "Finder",
				observation_token: token,
				keyboard: [{ type: "type_text", text: "text only" }],
			},
		});

		expect(probes).toBe(0);
	});
});

describe("#given a final type_text step #when run_hands has no expectation #then the final write skips its settlement fence", () => {
	it("keeps the fence on the earlier write only", async () => {
		// Settlement fences belong to the constant rhythm's one-shot accessibility write.
		process.env["OPENCUA_TYPE_RHYTHM"] = "constant";
		const computer = new FakeGuardedComputer();
		computer.delivery = "background";
		const harness = await createHarness(computer);
		closeHarness = harness.close;
		const token = await observe(harness);

		await harness.client.callTool({
			name: "run_hands",
			arguments: {
				app: "Finder",
				observation_token: token,
				keyboard: [
					{ type: "type_text", text: "first" },
					{ type: "type_text", text: "second" },
				],
			},
		});

		expect(computer.typeOptions).toEqual([{ settleWrite: true }, { settleWrite: false }]);
		Reflect.deleteProperty(process.env, "OPENCUA_TYPE_RHYTHM");
	});
});

describe("#given a live outcome with a gated capture #when run_hands has no input lane #then the outcome read overlaps the capture", () => {
	it("starts both reads before releasing the screenshot", async () => {
		class GatedVisionComputer extends FakeGuardedComputer {
			readonly visionEntered = new Deferred<void>();
			readonly outcomeEntered = new Deferred<void>();
			readonly releaseVision = new Deferred<void>();

			override async getAppState(targetPid = 1234, options?: AppStateOptions): Promise<AppState> {
				if (options?.includeAccessibilityTree === false) {
					this.visionEntered.resolve(undefined);
					await this.releaseVision.promise;
				} else if (options?.diffOnly === true) {
					this.outcomeEntered.resolve(undefined);
				}
				return await super.getAppState(targetPid, options);
			}
		}

		const computer = new GatedVisionComputer();
		computer.delivery = "background";
		const harness = await createHarness(computer);
		closeHarness = harness.close;
		const token = await observe(harness);

		const pending = harness.client.callTool({
			name: "run_hands",
			arguments: {
				app: "Finder",
				observation_token: token,
				vision: { include_screenshot: true },
				outcome: "live",
			},
		});
		await computer.visionEntered.promise;
		await computer.outcomeEntered.promise;
		computer.releaseVision.resolve(undefined);
		const result = await pending;

		expect(jsonPayload(result)["actionDispatched"]).toBe(false);
	}, 2_000);
});

describe("#given an expectation that passes #when run_hands finishes #then it verifies the outcome read instead of taking a pre-read", () => {
	it("uses one post-action observation", async () => {
		const computer = new FakeGuardedComputer();
		computer.delivery = "background";
		const harness = await createHarness(computer);
		closeHarness = harness.close;
		const token = await observe(harness);
		const readsBefore = computer.stateOptions.length;

		await harness.client.callTool({
			name: "run_hands",
			arguments: {
				app: "Finder",
				observation_token: token,
				pointer: [{ type: "click", element_index: "9" }],
				expect: {
					checks: [{ element_index: "9" }],
					timeout_ms: 1000,
				},
			},
		});

		expect(computer.stateOptions).toHaveLength(readsBefore + 1);
	});
});
