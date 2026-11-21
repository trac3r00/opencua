import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { GuardedSession } from "./guarded-session.js";
import { type ToolContent, type ToolResult, textResult } from "./tool-result.js";
import { parseVisualAnalysis, visualAnalysisPrompt } from "./visual-analysis.js";

const analyzeScreenSchema = z.object({
	app: z.string().min(1),
	window_id: z.number().int().positive().optional(),
});

const observationStateSchema = z
	.object({
		screenshotWidth: z.number().positive().optional(),
		screenshotHeight: z.number().positive().optional(),
		systemPrompts: z.array(z.unknown()).optional(),
	})
	.catchall(z.unknown());

const MAX_SAMPLE_TOKENS = 16_000;
const SAMPLE_TIMEOUT_MILLISECONDS = 180_000;
const MAX_FAILURE_DETAIL_LENGTH = 500;

export function registerVisualTools(server: McpServer, session: GuardedSession): void {
	server.registerTool(
		"analyze_screen",
		{
			description:
				"Describe an approved app window using client image sampling. Pixel regions are estimates, not accessibility ids or actions. Returns the observation and token for a separately guarded action.",
			inputSchema: analyzeScreenSchema,
			annotations: { readOnlyHint: true, destructiveHint: false },
		},
		async (input, extra) => {
			let observation: ToolResult;
			try {
				observation = await session.observe({
					app: input.app,
					diffOnly: false,
					includeScreenshot: true,
					...(input.window_id === undefined ? {} : { windowId: input.window_id }),
				});
			} catch (error: unknown) {
				return {
					...textResult(
						JSON.stringify({
							visualAnalysisUnavailable: "approved observation refused; direct agent fallback required",
							reason: error instanceof Error ? error.message : String(error),
						}),
					),
					isError: true,
				};
			}
			const observed = readObservationPayload(observation);
			const state = observed;
			const image = observation.content.find((item) => item.type === "image");
			const unavailable = (reason: string, error?: unknown, isError = true): ToolResult =>
				withVisualMetadata(
					observation,
					observed,
					{
						visualAnalysisUnavailable: reason,
						...(error === undefined ? {} : { visualAnalysisFailure: failureDetail(error) }),
					},
					isError,
				);

			if (state?.systemPrompts !== undefined && state.systemPrompts.length > 0) {
				return unavailable("system prompt present; direct agent visual fallback required");
			}
			if (image === undefined || state?.screenshotWidth === undefined || state.screenshotHeight === undefined) {
				return unavailable("approved window image unavailable");
			}
			if (server.server.getClientCapabilities()?.sampling === undefined) {
				// Most agent clients cannot sample. The observation, its image and its token are still a complete answer the
				// agent reads itself, so this is a success that says no server-side analysis was added, not a failure.
				return unavailable("client sampling unsupported; direct agent visual fallback required", undefined, false);
			}

			let sample: Awaited<ReturnType<typeof server.server.createMessage>>;
			try {
				sample = await server.server.createMessage(
					{
						messages: [
							{
								role: "user",
								content: [
									{
										type: "text",
										text: visualAnalysisPrompt(state.screenshotWidth, state.screenshotHeight),
									},
									{ type: "image", data: image.data, mimeType: image.mimeType },
								],
							},
						],
						includeContext: "none",
						temperature: 0,
						maxTokens: MAX_SAMPLE_TOKENS,
					},
					{ signal: extra.signal, timeout: SAMPLE_TIMEOUT_MILLISECONDS },
				);
			} catch (error: unknown) {
				const cancelled =
					extra.signal?.aborted === true ||
					(error instanceof Error &&
						(error.name === "AbortError" ||
							/\b(cancel|cancelled|canceled|abort|aborted)\b/i.test(error.message)));
				return unavailable(cancelled ? "client sampling cancelled" : "client sampling failed", error);
			}
			const sampledText = Array.isArray(sample.content)
				? sample.content.find((item) => item.type === "text")
				: sample.content.type === "text"
					? sample.content
					: undefined;
			if (sampledText === undefined) return unavailable("client sampling returned non-text content");

			let visualAnalysis: ReturnType<typeof parseVisualAnalysis>;
			try {
				visualAnalysis = parseVisualAnalysis(sampledText.text, state.screenshotWidth, state.screenshotHeight);
			} catch (error: unknown) {
				return unavailable("client sampling returned malformed visual analysis", error);
			}
			const inferredComplete =
				visualAnalysis.coverage.top &&
				visualAnalysis.coverage.middle &&
				visualAnalysis.coverage.bottom &&
				!visualAnalysis.truncated &&
				sample.stopReason !== "maxTokens";
			return withVisualMetadata(observation, observed, {
				visualAnalysis,
				visualAnalysisSource: "client-sampling",
				visualAnalysisCoordinates: "screenshot pixels, origin at top-left",
				visualAnalysisCompleteness: {
					inferredFromModelReportedCoverage: inferredComplete,
					verified: false,
				},
			});
		},
	);
}

function readObservationPayload(observation: ToolResult): z.infer<typeof observationStateSchema> | undefined {
	const text = observation.content.find((item) => item.type === "text");
	if (text === undefined) return undefined;
	try {
		const parsed: unknown = JSON.parse(text.text);
		const result = observationStateSchema.safeParse(parsed);
		return result.success ? result.data : undefined;
	} catch {
		return undefined;
	}
}

function failureDetail(error: unknown): string {
	const detail = error instanceof Error ? error.message : String(error);
	return detail.slice(0, MAX_FAILURE_DETAIL_LENGTH);
}

function withVisualMetadata(
	observation: ToolResult,
	payload: z.infer<typeof observationStateSchema> | undefined,
	metadata: Record<string, unknown>,
	isError = false,
): ToolResult {
	const content: ToolContent[] =
		payload === undefined
			? [...observation.content, ...textResult(JSON.stringify(metadata)).content]
			: observation.content.map((item) =>
					item.type === "text" ? { ...item, text: JSON.stringify({ ...payload, ...metadata }, null, 2) } : item,
				);
	return { content, ...(isError ? { isError: true } : {}) };
}
