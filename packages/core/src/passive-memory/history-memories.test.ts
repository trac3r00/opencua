import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HistoryPaths, historyPaths } from "./history-control.js";
import {
	clearHistory,
	historyMemoriesDir,
	historyMemoryPrompt,
	listHistoryMemories,
	parseHistoryMemoryText,
	sessionizeHistory,
	summarizeHistory,
} from "./history-memories.js";
import { setSkillDescriptionsEnabled } from "./history-skill-descriptions.js";

/** Distinctive strings that must never leave an event: typed text, a field's value, and a URL query. */
const TYPED = "zx-typed-secret-91";
const FIELD_VALUE = "zx-field-value-secret-44";
const QUERY = "zx-query-secret-17";

let scratch: string;
let paths: HistoryPaths;

beforeEach(() => {
	scratch = realpathSync(mkdtempSync(join(tmpdir(), "opencua-history-memories-")));
	paths = historyPaths(join(scratch, "state"));
	mkdirSync(paths.root, { recursive: true });
});

afterEach(() => {
	rmSync(scratch, { recursive: true, force: true });
});

const DAY = "2026-11-20";
const at = (clock: string, day = DAY): string => `${day}T${clock}Z`;
const ms = (clock: string, day = DAY): number => Date.parse(at(clock, day));
const app = (name: string) => ({ name, bundleIdentifier: `com.example.${name.toLowerCase()}`, processIdentifier: 7 });

function windowChange(name: string, title: string, clock: string, extra: Record<string, unknown> = {}): unknown {
	return { kind: "window.changed", timestamp: at(clock), app: app(name), window: { title, windowID: 3 }, ...extra };
}
function click(name: string, clock: string): unknown {
	return { kind: "mouse.click", timestamp: at(clock), app: app(name), mouse: { button: "left" } };
}
function shortcut(name: string, clock: string): unknown {
	return { kind: "keyboard.shortcut", timestamp: at(clock), app: app(name), keyboard: { keyEquivalent: "s" } };
}
function typed(name: string, field: string, text: string, clock: string): unknown {
	return {
		kind: "keyboard.text_input",
		timestamp: at(clock),
		app: app(name),
		keyboard: { text },
		element: { role: "AXTextField", title: field, value: FIELD_VALUE },
	};
}
/** `count` clicks in one app, a second apart, starting at `clock` (HH:MM:00). */
function clicks(name: string, clock: string, count: number): unknown[] {
	return Array.from({ length: count }, (_, index) =>
		click(name, `${clock.slice(0, 5)}:${String(index).padStart(2, "0")}`),
	);
}

function segmentId(clock: string, day = DAY): string {
	return `${day}T${clock.replace(/:/g, "-")}Z`;
}
function writeSegment(id: string, events: readonly unknown[]): void {
	const directory = join(paths.segmentsDir, id);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "events.jsonl"), events.map((event) => `${JSON.stringify(event)}\n`).join(""));
}
function segmentsOnDisk(): string[] {
	return existsSync(paths.segmentsDir) ? readdirSync(paths.segmentsDir).sort() : [];
}
function memoryFiles(): string[] {
	return listHistoryMemories(paths)
		.map((memory) => memory.file)
		.sort();
}
function readMemory(file: string): string {
	return readFileSync(join(historyMemoriesDir(paths), file), "utf8");
}

/** A working session in Xcode with a document, a page with a secret query, and typing into a labeled field. */
function reportSegment(): unknown[] {
	return [
		windowChange("Xcode", "report.md - notes", "10:01:00", { document: { path: "/Users/me/notes/report.md" } }),
		click("Xcode", "10:01:10"),
		typed("Xcode", "Search", TYPED, "10:01:20"),
		windowChange("Safari", "Pull requests", "10:02:00", {
			document: { url: `https://github.com/acme/app/pulls?token=${QUERY}#${QUERY}` },
		}),
		click("Xcode", "10:02:30"),
		shortcut("Xcode", "10:03:00"),
	];
}

const agentAnswer = JSON.stringify({
	title: "Reviewed the report",
	summary: "Edited report.md in Xcode and checked the open pull requests.",
	nextSteps: ["Reply to the review"],
});

function fakeAgent(answer: string = agentAnswer): {
	readonly prompts: string[];
	generate(prompt: string): Promise<string>;
} {
	const prompts: string[] = [];
	return {
		prompts,
		async generate(prompt) {
			prompts.push(prompt);
			return answer;
		},
	};
}

