import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_RETENTION_MS, historyPaths, writeHistoryState } from "@opencua/core";
import { MAX_MEMORY_BYTES, createHistorySource } from "./history-source.js";

const dirs: string[] = [];

function tempStateDir(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "cua-history-source-")));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("#given no watcher state #when status is read #then it reports stopped with the data paths", () => {
	it("defaults to stopped and reports the event-stream root", async () => {
		const stateDir = tempStateDir();
		const source = createHistorySource({ stateDir });
		const status = await source.status();
		expect(status.state).toBe("stopped");
		expect(status.eventStreamRootPath).toBe(join(stateDir, "cua-history"));
		expect(status.memoriesPath).toBe(join(stateDir, "cua-history", "memories"));
		expect(status.retentionHours).toBe(DEFAULT_RETENTION_MS / 3_600_000);
		expect(status.currentSegmentId).toBeUndefined();
	});
});

describe("#given settings updated through the tool #when read back #then the document round-trips", () => {
	it("persists settings for the watcher to read", async () => {
		const source = createHistorySource({ stateDir: tempStateDir() });
		await source.updateSettings({
			defaultApplicationBehavior: "do_not_observe",
			defaultURLBehavior: "observe",
			observePrivateBrowsing: false,
			rules: [{ scope: "app", bundleID: "com.apple.Terminal", behavior: "observe" }],
		});
		const read = await source.getSettings();
		expect(read.defaultApplicationBehavior).toBe("do_not_observe");
		expect(read.rules).toHaveLength(1);
	});
});

describe("#given a running watcher #when pause then resume #then the state file flips and back", () => {
	it("pauses a running watcher and resumes a paused one", async () => {
		const stateDir = tempStateDir();
		const source = createHistorySource({ stateDir, now: () => Date.parse("2026-10-29T04:03:00Z") });
		writeHistoryState(historyPaths(stateDir), "running");

		await source.pause();
		expect((await source.status()).state).toBe("paused");
		await source.resume();
		const status = await source.status();
		expect(status.state).toBe("running");
		expect(status.currentSegmentId).toBe("2026-10-29T04-00-00Z");
	});
});

describe("#given recorded segments on disk #when skills are suggested and saved #then files are read and written safely", () => {
	it("detects a repeat across segment files, saves once, and refuses to overwrite", async () => {
		const stateDir = tempStateDir();
		const segments = join(historyPaths(stateDir).root, "segments");
		// A Mail send with typed recipient and subject: real work, not navigation.
		const mail = { name: "Mail", bundleIdentifier: "com.apple.mail" };
		const typed = (field: string, text: string) =>
			JSON.stringify({
				kind: "keyboard.text_input",
				timestamp: "2026-11-01T10:00:00Z",
				app: mail,
				keyboard: { text },
				element: { role: "AXTextField", title: field },
			});
		const send = JSON.stringify({
			kind: "keyboard.shortcut",
			timestamp: "2026-11-01T10:00:00Z",
			app: mail,
			keyboard: { keyEquivalent: "d", modifiers: ["command", "shift"] },
		});
		const flow = [typed("To", "ann@x.io"), typed("Subject", "Invoice"), send];
		for (const id of ["2026-11-01T10-00-00Z", "2026-11-01T10-10-00Z"]) {
			mkdirSync(join(segments, id), { recursive: true });
			writeFileSync(join(segments, id, "events.jsonl"), `${[...flow, "{not json"].join("\n")}\n`);
		}
		mkdirSync(join(segments, "not-a-segment"));
		const skillsDirectory = join(stateDir, "skills");
		const source = createHistorySource({ stateDir, skillsDirectory });
		const detection = await source.suggestSkills({ limit: 5 });
		expect(detection.scannedSegments).toBe(2);
		expect(detection.skippedEvents).toBe(2);
		expect(detection.candidates[0]?.occurrences).toBe(2);
		const draft = { name: "invoice-ledger", description: "Copy totals", body: "# Steps" };
		const path = await source.saveSkill(draft);
		expect(path).toBe(join(skillsDirectory, "invoice-ledger", "SKILL.md"));
		expect(readFileSync(path, "utf8")).toContain('name: "invoice-ledger"');
		await expect(source.saveSkill(draft)).rejects.toThrow("Skill already exists");
	});

	it("ignores a symlinked events file", async () => {
		const stateDir = tempStateDir();
		const segment = join(historyPaths(stateDir).root, "segments", "2026-11-01T10-00-00Z");
		mkdirSync(segment, { recursive: true });
		const outside = join(stateDir, "outside.jsonl");
		writeFileSync(outside, "{}\n");
		symlinkSync(outside, join(segment, "events.jsonl"));
		const detection = await createHistorySource({ stateDir }).suggestSkills({ limit: 5 });
		expect(detection.scannedSegments).toBe(0);
	});
});

function writeMemory(stateDir: string, path: string, text: string): string {
	const file = join(historyPaths(stateDir).root, "memories", path);
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, text);
	return file;
}

const memory = (title: string, body: string) =>
	[
		"---",
		`title: "${title}"`,
		"start: 2026-11-23T09:30:00Z",
		"end: 2026-11-23T10:10:00Z",
		"apps: [Safari, 'Notes']",
		"segments:",
		"  - 2026-11-23T09-30-00Z",
		"  - 2026-11-23T09-40-00Z",
		"---",
		"",
		body,
	].join("\n");

describe("#given no memories folder #when the timeline is read #then it is empty", () => {
	it("returns no entries and nothing skipped", async () => {
		const stateDir = tempStateDir();
		const timeline = await createHistorySource({ stateDir }).timeline({ limit: 20 });
		expect(timeline).toEqual({ memoriesPath: join(stateDir, "cua-history", "memories"), entries: [], skipped: 0 });
	});
});

