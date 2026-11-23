import { describe, expect, it } from "bun:test";
import type { HistoryEvent } from "./history-events.js";
import {
	type HistorySegmentEvents,
	type HistorySkillDetection,
	type HistoryStep,
	detectHistorySkillCandidates,
	historyStepsForSegment,
	isPeriodic,
	nonOverlappingStarts,
} from "./history-skill-candidates.js";

let nextId = 0;
const at = (second: number): string =>
	`2026-11-01T10:${String(Math.floor(second / 60) % 60).padStart(2, "0")}:${String(second % 60).padStart(2, "0")}Z`;
const app = (name: string) => ({
	name,
	bundleIdentifier: `com.example.${name.toLowerCase().replace(/\W+/g, "")}`,
	processIdentifier: 100,
});
const base = (name: string, second: number) => ({ id: nextId++, timestamp: at(second), app: app(name) });

function nav(name: string, title: string, second = 0): HistoryEvent {
	return { ...base(name, second), kind: "window.changed", window: { title, windowID: 0 } };
}
function opened(name: string, document: { url?: string; path?: string }, second = 0): HistoryEvent {
	return { ...base(name, second), kind: "window.changed", window: { title: "Document", windowID: 7 }, document };
}
function bareClick(name: string, second = 0): HistoryEvent {
	return { ...base(name, second), kind: "mouse.click", mouse: { button: "left" } };
}
function press(name: string, title: string, second = 0): HistoryEvent {
	return {
		...base(name, second),
		kind: "mouse.click",
		mouse: { button: "left" },
		element: { role: "AXButton", title },
	};
}
function typed(name: string, field: string, text: string, second = 0): HistoryEvent {
	return {
		...base(name, second),
		kind: "keyboard.text_input",
		keyboard: { text },
		...(field === "" ? {} : { element: { role: "AXTextField", title: field } }),
	};
}
function shortcut(name: string, keyEquivalent: string, modifiers?: readonly string[], second = 0): HistoryEvent {
	return {
		...base(name, second),
		kind: "keyboard.shortcut",
		keyboard: modifiers === undefined ? { keyEquivalent } : { keyEquivalent, modifiers },
	};
}

const seg = (index: number, events: readonly unknown[]): HistorySegmentEvents => ({
	id: `2026-11-01T1${index}-00-00Z`,
	events,
});

describe("#given navigation-only history shaped like the owner's #when detecting #then nothing is suggested", () => {
	it("drops Brave <-> Herdr switching with bare clicks, one-character typing and tab shortcuts (13 repeats)", () => {
		const round = (): unknown[] => [
			bareClick("Brave Browser"),
			nav("Herdr", "Herdr"),
			bareClick("Herdr"),
			...["l", "s", "\r"].map((text) => ({ ...base("Herdr", 0), kind: "keyboard.text_input", keyboard: { text } })),
			bareClick("Herdr"),
			nav("Brave Browser", "YouTube - Audio playing - Brave"),
			shortcut("Brave Browser", "\t"),
			bareClick("Brave Browser"),
			shortcut("Brave Browser", "w"),
		];
		const repeats = (count: number) => Array.from({ length: count }, round).flat();
		const result = detectHistorySkillCandidates([seg(0, repeats(5)), seg(1, repeats(4)), seg(2, repeats(4))]);
		expect(result.candidates).toEqual([]);
		expect(result.skippedEvents).toBe(0);
	});
});

