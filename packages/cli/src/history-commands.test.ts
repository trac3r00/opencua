import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HistoryPaths, historyMemoriesDir, historyPaths, setSkillDescriptionsEnabled } from "@opencua/core/light";
import { Command } from "commander";
import { registerHistoryCommands } from "./history-commands.js";
import { SKILL_SUGGESTIONS_FILE } from "./history-suggest.js";

const TYPED = "zx-typed-secret-91";
const DAY = "2026-11-20";
const NOW = Date.parse(`${DAY}T12:00:00Z`);
const MAIL = `${DAY}/0901-mail.md`;
const REPORT = `${DAY}/1121-report-md-in-xcode.md`;
const NOTES = `${DAY}/1141-notes.md`;

let scratch: string;
let paths: HistoryPaths;
let previousStateDir: string | undefined;
let stdout: string[];
let stderr: string[];
let revealed: string[];
let prompts: string[];

beforeEach(() => {
	scratch = realpathSync(mkdtempSync(join(tmpdir(), "opencua-history-commands-")));
	paths = historyPaths(join(scratch, "state"));
	mkdirSync(paths.root, { recursive: true });
	previousStateDir = process.env["OPENCUA_STATE_DIR"];
	process.env["OPENCUA_STATE_DIR"] = join(scratch, "state");
	stdout = [];
	stderr = [];
	revealed = [];
	prompts = [];
	spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
		stdout.push(String(chunk));
		return true;
	});
	spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
		stderr.push(String(chunk));
		return true;
	});
});

afterEach(() => {
	mock.restore();
	if (previousStateDir === undefined) Reflect.deleteProperty(process.env, "OPENCUA_STATE_DIR");
	else process.env["OPENCUA_STATE_DIR"] = previousStateDir;
	rmSync(scratch, { recursive: true, force: true });
});

/** Runs `opencua history <args>` on the temp state directory with a fixed clock, a fake Finder and a fake agent. */
async function history(...args: string[]): Promise<string> {
	const program = new Command().exitOverride().configureOutput({ writeErr: () => undefined });
	program.option("--json", "print machine-readable JSON output");
	registerHistoryCommands(program, {
		isJsonOutput: () => program.opts<{ json?: boolean }>().json === true,
		now: () => NOW,
		timeZone: "UTC",
		reveal: async (path) => {
			revealed.push(path);
		},
		generate: async (prompt) => {
			prompts.push(prompt);
			return JSON.stringify({
				title: `Agent title ${prompts.length}`,
				summary: "What the agent wrote.",
				nextSteps: [],
			});
		},
	});
	const before = stdout.length;
	await program.parseAsync(args[0] === "--json" ? ["--json", "history", ...args.slice(1)] : ["history", ...args], {
		from: "user",
	});
	return stdout.slice(before).join("");
}

const app = (name: string) => ({ name, bundleIdentifier: `com.example.${name.toLowerCase()}`, processIdentifier: 7 });
const at = (clock: string, day = DAY): string => `${day}T${clock}Z`;
function clicks(name: string, clock: string, day = DAY): unknown[] {
	return [0, 1, 2, 3].map((second) => ({
		kind: "mouse.click",
		timestamp: at(`${clock}:0${second}`, day),
		app: app(name),
		mouse: { button: "left" },
	}));
}
function segmentId(clock: string, day = DAY): string {
	return `${day}T${clock.replace(/:/g, "-")}-00Z`;
}
function writeSegment(id: string, events: readonly unknown[]): void {
	mkdirSync(join(paths.segmentsDir, id), { recursive: true });
	writeFileSync(
		join(paths.segmentsDir, id, "events.jsonl"),
		events.map((event) => `${JSON.stringify(event)}\n`).join(""),
	);
}
function segmentsOnDisk(): string[] {
	return existsSync(paths.segmentsDir) ? readdirSync(paths.segmentsDir).sort() : [];
}
function memoryFiles(): string[] {
	const directory = historyMemoriesDir(paths);
	if (!existsSync(directory)) return [];
	return readdirSync(directory)
		.filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day))
		.flatMap((day) => readdirSync(join(directory, day)).map((name) => `${day}/${name}`))
		.sort();
}

/** Three stretches of work on one day: Mail in the morning, a report in Xcode at 11:21, Notes at 11:41. */
function threeSessions(): void {
	writeSegment(segmentId("09:00"), clicks("Mail", "09:01"));
	writeSegment(segmentId("11:20"), [
		{
			kind: "window.changed",
			timestamp: at("11:21:00"),
			app: app("Xcode"),
			window: { title: "report.md - notes", windowID: 3 },
			document: { path: "/Users/me/notes/report.md" },
		},
		{
			kind: "keyboard.text_input",
			timestamp: at("11:21:30"),
			app: app("Xcode"),
			keyboard: { text: TYPED },
			element: { role: "AXTextField", title: "Search", value: TYPED },
		},
		{
			kind: "window.changed",
			timestamp: at("11:22:00"),
			app: app("Safari"),
			window: { title: "Pull requests", windowID: 4 },
		},
		{ kind: "mouse.click", timestamp: at("11:23:00"), app: app("Xcode"), mouse: { button: "left" } },
	]);
	writeSegment(segmentId("11:40"), clicks("Notes", "11:41"));
}