describe("#given memories over several days #when the timeline is read #then entries come newest first with front matter and summary", () => {
	it("orders by day then time, parses lists, and takes the first non-heading paragraph", async () => {
		const stateDir = tempStateDir();
		writeMemory(stateDir, "2026-11-22/1700-old.md", memory("Old", "Earlier work."));
		writeMemory(
			stateDir,
			"2026-11-23/0930-invoices.md",
			memory("Invoices", "# Invoices\n\nPaid two\ninvoices.\n\nMore."),
		);
		writeMemory(
			stateDir,
			"2026-11-23/1415-ledger.md",
			"---\ntitle: Ledger\napps:\n  - Numbers\nsuggestedSkill:\n  name: ledger-entry\n  why: repeated\n---\nTotals.",
		);
		const source = createHistorySource({ stateDir });

		const timeline = await source.timeline({ limit: 20 });

		expect(timeline.entries.map((entry) => entry.path)).toEqual([
			"2026-11-23/1415-ledger.md",
			"2026-11-23/0930-invoices.md",
			"2026-11-22/1700-old.md",
		]);
		expect(timeline.entries[0]).toEqual({
			path: "2026-11-23/1415-ledger.md",
			title: "Ledger",
			apps: ["Numbers"],
			segments: [],
			suggestedSkill: { name: "ledger-entry", why: "repeated" },
			summary: "Totals.",
		});
		expect(timeline.entries[1]).toEqual({
			path: "2026-11-23/0930-invoices.md",
			title: "Invoices",
			start: "2026-11-23T09:30:00Z",
			end: "2026-11-23T10:10:00Z",
			apps: ["Safari", "Notes"],
			segments: ["2026-11-23T09-30-00Z", "2026-11-23T09-40-00Z"],
			summary: "Paid two invoices.",
		});
	});

	it("honours the limit and the day filter", async () => {
		const stateDir = tempStateDir();
		writeMemory(stateDir, "2026-11-22/1700-old.md", memory("Old", "Earlier."));
		writeMemory(stateDir, "2026-11-23/0930-a.md", memory("A", "a"));
		writeMemory(stateDir, "2026-11-23/1000-b.md", memory("B", "b"));
		const source = createHistorySource({ stateDir });

		expect((await source.timeline({ limit: 1 })).entries.map((entry) => entry.title)).toEqual(["B"]);
		expect((await source.timeline({ day: "2026-11-22", limit: 20 })).entries.map((entry) => entry.title)).toEqual([
			"Old",
		]);
		expect((await source.timeline({ day: "2026-01-01", limit: 20 })).entries).toEqual([]);
	});

	it("skips a file without front matter and never follows a symlinked memory", async () => {
		const stateDir = tempStateDir();
		writeMemory(stateDir, "2026-11-23/0900-plain.md", "No front matter here.");
		const outside = join(stateDir, "outside.md");
		writeFileSync(outside, memory("Outside", "secret"));
		mkdirSync(join(historyPaths(stateDir).root, "memories", "2026-11-23"), { recursive: true });
		symlinkSync(outside, join(historyPaths(stateDir).root, "memories", "2026-11-23", "1000-link.md"));

		const timeline = await createHistorySource({ stateDir }).timeline({ limit: 20 });

		expect(timeline.entries).toEqual([]);
		expect(timeline.skipped).toBe(1);
	});
});

describe("#given a memory path #when the memory is read #then only files inside the memories folder are returned", () => {
	it("returns the whole Markdown file", async () => {
		const stateDir = tempStateDir();
		const text = memory("Invoices", "Paid.");
		writeMemory(stateDir, "2026-11-23/0930-invoices.md", text);

		const read = await createHistorySource({ stateDir }).readMemory("2026-11-23/0930-invoices.md");

		expect(read).toEqual({
			path: "2026-11-23/0930-invoices.md",
			bytes: Buffer.byteLength(text),
			truncated: false,
			text,
		});
	});

	it.each([
		"../settings.json",
		"2026-11-23/../../state.json",
		"/etc/passwd",
		"2026-11-23/sub/0930-x.md",
		"2026-11-23\\0930-x.md",
		"2026-11-23/notes.txt",
	])("refuses the path %s before reading anything", async (path) => {
		const source = createHistorySource({ stateDir: tempStateDir() });
		await expect(source.readMemory(path)).rejects.toThrow("is not a memory path");
	});

	it("refuses a missing memory, a missing folder and a symlinked file", async () => {
		const stateDir = tempStateDir();
		const source = createHistorySource({ stateDir });
		await expect(source.readMemory("2026-11-23/0930-none.md")).rejects.toThrow("No memory");
		const outside = join(stateDir, "outside.md");
		writeFileSync(outside, "secret");
		mkdirSync(join(historyPaths(stateDir).root, "memories", "2026-11-23"), { recursive: true });
		symlinkSync(outside, join(historyPaths(stateDir).root, "memories", "2026-11-23", "0930-link.md"));
		await expect(source.readMemory("2026-11-23/0930-link.md")).rejects.toThrow("No memory");
	});

	it("caps an oversized memory and says it was truncated", async () => {
		const stateDir = tempStateDir();
		writeMemory(stateDir, "2026-11-23/0930-big.md", "x".repeat(MAX_MEMORY_BYTES + 100));

		const read = await createHistorySource({ stateDir }).readMemory("2026-11-23/0930-big.md");

		expect(read.truncated).toBe(true);
		expect(read.bytes).toBe(MAX_MEMORY_BYTES + 100);
		expect(read.text.length).toBe(MAX_MEMORY_BYTES);
	});
});
