import { type Static, Type } from "typebox";

import type { DisplayConfig } from "./computer-use/coords.js";

export const ANTHROPIC_NATIVE_COMPUTER_TOOL_NAME = "computer";

export interface AnthropicComputerToolVersion {
	readonly type: string;
	readonly beta: string;
}

/** Claude Opus 4.5, 4.6, 4.7 and Sonnet 4.6 take computer use only through this version (they reject 20250124). */
export const ANTHROPIC_COMPUTER_TOOL_20251124: AnthropicComputerToolVersion = {
	type: "computer_20251124",
	beta: "computer-use-2025-11-24",
};
/** The version every earlier documented model takes (Sonnet 4.5, 4, 3.7, 3.5, Opus 4 and 4.1, Haiku 4.5). */
export const ANTHROPIC_COMPUTER_TOOL_20250124: AnthropicComputerToolVersion = {
	type: "computer_20250124",
	beta: "computer-use-2025-01-24",
};
const COMPUTER_20251124_MODEL = /(opus-4[-.][5-7]|sonnet-4[-.]6)(?!\d)/;

/** The computer tool version and beta header a model accepts. */
export function anthropicComputerToolVersion(modelId: string): AnthropicComputerToolVersion {
	return COMPUTER_20251124_MODEL.test(modelId.toLowerCase())
		? ANTHROPIC_COMPUTER_TOOL_20251124
		: ANTHROPIC_COMPUTER_TOOL_20250124;
}

// Anthropic documents the native computer tool on Sonnet 4.5, Sonnet 4, 3.7 Sonnet,
// 3.5 Sonnet, Opus 4.x and Haiku 4.5. Each family prefix covers the dated and dotted id
// variants, so no documented generation silently loses the native path.
const SUPPORTS_NATIVE_COMPUTER_MODEL_MARKERS = [
	"sonnet-4",
	"4-sonnet",
	"sonnet-3-5",
	"sonnet-3.5",
	"3-5-sonnet",
	"3.5-sonnet",
	"3-7-sonnet",
	"3.7-sonnet",
	"opus-4",
	"haiku-4",
] as const;

type ToolDefinition = Record<string, unknown>;

const coordinateSchema = Type.Array(Type.Number(), { minItems: 2, maxItems: 2 });

export const anthropicComputerToolSchema = Type.Object(
	{
		action: Type.Union([
			Type.Literal("screenshot"),
			Type.Literal("key"),
			Type.Literal("type"),
			Type.Literal("mouse_move"),
			Type.Literal("left_click"),
			Type.Literal("right_click"),
			Type.Literal("middle_click"),
			Type.Literal("double_click"),
			Type.Literal("triple_click"),
			Type.Literal("left_click_drag"),
			Type.Literal("cursor_position"),
			Type.Literal("left_mouse_down"),
			Type.Literal("left_mouse_up"),
			Type.Literal("scroll"),
			Type.Literal("hold_key"),
			Type.Literal("wait"),
		]),
		coordinate: Type.Optional(coordinateSchema),
		start_coordinate: Type.Optional(coordinateSchema),
		text: Type.Optional(Type.String()),
		key: Type.Optional(Type.String()),
		scroll_direction: Type.Optional(
			Type.Union([Type.Literal("up"), Type.Literal("down"), Type.Literal("left"), Type.Literal("right")]),
		),
		scroll_amount: Type.Optional(Type.Number()),
		duration: Type.Optional(Type.Number()),
	},
	{ additionalProperties: false },
);

export const computerToolSchema = anthropicComputerToolSchema;
export type ComputerToolInput = Static<typeof anthropicComputerToolSchema>;

export function supportsAnthropicNativeComputerUse(modelId: string | undefined): boolean {
	if (modelId === undefined) {
		return false;
	}
	const normalized = modelId.toLowerCase();
	return SUPPORTS_NATIVE_COMPUTER_MODEL_MARKERS.some((marker) => normalized.includes(marker));
}

function sanitizeTools(tools: readonly unknown[]): ToolDefinition[] {
	const sanitizedTools: ToolDefinition[] = [];
	for (const tool of tools) {
		if (!isRecord(tool)) {
			continue;
		}
		const shouldStripFunctionVariant =
			tool["name"] === ANTHROPIC_NATIVE_COMPUTER_TOOL_NAME && !isComputerToolType(tool["type"]);
		if (!shouldStripFunctionVariant) {
			sanitizedTools.push(tool);
		}
	}
	return sanitizedTools;
}

function mergeBetaHeader(existing: unknown, beta: string): string {
	const existingParts =
		typeof existing === "string"
			? existing
					.split(",")
					.map((part) => part.trim())
					.filter(Boolean)
			: [];
	if (existingParts.includes(beta)) {
		return existingParts.join(",");
	}
	return [...existingParts, beta].join(",");
}

export function addAnthropicComputerUseToPayload(
	api: string | undefined,
	payload: unknown,
	display: DisplayConfig,
	modelId?: string,
): unknown {
	if (
		api !== "anthropic-messages" ||
		!isRecord(payload) ||
		modelId === undefined ||
		!supportsAnthropicNativeComputerUse(modelId)
	) {
		return payload;
	}
	const version = anthropicComputerToolVersion(modelId);

	const tools = Array.isArray(payload["tools"]) ? payload["tools"] : [];
	const sanitizedTools = sanitizeTools(tools);
	const hasNativeComputer = sanitizedTools.some((tool) => isComputerToolType(tool["type"]));
	if (!hasNativeComputer) {
		sanitizedTools.push({
			type: version.type,
			name: ANTHROPIC_NATIVE_COMPUTER_TOOL_NAME,
			display_width_px: display.modelWidth,
			display_height_px: display.modelHeight,
		});
	}

	const extraBody = payload["extra_body"];
	const existingBetas = isRecord(extraBody) ? extraBody["betas"] : undefined;
	const mergedBetas = Array.isArray(existingBetas)
		? existingBetas.includes(version.beta)
			? existingBetas
			: [...existingBetas, version.beta]
		: [version.beta];
	const headers = payload["headers"];
	const headerRecord = isRecord(headers) ? headers : {};

	return {
		...payload,
		tools: sanitizedTools,
		headers: { ...headerRecord, "anthropic-beta": mergeBetaHeader(headerRecord["anthropic-beta"], version.beta) },
		extra_body: { ...(isRecord(extraBody) ? extraBody : {}), betas: mergedBetas },
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isComputerToolType(value: unknown): value is string {
	return typeof value === "string" && value.startsWith("computer_");
}
