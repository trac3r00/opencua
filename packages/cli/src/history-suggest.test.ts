import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HistorySkillDetection, SKILL_DESCRIPTIONS_FILE, suggestHistorySkills } from "@opencua/core/light";
import {
	SKILL_SUGGESTIONS_FILE,
	formatSuggestions,
	menuSuggestions,
	suggestedHistorySkills,
	withoutSkippedCandidates,
	writeMenuSuggestions,
} from "./history-suggest.js";

const TYPED = ["private-to-1@example.com", "private-to-2@example.com", "private-subject-1", "private-subject-2"];
const mail = { name: "Mail", bundleIdentifier: "com.apple.mail", processIdentifier: 100 };

/** Composing a message: press New Message, type into To and Subject, send with shift+cmd+d. The typed text differs each time. */
function compose(run: number, minute: number): unknown[] {
	const base = { timestamp: `2026-11-01T10:${String(minute).padStart(2, "0")}:00Z`, app: mail };
	return [
		{ ...base, kind: "mouse.click", mouse: { button: "left" }, element: { role: "AXButton", title: "New Message" } },
		{
			...base,
			kind: "keyboard.text_input",
			keyboard: { text: `private-to-${run}@example.com` },
			element: { role: "AXTextField", title: "To" },
		},
		{
			...base,
			kind: "keyboard.text_input",
			keyboard: { text: `private-subject-${run}` },
			element: { role: "AXTextField", title: "Subject" },
		},
		{ ...base, kind: "keyboard.shortcut", keyboard: { keyEquivalent: "d", modifiers: ["command", "shift"] } },
	];
}

let root: string;
let detection: HistorySkillDetection;

beforeEach(async () => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "opencua-suggest-")));
	for (const [id, events] of [
		["2026-11-01T10-00-00Z", compose(1, 1)],
		["2026-11-01T10-10-00Z", compose(2, 11)],
	] as const) {
		mkdirSync(join(root, "segments", id), { recursive: true });
		writeFileSync(
			join(root, "segments", id, "events.jsonl"),
			events.map((event) => `${JSON.stringify(event)}\n`).join(""),
		);
	}
	detection = await suggestHistorySkills(root, { limit: 5 });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function expectNoTypedText(output: string): void {
	for (const text of TYPED) expect(output).not.toContain(text);
}

describe("#given a form filled twice in two segments #when formatting #then the terminal list and menu items name it without typed text", () => {
	it("prints a numbered list and builds an agent prompt per menu item", () => {
		const list = formatSuggestions(detection);
		const [item] = menuSuggestions(detection);

		expect(detection.candidates.map((candidate) => candidate.steps.map((step) => step.action))).toEqual([
			["press", "type", "type", "shortcut"],
		]);
		expect(list).toContain("1. mail-workflow  (repeated 2x");
		expect(item?.title).toBe("Mail: 4 steps, repeated 2x");
		expect(item?.prompt).toContain("cua_history_save_skill");
		expectNoTypedText(list);
		expectNoTypedText(JSON.stringify(menuSuggestions(detection)));
	});

	it("explains how to get suggestions when none exist", async () => {
		rmSync(join(root, "segments"), { recursive: true });

		expect(formatSuggestions(await suggestHistorySkills(root))).toContain("repeat a task at least twice");
	});
});

describe("#given a history root #when writing menu suggestions #then the file is private JSON and symlinks are refused", () => {
	it("writes 0600 JSON atomically, without typed text", async () => {
		const path = await writeMenuSuggestions(root, detection);

		expect(path).toBe(join(root, SKILL_SUGGESTIONS_FILE));
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(path, "utf8")).suggestions).toHaveLength(1);
		expectNoTypedText(readFileSync(path, "utf8"));
	});

	it("refuses a symlinked root", async () => {
		symlinkSync(root, join(root, "link"));

		await expect(writeMenuSuggestions(join(root, "link"), detection)).rejects.toThrow("real directory");
	});
});

describe("#given a candidate a model rejected as navigation #when suggestions are gathered #then it is not suggested", () => {
	it("drops the skipped candidate from the list and from the menu file", async () => {
		const id = detection.candidates[0]?.id ?? "";
		writeFileSync(join(root, SKILL_DESCRIPTIONS_FILE), JSON.stringify({ descriptions: {}, skipped: [id] }));

		const kept = await suggestedHistorySkills(root, 5);
		const path = await writeMenuSuggestions(root, kept);

		expect(detection.candidates).toHaveLength(1);
		expect(kept.candidates).toEqual([]);
		expect(kept.scannedSegments).toBe(2);
		expect(JSON.parse(readFileSync(path, "utf8")).suggestions).toEqual([]);
		expect(formatSuggestions(kept)).not.toContain("mail-workflow");
	});

	it("keeps candidates that are not skipped", async () => {
		writeFileSync(
			join(root, SKILL_DESCRIPTIONS_FILE),
			JSON.stringify({ descriptions: {}, skipped: ["0123456789ab"] }),
		);

		expect((await suggestedHistorySkills(root, 5)).candidates).toEqual(detection.candidates);
		expect(withoutSkippedCandidates(detection, new Set(["0123456789ab"])).candidates).toHaveLength(1);
	});
});

describe("#given a description a small model wrote #when suggestions are shown #then people see what the skill does", () => {
	const description = {
		name: "send-a-message",
		title: "Compose and send a message",
		summary: "Opens a new message, fills in the recipient and subject, and sends it.",
		whenToUse: "When you ask to send someone a message.",
	};

	it("titles the menu item with the description and names the skill in the agent prompt", () => {
		const id = detection.candidates[0]?.id ?? "";
		const [item] = menuSuggestions(detection, { [id]: description });

		expect(item?.title).toBe(`${description.title} (2x)`);
		expect(item?.prompt).toContain(description.name);
		expectNoTypedText(item?.prompt ?? "");
	});

	it("prints the title, summary and when to use it, and still the raw steps without one", () => {
		const id = detection.candidates[0]?.id ?? "";
		const described = formatSuggestions(detection, { [id]: description });

		for (const text of [description.title, description.summary, description.whenToUse])
			expect(described).toContain(text);
		expect(formatSuggestions(detection)).toContain(detection.candidates[0]?.proposedName ?? "missing");
		expectNoTypedText(described);
	});
});
