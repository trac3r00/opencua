import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { invokeMenu, readClipboard, setWindowFrame, writeClipboard } from "@opencua/core";
import type { GuardedComputerInterface, InputObservation, Rect } from "@opencua/core";
import { z } from "zod/v4";
import type { GuardedSession } from "./guarded-session.js";
import { type StepDispatch, type ToolResult, textResult } from "./tool-result.js";
import type { RunStep } from "./tool-schemas.js";

const READ_ONLY_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false } as const;
const MUTATION_ANNOTATIONS = { readOnlyHint: false, destructiveHint: true } as const;

const mutationBase = {
	app: z.string().min(1),
	observation_token: z.string().min(1),
	full_state: z.boolean().optional(),
};

const invokeMenuSchema = z.object({
	...mutationBase,
	path: z.array(z.string()).min(1).max(16),
});

const setWindowFrameSchema = z.object({
	...mutationBase,
	x: z.number().finite(),
	y: z.number().finite(),
	width: z.number().positive().finite(),
	height: z.number().positive().finite(),
});

const clipboardReadSchema = z.object({});
const clipboardWriteSchema = z
	.object({
		...mutationBase,
		text: z.string().optional(),
		image_path: z.string().optional(),
		file_path: z.string().optional(),
	})
	.refine(
		(input) => [input.text, input.image_path, input.file_path].filter((value) => value !== undefined).length === 1,
		{
			message: "provide exactly one of text, image_path, or file_path",
		},
	);

interface PowerComputerExtensions {
	invokeMenu?(
		pid: number,
		path: readonly string[],
	): Promise<{ readonly resolvedPath: readonly string[]; readonly action: string }>;
	setWindowFrame?(
		pid: number,
		windowId: number,
		frame: Rect,
	): Promise<{
		readonly requested: Rect;
		readonly applied: Rect | null;
		readonly verified: boolean;
		readonly attempts: number;
	}>;
	openUrl?(pid: number, url: string): Promise<{ readonly bundleId: string; readonly url: string }>;
	readClipboard?(): ReturnType<typeof readClipboard>;
	writeClipboard?(input: Parameters<typeof writeClipboard>[0]): ReturnType<typeof writeClipboard>;
}

type PowerComputer = GuardedComputerInterface & PowerComputerExtensions;

/** Dispatch the power-tool step types inside a run_steps batch; returns undefined for other types. */
export async function dispatchPowerStep(
	computer: GuardedComputerInterface,
	step: RunStep,
	targetPid: number,
	observation: InputObservation,
): Promise<StepDispatch | undefined> {
	const powerComputer: PowerComputer = computer;
	switch (step.type) {
		case "invoke_menu": {
			const report = await (powerComputer.invokeMenu?.(targetPid, step.path) ?? invokeMenu(targetPid, step.path));
			return { route: "accessibility", delivery: "background", detail: report };
		}
		case "set_window_frame": {
			const requested = { x: step.x, y: step.y, width: step.width, height: step.height };
			const report = await setFrame(powerComputer, targetPid, observation, requested);
			return { route: "synthetic_events", delivery: "background", detail: report };
		}
		case "clipboard_write": {
			const writeInput = clipboardInput(step);
			const report = powerComputer.writeClipboard?.(writeInput) ?? writeClipboard(writeInput);
			return { route: "synthetic_events", delivery: "not_applicable", detail: report };
		}
		case "open_url": {
			if (powerComputer.openUrl === undefined) {
				throw new Error("this computer cannot open URLs in an app");
			}
			const report = await powerComputer.openUrl(targetPid, step.url);
			// Launch Services delivers the URL (neither an accessibility action nor synthetic input). It opens in the
			// background, but the app may still activate itself, so the desktop is not known to be untouched.
			return { route: "unknown", delivery: "unknown", detail: report };
		}
		default:
			return undefined;
	}
}

