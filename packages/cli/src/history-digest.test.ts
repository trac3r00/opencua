import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type HistoryMemory,
	SKILL_DESCRIPTIONS_FILE,
	historyPaths,
	listHistoryMemories,
	setSkillDescriptionsEnabled,
} from "@opencua/core/light";
import {
	digestLatestHistory,
	formatTimeline,
	historyAutomationEnabled,
	listHistoryDigests,
	setHistoryAutomation,
	summarizeHistoryNow,
	timelineDays,
} from "./history-digest.js";

const roots: string[] = [];
const segmentId = "2026-10-29T04-00-00Z";

function tempRoot(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "opencua-history-digest-")));
	roots.push(root);
	return root;
}

function writeSegment(root: string, id = segmentId, endedAt = "2026-10-29T04:10:00Z"): void {
	const directory = join(root, "segments", id);
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "metadata.json"),
		JSON.stringify({
			id,
			startedAt: "2026-10-29T04:00:00Z",
			endedAt,
			eventCount: 1,
		}),
	);
	writeFileSync(
		join(directory, "events.jsonl"),
		`${JSON.stringify({
			kind: "mouse.click",
			timestamp: "2026-10-29T04:03:00Z",
			app: { name: "Finder" },
		})}\n`,
	);
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("#given a workflow repeated in a session #when history is summarized now #then its memory names the suggested skill", () => {
	const mail = { name: "Mail", bundleIdentifier: "com.apple.mail", processIdentifier: 100 };
	const now = Date.parse("2026-11-01T11:00:00Z");
	const segments = ["2026-11-01T10-00-00Z", "2026-11-01T10-10-00Z"];

	/** Mail composed twice, six minutes apart, in two segments: one session and one repeated workflow. */
	function composedTwice(): ReturnType<typeof historyPaths> {
		const paths = historyPaths(tempRoot());
		for (const [index, id] of segments.entries()) {
			const base = { timestamp: `2026-11-01T10:${index === 0 ? "05" : "11"}:00Z`, app: mail };
			const events = [
				{ ...base, kind: "mouse.click", mouse: {}, element: { role: "AXButton", title: "New Message" } },
				{
					...base,
					kind: "keyboard.text_input",
					keyboard: { text: `private-to-${index}` },
					element: { role: "AXTextField", title: "To" },
				},
				{
					...base,
					kind: "keyboard.text_input",
					keyboard: { text: `private-subject-${index}` },
					element: { role: "AXTextField", title: "Subject" },
				},
				{ ...base, kind: "keyboard.shortcut", keyboard: { keyEquivalent: "d", modifiers: ["command", "shift"] } },
			];
			mkdirSync(join(paths.segmentsDir, id), { recursive: true });
			writeFileSync(
				join(paths.segmentsDir, id, "events.jsonl"),
				events.map((event) => `${JSON.stringify(event)}\n`).join(""),
			);
		}
		return paths;
	}

	function agent(): { readonly prompts: string[]; generate(prompt: string): Promise<string> } {
		const prompts: string[] = [];
		return {
			prompts,
			async generate(prompt) {
				prompts.push(prompt);
				return JSON.stringify({
					title: "Sent two messages",
					summary: "Composed and sent mail twice.",
					nextSteps: [],
				});
			},
		};
	}

	it("asks the agent with the switch on and titles the skill by its proposed name until it is described", async () => {
		const paths = composedTwice();
		const owner = agent();

		const result = await summarizeHistoryNow(paths, { generate: owner.generate, now, timeZone: "UTC" });

		const [memory] = listHistoryMemories(paths);
		expect(result).toMatchObject({ created: ["2026-11-01/1005-sent-two-messages.md"], summarizer: "agent" });
		expect(owner.prompts).toHaveLength(1);
		expect(owner.prompts[0]).not.toContain("private-");
		expect(memory).toMatchObject({ title: "Sent two messages", segments, apps: ["Mail"] });
		expect(memory?.suggestedSkill).toEqual({ id: expect.stringMatching(/^[0-9a-f]{12}$/), title: "mail-workflow" });
	});

	it("uses the title the owner already sees for a described suggestion, and drops one a model rejected", async () => {
		const described = composedTwice();
		await summarizeHistoryNow(described, { useAgent: false, now, timeZone: "UTC" });
		const id = listHistoryMemories(described)[0]?.suggestedSkill?.id ?? "";
		const description = {
			name: "send-mail",
			title: "Compose and send a message",
			summary: "Sends mail.",
			whenToUse: "x",
		};

		const titled = composedTwice();
		writeFileSync(
			join(titled.root, SKILL_DESCRIPTIONS_FILE),
			JSON.stringify({ descriptions: { [id]: description } }),
		);
		await summarizeHistoryNow(titled, { useAgent: false, now, timeZone: "UTC" });
		const rejected = composedTwice();
		writeFileSync(join(rejected.root, SKILL_DESCRIPTIONS_FILE), JSON.stringify({ descriptions: {}, skipped: [id] }));
		await summarizeHistoryNow(rejected, { useAgent: false, now, timeZone: "UTC" });

		expect(id).toMatch(/^[0-9a-f]{12}$/);
		expect(listHistoryMemories(titled)[0]?.suggestedSkill).toEqual({ id, title: description.title });
		expect(listHistoryMemories(rejected)).toHaveLength(1);
		expect(listHistoryMemories(rejected)[0]?.suggestedSkill).toBeUndefined();
	});

	it.each([
		["the switch is off", { off: true, useAgent: true }],
		["the caller asks for no model", { off: false, useAgent: false }],
	])("never calls the agent when %s", async (_case, { off, useAgent }) => {
		const paths = composedTwice();
		if (off) await setSkillDescriptionsEnabled(paths.root, false);
		const owner = agent();

		const result = await summarizeHistoryNow(paths, { generate: owner.generate, useAgent, now, timeZone: "UTC" });

		expect(owner.prompts).toEqual([]);
		expect(result).toMatchObject({ created: ["2026-11-01/1005-mail.md"], summarizer: "local" });
	});

	it("writes nothing when the run is already stopped, so a slow agent cannot hold up the caller", async () => {
		const paths = composedTwice();
		const owner = agent();
		const stopped = new AbortController();
		stopped.abort();

		const result = await summarizeHistoryNow(paths, {
			generate: owner.generate,
			signal: stopped.signal,
			now,
			timeZone: "UTC",
		});

		expect(result).toMatchObject({ created: [], deferred: 1 });
		expect(owner.prompts).toEqual([]);
	});
});

