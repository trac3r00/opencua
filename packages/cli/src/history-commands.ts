import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	type HistoryMemoryGenerator,
	type HistorySegmentSummary,
	type HistorySkillDetection,
	type SkillDescription,
	clearHistory,
	deleteHistorySegments,
	describeSkillCandidates,
	historyMemoriesDir,
	historyPaths,
	listHistoryMemories,
	listHistorySegments,
	parseHistoryDuration,
	readHistoryState,
	readRawRetentionMs,
	readSkillDescriptions,
	readSkippedSkillCandidates,
	setSkillDescriptionsEnabled,
	skillDescriptionsEnabled,
	writeHistoryState,
} from "@opencua/core/light";
import { resolveStateDir } from "@opencua/core/stop";
import type { Command } from "commander";
import { z } from "zod/v4";
import { historyServiceStatus, installHistoryService, uninstallHistoryService } from "./history-service.js";

type HistoryCommandOptions = {
	readonly isJsonOutput: () => boolean;
	/** Reveals a folder in Finder. A test passes a fake so nothing opens on the desktop. */
	readonly reveal?: (path: string) => Promise<void>;
	/** Writes memory titles and summaries; the owner's agent when omitted. */
	readonly generate?: HistoryMemoryGenerator;
	readonly now?: () => number;
	/** IANA zone for memory day folders; the system zone when omitted. */
	readonly timeZone?: string;
};

/** The recorder runs `history suggest --write` every ten minutes and waits for it, so writing memories is cut off here. */
const MEMORY_BUDGET_MS = 60_000;