describe("#given a form filled the same way with different text in two sessions #when detecting #then one parameterized candidate is suggested", () => {
	it("keys steps by field label, never by typed text, and reports which fields vary", () => {
		const compose = (n: number): HistoryEvent[] => [
			nav("Mail", "Inbox"),
			press("Mail", "New Message"),
			nav("Mail", "New Message"),
			typed("Mail", "To", `private-to-${n}@example.com`),
			bareClick("Mail"),
			typed("Mail", "Cc", "private-team@example.com"),
			typed("Mail", "Subject", `private-subject ${n}`),
			shortcut("Mail", "d", ["command", "shift"]),
		];
		const noise = [
			nav("Brave Browser", "News"),
			bareClick("Brave Browser"),
			nav("Herdr", "Herdr"),
			bareClick("Herdr"),
		];
		const result = detectHistorySkillCandidates([
			seg(0, [...compose(1), ...noise, ...compose(2)]),
			seg(1, [...noise, ...compose(3)]),
		]);
		expect(result.candidates).toHaveLength(1);
		const [candidate] = result.candidates;
		expect(candidate?.steps.map((step) => `${step.action}:${step.detail}`)).toEqual([
			"press:new message",
			"type:to",
			"type:cc",
			"type:subject",
			"shortcut:shift+cmd+d",
		]);
		expect(candidate?.occurrences).toBe(3);
		expect(candidate?.segmentIds).toHaveLength(2);
		expect(candidate?.parameters).toEqual([
			{ step: 2, app: "Mail", field: "to", samples: 3, distinctValues: 3, varies: true },
			{ step: 3, app: "Mail", field: "cc", samples: 3, distinctValues: 1, varies: false },
			{ step: 4, app: "Mail", field: "subject", samples: 3, distinctValues: 3, varies: true },
		]);
		expect(candidate?.parameters.filter((parameter) => parameter.varies)).toHaveLength(2);
		expect(JSON.stringify(result)).not.toContain("private");
	});
});

describe("#given legacy events from the old recorder #when parsing a segment #then they still parse", () => {
	it("coalesces one-character typing into one step and reads the old mouse target", () => {
		const legacyApp = { name: "Herdr", bundleIdentifier: "com.example.herdr", processIdentifier: 7 };
		const events: unknown[] = [
			{ id: 1, timestamp: at(1), kind: "window.changed", app: legacyApp, window: { title: "Herdr", windowID: 0 } },
			...["l", "s", "\r"].map((text, index) => ({
				id: 2 + index,
				timestamp: at(2 + index),
				kind: "keyboard.text_input",
				app: legacyApp,
				keyboard: { text },
			})),
			{ id: 5, timestamp: at(5), kind: "mouse.click", app: legacyApp, mouse: { button: "left" } },
			{
				id: 6,
				timestamp: at(6),
				kind: "mouse.click",
				app: legacyApp,
				mouse: { button: "left", target: { role: "AXButton", title: "Run" } },
			},
			{ id: 7, timestamp: at(7), kind: "keyboard.shortcut", app: legacyApp, keyboard: { keyEquivalent: "s" } },
			{ id: 8, timestamp: at(8), kind: "selection.changed", app: legacyApp, selection: { target: { role: "x" } } },
		];
		const parsed = historyStepsForSegment(events);
		expect(parsed.skipped).toBe(0);
		expect(parsed.steps).toEqual([
			{ app: "Herdr", action: "type", detail: "" },
			{ app: "Herdr", action: "press", role: "button", detail: "run" },
			{ app: "Herdr", action: "shortcut", detail: "s" },
		]);
		expect(parsed.timestamps).toEqual([at(4), at(6), at(7)]);
		expect(JSON.stringify(parsed)).not.toContain("ls");
	});
});

describe("#given a periodic alternation between two apps with labeled clicks #when detecting #then it is rejected", () => {
	it("does not suggest pressing Reload and Run tests back and forth", () => {
		const alternate = () =>
			Array.from({ length: 6 }, () => [
				press("Brave Browser", "Reload"),
				nav("Herdr", "Herdr"),
				press("Herdr", "Run tests"),
				nav("Brave Browser", "Preview"),
			]).flat();
		expect(detectHistorySkillCandidates([seg(0, alternate()), seg(1, alternate())]).candidates).toEqual([]);
	});
});

describe("#given a repeated flow with no substantive step #when detecting #then it is not suggested", () => {
	it("rejects unlabeled typing with plain copy and paste even across sessions", () => {
		const flow = (n: number) => [
			typed("Herdr", "", `private ${n}`),
			shortcut("Herdr", "c", ["command"]),
			typed("Notes", "", `private ${n}`),
			shortcut("Notes", "v", ["command"]),
		];
		const segments = [seg(0, [...flow(1), ...flow(2)]), seg(1, [...flow(3), ...flow(4)])];
		expect(detectHistorySkillCandidates(segments).candidates).toEqual([]);
	});
});