describe("#given memories #when the timeline is formatted #then they are grouped by day in the order given", () => {
	const memory = (day: string, time: string, extra: Partial<HistoryMemory> = {}): HistoryMemory => ({
		day,
		time,
		file: `${day}/${time.replace(":", "")}-work.md`,
		path: `/memories/${day}/${time.replace(":", "")}-work.md`,
		title: `Work at ${time}`,
		apps: ["Xcode"],
		segments: [],
		...extra,
	});

	it("groups consecutive memories of one day and shows how long each took when both ends are known", () => {
		const memories = [
			memory("2026-11-21", "01:31", { start: "2026-11-20T16:31:00Z", end: "2026-11-20T18:18:00Z" }),
			memory("2026-11-20", "19:01", { start: "2026-11-20T10:01:00Z", apps: [] }),
			memory("2026-11-20", "09:00", { suggestedSkill: { id: "abc123def456", title: "File the report" } }),
		];

		expect(timelineDays(memories).map((group) => [group.day, group.memories.map((entry) => entry.time)])).toEqual([
			["2026-11-21", ["01:31"]],
			["2026-11-20", ["19:01", "09:00"]],
		]);
		expect(formatTimeline(memories).split("\n")).toEqual([
			"2026-11-21",
			"  01:31  Work at 01:31  [Xcode]  1h 47m",
			"2026-11-20",
			"  19:01  Work at 19:01",
			"  09:00  Work at 09:00  [Xcode]",
			"         suggested skill: File the report (abc123def456)",
			"",
		]);
	});

	it("says which day has no memories instead of printing an empty list", () => {
		expect(formatTimeline([], "2026-11-19")).toContain("2026-11-19");
		expect(formatTimeline([]).trim().length).toBeGreaterThan(0);
	});
});

describe("#given history automation #when checking consent #then only explicit settings enable it", () => {
	it("defaults to disabled and persists opt-in", async () => {
		const root = tempRoot();
		expect(await historyAutomationEnabled(join(root, "missing"))).toBe(false);
		expect(await historyAutomationEnabled(root)).toBe(false);
		await setHistoryAutomation(root, true);
		expect(await historyAutomationEnabled(root)).toBe(true);
		await setHistoryAutomation(root, false);
		expect(await historyAutomationEnabled(root)).toBe(false);
	});
});

