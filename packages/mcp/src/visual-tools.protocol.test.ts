import { afterEach, describe, expect, it } from "bun:test";
import type { CreateMessageRequest, CreateMessageResult } from "@modelcontextprotocol/sdk/types.js";
import { copyForMatch } from "@opencua/test-support";
import { createHarness, jsonPayload } from "./protocol-client-harness.js";
import { FakeGuardedComputer } from "./protocol-test-harness.js";

let closeHarness: (() => Promise<void>) | undefined;

afterEach(async () => {
	if (closeHarness !== undefined) {
		await closeHarness();
		closeHarness = undefined;
	}
});

const visualResponse = JSON.stringify({
	elements: [
		{
			label: "Icon-only back",
			role: "button",
			interaction: "unknown",
			confidence: 0.8,
			frame: { x: 2, y: 2, width: 10, height: 10 },
		},
		{
			label: "Bottom action",
			role: "button",
			interaction: "click",
			confidence: 0.9,
			frame: { x: 20, y: 370, width: 40, height: 20 },
		},
	],
	coverage: { top: true, middle: true, bottom: true },
	truncated: false,
});

function sample(text: string): CreateMessageResult {
	return { role: "assistant", content: { type: "text", text }, model: "fake", stopReason: "endTurn" };
}

async function run(
	onSample?: (request: CreateMessageRequest) => CreateMessageResult | Promise<CreateMessageResult>,
	computer = new FakeGuardedComputer(),
) {
	const harness = await createHarness(computer, undefined, undefined, {
		capabilities: { sampling: {} },
		...(onSample === undefined ? {} : { onSample }),
	});
	closeHarness = harness.close;
	return harness;
}

describe("#given an approved observed window #when analyze_screen samples it #then pixels and token are preserved", () => {
	it("delivers the screenshot, reports regions, and leaves the original token usable once", async () => {
		let request: CreateMessageRequest | undefined;
		const harness = await run((value) => {
			request = value;
			return sample(visualResponse);
		});
		const result = await harness.client.callTool({
			name: "analyze_screen",
			arguments: { app: "Finder", window_id: 71 },
		});
		const payload = jsonPayload(result);
		expect(request?.params.messages[0]?.content).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "image", data: Buffer.from("png-bytes").toString("base64") }),
			]),
		);
		expect(request?.params.messages[0]?.content).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "text" })]),
		);
		expect(request?.params.includeContext).toBe("none");
		expect(request?.params.temperature).toBe(0);
		expect(request?.params.maxTokens).toBe(16_000);
		expect(request?.params).not.toHaveProperty("tools");
		expect(harness.computer.stateOptions.at(-1)).toMatchObject({ windowId: 71 });
		expect(copyForMatch(payload["visualAnalysis"])).toMatchObject({
			elements: expect.arrayContaining([
				expect.objectContaining({ label: "Icon-only back", frame: { x: 2, y: 2, width: 10, height: 10 } }),
				expect.objectContaining({ label: "Bottom action", frame: { x: 20, y: 370, width: 40, height: 20 } }),
			]),
			coverage: { top: true, middle: true, bottom: true },
		});
		expect(payload["visualAnalysisCompleteness"]).toEqual({
			inferredFromModelReportedCoverage: true,
			verified: false,
		});
		expect(payload).not.toHaveProperty("visualAnalysisComplete");
		expect(payload["observation_token"]).toEqual(expect.any(String));
		expect(result.content).toContainEqual({
			type: "image",
			data: Buffer.from("png-bytes").toString("base64"),
			mimeType: "image/png",
		});
		const token = payload["observation_token"];
		if (typeof token !== "string") throw new Error("expected observation token");
		const action = await harness.client.callTool({
			name: "click",
			arguments: { app: "Finder", observation_token: token, element_index: "9" },
		});
		expect(action.isError).not.toBe(true);
		const replay = await harness.client.callTool({
			name: "click",
			arguments: { app: "Finder", observation_token: token, element_index: "9" },
		});
		expect(replay.isError).toBe(true);
	});

	it("marks model-reported incomplete coverage as an incomplete inference", async () => {
		const harness = await run(() =>
			sample(
				JSON.stringify({
					elements: [],
					coverage: { top: true, middle: false, bottom: true },
					truncated: false,
				}),
			),
		);
		const payload = jsonPayload(
			await harness.client.callTool({ name: "analyze_screen", arguments: { app: "Finder" } }),
		);
		expect(payload["visualAnalysisCompleteness"]).toEqual({
			inferredFromModelReportedCoverage: false,
			verified: false,
		});
	});

	it("marks a sampling token limit as an incomplete inference", async () => {
		const harness = await run(() => ({
			...sample(visualResponse),
			stopReason: "maxTokens",
		}));
		const payload = jsonPayload(
			await harness.client.callTool({ name: "analyze_screen", arguments: { app: "Finder" } }),
		);
		expect(payload["visualAnalysisCompleteness"]).toEqual({
			inferredFromModelReportedCoverage: false,
			verified: false,
		});
	});
});