describe("#given recorded segments #when they are grouped into sessions #then a long pause or a change of main app starts a new one", () => {
	const mail = (clock: string): unknown[] => clicks("Mail", clock, 4);

	it("keeps segments together across a pause just under ten minutes and splits at exactly ten", () => {
		const first = { id: segmentId("10:00:00"), events: [...mail("10:04:00"), click("Mail", "10:05:00")] };
		const near = sessionizeHistory([first, { id: segmentId("10:10:00"), events: [click("Mail", "10:14:59")] }]);
		const far = sessionizeHistory([first, { id: segmentId("10:10:00"), events: [click("Mail", "10:15:00")] }]);

		expect(near.map((session) => session.segments)).toEqual([[segmentId("10:00:00"), segmentId("10:10:00")]]);
		expect(far.map((session) => session.segments)).toEqual([[segmentId("10:00:00")], [segmentId("10:10:00")]]);
		expect(near[0]).toMatchObject({ start: at("10:04:00"), end: at("10:14:59"), activity: 6 });
	});

	it("weighs typing by its length, so an app the owner wrote in outranks one they clicked around in", () => {
		const forty = "x".repeat(40);
		const oneRun = [...clicks("Brave Browser", "10:01:00", 3), typed("Herdr", "", forty, "10:02:00")];
		const perCharacter = [
			...clicks("Brave Browser", "10:01:00", 3),
			...[...forty].map((letter) => typed("Herdr", "", letter, "10:02:00")),
		];

		for (const events of [oneRun, perCharacter]) {
			const [session] = sessionizeHistory([{ id: segmentId("10:00:00"), events }]);
			expect(session?.apps).toEqual(["Herdr", "Brave Browser"]);
			expect(session?.activity).toBe(11);
		}
	});

	it("does not name an app that was barely touched", () => {
		const events = [...clicks("Xcode", "10:01:00", 30), click("SecurityAgent", "10:02:00")];
		const [session] = sessionizeHistory([{ id: segmentId("10:00:00"), events }]);

		expect(session?.apps).toEqual(["Xcode"]);
		expect(session?.activity).toBe(31);
	});

	it("splits when the next segment shares no main app, and not when a main app carries over", () => {
		const first = { id: segmentId("10:00:00"), events: mail("10:08:00") };
		const otherApp = { id: segmentId("10:10:00"), events: clicks("Xcode", "10:11:00", 4) };
		// Mail is one action in four here: above the one-in-five share that makes it a main app.
		const shared = {
			id: segmentId("10:10:00"),
			events: [...clicks("Xcode", "10:11:00", 3), click("Mail", "10:12:00")],
		};
		// One Mail action in six is below that share, so the work has moved on.
		const stray = {
			id: segmentId("10:10:00"),
			events: [...clicks("Xcode", "10:11:00", 5), click("Mail", "10:12:00")],
		};

		expect(sessionizeHistory([first, otherApp])).toHaveLength(2);
		expect(sessionizeHistory([first, shared])).toHaveLength(1);
		expect(sessionizeHistory([first, stray])).toHaveLength(2);
	});

	it("leaves out segments that hold no action and orders sessions oldest first whatever the input order", () => {
		const sessions = sessionizeHistory([
			{ id: segmentId("12:00:00"), events: mail("12:01:00") },
			{
				id: segmentId("11:00:00"),
				events: [{ kind: "session.started", timestamp: at("11:00:01") }, "not an event"],
			},
			{ id: segmentId("10:00:00"), events: mail("10:01:00") },
		]);

		expect(sessions.map((session) => session.segments)).toEqual([[segmentId("10:00:00")], [segmentId("12:00:00")]]);
	});

	it("counts one-character typing events from older recorders as one run and keeps only their length", () => {
		const letters = [..."hello"].map((letter, index) => typed("Notes", "Body", letter, `10:01:0${index}`));
		const [session] = sessionizeHistory([
			{ id: segmentId("10:00:00"), events: [...letters, click("Notes", "10:02:00")] },
		]);

		expect(session?.activity).toBe(2);
		expect(session?.counts).toEqual({ typedCharacters: 5, clicks: 1, shortcuts: 0, windowChanges: 0 });
		expect(session?.fields).toEqual([{ app: "Notes", label: "Body", role: "text field", characters: 5 }]);
	});

	it("records what was acted on: apps by activity, windows, documents and pages without scheme, query or fragment", () => {
		const [session] = sessionizeHistory([{ id: segmentId("10:00:00"), events: reportSegment() }]);

		expect(session?.apps).toEqual(["Xcode", "Safari"]);
		expect(session?.documents).toEqual([{ app: "Xcode", path: "/Users/me/notes/report.md" }]);
		expect(session?.pages).toEqual([{ app: "Safari", page: "github.com/acme/app/pulls" }]);
		expect(session?.windows).toEqual([
			{ app: "Xcode", title: "report.md - notes" },
			{ app: "Safari", title: "Pull requests" },
		]);
		expect(session?.fields).toEqual([
			{ app: "Xcode", label: "Search", role: "text field", characters: TYPED.length },
		]);
		expect(session?.lastActive).toEqual({ app: "Xcode", window: "report.md - notes" });
		expect(JSON.stringify(session)).not.toContain(TYPED);
		expect(JSON.stringify(session)).not.toContain(FIELD_VALUE);
		expect(JSON.stringify(session)).not.toContain(QUERY);
	});
});