export function registerPowerTools(
	server: McpServer,
	session: GuardedSession,
	computer: GuardedComputerInterface,
): void {
	const powerComputer: PowerComputer = computer;

	server.registerTool(
		"invoke_menu",
		{
			description:
				"Invoke an exact live native menu path; no pixel fallback. Missing, ambiguous, disabled, or unsupported hops fail closed. Requires the target app/window's one-use observation_token.",
			inputSchema: invokeMenuSchema,
			annotations: MUTATION_ANNOTATIONS,
		},
		async (input) => {
			let report: Awaited<ReturnType<typeof invokeMenu>> | undefined;
			const result = await session.mutate(
				input.observation_token,
				input.app,
				() => undefined,
				async (targetPid) => {
					report = await (powerComputer.invokeMenu?.(targetPid, input.path) ?? invokeMenu(targetPid, input.path));
					return { route: "accessibility", delivery: "background" } as const;
				},
				{ fullState: input.full_state === true },
			);
			return appendReport(result, "invokeMenu", report);
		},
	);

	server.registerTool(
		"set_window_frame",
		{
			description:
				"Set an observed top-level window's desktop geometry and verify through WindowServer within 2 points. Requires a one-use observation_token. On the shared host this is refused (isolated-session-required), because moving a window acts on the human desktop.",
			inputSchema: setWindowFrameSchema,
			annotations: MUTATION_ANNOTATIONS,
		},
		async (input) => {
			let report: Awaited<ReturnType<typeof setWindowFrame>> | undefined;
			const requested = { x: input.x, y: input.y, width: input.width, height: input.height };
			const result = await session.mutate(
				input.observation_token,
				input.app,
				() => undefined,
				async (targetPid, observation) => {
					report = await setFrame(powerComputer, targetPid, observation, requested);
					return { route: "synthetic_events", delivery: "background" } as const;
				},
				{ fullState: input.full_state === true },
			);
			return appendReport(result, "setWindowFrame", report);
		},
	);

	server.registerTool(
		"clipboard_read",
		{
			description:
				"Read available clipboard types and plain text, image, or file URL content. Clipboard data is sensitive.",
			inputSchema: clipboardReadSchema,
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async () => textResult(JSON.stringify(powerComputer.readClipboard?.() ?? readClipboard(), null, 2)),
	);

	server.registerTool(
		"clipboard_clear",
		{
			description:
				"Clear clipboard content with empty text; the text type remains. Needs the latest app token; returns fresh state. Does not paste.",
			inputSchema: z.object(mutationBase),
			annotations: MUTATION_ANNOTATIONS,
		},
		async (input) => {
			let report: ReturnType<typeof writeClipboard> | undefined;
			const result = await session.mutate(
				input.observation_token,
				input.app,
				() => undefined,
				async () => {
					const writeInput = { type: "text", text: "" } as const;
					report = powerComputer.writeClipboard?.(writeInput) ?? writeClipboard(writeInput);
					return { route: "synthetic_events", delivery: "not_applicable" } as const;
				},
				{ fullState: input.full_state === true },
			);
			return appendReport(result, "clipboardClear", report);
		},
	);

	server.registerTool(
		"clipboard_write",
		{
			description:
				"Replace clipboard with one plain-text value, image at an absolute existing path, or file URL at an absolute existing path. Requires a one-use observation_token; returns fresh app state.",
			inputSchema: clipboardWriteSchema,
			annotations: MUTATION_ANNOTATIONS,
		},
		async (input) => {
			let report: ReturnType<typeof writeClipboard> | undefined;
			const result = await session.mutate(
				input.observation_token,
				input.app,
				() => undefined,
				async () => {
					const writeInput = clipboardInput(input);
					report = powerComputer.writeClipboard?.(writeInput) ?? writeClipboard(writeInput);
					return { route: "synthetic_events", delivery: "not_applicable" } as const;
				},
				{ fullState: input.full_state === true },
			);
			return appendReport(result, "clipboardWrite", report);
		},
	);
}

async function setFrame(
	computer: PowerComputer,
	pid: number,
	observation: InputObservation,
	requested: Rect,
): Promise<Awaited<ReturnType<typeof setWindowFrame>>> {
	return await (computer.setWindowFrame?.(pid, observation.windowId, requested) ??
		setWindowFrame(pid, observation.windowId, requested));
}

function clipboardInput(input: {
	readonly text?: string | undefined;
	readonly image_path?: string | undefined;
	readonly file_path?: string | undefined;
}): Parameters<typeof writeClipboard>[0] {
	if (input.text !== undefined) {
		return { type: "text", text: input.text };
	}
	if (input.image_path !== undefined) {
		return { type: "image", path: input.image_path };
	}
	if (input.file_path !== undefined) {
		return { type: "file-url", paths: [input.file_path] };
	}
	throw new Error("clipboard_write: provide exactly one clipboard value");
}

function appendReport(result: ToolResult, key: string, report: unknown): ToolResult {
	if (report === undefined) {
		return result;
	}
	return {
		content: [...result.content, { type: "text", text: JSON.stringify({ [key]: report }, null, 2) }],
	};
}