describe("#given memories #when the timeline is shown #then it lists them by day and time with title and apps", () => {
	beforeEach(async () => {
		threeSessions();
		await setSkillDescriptionsEnabled(paths.root, false);
		await history("summarize");
	});

	it("prints one line per memory under its day, newest first", async () => {
		expect((await history("timeline")).split("\n")).toEqual([
			DAY,
			"  11:41  Notes  [Notes]  1m",
			"  11:21  report.md in Xcode  [Xcode, Safari]  2m",
			"  09:01  Mail  [Mail]  1m",
			"",
		]);
	});

	it.each([
		["after the subcommand", ["timeline", "--json"]],
		["before it", ["--json", "timeline"]],
	])("prints the same days as JSON with --json %s", async (_where, args) => {
		const timeline: unknown = JSON.parse(await history(...args));

		expect(timeline).toMatchObject({
			directory: historyMemoriesDir(paths),
			days: [
				{
					day: DAY,
					memories: [
						{ time: "11:41", title: "Notes", apps: ["Notes"], file: NOTES },
						{
							time: "11:21",
							title: "report.md in Xcode",
							apps: ["Xcode", "Safari"],
							file: REPORT,
							start: at("11:21:00"),
							end: at("11:23:00"),
							segments: [segmentId("11:20")],
						},
						{ time: "09:01", title: "Mail", apps: ["Mail"], file: MAIL },
					],
				},
			],
		});
	});

	it("shows only the asked-for day and rejects a day that is not a date", async () => {
		expect(JSON.parse(await history("--json", "timeline", "--day", "2026-11-19"))).toMatchObject({ days: [] });
		expect((await history("timeline", "--day", DAY)).split("\n")[0]).toBe(DAY);
		await expect(history("timeline", "--day", "yesterday")).rejects.toThrow(/--day/);
	});

	it("reveals the memories folder only with --open, through the injected opener", async () => {
		await history("timeline");
		expect(revealed).toEqual([]);

		await history("timeline", "--open");

		expect(revealed).toEqual([historyMemoriesDir(paths)]);
	});

	it("names the suggested skill of a session that repeated a workflow", async () => {
		const mail = app("Mail");
		const compose = (run: number, clock: string): unknown[] => [
			{
				kind: "mouse.click",
				timestamp: at(clock),
				app: mail,
				mouse: {},
				element: { role: "AXButton", title: "New Message" },
			},
			{
				kind: "keyboard.text_input",
				timestamp: at(clock),
				app: mail,
				keyboard: { text: `to-${run}` },
				element: { role: "AXTextField", title: "To" },
			},
			{
				kind: "keyboard.text_input",
				timestamp: at(clock),
				app: mail,
				keyboard: { text: `re-${run}` },
				element: { role: "AXTextField", title: "Subject" },
			},
			{
				kind: "keyboard.shortcut",
				timestamp: at(clock),
				app: mail,
				keyboard: { keyEquivalent: "d", modifiers: ["command", "shift"] },
			},
		];
		writeSegment(segmentId("10:00"), compose(1, "10:05:00"));
		writeSegment(segmentId("10:10"), compose(2, "10:11:00"));
		await history("summarize");

		const lines = (await history("timeline")).split("\n");
		const composed = lines.findIndex((line) => line.startsWith("  10:05  "));

		expect(composed).toBeGreaterThan(0);
		expect(lines[composed + 1]).toMatch(/^ {9}suggested skill: mail-workflow \([0-9a-f]{12}\)$/);
	});
});

describe("#given no memories yet #when the timeline is opened #then the folder is made and revealed", () => {
	it("creates the memories folder so the menu's Open timeline always shows something", async () => {
		await history("timeline", "--open");

		expect(revealed).toEqual([historyMemoriesDir(paths)]);
		expect(existsSync(historyMemoriesDir(paths))).toBe(true);
		expect(JSON.parse(await history("--json", "timeline"))).toMatchObject({ days: [] });
	});
});