describe("#given completed history #when a digest is requested #then one segment is summarized", () => {
	it("does not call the generator unless enabled and selects newest completed evidence", async () => {
		const root = tempRoot();
		mkdirSync(join(root, "segments"));
		writeSegment(root, segmentId);
		const newer = "2026-10-29T04-20-00Z";
		writeSegment(root, newer, "2026-10-29T04:30:00Z");
		let calls = 0;
		const generate = async (prompt: string): Promise<string> => {
			calls += 1;
			expect(prompt).toContain(newer);
			return JSON.stringify({ title: "Finder task", summary: "A short summary.", suggestion: null });
		};
		expect(await digestLatestHistory(root, generate, Date.parse("2026-10-30T00:00:00Z"))).toEqual({
			state: "disabled",
		});
		expect(calls).toBe(0);
		await setHistoryAutomation(root, true);
		const created = await digestLatestHistory(root, generate, Date.parse("2026-10-30T00:00:00Z"));
		expect(created.state).toBe("created");
		expect(created.digest).toMatchObject({ id: newer, sourceIds: [newer], title: "Finder task" });
		expect(calls).toBe(1);
		expect(await digestLatestHistory(root, generate, Date.parse("2026-10-30T00:00:00Z"))).toEqual({
			state: "up_to_date",
		});
		expect(calls).toBe(1);
	});

	it("returns empty for missing roots and ignores unfinished segments", async () => {
		const root = tempRoot();
		expect(await digestLatestHistory(join(root, "missing"))).toEqual({ state: "disabled" });
		mkdirSync(join(root, "segments"));
		writeSegment(root, segmentId, "2026-10-31T04:10:00Z");
		await setHistoryAutomation(root, true);
		expect(await digestLatestHistory(root, async () => "{}", Date.parse("2026-10-30T00:00:00Z"))).toEqual({
			state: "empty",
		});
	});
});

describe("#given generated model output #when validated #then malformed families are rejected", () => {
	it("counts every deterministic family as executed and rejects invalid output", async () => {
		const root = tempRoot();
		mkdirSync(join(root, "segments"));
		writeSegment(root);
		await setHistoryAutomation(root, true);
		const valid = { title: "Okay", summary: "Done", suggestion: null };
		const cases: readonly { readonly output: string; readonly accepted: boolean }[] = [
			{ output: JSON.stringify(valid), accepted: true },
			{ output: JSON.stringify({ ...valid, title: "t".repeat(161) }), accepted: false },
			{ output: JSON.stringify({ ...valid, summary: "s".repeat(12_001) }), accepted: false },
			{
				output: JSON.stringify({ ...valid, suggestion: { name: "Bad Name", description: "d", goal: "g" } }),
				accepted: false,
			},
			{
				output: JSON.stringify({
					...valid,
					suggestion: { name: "good-name", description: "d".repeat(1025), goal: "g" },
				}),
				accepted: false,
			},
			{ output: JSON.stringify({ ...valid, extra: true }), accepted: false },
			{ output: "{", accepted: false },
		];
		let attempted = 0;
		let executed = 0;
		const discarded = 0;
		let rejections = 0;
		for (const [index, testCase] of cases.entries()) {
			attempted += 1;
			executed += 1;
			const caseRoot = index === 0 ? root : tempRoot();
			if (index > 0) {
				mkdirSync(join(caseRoot, "segments"));
				writeSegment(caseRoot);
				await setHistoryAutomation(caseRoot, true);
			}
			const result = digestLatestHistory(caseRoot, async () => testCase.output, Date.parse("2026-10-30T00:00:00Z"));
			if (testCase.accepted) {
				await expect(result).resolves.toMatchObject({ state: "created" });
			} else {
				await expect(result).rejects.toThrow();
				rejections += 1;
			}
		}
		expect({ attempted, executed, discarded, rejections }).toEqual({
			attempted: 7,
			executed: 7,
			discarded: 0,
			rejections: 6,
		});
	});

	it("rejects symlink digest files and malformed persisted JSON", async () => {
		const root = tempRoot();
		const summaries = join(root, "summaries");
		mkdirSync(summaries);
		const outside = join(root, "outside");
		writeFileSync(outside, "{}");
		symlinkSync(outside, join(summaries, `auto-${segmentId}.json`));
		await expect(listHistoryDigests(root)).rejects.toThrow("Invalid or oversized history digest file");
	});
});
