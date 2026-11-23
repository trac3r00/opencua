import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HistorySkillCandidate, describeHistoryStep } from "./history-skill-candidates.js";
import {
	SKILL_DESCRIPTIONS_FILE,
	describeSkillCandidates,
	parseSkillDescription,
	readSkillDescriptions,
	readSkippedSkillCandidates,
	setSkillDescriptionsEnabled,
	skillDescriptionPrompt,
	skillDescriptionsEnabled,
} from "./history-skill-descriptions.js";

let root: string;

beforeEach(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "opencua-skill-descriptions-")));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

function candidate(id: string): HistorySkillCandidate {
	return {
		id,
		proposedName: "safari-notes-workflow",
		description: "",
		occurrences: 3,
		apps: ["Notes", "Safari"],
		steps: [
			{ app: "Safari", action: "open", detail: "billing.example.com/invoices" },
			{ app: "Safari", action: "shortcut", detail: "cmd+c" },
			{ app: "Notes", action: "type", role: "text field", detail: "amount" },
			{ app: "Notes", action: "shortcut", detail: "cmd+s" },
		],
		parameters: [{ step: 3, app: "Notes", field: "amount", samples: 3, distinctValues: 3, varies: true }],
		segmentIds: ["s", "t"],
		lastSeenAt: "",
	};
}

const answer = JSON.stringify({
	name: "copy-invoice-to-ledger",
	title: "Copy invoice text into the Notes ledger",
	summary: "Copies text from an invoice in Safari and pastes it into your Notes ledger.",
	whenToUse: "When you move invoice text from Safari into Notes.",
});

describe("#given model text #when it is parsed #then only a complete, bounded description is accepted", () => {
	it("reads the JSON object even with prose around it", () => {
		expect(parseSkillDescription(`Sure! ${answer} Hope it helps.`)?.name).toBe("copy-invoice-to-ledger");
	});

	it.each([
		["no JSON", "I cannot help with that."],
		["broken JSON", "{ name: nope"],
		["a bad slug", answer.replace("copy-invoice-to-ledger", "Copy Invoice")],
		["a missing field", JSON.stringify({ name: "a", title: "b", summary: "c" })],
		["an oversized title", answer.replace("Copy invoice text into the Notes ledger", "x".repeat(81))],
		["a non-string field", JSON.stringify({ name: "a", title: 1, summary: "c", whenToUse: "d" })],
	])("rejects %s", (_label, text) => {
		expect(parseSkillDescription(text)).toBeUndefined();
	});
});

describe("#given suggested candidates #when they are described #then each is asked once and cached", () => {
	it("asks for the missing candidates in parallel, caches answers, and reuses them on the next run", async () => {
		const prompts: string[] = [];
		const generate = async (prompt: string) => {
			prompts.push(prompt);
			return answer;
		};

		const first = await describeSkillCandidates(root, [candidate("a1"), candidate("b2")], generate);
		const second = await describeSkillCandidates(root, [candidate("a1"), candidate("b2")], generate);

		expect(prompts).toHaveLength(2);
		expect(first["a1"]?.title).toBe("Copy invoice text into the Notes ledger");
		expect(second).toEqual(first);
		expect((await stat(join(root, SKILL_DESCRIPTIONS_FILE))).mode & 0o777).toBe(0o600);
	});

	it("leaves a failed or unusable answer undescribed so the next run tries again", async () => {
		const generate = async (prompt: string) => {
			if (prompt.includes("x9")) throw new Error("model unavailable");
			return "not json";
		};

		expect(await describeSkillCandidates(root, [candidate("x9"), candidate("y8")], generate)).toEqual({});
		expect(await readSkillDescriptions(root)).toEqual({});
		await expect(readFile(join(root, SKILL_DESCRIPTIONS_FILE))).rejects.toThrow();
	});

	it("caches a skip verdict for mere navigation and never shows or asks for that candidate again", async () => {
		const prompts: string[] = [];
		const generate = async (prompt: string) => {
			prompts.push(prompt);
			return prompt.includes("reload") ? 'Skipping: {"skip": true, "reason": "only app switching"}' : answer;
		};
		const navigation: HistorySkillCandidate = {
			...candidate("a1"),
			steps: [
				{ app: "Brave Browser", action: "press", role: "button", detail: "reload" },
				{ app: "Herdr", action: "shortcut", detail: "cmd+r" },
				{ app: "Brave Browser", action: "press", role: "button", detail: "back" },
			],
			parameters: [],
		};

		const first = await describeSkillCandidates(root, [navigation, candidate("b2")], generate);
		const second = await describeSkillCandidates(root, [navigation, candidate("b2")], generate);

		expect(Object.keys(first)).toEqual(["b2"]);
		expect(second).toEqual(first);
		expect(prompts).toHaveLength(2);
		expect([...(await readSkippedSkillCandidates(root))]).toEqual(["a1"]);
		expect(Object.keys(await readSkillDescriptions(root))).toEqual(["b2"]);
	});

	it("puts every step into the prompt the way history describes it", () => {
		const prompt = skillDescriptionPrompt(candidate("a1"));
		for (const step of candidate("a1").steps) expect(prompt).toContain(describeHistoryStep(step));
	});
});

describe("#given the descriptions setting #when read #then it is on until turned off", () => {
	it("defaults on, turns off and on again", async () => {
		expect(await skillDescriptionsEnabled(root)).toBe(true);
		await setSkillDescriptionsEnabled(root, false);
		expect(await skillDescriptionsEnabled(root)).toBe(false);
		await setSkillDescriptionsEnabled(root, true);
		expect(await skillDescriptionsEnabled(root)).toBe(true);
	});
});