export function registerHistoryCommands(program: Command, options: HistoryCommandOptions): void {
	const history = program.command("history").description("Control the always-on cua-history watcher");
	const now = options.now ?? Date.now;
	const summarizeSeams = () => ({
		now: now(),
		...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
		...(options.generate === undefined ? {} : { generate: options.generate }),
	});

	history
		.command("list")
		.description("List recorded 10-minute history segments, newest first, with the apps each one holds")
		.option("--limit <count>", "Most segments to show", "36")
		.action((command: { readonly limit: string }) => {
			const limit = Number.parseInt(command.limit, 10);
			if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
				throw new Error("--limit must be an integer from 1 to 1000.");
			}
			const segments = listHistorySegments(historyPaths(resolveStateDir()));
			const shown = segments.slice(0, limit);
			if (options.isJsonOutput()) {
				process.stdout.write(`${JSON.stringify({ total: segments.length, segments: shown })}\n`);
				return;
			}
			if (segments.length === 0) {
				process.stdout.write("No history recorded yet.\n");
				return;
			}
			process.stdout.write(`${shown.map(formatSegment).join("\n")}\n`);
			if (shown.length < segments.length) {
				process.stdout.write(
					`${segments.length - shown.length} older segment(s) not shown; pass --limit to see them.\n`,
				);
			}
		});

	history
		.command("delete")
		.description("Delete recorded history: exact segment ids, the last period (--last 1h), or all of it (--all)")
		.argument("[segment-ids...]", "segment ids from opencua history list")
		.option("--last <duration>", "delete every segment overlapping the last 15m, 2h, 1d, ...")
		.option("--all", "delete every recorded segment")
		.option("--yes", "confirm the deletion")
		.action(
			async (
				ids: readonly string[],
				command: { readonly last?: string; readonly all?: boolean; readonly yes?: boolean },
			) => {
				const selectors = [ids.length > 0, command.last !== undefined, command.all === true].filter(Boolean).length;
				if (selectors !== 1) {
					throw new Error("Name what to delete with exactly one of: segment ids, --last <duration>, or --all.");
				}
				const deletion =
					ids.length > 0
						? { ids }
						: command.last !== undefined
							? { withinMs: parseHistoryDuration(command.last) }
							: { all: true as const };
				if (command.yes !== true) {
					throw new Error("Deleting history cannot be undone; add --yes to confirm.");
				}
				const paths = historyPaths(resolveStateDir());
				const deleted = deleteHistorySegments(paths, deletion);
				await rebuildMenuSuggestions(paths.root);
				if (options.isJsonOutput()) {
					process.stdout.write(`${JSON.stringify({ deleted })}\n`);
					return;
				}
				process.stdout.write(
					deleted.length === 0
						? "Nothing to delete.\n"
						: `Deleted ${deleted.length} segment(s): ${deleted.join(", ")}. Skill suggestions were rebuilt without them; recording continues.\n`,
				);
			},
		);

	history
		.command("clear")
		.description("Delete what was recorded in the last period, raw segments and memories alike (no confirmation)")
		.requiredOption("--last <period>", "how far back to clear: 10m, 1h, 1d, ... or all")
		.action(async (command: { readonly last: string }) => {
			const period =
				command.last === "all" ? { all: true as const } : { withinMs: parseHistoryDuration(command.last) };
			const paths = historyPaths(resolveStateDir());
			const cleared = clearHistory(paths, period, now());
			await rebuildMenuSuggestions(paths.root);
			if (options.isJsonOutput()) {
				process.stdout.write(`${JSON.stringify(cleared)}\n`);
				return;
			}
			const what = command.last === "all" ? "all history" : `the last ${command.last}`;
			process.stdout.write(
				cleared.segments.length + cleared.memories.length + cleared.digests.length === 0
					? `Nothing was recorded in ${what}.\n`
					: `Cleared ${what}: ${cleared.segments.length} raw segment(s), ${cleared.memories.length} memory file(s) and ${cleared.digests.length} automatic summary file(s) deleted. Skill suggestions were rebuilt without them; recording continues.\n`,
			);
		});

	history
		.command("summarize")
		.description("Write a memory for each stretch of recent work now, then delete raw segments past the retention")
		.action(async () => {
			const { formatSummarizeResult, summarizeHistoryNow } = await import("./history-digest.js");
			const paths = historyPaths(resolveStateDir());
			const result = await summarizeHistoryNow(paths, summarizeSeams());
			process.stdout.write(
				options.isJsonOutput()
					? `${JSON.stringify(result)}\n`
					: formatSummarizeResult(result, readRawRetentionMs(paths)),
			);
		});

	history
		.command("timeline")
		.description("List memories by day and time with their apps and suggested skill")
		.option("--day <date>", "only this day, as YYYY-MM-DD")
		.option("--open", "reveal the memories folder in Finder")
		.action(async (command: { readonly day?: string; readonly open?: boolean }) => {
			if (command.day !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(command.day)) {
				throw new Error("--day must be a date such as 2026-11-24.");
			}
			const { formatTimeline, timelineDays } = await import("./history-digest.js");
			const paths = historyPaths(resolveStateDir());
			const directory = historyMemoriesDir(paths);
			const memories = listHistoryMemories(paths, command.day === undefined ? {} : { day: command.day });
			process.stdout.write(
				options.isJsonOutput()
					? `${JSON.stringify({ directory, days: timelineDays(memories) })}\n`
					: formatTimeline(memories, command.day),
			);
			if (command.open === true) {
				// The menu's "Open timeline" runs this: an empty folder opening says more than nothing happening.
				await mkdir(directory, { recursive: true, mode: 0o700 });
				await (options.reveal ?? revealInFinder)(directory);
			}
		});

	history
		.command("suggest")
		.description("List repeated workflows from recent history as skill suggestions, each described by a small model")
		.option("--limit <count>", "Maximum suggestions", "5")
		.option("--write", "Also write skill-suggestions.json for the menu bar")
		.option("--no-describe", "show the recorded steps without asking a model for descriptions")
		.action(async (command: { readonly limit: string; readonly write?: boolean; readonly describe: boolean }) => {
			const limit = Number.parseInt(command.limit, 10);
			if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
				throw new Error("--limit must be an integer from 1 to 20.");
			}
			const {
				formatSuggestions,
				menuSuggestions,
				suggestedHistorySkills,
				withoutSkippedCandidates,
				writeMenuSuggestions,
			} = await import("./history-suggest.js");
			const paths = historyPaths(resolveStateDir());
			if (command.write === true) {
				// Memories first, and raw segments past the retention go with them, so the suggestions below see what is left.
				const { summarizeHistoryNow } = await import("./history-digest.js");
				const budget = new AbortController();
				// Cleared below, so a finished run leaves no timer holding the process open.
				const timer = setTimeout(() => budget.abort(), MEMORY_BUDGET_MS);
				try {
					await summarizeHistoryNow(paths, {
						...summarizeSeams(),
						useAgent: command.describe,
						signal: budget.signal,
					});
				} catch (error: unknown) {
					// The menu still needs its suggestions when memories cannot be written; the failure is reported, not hidden.
					process.stderr.write(
						`History memories were not updated: ${error instanceof Error ? error.message : String(error)}\n`,
					);
				} finally {
					clearTimeout(timer);
				}
			}
			const found = await suggestedHistorySkills(paths.root, limit);
			const descriptions = await describedSuggestions(paths.root, found, command.describe);
			// Describing may have just recorded a candidate as navigation; it is dropped in this same run.
			const detection = withoutSkippedCandidates(found, await readSkippedSkillCandidates(paths.root));
			if (command.write === true) {
				await mkdir(paths.root, { recursive: true, mode: 0o700 });
				await writeMenuSuggestions(paths.root, detection, descriptions);
			}
			process.stdout.write(
				options.isJsonOutput()
					? `${JSON.stringify({ ...detection, descriptions, suggestions: menuSuggestions(detection, descriptions) })}\n`
					: formatSuggestions(detection, descriptions),
			);
		});

	history
		.command("descriptions")
		.description("Show, or turn on or off, the small-model descriptions of suggested skills (on by default)")
		.argument("[state]", "on or off")
		.action(async (state: string | undefined) => {
			const paths = historyPaths(resolveStateDir());
			if (state !== undefined) {
				if (state !== "on" && state !== "off") throw new Error('Pass "on" or "off".');
				await mkdir(paths.root, { recursive: true, mode: 0o700 });
				await setSkillDescriptionsEnabled(paths.root, state === "on");
			}
			const enabled = await skillDescriptionsEnabled(paths.root);
			process.stdout.write(
				options.isJsonOutput()
					? `${JSON.stringify({ enabled })}\n`
					: enabled
						? "Skill descriptions are on: each suggestion's recorded steps (never typed text) go to a small model.\n"
						: "Skill descriptions are off: suggestions show their recorded steps only.\n",
			);
		});

	const record = history.command("record").description("Mark a deliberate skill demonstration in history");
	record
		.command("start")
		.description("Start marking a demonstration; perform the workflow, then run `opencua history record stop`")
		.action(async () => {
			const { startHistoryDemonstration } = await import("./history-demonstration.js");
			const paths = historyPaths(resolveStateDir());
			const demonstration = await startHistoryDemonstration(paths.root);
			await writeFile(join(paths.root, "active-demonstration.json"), JSON.stringify({ id: demonstration.id }), {
				mode: 0o600,
			});
			process.stdout.write(
				options.isJsonOutput()
					? `${JSON.stringify(demonstration)}\n`
					: `Demonstration ${demonstration.id} started. Do the workflow, then run: opencua history record stop\n`,
			);
		});
	record
		.command("stop")
		.description("Stop the active demonstration and print the prompt to give your agent")
		.option("--id <uuid>", "Demonstration id (defaults to the active one)")
		.action(async (command: { readonly id?: string }) => {
			const { stopHistoryDemonstration } = await import("./history-demonstration.js");
			const paths = historyPaths(resolveStateDir());
			const activePath = join(paths.root, "active-demonstration.json");
			const id =
				command.id ??
				(await readFile(activePath, "utf8").then(
					(text) => z.object({ id: z.uuid() }).parse(JSON.parse(text)).id,
					() => undefined,
				));
			if (id === undefined) throw new Error("No active demonstration. Start one with: opencua history record start");
			const stopped = await stopHistoryDemonstration(paths.root, id);
			await rm(activePath, { force: true });
			const prompt = `Create a reusable skill from my OpenCUA history demonstration ${stopped.id} (${stopped.startedAt} to ${stopped.endedAt ?? ""}). Read the matching events from cua_history_status paths, draft a SKILL.md with parameters instead of private values, show me the draft, and save it with cua_history_save_skill after I approve.`;
			process.stdout.write(
				options.isJsonOutput()
					? `${JSON.stringify({ ...stopped, prompt })}\n`
					: `Demonstration stopped.\n\n${prompt}\n`,
			);
		});

	history
		.command("open")
		.description("Show skill suggestions in the terminal; --web opens the legacy local timeline page")
		.option("--web", "Open the legacy localhost timeline page instead")
		.option("--no-open", "With --web: print the local URL without opening a browser")
		.option("--record", "With --web: focus the recording controls")
		.option("--skills-dir <path>", "Directory for reviewed skills", join(homedir(), ".agents", "skills"))
		.action(
			async (command: {
				readonly open: boolean;
				readonly skillsDir: string;
				readonly record?: boolean;
				readonly web?: boolean;
			}) => {
				if (command.web !== true) {
					const { formatSuggestions, suggestedHistorySkills } = await import("./history-suggest.js");
					const root = historyPaths(resolveStateDir()).root;
					const detection = await suggestedHistorySkills(root, 5);
					process.stdout.write(formatSuggestions(detection, await describedSuggestions(root, detection, false)));
					return;
				}
				const { startHistoryUi } = await import("./history-ui.js");
				const ui = await startHistoryUi({
					stateDirectory: resolveStateDir(),
					skillsDirectory: command.skillsDir,
				});
				const stop = () => {
					void ui.close();
				};
				process.once("SIGINT", stop);
				process.once("SIGTERM", stop);
				const url = command.record === true ? `${ui.url}?record=1` : ui.url;
				if (!command.open) {
					process.stdout.write(`${url}\n`);
					return;
				}
				try {
					await promisify(execFile)("/usr/bin/open", [url]);
					process.stdout.write(
						"History opened. Close it from the page when finished; recording is independent.\n",
					);
				} catch (error: unknown) {
					await ui.close();
					throw error;
				}
			},
		);

	history
		.command("digest")
		.description("Summarize one completed segment only when automatic summaries are enabled")
		.action(async () => {
			const { digestLatestHistory } = await import("./history-digest.js");
			const paths = historyPaths(resolveStateDir());
			try {
				const result = await digestLatestHistory(paths.root);
				await mkdir(paths.root, { recursive: true, mode: 0o700 });
				await writeFile(
					join(paths.root, "automation-status.json"),
					JSON.stringify({ state: result.state, updatedAt: new Date().toISOString() }),
					{ mode: 0o600 },
				);
				process.stdout.write(`${JSON.stringify({ state: result.state })}\n`);
			} catch {
				await mkdir(paths.root, { recursive: true, mode: 0o700 });
				await writeFile(
					join(paths.root, "automation-status.json"),
					JSON.stringify({ state: "error", updatedAt: new Date().toISOString() }),
					{ mode: 0o600 },
				);
				throw new Error("Automatic history summary failed. Check model access and preview the segment in history.");
			}
		});

	history
		.command("start")
		.description("Install and start the cua-history watcher (menu-bar status item, autostart at login)")
		.action(async () => {
			const paths = await installHistoryService();
			if (options.isJsonOutput()) {
				process.stdout.write(`${JSON.stringify({ started: true, launchAgent: paths.launchAgent })}\n`);
				return;
			}
			process.stdout.write(
				`cua-history watcher started and set to launch at login.\nData: ${paths.stateDirectory}/cua-history\nIt records which apps and windows you use, clicks and shortcuts in every app, private browser windows included. Typed text is off by default and password fields are never recorded. To skip an app, open the opencua menu bar item and choose Don't record.\nNext: run opencua permissions grant. It walks you through Input Monitoring (keystrokes and clicks) and Accessibility (window titles) for "opencua-mcp", the same entry the rest of opencua uses.\n`,
			);
		});

	history
		.command("stop")
		.description("Stop the cua-history watcher and remove it from login items")
		.action(async () => {
			const paths = await uninstallHistoryService();
			if (options.isJsonOutput()) {
				process.stdout.write(`${JSON.stringify({ stopped: true, launchAgent: paths.launchAgent })}\n`);
				return;
			}
			process.stdout.write("cua-history watcher stopped.\n");
		});

	history
		.command("pause")
		.description("Pause recording without stopping the watcher (its current segment is kept)")
		.action(() => {
			const paths = historyPaths(resolveStateDir());
			if (readHistoryState(paths) === "running") {
				writeHistoryState(paths, "paused");
			}
			if (options.isJsonOutput()) {
				process.stdout.write(`${JSON.stringify({ state: readHistoryState(paths) })}\n`);
				return;
			}
			process.stdout.write(`cua-history ${readHistoryState(paths)}.\n`);
		});

	history
		.command("resume")
		.description("Resume a paused watcher")
		.action(() => {
			const paths = historyPaths(resolveStateDir());
			if (readHistoryState(paths) === "paused") {
				writeHistoryState(paths, "running");
			}
			if (options.isJsonOutput()) {
				process.stdout.write(`${JSON.stringify({ state: readHistoryState(paths) })}\n`);
				return;
			}
			process.stdout.write(`cua-history ${readHistoryState(paths)}.\n`);
		});

	history
		.command("status")
		.description("Report whether the cua-history watcher is installed and running")
		.action(async () => {
			const status = await historyServiceStatus();
			if (options.isJsonOutput()) {
				process.stdout.write(`${JSON.stringify(status)}\n`);
				return;
			}
			process.stdout.write(
				`installed: ${status.installed}\nrunning: ${status.running}\nstate: ${status.state}${status.reason === undefined ? "" : ` (${status.reason})`}\ndata: ${status.eventStreamRootPath}\n`,
			);
		});
}

