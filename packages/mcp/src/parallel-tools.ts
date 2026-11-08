import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type GuardedComputerInterface, resolveAppPid, withCursorIdentity } from "@opencua/core";
import type { GuardedSession } from "./guarded-session.js";
import { createRunStepDriver, expectFromInput } from "./step-actions.js";
import type { ToolContent, ToolResult } from "./tool-result.js";
import { observeAppsSchema, parseRunSteps, runParallelSchema } from "./tool-schemas.js";

interface AppOutcome {
	readonly app: string;
	readonly result?: ToolResult;
	readonly error?: string;
}

async function assertDistinctTargets(
	computer: GuardedComputerInterface,
	apps: readonly string[],
): Promise<ReadonlyMap<string, number>> {
	const targets = await Promise.allSettled(apps.map((app) => resolveAppPid(computer, app)));
	const pids = targets.flatMap((target) => (target.status === "fulfilled" ? [target.value] : []));
	if (new Set(pids).size !== pids.length) {
		throw new Error("each entry must target a different app process; app aliases cannot share a parallel call");
	}
	const resolved = new Map<string, number>();
	for (const [index, target] of targets.entries()) {
		const app = apps[index];
		if (app !== undefined && target.status === "fulfilled") resolved.set(app, target.value);
	}
	return resolved;
}

async function settle(app: string, run: () => Promise<ToolResult>): Promise<AppOutcome> {
	try {
		return { app, result: await run() };
	} catch (error: unknown) {
		return { app, error: error instanceof Error ? error.message : String(error) };
	}
}

function parsedText(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

/**
 * One answer for several apps: each app's own answer, parsed, under its name, with every image
 * kept and indexed so the caller can tell whose window it shows. The call is an error only when
 * every app failed, so one busy app does not hide what the others did.
 */
function combine(key: "apps" | "batches", outcomes: readonly AppOutcome[]): ToolResult {
	const images: ToolContent[] = [];
	const entries = outcomes.map((outcome) => {
		if (outcome.result === undefined) {
			return { app: outcome.app, ok: false, error: outcome.error ?? "failed without a message" };
		}
		const texts: unknown[] = [];
		const imageIndexes: number[] = [];
		for (const item of outcome.result.content) {
			if (item.type === "text") {
				texts.push(parsedText(item.text));
			} else {
				imageIndexes.push(images.length);
				images.push(item);
			}
		}
		return {
			app: outcome.app,
			ok: outcome.result.isError !== true,
			result: texts.length === 1 ? texts[0] : texts,
			...(imageIndexes.length === 0 ? {} : { images: imageIndexes }),
		};
	});
	return {
		content: [{ type: "text", text: JSON.stringify({ [key]: entries }) }, ...images],
		...(entries.every((entry) => !entry.ok) ? { isError: true } : {}),
	};
}

export function registerParallelTools(
	server: McpServer,
	session: GuardedSession,
	computer: GuardedComputerInterface,
): void {
	// One cursor identity per app process, kept for the most recent processes only.
	const cursors = new Map<number, string>();
	const cursorFor = (pid: number | undefined): string => {
		if (pid === undefined) return randomUUID();
		let cursor = cursors.get(pid);
		if (cursor === undefined) {
			cursor = randomUUID();
			cursors.set(pid, cursor);
			if (cursors.size > 64) {
				const oldest = cursors.keys().next().value;
				if (oldest !== undefined) cursors.delete(oldest);
			}
		}
		return cursor;
	};
	// The session acts on the exact process the cursor was chosen for, not on a name resolved a second time.
	const resolvedApp = (targets: ReadonlyMap<string, number>, app: string): string => {
		const pid = targets.get(app);
		return pid === undefined ? app : String(pid);
	};
	server.registerTool(
		"observe_apps",
		{
			description:
				"Observe approved apps concurrently. apps[] contains each get_app_state answer and token. Text-only by default; include_screenshot adds indexed images. Elements are tab-separated unless element_format=json. diff_only and max_elements apply to all. A failed app is reported without failing others.",
			inputSchema: observeAppsSchema,
			annotations: { readOnlyHint: true, destructiveHint: false },
		},
		async (input) => {
			const targets = await assertDistinctTargets(computer, input.apps);
			return combine(
				"apps",
				await Promise.all(
					input.apps.map((app) =>
						settle(app, () =>
							withCursorIdentity(cursorFor(targets.get(app)), () =>
								session.observe({
									app: resolvedApp(targets, app),
									diffOnly: input.diff_only === true,
									includeScreenshot: input.include_screenshot === true,
									...(input.max_elements === undefined ? {} : { maxElements: input.max_elements }),
									elementFormat: input.element_format ?? "table",
								}),
							),
						),
					),
				),
			);
		},
	);

	server.registerTool(
		"run_parallel",
		{
			description:
				"Run a validated step batch per distinct app. Background runs concurrently; attended serializes. Returns each result and next token; failures do not stop others.",
			inputSchema: runParallelSchema,
			annotations: { readOnlyHint: false, destructiveHint: true },
		},
		async (input, extra) => {
			const batches = input.batches.map((batch, index) => ({
				...batch,
				steps: parseRunSteps(batch.steps, "run_parallel", `batches[${index}].steps`),
			}));
			const targets = await assertDistinctTargets(
				computer,
				batches.map((batch) => batch.app),
			);
			const driver = createRunStepDriver(computer);
			const options = { fullState: input.full_state === true, includeScreenshot: input.include_screenshot === true };
			const runBatch = (batch: (typeof batches)[number]): Promise<AppOutcome> =>
				settle(batch.app, () =>
					withCursorIdentity(cursorFor(targets.get(batch.app)), () =>
						session.runSteps(
							batch.observation_token,
							resolvedApp(targets, batch.app),
							batch.steps,
							expectFromInput(batch.expect),
							driver,
							options,
							{ signal: extra.signal, ...(input.pace === undefined ? {} : { pace: input.pace }) },
						),
					),
				);
			if (computer.delivery === "background") {
				return combine("batches", await Promise.all(batches.map(runBatch)));
			}
			const outcomes: AppOutcome[] = [];
			for (const batch of batches) {
				outcomes.push(await runBatch(batch));
			}
			return combine("batches", outcomes);
		},
	);
}