describe("#given a session and the model switch off #when history is summarized #then a local memory is written and no agent is called", () => {
	it("writes front matter and the worked-on record from apps, documents, pages and fields, never typed text", async () => {
		writeSegment(segmentId("10:00:00"), reportSegment());
		await setSkillDescriptionsEnabled(paths.root, false);
		const agent = fakeAgent();

		const result = await summarizeHistory(paths, {
			now: ms("10:30:00"),
			timeZone: "UTC",
			generate: agent.generate,
			skills: [{ id: "abc123def456", title: "File the report", segmentIds: [segmentId("10:00:00")] }],
		});

		const file = "2026-11-20/1001-report-md-in-xcode.md";
		expect(agent.prompts).toEqual([]);
		expect(result).toMatchObject({ created: [file], updated: [], skipped: 0, deferred: 0, summarizer: "local" });
		expect(listHistoryMemories(paths)).toEqual([
			{
				day: "2026-11-20",
				time: "10:01",
				file,
				path: join(historyMemoriesDir(paths), file),
				title: "report.md in Xcode",
				start: at("10:01:00"),
				end: at("10:03:00"),
				apps: ["Xcode", "Safari"],
				segments: [segmentId("10:00:00")],
				suggestedSkill: { id: "abc123def456", title: "File the report" },
			},
		]);
		const text = readMemory(file);
		for (const shown of ["/Users/me/notes/report.md", "github.com/acme/app/pulls", "Pull requests", "`Search`"]) {
			expect(text).toContain(shown);
		}
		expect(text).toContain(`typed ${TYPED.length} chars into`);
		for (const secret of [TYPED, FIELD_VALUE, QUERY]) expect(text).not.toContain(secret);
		expect(statSync(join(historyMemoriesDir(paths), file)).mode & 0o777).toBe(0o600);
	});

	it("files the memory under the owner's local day and time, not the UTC one", async () => {
		writeSegment(segmentId("16:30:00"), clicks("Herdr", "16:31:00", 4));
		await setSkillDescriptionsEnabled(paths.root, false);

		const result = await summarizeHistory(paths, { now: ms("17:00:00"), timeZone: "Asia/Seoul" });

		expect(result.created).toEqual(["2026-11-21/0131-herdr.md"]);
		expect(listHistoryMemories(paths, { day: "2026-11-21" })).toHaveLength(1);
		expect(listHistoryMemories(paths, { day: "2026-11-20" })).toEqual([]);
	});

	it("titles a memory without the app name a window title repeats, and never cuts off the app", async () => {
		const long = `${"Quarterly planning notes ".repeat(6)}- Brave`;
		writeSegment(segmentId("10:00:00"), [
			windowChange("Brave Browser", "YouTube - Brave", "10:01:00"),
			...clicks("Brave Browser", "10:02:00", 3),
		]);
		writeSegment(segmentId("12:00:00"), [
			windowChange("Brave Browser", long, "12:01:00"),
			...clicks("Brave Browser", "12:02:00", 3),
		]);
		await setSkillDescriptionsEnabled(paths.root, false);

		await summarizeHistory(paths, { now: ms("12:30:00"), timeZone: "UTC" });

		const [later, earlier] = listHistoryMemories(paths);
		expect(earlier?.title).toBe("YouTube in Brave Browser");
		expect(later?.title.endsWith("... in Brave Browser")).toBe(true);
		expect(later?.title.length).toBeLessThanOrEqual(80);
	});

	it("keeps the letters of a title in another script in the file name", async () => {
		writeSegment(segmentId("10:00:00"), [
			windowChange("메모", "장보기 목록", "10:01:00"),
			...clicks("메모", "10:02:00", 3),
		]);
		await setSkillDescriptionsEnabled(paths.root, false);

		const result = await summarizeHistory(paths, { now: ms("10:30:00"), timeZone: "UTC" });

		expect(result.created).toEqual(["2026-11-20/1001-장보기-목록-in-메모.md"]);
	});

	it("writes no memory for a stray action or for the segment still being recorded", async () => {
		writeSegment(segmentId("09:00:00"), [windowChange("Brave Browser", "A page retitled itself", "09:05:00")]);
		writeSegment(segmentId("10:20:00"), clicks("Mail", "10:21:00", 5));
		await setSkillDescriptionsEnabled(paths.root, false);

		const result = await summarizeHistory(paths, { now: ms("10:25:00"), timeZone: "UTC" });

		expect(result).toMatchObject({ created: [], skipped: 1 });
		expect(memoryFiles()).toEqual([]);
	});
});

