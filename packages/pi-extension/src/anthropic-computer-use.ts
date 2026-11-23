import type { ComputerToolInput } from "./anthropic-payload.js";
export {
	ANTHROPIC_COMPUTER_TOOL_20250124,
	ANTHROPIC_COMPUTER_TOOL_20251124,
	ANTHROPIC_NATIVE_COMPUTER_TOOL_NAME,
	addAnthropicComputerUseToPayload,
	anthropicComputerToolVersion,
	computerToolSchema,
	supportsAnthropicNativeComputerUse,
} from "./anthropic-payload.js";
export type { ComputerToolInput } from "./anthropic-payload.js";
import {
	type ClickOptions,
	ComputerUseError,
	type ComputerUseResult,
	MCP_GAPS,
	type NativeComputer,
	type Point,
	errorMessage,
	textResult,
	unsupportedAction,
} from "./computer-use/native-computer.js";
export { ComputerUseError } from "./computer-use/native-computer.js";
export type { ComputerUseResult, NativeComputer } from "./computer-use/native-computer.js";

const MAX_WAIT_SECONDS = 10;

export function buildComputerUseSection(): string {
	return "## Computer Use\n`computer` drives the app window you last observed with `get_app_state`, so call that first. Its screenshot re-observes that window, coordinates are pixels in that screenshot, and every action answers with what changed. An answer without an observation_token means take a screenshot before acting again. `computer` cannot scroll at a point, hover or read the pointer; use the element tools for those.\n";
}

/** One Anthropic computer action (computer_20250124 or computer_20251124) as opencua-mcp calls; actions the server cannot do are refused by name. */
export async function executeNativeComputerAction(
	input: ComputerToolInput,
	computer: NativeComputer,
): Promise<ComputerUseResult> {
	try {
		switch (input.action) {
			case "screenshot":
				return await computer.screenshot();
			case "left_click":
				return await computer.click(parseCoordinate(input.coordinate, "left_click"), clickOf("left", 1));
			case "right_click":
				return await computer.click(parseCoordinate(input.coordinate, "right_click"), clickOf("right", 1));
			case "middle_click":
				return await computer.click(parseCoordinate(input.coordinate, "middle_click"), clickOf("middle", 1));
			case "double_click":
				return await computer.click(parseCoordinate(input.coordinate, "double_click"), clickOf("left", 2));
			case "triple_click":
				return await computer.click(parseCoordinate(input.coordinate, "triple_click"), clickOf("left", 3));
			case "left_click_drag":
				return await computer.drag(
					parseCoordinate(input.start_coordinate, "left_click_drag.start_coordinate"),
					parseCoordinate(input.coordinate, "left_click_drag.coordinate"),
				);
			case "key":
				return await computer.pressKeys(parseKeySequence(input.text ?? input.key));
			case "hold_key":
				return await computer.pressKeys([
					{ key: parseText(input.text ?? input.key, "hold_key"), hold_seconds: parseHoldSeconds(input.duration) },
				]);
			case "type":
				return await computer.typeText(parseText(input.text, "type"));
			case "wait":
				await computer.wait(parseWaitDurationMilliseconds(input.duration));
				return textResult("wait complete");
			case "scroll":
				throw unsupportedAction(input.action, MCP_GAPS.scroll);
			case "mouse_move":
				throw unsupportedAction(input.action, MCP_GAPS.pointerMove);
			case "cursor_position":
				throw unsupportedAction(input.action, MCP_GAPS.cursorPosition);
			case "left_mouse_down":
			case "left_mouse_up":
				throw unsupportedAction(input.action, MCP_GAPS.mouseButtonPhase);
		}
	} catch (error) {
		if (error instanceof ComputerUseError) {
			throw error;
		}
		throw new ComputerUseError("execution_failed", errorMessage(error), { action: input.action, cause: error });
	}
}

function clickOf(button: ClickOptions["button"], count: number): ClickOptions {
	return { button, count, modifiers: [] };
}

function parseCoordinate(coordinate: readonly number[] | undefined, action: string): Point {
	if (coordinate === undefined || coordinate.length !== 2) {
		throw new ComputerUseError("invalid_arguments", `${action} requires coordinate [x, y]`);
	}
	const x = coordinate[0];
	const y = coordinate[1];
	if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
		throw new ComputerUseError("invalid_arguments", `${action} requires finite coordinate [x, y]`);
	}
	return { x, y };
}

function parseText(text: string | undefined, action: string): string {
	if (text === undefined || text.length === 0) {
		throw new ComputerUseError("invalid_arguments", `${action} requires text`);
	}
	return text;
}

/** xdotool key syntax: one chord ("cmd+shift+t", "Return"), or several separated by spaces, pressed in order. */
function parseKeySequence(text: string | undefined): string[] {
	const keys = parseText(text, "key").trim().split(/\s+/).filter(Boolean);
	if (keys.length === 0) {
		throw new ComputerUseError("invalid_arguments", "key requires a key or key combination");
	}
	return keys;
}

function parseHoldSeconds(duration: number | undefined): number {
	if (duration === undefined || !Number.isFinite(duration) || duration < 0) {
		throw new ComputerUseError("invalid_arguments", "hold_key requires a finite, non-negative duration");
	}
	return duration;
}

function parseWaitDurationMilliseconds(duration: number | undefined): number {
	if (duration === undefined || !Number.isFinite(duration)) {
		throw new ComputerUseError("invalid_arguments", "wait requires finite duration");
	}
	return Math.min(MAX_WAIT_SECONDS, Math.max(0, duration)) * 1000;
}