describe("#given a substantive flow seen in only one session #when detecting #then it is not suggested", () => {
	it("requires occurrences in at least two segments", () => {
		const flow = (n: number) => [
			typed("Notes", "Title", `private ${n}`),
			press("Notes", "Share"),
			shortcut("Notes", "s"),
		];
		const once = detectHistorySkillCandidates([seg(0, [...flow(1), ...flow(2), ...flow(3)])]);
		expect(once.candidates).toEqual([]);
		const twice = detectHistorySkillCandidates([seg(0, [...flow(1), ...flow(2)]), seg(1, flow(3))]);
		expect(twice.candidates[0]?.occurrences).toBe(3);
	});
});

describe("#given documents opened between copy and paste #when detecting #then the step names the document pattern only", () => {
	it("keys URLs by host and files by extension", () => {
		const flow = (n: number) => [
			opened("Safari", { url: `https://www.billing.example.com/invoices/${1040 + n}?private=${n}` }),
			shortcut("Safari", "c", ["command"]),
			opened("Numbers", { path: `/Users/me/private-${n}/Ledger ${n}.numbers` }),
			shortcut("Numbers", "v", ["command"]),
			nav("Numbers", "Ledger"),
		];
		const result = detectHistorySkillCandidates([seg(0, [...flow(1), ...flow(2)]), seg(1, flow(3))]);
		expect(result.candidates).toHaveLength(1);
		expect(result.candidates[0]?.steps.map((step) => `${step.app}:${step.action}:${step.detail}`)).toEqual([
			"Safari:open:billing.example.com",
			"Safari:shortcut:cmd+c",
			"Numbers:open:*.numbers",
			"Numbers:shortcut:cmd+v",
		]);
		expect(JSON.stringify(result)).not.toMatch(/private|104#|1041|ledger #/);
	});
});

describe("#given moving between documents and pages with nothing done in them #when detecting #then it is not suggested", () => {
	it("rejects a repeated Mail, Safari page and Notes document cycle", () => {
		const flow = (n: number) => [
			opened("Mail", { path: `/Users/me/Mail/${n}.eml` }),
			opened("Safari", { url: `https://news.example.com/story/${n}` }),
			opened("Notes", { path: `/Users/me/Notes/${n}.txt` }),
		];
		expect(detectHistorySkillCandidates([seg(0, [...flow(1), ...flow(2)]), seg(1, flow(3))]).candidates).toEqual([]);
	});
});

describe("#given a pressed row whose label is its content #when detecting #then the row is named by role only", () => {
	it("keeps an autocomplete row's text out of the step", () => {
		const row = (n: number) => ({
			kind: "mouse.click",
			timestamp: "2026-11-01T10:00:00Z",
			app: { name: "Mail" },
			mouse: { button: "left" },
			element: { role: "AXRow", title: `secret-${n}@example.com` },
		});
		const flow = (n: number) => [press("Mail", "New Message"), row(n), shortcut("Mail", "d", ["command", "shift"])];
		const result = detectHistorySkillCandidates([seg(0, [...flow(1), ...flow(2)]), seg(1, flow(3))]);
		expect(JSON.stringify(result)).not.toContain("secret-");
	});
});

describe("#given a repeat split across a segment boundary #when detecting #then it is not joined", () => {
	it("keeps segments separate", () => {
		const flow = [press("Safari", "x"), press("Notes", "y"), press("Mail", "z")];
		const segments = [seg(0, [...flow, ...flow.slice(0, 2)]), seg(1, flow.slice(2)), seg(2, flow.slice(0, 1))];
		expect(detectHistorySkillCandidates(segments).candidates).toEqual([]);
	});
});

describe("#given malformed events #when detecting #then they are skipped and counted, never thrown", () => {
	it("counts each invalid family", () => {
		const invalid: unknown[] = [
			null,
			"text",
			[],
			{},
			{ kind: "window.changed" },
			{ kind: "window.changed", timestamp: "t", app: { name: "" } },
			{ kind: "window.changed", timestamp: "t", app: "Safari" },
			{ kind: "unknown.kind", timestamp: "t", app: { name: "Safari" } },
		];
		const result = detectHistorySkillCandidates([{ id: "s", events: invalid }]);
		expect(result).toEqual({ candidates: [], scannedSegments: 1, scannedEvents: invalid.length, skippedEvents: 8 });
	});
});

describe("#given empty and boundary inputs #when detecting #then results are empty but well-formed", () => {
	it("handles no segments, empty segments and the event budget", () => {
		expect(detectHistorySkillCandidates([]).candidates).toEqual([]);
		expect(detectHistorySkillCandidates([{ id: "s", events: [] }]).scannedSegments).toBe(1);
		const flow = [press("Safari", "x"), press("Notes", "y"), press("Mail", "z")];
		const segments = [seg(0, flow), seg(1, flow)];
		expect(detectHistorySkillCandidates(segments, { maxEvents: 4 }).candidates).toEqual([]);
		expect(detectHistorySkillCandidates(segments, { maxEvents: 6 }).candidates).toHaveLength(1);
	});
});

describe("#given a workflow repeated back to back #when detecting #then only the single workflow is suggested, not its doubling", () => {
	it("drops periodic candidates such as the workflow repeated twice", () => {
		const flow = [
			typed("Notes", "Title", "private"),
			shortcut("Notes", "c"),
			press("Mail", "Draft"),
			shortcut("Mail", "v"),
		];
		const twice = [...flow, ...flow];
		const result = detectHistorySkillCandidates([seg(0, twice), seg(1, twice)], { maxSteps: 12 });
		expect(result.candidates.map((candidate) => candidate.steps.length)).toEqual([4]);
		expect(result.candidates[0]?.occurrences).toBe(4);
		expect(isPeriodic(["a", "b", "c", "a", "b"], 2)).toBe(true);
		expect(isPeriodic(["a", "b", "c", "a"], 2)).toBe(false);
		expect(nonOverlappingStarts([0, 2, 4], 3)).toEqual([0, 4]);
	});
});

// Brute-force model of the detector, used by the calibration and property tests below.

type AbstractStep =
	| { readonly kind: "nav" | "bare"; readonly app: string }
	| { readonly kind: "press"; readonly app: string; readonly label: string }
	| { readonly kind: "type"; readonly app: string; readonly field: string; readonly text: string }
	| { readonly kind: "shortcut"; readonly app: string; readonly key: string }
	| { readonly kind: "open"; readonly app: string; readonly url: string };

const APPS = ["Safari", "Notes", "Mail"] as const;
const LABELS = ["a", "b"] as const;
const FIELDS = ["To", ""] as const;
const KEYS = ["s", "c", "\t"] as const;
const URLS = ["https://a.example/x/1", "https://a.example/x/2", "https://b.example/y"] as const;
const PATTERNS: Record<string, string> = {
	"https://a.example/x/1": "a.example",
	"https://a.example/x/2": "a.example",
	"https://b.example/y": "b.example",
};

function toEvent(step: AbstractStep, second: number): HistoryEvent {
	switch (step.kind) {
		case "nav":
			return nav(step.app, "window", second);
		case "bare":
			return bareClick(step.app, second);
		case "press":
			return press(step.app, step.label, second);
		case "type":
			return typed(step.app, step.field, step.text, second);
		case "shortcut":
			return shortcut(step.app, step.key, undefined, second);
		case "open":
			return opened(step.app, { url: step.url }, second);
	}
}

const keyOf = (step: HistoryStep): string => `${step.app}|${step.action}|${step.role ?? ""}|${step.detail}`;

function modelSteps(steps: readonly AbstractStep[]): HistoryStep[] {
	const out: HistoryStep[] = [];
	const documents = new Map<string, string>();
	for (const step of steps) {
		let next: HistoryStep | undefined;
		if (step.kind === "press") next = { app: step.app, action: "press", role: "button", detail: step.label };
		else if (step.kind === "type")
			next =
				step.field === ""
					? { app: step.app, action: "type", detail: "" }
					: { app: step.app, action: "type", role: "text field", detail: step.field.toLowerCase() };
		else if (step.kind === "shortcut" && step.key !== "\t")
			next = { app: step.app, action: "shortcut", detail: step.key };
		else if (step.kind === "open" && documents.get(step.app) !== step.url) {
			documents.set(step.app, step.url);
			next = { app: step.app, action: "open", detail: PATTERNS[step.url] ?? "" };
		}
		if (next === undefined) continue;
		const last = out.at(-1);
		if (last === undefined || keyOf(last) !== keyOf(next)) out.push(next);
	}
	return out;
}

function naiveCount(sequence: readonly string[], pattern: readonly string[]): number {
	let count = 0;
	let index = 0;
	while (index + pattern.length <= sequence.length) {
		if (pattern.every((key, offset) => sequence[index + offset] === key)) {
			count += 1;
			index += pattern.length;
		} else {
			index += 1;
		}
	}
	return count;
}

const contains = (outer: readonly string[], inner: readonly string[]): boolean => naiveCount(outer, inner) > 0;
const substantive = (steps: readonly HistoryStep[]): boolean =>
	steps.some(
		(step) =>
			step.action === "press" ||
			(step.action === "type" && step.detail !== "") ||
			(step.action === "shortcut" && step.detail === "s"),
	) ||
	(steps.some((step) => step.action === "shortcut" && step.detail === "c") &&
		steps.some((step) => step.action === "open"));
const smallestPeriod = (keys: readonly string[]): number => {
	for (let period = 1; period < keys.length; period += 1) {
		if (keys.slice(period).every((key, index) => key === keys[index])) return period;
	}
	return keys.length;
};
const periodicReject = (keys: readonly string[], minSteps: number): boolean => {
	const period = smallestPeriod(keys);
	return period < minSteps || keys.length - period >= minSteps;
};
const cyclicRun = (inner: readonly string[], cycle: readonly string[]): boolean =>
	contains(Array.from({ length: Math.ceil(inner.length / cycle.length) + 1 }, () => cycle).flat(), inner);

function violations(
	segments: readonly { readonly id: string; readonly steps: readonly HistoryStep[] }[],
	detection: HistorySkillDetection,
	bounds: { readonly minSteps: number; readonly maxSteps: number },
): string[] {
	const problems: string[] = [];
	const sequences = segments.map((segment) => ({ id: segment.id, keys: segment.steps.map(keyOf) }));
	const total = (pattern: readonly string[]) =>
		sequences.reduce((sum, sequence) => sum + naiveCount(sequence.keys, pattern), 0);
	const holders = (pattern: readonly string[]) =>
		sequences.filter((sequence) => naiveCount(sequence.keys, pattern) > 0).map((sequence) => sequence.id);
	for (const candidate of detection.candidates) {
		const pattern = candidate.steps.map(keyOf);
		if (pattern.length < bounds.minSteps || pattern.length > bounds.maxSteps)
			problems.push(`length ${pattern.length}`);
		const expected = total(pattern);
		if (expected !== candidate.occurrences) problems.push(`occurrences ${candidate.occurrences} != ${expected}`);
		if (!substantive(candidate.steps)) problems.push("no substantive step");
		if (periodicReject(pattern, bounds.minSteps)) problems.push("periodic");
		if (candidate.segmentIds.length < 2) problems.push("fewer than two segments");
		if (candidate.segmentIds.some((id) => !holders(pattern).includes(id)))
			problems.push("segment without occurrence");
		const typedSteps = candidate.steps.filter((step) => step.action === "type").length;
		if (candidate.parameters.length !== typedSteps) problems.push("parameters do not match typed steps");
		if (candidate.parameters.some((parameter) => parameter.samples !== candidate.occurrences))
			problems.push("parameter samples");
		if (JSON.stringify(candidate).includes("private-literal")) problems.push("typed text leaked");
	}
	for (const [position, sequence] of sequences.entries()) {
		for (let length = bounds.minSteps; length <= bounds.maxSteps; length += 1) {
			for (let start = 0; start + length <= sequence.keys.length; start += 1) {
				const pattern = sequence.keys.slice(start, start + length);
				const steps = segments[position]?.steps.slice(start, start + length) ?? [];
				const count = total(pattern);
				if (count < 2 || holders(pattern).length < 2 || !substantive(steps)) continue;
				if (periodicReject(pattern, bounds.minSteps)) continue;
				const covered = detection.candidates.some(
					(candidate) =>
						(candidate.occurrences >= count && contains(candidate.steps.map(keyOf), pattern)) ||
						(candidate.occurrences + 1 >= count && cyclicRun(pattern, candidate.steps.map(keyOf))),
				);
				if (!covered) problems.push(`missed repeated workflow ${pattern.join(" > ")} x${count}`);
			}
		}
	}
	return problems;
}

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

function pick<T>(random: () => number, values: readonly T[]): T {
	const value = values[Math.floor(random() * values.length)];
	if (value === undefined) throw new Error("empty choice");
	return value;
}

function randomStep(random: () => number): AbstractStep {
	const app = pick(random, APPS);
	switch (pick(random, ["nav", "bare", "press", "type", "shortcut", "open"] as const)) {
		case "nav":
			return { kind: "nav", app };
		case "bare":
			return { kind: "bare", app };
		case "press":
			return { kind: "press", app, label: pick(random, LABELS) };
		case "type":
			return { kind: "type", app, field: pick(random, FIELDS), text: `private-literal-${pick(random, LABELS)}` };
		case "shortcut":
			return { kind: "shortcut", app, key: pick(random, KEYS) };
		case "open":
			return { kind: "open", app, url: pick(random, URLS) };
	}
}

function generate(random: () => number): { abstract: AbstractStep[][]; segments: HistorySegmentEvents[] } {
	const planted = Array.from({ length: 3 + Math.floor(random() * 3) }, () => randomStep(random));
	const abstract: AbstractStep[][] = [];
	for (let index = 0, count = Math.floor(random() * 5); index < count; index += 1) {
		const steps: AbstractStep[] = [];
		for (let position = 0, length = Math.floor(random() * 18); position < length; position += 1) {
			if (random() < 0.2) steps.push(...planted);
			else steps.push(randomStep(random));
		}
		abstract.push(steps);
	}
	const segments = abstract.map((steps, index) => seg(index, steps.map(toEvent)));
	return { abstract, segments };
}

describe("#given the oracle #when fed a corrupted detection #then it reports the violation (calibration)", () => {
	it("rejects inflated counts, typed-text leaks, invented segments and missed workflows", () => {
		const flow: AbstractStep[] = [
			{ kind: "press", app: "Safari", label: "a" },
			{ kind: "type", app: "Notes", field: "To", text: "private-literal-a" },
			{ kind: "press", app: "Mail", label: "b" },
		];
		const segments = [seg(0, flow.map(toEvent)), seg(1, flow.map(toEvent))];
		const model = segments.map((segment) => ({ id: segment.id, steps: modelSteps(flow) }));
		const bounds = { minSteps: 3, maxSteps: 12 };
		const good = detectHistorySkillCandidates(segments);
		expect(violations(model, good, bounds)).toEqual([]);
		const first = good.candidates[0];
		if (first === undefined) throw new Error("expected a candidate");
		const inflated = { ...good, candidates: [{ ...first, occurrences: first.occurrences + 1 }] };
		const leaked = { ...good, candidates: [{ ...first, description: "private-literal" }] };
		const invented = { ...good, candidates: [{ ...first, segmentIds: [...first.segmentIds, "other"] }] };
		const missing = { ...good, candidates: [] };
		expect(violations(model, inflated, bounds).join()).toContain("occurrences");
		expect(violations(model, leaked, bounds).join()).toContain("typed text leaked");
		expect(violations(model, invented, bounds).join()).toContain("segment without occurrence");
		expect(violations(model, missing, bounds).join()).toContain("missed repeated workflow");
	});
});

describe("#given seeded generated histories #when detecting #then every result matches the brute-force model", () => {
	it("passes the bounded property campaign (seed 20261101, 400 cases)", () => {
		const random = mulberry32(20261101);
		const bounds = { minSteps: 3, maxSteps: 6 };
		const counts = { executed: 0, withCandidates: 0, empty: 0 };
		const failures: string[] = [];
		for (let index = 0; index < 400; index += 1) {
			const { abstract, segments } = generate(random);
			const model = abstract.map((steps, position) => ({
				id: segments[position]?.id ?? "",
				steps: modelSteps(steps),
			}));
			const detection = detectHistorySkillCandidates(segments, { ...bounds, limit: 10_000 });
			const reversed = detectHistorySkillCandidates([...segments].reverse(), { ...bounds, limit: 10_000 });
			const problems = violations(model, detection, bounds);
			if (JSON.stringify(reversed) !== JSON.stringify(detection)) problems.push("order dependent");
			counts.executed += 1;
			if (detection.candidates.length > 0) counts.withCandidates += 1;
			else counts.empty += 1;
			if (problems.length > 0) failures.push(`case ${index}: ${problems.slice(0, 3).join("; ")}`);
		}
		expect(failures.slice(0, 5)).toEqual([]);
		expect(counts.executed).toBe(400);
		expect(counts.withCandidates).toBeGreaterThan(50);
		expect(counts.empty).toBeGreaterThan(20);
	}, 30_000);
});