async function revealInFinder(path: string): Promise<void> {
	await promisify(execFile)("/usr/bin/open", [path]);
}

/** Suggestions are derived from the segments, so they are rebuilt after a deletion: deleted activity must not stay in the menu. */
async function rebuildMenuSuggestions(root: string): Promise<void> {
	const { suggestedHistorySkills, writeMenuSuggestions } = await import("./history-suggest.js");
	await mkdir(root, { recursive: true, mode: 0o700 });
	await writeMenuSuggestions(root, await suggestedHistorySkills(root, 5));
}

function formatSegment(segment: HistorySegmentSummary): string {
	const time = (iso: string): string =>
		new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
	const day = new Date(segment.startedAt).toLocaleDateString();
	const apps = segment.apps.length === 0 ? "no app events" : segment.apps.join(", ");
	return `${segment.id}  ${day} ${time(segment.startedAt)}-${time(segment.endedAt)}  ${segment.eventCount} event(s)  ${apps}`;
}

/**
 * Descriptions for the detected candidates. With the setting on and a model allowed, the missing ones are written by a
 * small model and cached; otherwise only cached ones are shown, and none at all once the person turned it off.
 */
async function describedSuggestions(
	root: string,
	detection: HistorySkillDetection,
	allowModel: boolean,
): Promise<Record<string, SkillDescription>> {
	if (detection.candidates.length === 0 || !(await skillDescriptionsEnabled(root))) return {};
	if (!allowModel) {
		const cached = await readSkillDescriptions(root);
		return Object.fromEntries(
			detection.candidates.flatMap((candidate) => {
				const description = cached[candidate.id];
				return description === undefined ? [] : [[candidate.id, description] as const];
			}),
		);
	}
	const { generateHistoryText, skillDescriptionCommand } = await import("./history-agent.js");
	const command = skillDescriptionCommand();
	await mkdir(root, { recursive: true, mode: 0o700 });
	return await describeSkillCandidates(root, detection.candidates, (prompt) =>
		generateHistoryText(prompt, { ...command, timeoutMs: 45_000 }),
	);
}