describe("#given visual sampling is unavailable #when analyze_screen runs #then original observation is retained", () => {
	it("succeeds with the observation, its image and token, and says no analysis was added, when sampling is unsupported", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;
		const result = await harness.client.callTool({ name: "analyze_screen", arguments: { app: "Finder" } });
		expect(result.isError).not.toBe(true);
		expect(Array.isArray(result.content) && result.content.some((item) => item.type === "image")).toBe(true);
		expect(jsonPayload(result)["visualAnalysisUnavailable"]).toContain("sampling unsupported");
		expect(jsonPayload(result)["observation_token"]).toEqual(expect.any(String));
	});

	it("reports missing images and malformed sample output honestly", async () => {
		const noImage = new FakeGuardedComputer();
		noImage.screenCaptureDenied = true;
		const missing = await run(() => sample(visualResponse), noImage);
		const missingResult = await missing.client.callTool({ name: "analyze_screen", arguments: { app: "Finder" } });
		expect(jsonPayload(missingResult)["visualAnalysisUnavailable"]).toContain("image unavailable");
		await closeHarness?.();
		closeHarness = undefined;

		const malformed = await run(() => sample("not json"));
		const malformedResult = await malformed.client.callTool({ name: "analyze_screen", arguments: { app: "Finder" } });
		expect(jsonPayload(malformedResult)).toMatchObject({
			visualAnalysisUnavailable: expect.stringContaining("malformed"),
			visualAnalysisFailure: "Visual analysis output must be valid JSON.",
		});
	});

	it("returns unavailable for a non-text sampling response", async () => {
		const harness = await run(() => ({
			role: "assistant",
			content: { type: "image", data: Buffer.from("sample").toString("base64"), mimeType: "image/png" },
			model: "fake",
			stopReason: "endTurn",
		}));
		const result = await harness.client.callTool({ name: "analyze_screen", arguments: { app: "Finder" } });
		expect(jsonPayload(result)["visualAnalysisUnavailable"]).toContain("non-text");
	});

	it("preserves bounded sampling refusal details", async () => {
		const refusal = `Sampling refused: ${"x".repeat(600)}`;
		const harness = await run(async () => {
			throw new Error(refusal);
		});
		const result = await harness.client.callTool({ name: "analyze_screen", arguments: { app: "Finder" } });
		const payload = jsonPayload(result);
		expect(payload["visualAnalysisUnavailable"]).toBe("client sampling failed");
		expect(payload["visualAnalysisFailure"]).toContain("Sampling refused:");
		expect(payload["visualAnalysisFailure"]).toHaveLength(500);
	});

	it("classifies abort errors as sampling cancellation and preserves their detail", async () => {
		const cancellation = new Error("sampling request cancelled");
		cancellation.name = "AbortError";
		const harness = await run(async () => {
			throw cancellation;
		});
		const result = await harness.client.callTool({ name: "analyze_screen", arguments: { app: "Finder" } });
		expect(jsonPayload(result)).toMatchObject({
			visualAnalysisUnavailable: "client sampling cancelled",
			visualAnalysisFailure: expect.stringContaining("sampling request cancelled"),
		});
	});

	it("does not sample through a system prompt and preserves the refusal", async () => {
		const computer = new FakeGuardedComputer();
		computer.systemPrompts = [
			{
				kind: "permission",
				title: "Permission",
				windowId: 17,
				ownerPid: 0,
				owner: "SecurityAgent",
				bounds: { x: 0, y: 0, width: 100, height: 100 },
			},
		];
		const harness = await createHarness(computer, undefined, undefined, {
			capabilities: { sampling: {} },
			// The app-state source supplies the system prompt included in this observation.
			onSample: () => sample(visualResponse),
		});
		closeHarness = harness.close;
		const result = await harness.client.callTool({ name: "analyze_screen", arguments: { app: "Finder" } });
		expect(result.isError).toBe(true);
		expect(jsonPayload(result)["visualAnalysisUnavailable"]).toContain("system prompt");
	});

	it("reports an observation approval refusal without sampling", async () => {
		const computer = new FakeGuardedComputer();
		computer.stateError = new Error("Computer Use needs your approval");
		const harness = await run(() => sample(visualResponse), computer);
		const result = await harness.client.callTool({ name: "analyze_screen", arguments: { app: "Finder" } });
		expect(jsonPayload(result)).toMatchObject({
			visualAnalysisUnavailable: expect.stringContaining("observation refused"),
			reason: "Computer Use needs your approval",
		});
	});
});