describe("#given the model switch on #when history is summarized #then the owner's agent writes the title and summary from a prompt without typed text", () => {
	it("sends apps, windows, documents, pages and field labels to the agent and never what was typed", async () => {
		writeSegment(segmentId("10:00:00"), reportSegment());
		const agent = fakeAgent();

		const result = await summarizeHistory(paths, { now: ms("10:30:00"), timeZone: "UTC", generate: agent.generate });

		const file = "2026-11-20/1001-reviewed-the-report.md";
		expect(result).toMatchObject({ created: [file], agentFailures: 0, summarizer: "agent" });
		expect(agent.prompts).toHaveLength(1);
		const [prompt = ""] = agent.prompts;
		// Browser pages reach the agent as their host only (see the search-title test below).
		for (const shown of ["Xcode", "Safari", "/Users/me/notes/report.md", '"github.com"', "Search"]) {
			expect(prompt).toContain(shown);
		}
		expect(prompt).toContain(`typed ${TYPED.length} chars into`);
		for (const secret of [TYPED, FIELD_VALUE, QUERY]) {
			expect(prompt).not.toContain(secret);
			expect(readMemory(file)).not.toContain(secret);
		}
		expect(listHistoryMemories(paths)[0]?.title).toBe("Reviewed the report");
		expect(readMemory(file)).toContain("Reply to the review");
	});

	it("builds the same prompt directly from a session, which holds no typed text to leak", () => {
		const [session] = sessionizeHistory([{ id: segmentId("10:00:00"), events: reportSegment() }]);
		if (session === undefined) throw new Error("fixture produced no session");

		const prompt = historyMemoryPrompt(session, "UTC");

		for (const secret of [TYPED, FIELD_VALUE, QUERY]) expect(prompt).not.toContain(secret);
	});

	it("gives the agent a browser's site host only, never a search title or page path that repeats what was typed", () => {
		const searched = "zx-searched-words-63";
		const events = [
			windowChange("Safari", `${searched} - Google Search`, "10:01:00", {
				document: { url: `https://www.google.com/maps/search/${searched}` },
			}),
			...clicks("Safari", "10:02:00", 4),
			windowChange("Xcode", "report.md - notes", "10:03:00"),
			...clicks("Xcode", "10:04:00", 4),
		];
		const [session] = sessionizeHistory([{ id: segmentId("10:00:00"), events }]);
		if (session === undefined) throw new Error("fixture produced no session");

		const prompt = historyMemoryPrompt(session, "UTC");

		expect(prompt).not.toContain(searched);
		expect(prompt).toContain('"www.google.com"');
		expect(prompt).toContain('"report.md - notes"');
	});

	it.each([
		["throws", (): Promise<string> => Promise.reject(new Error("agent unavailable"))],
		["answers without JSON", (): Promise<string> => Promise.resolve("I cannot help with that.")],
		["answers with an empty title", (): Promise<string> => Promise.resolve('{"title": " ", "summary": "x"}')],
	])("falls back to the local summary and counts the failure when the agent %s", async (_case, generate) => {
		writeSegment(segmentId("10:00:00"), reportSegment());

		const result = await summarizeHistory(paths, { now: ms("10:30:00"), timeZone: "UTC", generate });

		expect(result).toMatchObject({ created: ["2026-11-20/1001-report-md-in-xcode.md"], agentFailures: 1 });
	});

	it("leaves a session for the next run when the run was stopped, and writes it then", async () => {
		writeSegment(segmentId("10:00:00"), reportSegment());
		const agent = fakeAgent();
		const stopped = new AbortController();
		stopped.abort();

		const first = await summarizeHistory(paths, {
			now: ms("10:30:00"),
			timeZone: "UTC",
			generate: agent.generate,
			signal: stopped.signal,
		});
		const second = await summarizeHistory(paths, { now: ms("10:30:00"), timeZone: "UTC", generate: agent.generate });

		expect(first).toMatchObject({ created: [], deferred: 1 });
		expect(second).toMatchObject({ created: ["2026-11-20/1001-reviewed-the-report.md"], deferred: 0 });
	});

	it("reads agent text only when it is one bounded JSON object, and makes model text one line each", () => {
		expect(parseHistoryMemoryText(`Sure: ${agentAnswer}`)?.title).toBe("Reviewed the report");
		expect(parseHistoryMemoryText('{"title": "A\\nB", "summary": "s", "nextSteps": ["x", 3, " "]}')).toEqual({
			title: "A B",
			summary: "s",
			nextSteps: ["x"],
		});
		expect(parseHistoryMemoryText(JSON.stringify({ title: "t".repeat(81), summary: "s" }))).toBeUndefined();
		expect(parseHistoryMemoryText(JSON.stringify({ title: "t", summary: "s".repeat(601) }))).toBeUndefined();
		expect(parseHistoryMemoryText("[1, 2]")).toBeUndefined();
	});

	it("writes page text that tries to be Markdown as inert text", async () => {
		const hostile = "![x](https://evil.example/p.png) <img src=x>";
		writeSegment(segmentId("10:00:00"), [
			windowChange("Safari", hostile, "10:01:00"),
			...clicks("Safari", "10:02:00", 3),
		]);
		await setSkillDescriptionsEnabled(paths.root, false);

		const result = await summarizeHistory(paths, { now: ms("10:30:00"), timeZone: "UTC" });

		const body = readMemory(result.created[0] ?? "").split("\n---\n")[1] ?? "";
		const outsideCode = body.replace(/`[^`\n]*`/g, "");
		expect(outsideCode).not.toMatch(/(?<!\\)[[\]<>]/);
		expect(listHistoryMemories(paths)[0]?.title).toContain(hostile.slice(0, 20));
	});
});

describe("#given a memory already written #when history is summarized again #then nothing is rewritten unless its session went on", () => {
	const untilEight = (): unknown[] => [...clicks("Xcode", "10:01:00", 4), click("Xcode", "10:08:00")];

	it("writes nothing and asks the agent nothing on a second run over the same segments", async () => {
		writeSegment(segmentId("10:00:00"), untilEight());
		const agent = fakeAgent();
		const options = { now: ms("10:30:00"), timeZone: "UTC", generate: agent.generate };
		const first = await summarizeHistory(paths, options);
		const file = first.created[0] ?? "";
		const index = join(historyMemoriesDir(paths), ".index.json");
		const before = { memory: readMemory(file), index: readFileSync(index, "utf8"), written: statSync(index).mtimeMs };

		const second = await summarizeHistory(paths, options);

		expect(second).toMatchObject({ created: [], updated: [], skipped: 0, deferred: 0 });
		expect(agent.prompts).toHaveLength(1);
		expect(readMemory(file)).toBe(before.memory);
		expect(readFileSync(index, "utf8")).toBe(before.index);
		expect(statSync(index).mtimeMs).toBe(before.written);
	});

	it("rewrites the newest memory in place, at the same path, when its session goes on", async () => {
		writeSegment(segmentId("10:00:00"), untilEight());
		await setSkillDescriptionsEnabled(paths.root, false);
		const first = await summarizeHistory(paths, { now: ms("10:12:00"), timeZone: "UTC" });
		writeSegment(segmentId("10:10:00"), clicks("Xcode", "10:11:00", 3));

		const second = await summarizeHistory(paths, { now: ms("10:25:00"), timeZone: "UTC" });

		expect(second).toMatchObject({ created: [], updated: first.created });
		expect(listHistoryMemories(paths)).toHaveLength(1);
		expect(listHistoryMemories(paths)[0]).toMatchObject({
			start: at("10:01:00"),
			end: at("10:11:02"),
			segments: [segmentId("10:00:00"), segmentId("10:10:00")],
		});
	});

	it("never rewrites a memory the owner edited: later activity starts a new memory instead", async () => {
		writeSegment(segmentId("10:00:00"), untilEight());
		await setSkillDescriptionsEnabled(paths.root, false);
		const [file = ""] = (await summarizeHistory(paths, { now: ms("10:12:00"), timeZone: "UTC" })).created;
		const edited = `${readMemory(file)}\nMy own note: ask Dana about the release.\n`;
		writeFileSync(join(historyMemoriesDir(paths), file), edited);
		writeSegment(segmentId("10:10:00"), clicks("Xcode", "10:11:00", 3));

		const second = await summarizeHistory(paths, { now: ms("10:25:00"), timeZone: "UTC" });

		expect(readMemory(file)).toBe(edited);
		expect(second).toMatchObject({ created: ["2026-11-20/1011-xcode.md"], updated: [] });
		expect(listHistoryMemories(paths).map((memory) => memory.segments)).toEqual([
			[segmentId("10:10:00")],
			[segmentId("10:00:00")],
		]);
	});

	it("does not bring back a memory the owner deleted, with or without new activity", async () => {
		writeSegment(segmentId("10:00:00"), untilEight());
		await setSkillDescriptionsEnabled(paths.root, false);
		const [file = ""] = (await summarizeHistory(paths, { now: ms("10:12:00"), timeZone: "UTC" })).created;
		rmSync(join(historyMemoriesDir(paths), file));

		const quiet = await summarizeHistory(paths, { now: ms("10:20:00"), timeZone: "UTC" });
		writeSegment(segmentId("10:10:00"), clicks("Xcode", "10:11:00", 3));
		const later = await summarizeHistory(paths, { now: ms("10:25:00"), timeZone: "UTC" });

		expect(quiet).toMatchObject({ created: [], updated: [] });
		expect(later.created).toEqual(["2026-11-20/1011-xcode.md"]);
		expect(memoryFiles()).toEqual(["2026-11-20/1011-xcode.md"]);
	});

	it("never replaces a file that already sits at the name a new memory would take", async () => {
		writeSegment(segmentId("10:00:00"), untilEight());
		await setSkillDescriptionsEnabled(paths.root, false);
		const day = join(historyMemoriesDir(paths), "2026-11-20");
		mkdirSync(day, { recursive: true });
		writeFileSync(join(day, "1001-xcode.md"), "the owner's own file\n");

		const result = await summarizeHistory(paths, { now: ms("10:30:00"), timeZone: "UTC" });

		expect(result.created).toEqual(["2026-11-20/1001-xcode-2.md"]);
		expect(readMemory("2026-11-20/1001-xcode.md")).toBe("the owner's own file\n");
	});
});

describe("#given raw segments past the retention #when history is summarized #then only summarized ones are deleted and memories stay", () => {
	const old = "2026-11-18";
	const oldSegment = segmentId("09:00:00", old);
	const oldEvents = (): unknown[] =>
		Array.from({ length: 4 }, (_, index) => ({
			kind: "mouse.click",
			timestamp: at(`09:01:0${index}`, old),
			app: app("Mail"),
			mouse: { button: "left" },
		}));

	it("keeps an old segment whose session has no memory yet, then deletes it once the memory exists", async () => {
		writeSegment(oldSegment, oldEvents());
		writeSegment(segmentId("10:00:00"), clicks("Xcode", "10:01:00", 4));
		const agent = fakeAgent();
		const stopped = new AbortController();
		stopped.abort();
		const options = { now: ms("10:30:00"), timeZone: "UTC", generate: agent.generate };

		const first = await summarizeHistory(paths, { ...options, signal: stopped.signal });
		const kept = segmentsOnDisk();
		const second = await summarizeHistory(paths, options);

		expect(first).toMatchObject({ deferred: 2, expiredSegments: [] });
		expect(kept).toEqual([oldSegment, segmentId("10:00:00")]);
		expect(second.expiredSegments).toEqual([oldSegment]);
		expect(segmentsOnDisk()).toEqual([segmentId("10:00:00")]);
		expect(memoryFiles()).toEqual([
			"2026-11-18/0901-reviewed-the-report.md",
			"2026-11-20/1001-reviewed-the-report.md",
		]);
	});

	it("deletes old segments that hold nothing to summarize, and keeps a memory after its raw segment is gone", async () => {
		writeSegment(oldSegment, oldEvents());
		writeSegment(segmentId("09:30:00", old), [{ kind: "session.started", timestamp: at("09:30:01", old) }]);
		await setSkillDescriptionsEnabled(paths.root, false);

		const result = await summarizeHistory(paths, { now: ms("10:30:00"), timeZone: "UTC" });
		const again = await summarizeHistory(paths, { now: ms("10:40:00"), timeZone: "UTC" });

		expect(result.expiredSegments).toEqual([oldSegment, segmentId("09:30:00", old)]);
		expect(segmentsOnDisk()).toEqual([]);
		expect(memoryFiles()).toEqual(["2026-11-18/0901-mail.md"]);
		expect(again).toMatchObject({ created: [], updated: [], expiredSegments: [] });
	});

	it("uses rawRetentionHours from settings.json when it is set", async () => {
		writeSegment(segmentId("08:00:00"), clicks("Mail", "08:01:00", 4));
		writeSegment(segmentId("10:00:00"), clicks("Xcode", "10:01:00", 4));
		writeFileSync(paths.settingsPath, JSON.stringify({ rawRetentionHours: 1 }));
		await setSkillDescriptionsEnabled(paths.root, false);

		const result = await summarizeHistory(paths, { now: ms("10:30:00"), timeZone: "UTC" });

		expect(result.expiredSegments).toEqual([segmentId("08:00:00")]);
		expect(memoryFiles()).toHaveLength(2);
	});
});

describe("#given segments and memories #when a period is cleared #then only what reaches into that period is deleted", () => {
	async function threeSessions(): Promise<void> {
		writeSegment(segmentId("09:00:00"), clicks("Mail", "09:01:00", 4));
		writeSegment(segmentId("11:20:00"), clicks("Xcode", "11:21:00", 4));
		writeSegment(segmentId("11:40:00"), clicks("Notes", "11:41:00", 4));
		await setSkillDescriptionsEnabled(paths.root, false);
		await summarizeHistory(paths, { now: ms("12:00:00"), timeZone: "UTC" });
		mkdirSync(paths.summariesPath, { recursive: true });
		for (const id of [segmentId("09:00:00"), segmentId("11:40:00")]) {
			writeFileSync(join(paths.summariesPath, `auto-${id}.json`), "{}");
		}
	}

	it("clears the last thirty minutes: the one segment and memory inside it, and that segment's automatic summary", async () => {
		await threeSessions();

		const cleared = clearHistory(paths, { withinMs: 30 * 60_000 }, ms("12:00:00"));

		expect(cleared).toEqual({
			segments: [segmentId("11:40:00")],
			memories: ["2026-11-20/1141-notes.md"],
			digests: [`auto-${segmentId("11:40:00")}.json`],
		});
		expect(segmentsOnDisk()).toEqual([segmentId("09:00:00"), segmentId("11:20:00")]);
		expect(memoryFiles()).toEqual(["2026-11-20/0901-mail.md", "2026-11-20/1121-xcode.md"]);
		expect(readdirSync(paths.summariesPath)).toEqual([`auto-${segmentId("09:00:00")}.json`]);
	});

	it("clears the last hour and keeps the morning", async () => {
		await threeSessions();

		const cleared = clearHistory(paths, { withinMs: 60 * 60_000 }, ms("12:00:00"));

		expect(cleared.segments).toEqual([segmentId("11:40:00"), segmentId("11:20:00")]);
		expect([...cleared.memories].sort()).toEqual(["2026-11-20/1121-xcode.md", "2026-11-20/1141-notes.md"]);
		expect(memoryFiles()).toEqual(["2026-11-20/0901-mail.md"]);
	});

	it("clears everything, removes the emptied day folder, and leaves a linked file and its target alone", async () => {
		await threeSessions();
		const outside = join(scratch, "outside.md");
		writeFileSync(outside, "not a memory\n");
		symlinkSync(outside, join(historyMemoriesDir(paths), "2026-11-20", "1200-linked.md"));

		const cleared = clearHistory(paths, { all: true }, ms("12:00:00"));

		expect(cleared.segments).toHaveLength(3);
		expect(cleared.memories).toHaveLength(3);
		expect(segmentsOnDisk()).toEqual([]);
		expect(memoryFiles()).toEqual([]);
		expect(readFileSync(outside, "utf8")).toBe("not a memory\n");
		expect(readdirSync(join(historyMemoriesDir(paths), "2026-11-20"))).toEqual(["1200-linked.md"]);
		expect(readdirSync(paths.summariesPath)).toEqual([]);
	});

	it("removes an emptied day folder and forgets cleared sessions, so a later run does not bring them back", async () => {
		await threeSessions();

		clearHistory(paths, { all: true }, ms("12:00:00"));
		const again = await summarizeHistory(paths, { now: ms("12:30:00"), timeZone: "UTC" });

		expect(existsSync(join(historyMemoriesDir(paths), "2026-11-20"))).toBe(false);
		expect(again).toMatchObject({ created: [], updated: [] });
	});

	it("deletes the memory of a session that reaches into the period and summarizes its older part again", async () => {
		writeSegment(segmentId("11:20:00"), [...clicks("Xcode", "11:21:00", 4), click("Xcode", "11:29:00")]);
		writeSegment(segmentId("11:30:00"), clicks("Xcode", "11:36:00", 4));
		await setSkillDescriptionsEnabled(paths.root, false);
		await summarizeHistory(paths, { now: ms("12:00:00"), timeZone: "UTC" });

		const cleared = clearHistory(paths, { withinMs: 25 * 60_000 }, ms("12:00:00"));
		const again = await summarizeHistory(paths, { now: ms("12:00:00"), timeZone: "UTC" });

		expect(cleared).toMatchObject({ segments: [segmentId("11:30:00")], memories: ["2026-11-20/1121-xcode.md"] });
		expect(again.created).toEqual(["2026-11-20/1121-xcode.md"]);
		expect(listHistoryMemories(paths)[0]).toMatchObject({ end: at("11:29:00"), segments: [segmentId("11:20:00")] });
	});

	it("rejects a period that is not a positive duration before deleting anything", async () => {
		await threeSessions();

		expect(() => clearHistory(paths, { withinMs: 0 }, ms("12:00:00"))).toThrow(/positive duration/);
		expect(memoryFiles()).toHaveLength(3);
	});
});

describe("#given memory files #when they are listed #then they come newest first and an owner's plain YAML still reads", () => {
	it("orders by day then time, filters by day, and skips links and files that are not memories", async () => {
		const memories = historyMemoriesDir(paths);
		for (const [day, name] of [
			["2026-11-19", "2300-late.md"],
			["2026-11-20", "0900-early.md"],
			["2026-11-20", "1400-after.md"],
		] as const) {
			mkdirSync(join(memories, day), { recursive: true });
			writeFileSync(join(memories, day, name), `---\ntitle: ${JSON.stringify(name)}\n---\n`);
		}
		writeFileSync(join(memories, "2026-11-20", "notes.txt"), "not a memory");
		mkdirSync(join(scratch, "elsewhere", "2026-11-21"), { recursive: true });
		writeFileSync(join(scratch, "elsewhere", "2026-11-21", "0100-linked.md"), "---\ntitle: linked\n---\n");
		symlinkSync(join(scratch, "elsewhere", "2026-11-21"), join(memories, "2026-11-21"));

		expect(listHistoryMemories(paths).map((memory) => memory.file)).toEqual([
			"2026-11-20/1400-after.md",
			"2026-11-20/0900-early.md",
			"2026-11-19/2300-late.md",
		]);
		expect(listHistoryMemories(paths, { day: "2026-11-19" }).map((memory) => memory.time)).toEqual(["23:00"]);
	});

	it("reads front matter an owner rewrote as plain YAML, and names a file without a title after its file name", () => {
		const day = join(historyMemoriesDir(paths), "2026-11-20");
		mkdirSync(day, { recursive: true });
		writeFileSync(
			join(day, "0900-planning.md"),
			[
				"---",
				"title: Planning: the release",
				"start: 2026-11-20T09:00:00Z",
				"apps:",
				"  - Notes",
				"  - 'Brave Browser'",
				"segments: [2026-11-20T09-00-00Z]",
				"suggestedSkill:",
				"  id: abc123",
				"  title: Draft the plan",
				"---",
				"body",
			].join("\n"),
		);
		writeFileSync(join(day, "0800-stand-up-notes.md"), "no front matter here\n");

		const [planning, untitled] = listHistoryMemories(paths);

		expect(planning).toMatchObject({
			title: "Planning: the release",
			start: "2026-11-20T09:00:00Z",
			apps: ["Notes", "Brave Browser"],
			segments: ["2026-11-20T09-00-00Z"],
			suggestedSkill: { id: "abc123", title: "Draft the plan" },
		});
		expect(planning?.end).toBeUndefined();
		expect(untitled).toMatchObject({ title: "stand up notes", apps: [], segments: [] });
	});
});

describe("#given a clear while the agent is answering #when the summary would be written #then the clear wins", () => {
	it("writes nothing over a cleared history and summarizes on the next run", async () => {
		writeSegment(segmentId("10:00:00"), reportSegment());

		const result = await summarizeHistory(paths, {
			now: ms("10:30:00"),
			timeZone: "UTC",
			generate: async () => {
				clearHistory(paths, { all: true }, ms("10:30:00"));
				return agentAnswer;
			},
		});

		expect(result.created).toEqual([]);
		expect(result.updated).toEqual([]);
		expect(memoryFiles()).toEqual([]);
	});
});

describe("#given a lock left by a run that died #when history is cleared #then the stale lock is taken over", () => {
	it("clears after removing a lock older than the stale limit", () => {
		writeSegment(segmentId("10:00:00"), reportSegment());
		const lock = join(historyMemoriesDir(paths), ".lock");
		mkdirSync(historyMemoriesDir(paths), { recursive: true });
		writeFileSync(lock, "1\n");
		const old = new Date(Date.now() - 60_000);
		utimesSync(lock, old, old);

		expect(clearHistory(paths, { all: true }, ms("10:30:00")).segments).toEqual([segmentId("10:00:00")]);
		expect(existsSync(lock)).toBe(false);
	});
});