describe("#given recorded history #when summarize runs #then the consent switch decides whether the agent is asked", () => {
	it("writes local memories and calls no agent with the switch off", async () => {
		threeSessions();
		await setSkillDescriptionsEnabled(paths.root, false);

		const result: unknown = JSON.parse(await history("--json", "summarize"));

		expect(result).toMatchObject({ created: [MAIL, REPORT, NOTES], updated: [], summarizer: "local" });
		expect(prompts).toEqual([]);
		expect(memoryFiles()).toEqual([MAIL, REPORT, NOTES]);
	});

	it("asks the agent once per session with the switch on, and typed text reaches neither prompt nor file", async () => {
		threeSessions();

		const result: unknown = JSON.parse(await history("--json", "summarize"));

		expect(result).toMatchObject({ summarizer: "agent", agentFailures: 0 });
		expect(prompts).toHaveLength(3);
		expect(memoryFiles()).toHaveLength(3);
		for (const prompt of prompts) expect(prompt).not.toContain(TYPED);
		for (const file of memoryFiles()) {
			const text = readFileSync(join(historyMemoriesDir(paths), file), "utf8");
			expect(text).not.toContain(TYPED);
			expect(text).toContain("What the agent wrote.");
		}
		expect(prompts.join("\n")).toContain(`typed ${TYPED.length} chars into`);
	});

	it("writes nothing new on a second run", async () => {
		threeSessions();
		await history("summarize");

		const again: unknown = JSON.parse(await history("--json", "summarize"));

		expect(again).toMatchObject({ created: [], updated: [] });
		expect(prompts).toHaveLength(3);
	});
});

describe("#given segments and memories #when history clear --last runs #then only that period goes, without asking", () => {
	beforeEach(async () => {
		threeSessions();
		await setSkillDescriptionsEnabled(paths.root, false);
		await history("summarize");
	});

	it.each([
		["30m", [segmentId("09:00"), segmentId("11:20")], [MAIL, REPORT]],
		["1h", [segmentId("09:00")], [MAIL]],
		["1d", [], []],
		["all", [], []],
	])("clear --last %s leaves segments %j and memories %j", async (period, segments, memories) => {
		const cleared: unknown = JSON.parse(await history("--json", "clear", "--last", period));

		expect(segmentsOnDisk()).toEqual(segments);
		expect(memoryFiles()).toEqual(memories);
		expect(cleared).toMatchObject({ segments: expect.any(Array), memories: expect.any(Array), digests: [] });
		expect(existsSync(join(paths.root, SKILL_SUGGESTIONS_FILE))).toBe(true);
	});

	it("reports exactly what it deleted", async () => {
		expect(JSON.parse(await history("--json", "clear", "--last", "30m"))).toEqual({
			segments: [segmentId("11:40")],
			memories: [NOTES],
			digests: [],
		});
	});

	it.each([[["clear"]], [["clear", "--last", "soon"]], [["clear", "--last", "0m"]]])(
		"refuses %j and deletes nothing",
		async (args) => {
			await expect(history(...args)).rejects.toThrow();

			expect(segmentsOnDisk()).toHaveLength(3);
			expect(memoryFiles()).toHaveLength(3);
		},
	);

	it("keeps history delete working: it removes the named segment and leaves memories alone", async () => {
		await history("delete", segmentId("11:40"), "--yes");

		expect(segmentsOnDisk()).toEqual([segmentId("09:00"), segmentId("11:20")]);
		expect(memoryFiles()).toEqual([MAIL, REPORT, NOTES]);
	});
});

describe("#given the recorder's periodic run #when history suggest --write runs #then memories are written before suggestions", () => {
	it("summarizes, deletes summarized raw segments past the retention, then writes the menu file", async () => {
		threeSessions();
		const old = "2026-11-17";
		writeSegment(segmentId("09:00", old), clicks("Finder", "09:01", old));

		await history("suggest", "--write");

		expect(prompts).toHaveLength(4);
		expect(memoryFiles()).toHaveLength(4);
		expect(memoryFiles()[0]).toMatch(/^2026-11-17\/0901-agent-title-\d\.md$/);
		expect(segmentsOnDisk()).toEqual([segmentId("09:00"), segmentId("11:20"), segmentId("11:40")]);
		expect(JSON.parse(readFileSync(join(paths.root, SKILL_SUGGESTIONS_FILE), "utf8"))).toEqual({ suggestions: [] });
	});

	it("asks no model at all with --no-describe, and still writes local memories", async () => {
		threeSessions();

		await history("suggest", "--write", "--no-describe");

		expect(prompts).toEqual([]);
		expect(memoryFiles()).toEqual([MAIL, REPORT, NOTES]);
	});

	it("writes no memories without --write", async () => {
		threeSessions();

		await history("suggest");

		expect(memoryFiles()).toEqual([]);
		expect(prompts).toEqual([]);
	});

	it("still writes the menu file, and says so on stderr, when memories cannot be written", async () => {
		threeSessions();
		writeFileSync(historyMemoriesDir(paths), "a file where the folder should be");

		await history("suggest", "--write", "--no-describe");

		expect(stderr.join("")).toContain("History memories were not updated");
		expect(existsSync(join(paths.root, SKILL_SUGGESTIONS_FILE))).toBe(true);
		expect(segmentsOnDisk()).toHaveLength(3);
	});
});
