import { createHash, createHmac, randomBytes } from "node:crypto";

/**
 * Local, model-free detection of repeated workflows in recorded history.
 *
 * Input is untrusted recorded data. A step names what was acted on: the pressed element's role and label, the label of
 * the field typed into, a shortcut, or the pattern of an opened document, always within one app. Typed text is a
 * parameter: its value never enters a step or a candidate, only how many distinct values a field took. Window changes,
 * app switches and clicks on nothing labeled are navigation and are dropped before mining; adjacent duplicate steps are
 * merged. A candidate is a contiguous step sequence that occurs at least `minOccurrences` times without overlapping, in
 * at least two segments, never across a segment boundary, with at least one substantive step.
 */

export type HistoryStepAction = "open" | "press" | "type" | "shortcut";

export interface HistoryStep {
	readonly app: string;
	readonly action: HistoryStepAction;
	/** open: document pattern; press: element label; type: field label, empty when unlabeled; shortcut: key combo. */
	readonly detail: string;
	/** Accessibility role of the pressed element or typed-into field, without the AX prefix. */
	readonly role?: string;
}

/** A field typed into in every occurrence. Only counts are kept, never the typed values. */
export interface HistorySkillParameter {
	/** 1-based position of the typing step in the candidate's steps. */
	readonly step: number;
	readonly app: string;
	readonly field: string;
	readonly samples: number;
	readonly distinctValues: number;
	/** The value changed between occurrences, so a skill should ask for it instead of fixing it. */
	readonly varies: boolean;
}

export interface HistorySegmentEvents {
	readonly id: string;
	readonly events: readonly unknown[];
}

export interface HistorySkillCandidate {
	readonly id: string;
	readonly proposedName: string;
	readonly description: string;
	readonly occurrences: number;
	readonly apps: readonly string[];
	readonly steps: readonly HistoryStep[];
	readonly parameters: readonly HistorySkillParameter[];
	readonly segmentIds: readonly string[];
	readonly lastSeenAt: string;
}

export interface HistorySkillDetection {
	readonly candidates: readonly HistorySkillCandidate[];
	readonly scannedSegments: number;
	readonly scannedEvents: number;
	readonly skippedEvents: number;
}

export interface HistorySkillDetectionOptions {
	readonly minSteps?: number;
	readonly maxSteps?: number;
	readonly minOccurrences?: number;
	readonly limit?: number;
	readonly maxEvents?: number;
}

const MAX_DETAIL = 60;
const MIN_SEGMENTS = 2;
const ACTION_KINDS = new Set([
	"window.changed",
	"keyboard.text_input",
	"keyboard.shortcut",
	"mouse.click",
	"mouse.drag",
]);
const KEY_NAMES: Readonly<Record<string, string>> = {
	"\t": "tab",
	"\r": "return",
	"\n": "return",
	"\u0003": "enter",
	"\b": "delete",
	"\u007f": "delete",
	"\u001b": "escape",
	"\u001c": "left",
	"\u001d": "right",
	"\u001e": "up",
	"\u001f": "down",
	" ": "space",
};
/** Shortcut keys that move between apps, windows, tabs or spaces (Command-Tab, Command-W, Control-arrow, ...). */
/** Roles whose label is their content rather than a control name. */
const CONTENT_ROLES: ReadonlySet<string> = new Set(["AXRow", "AXCell", "AXStaticText", "AXOutlineRow"]);

const NAVIGATION_KEYS = new Set(["tab", "left", "right", "up", "down", "space", "`", "w", "t", "q", "h", "m"]);
const MODIFIERS: Readonly<Record<string, string>> = {
	control: "ctrl",
	ctrl: "ctrl",
	option: "opt",
	alt: "opt",
	opt: "opt",
	shift: "shift",
	command: "cmd",
	cmd: "cmd",
};
const MODIFIER_ORDER = ["ctrl", "opt", "shift", "cmd"];
/** Per-process key, so typed-value digests can be compared within one detection but never reversed or linked. */
const DIGEST_KEY = randomBytes(32);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordAt(value: unknown, key: string): Record<string, unknown> | undefined {
	const field = isRecord(value) ? value[key] : undefined;
	return isRecord(field) ? field : undefined;
}

function stringAt(value: Record<string, unknown> | undefined, key: string): string {
	const field = value?.[key];
	return typeof field === "string" ? field : "";
}

function normalizeDetail(value: string): string {
	const collapsed = value.replace(/\s+/g, " ").trim().toLowerCase().replace(/\d+/g, "#");
	return [...collapsed].slice(0, MAX_DETAIL).join("");
}

function roleName(role: string): string {
	return role
		.replace(/^AX/, "")
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.trim()
		.toLowerCase();
}

/** The acted-on element: the new top-level `element`, or the `target` older recorders nested in mouse or keyboard. */
function elementOf(event: Record<string, unknown>): { readonly role: string; readonly label: string } | undefined {
	const element =
		recordAt(event, "element") ??
		recordAt(recordAt(event, "mouse"), "target") ??
		recordAt(recordAt(event, "keyboard"), "target");
	if (element === undefined) return undefined;
	// A row, cell or text item is labelled by its content (an autocomplete row often echoes what was typed), so it
	// is named by its role alone.
	if (CONTENT_ROLES.has(stringAt(element, "role"))) return { role: roleName(stringAt(element, "role")), label: "" };
	const label = ["title", "description", "placeholder", "identifier"]
		.map((key) => normalizeDetail(stringAt(element, key)))
		.find((text) => text.length > 0);
	return { role: roleName(stringAt(element, "role")), label: label ?? "" };
}

function fileDocument(path: string): { readonly identity: string; readonly pattern: string } {
	const name = path.split("/").at(-1) ?? "";
	const dot = name.lastIndexOf(".");
	const extension =
		dot > 0
			? name
					.slice(dot + 1)
					.toLowerCase()
					.slice(0, 12)
			: "";
	return { identity: `file:${path}`, pattern: extension.length > 0 ? `*.${extension}` : "a file" };
}

/** A document's exact identity (to notice a change) and its pattern: URL host + first path segment, or file extension. */
function documentOf(
	event: Record<string, unknown>,
): { readonly identity: string; readonly pattern: string } | undefined {
	const document = recordAt(event, "document");
	const url = stringAt(document, "url") || stringAt(recordAt(event, "window"), "url");
	if (url.length > 0) {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			return undefined;
		}
		if (parsed.protocol === "file:") return fileDocument(decodeURIComponent(parsed.pathname));
		const host = parsed.hostname.replace(/^www\./, "");
		if (host.length === 0) return undefined;
		// The host only: a path segment can be something the person typed (a search term, a user name).
		return { identity: url, pattern: normalizeDetail(host) };
	}
	const path = stringAt(document, "path");
	return path.length > 0 ? fileDocument(path) : undefined;
}

/** The shortcut as "ctrl+opt+shift+cmd+key"; older events have no modifiers and show the key alone. */
function shortcutCombo(keyboard: Record<string, unknown> | undefined): string | undefined {
	const raw = stringAt(keyboard, "keyEquivalent");
	const key = KEY_NAMES[raw] ?? [...raw.trim().toLowerCase()].slice(0, 12).join("");
	if (key.length === 0 || NAVIGATION_KEYS.has(key) || /^\d$/.test(key)) return undefined;
	const listed = keyboard?.["modifiers"];
	const names = new Set(
		(Array.isArray(listed) ? listed : []).map((name) =>
			typeof name === "string" ? MODIFIERS[name.toLowerCase()] : "",
		),
	);
	return [...MODIFIER_ORDER.filter((name) => names.has(name)), key].join("+");
}

/** What a shortcut does when it is one of the few that finish a piece of work. */
function shortcutMeaning(combo: string): string | undefined {
	const parts = combo.split("+");
	const key = parts.at(-1);
	const shift = parts.includes("shift");
	if (key === "s") return shift ? "save as" : "save";
	if (key === "return" || key === "enter" || (key === "d" && shift)) return "send";
	if (key === "p") return "print";
	return undefined;
}

interface ParsedStep {
	readonly step: HistoryStep;
	readonly timestamp: string;
	readonly text?: string;
}

function withRole(step: HistoryStep, role: string | undefined): HistoryStep {
	return role === undefined || role.length === 0 ? step : { ...step, role };
}

function actionStep(
	kind: string,
	event: Record<string, unknown>,
	app: string,
): Omit<ParsedStep, "timestamp"> | undefined {
	const element = elementOf(event);
	if (kind === "keyboard.text_input") {
		const text = stringAt(recordAt(event, "keyboard"), "text");
		const label = element?.label ?? "";
		return { step: withRole({ app, action: "type", detail: label }, element?.role), text };
	}
	if (kind === "keyboard.shortcut") {
		const combo = shortcutCombo(recordAt(event, "keyboard"));
		return combo === undefined ? undefined : { step: { app, action: "shortcut", detail: combo } };
	}
	if (kind === "mouse.click" && element !== undefined && element.label.length > 0) {
		return { step: withRole({ app, action: "press", detail: element.label }, element.role) };
	}
	return undefined;
}

/**
 * The steps one event contributes: an "open" step when it shows a document other than the one last seen in its app,
 * then its own step unless it is navigation. `documents` holds the last document identity per app within a segment.
 */
function eventSteps(event: unknown, documents: Map<string, string>): readonly ParsedStep[] | "invalid" {
	if (!isRecord(event) || typeof event["kind"] !== "string" || typeof event["timestamp"] !== "string") {
		return "invalid";
	}
	const kind = event["kind"];
	if (kind === "session.started" || kind === "selection.changed") return [];
	const app = stringAt(recordAt(event, "app") ?? {}, "name").trim();
	if (app.length === 0 || !ACTION_KINDS.has(kind)) return "invalid";
	const timestamp = event["timestamp"];
	const steps: ParsedStep[] = [];
	const document = documentOf(event);
	if (document !== undefined && documents.get(app) !== document.identity) {
		documents.set(app, document.identity);
		steps.push({ timestamp, step: { app, action: "open", detail: document.pattern } });
	}
	const own = actionStep(kind, event, app);
	if (own !== undefined) steps.push({ ...own, timestamp });
	return steps;
}

function stepKey(step: HistoryStep): string {
	return `${step.app}\u0000${step.action}\u0000${step.role ?? ""}\u0000${step.detail}`;
}

/**
 * Steps of one segment with navigation dropped and adjacent duplicates merged; a merged typing step joins its text, so
 * one-character events from older recorders become one run. `valueDigests` holds a keyed digest of each typing step's
 * text (undefined for other steps), comparable only within this process.
 */
export function historyStepsForSegment(events: readonly unknown[]): {
	readonly steps: readonly HistoryStep[];
	readonly timestamps: readonly string[];
	readonly valueDigests: readonly (string | undefined)[];
	readonly skipped: number;
} {
	const steps: HistoryStep[] = [];
	const timestamps: string[] = [];
	const texts: (string | undefined)[] = [];
	const documents = new Map<string, string>();
	let skipped = 0;
	for (const event of events) {
		const parsed = eventSteps(event, documents);
		if (parsed === "invalid") {
			skipped += 1;
			continue;
		}
		for (const { step, timestamp, text } of parsed) {
			const last = steps.length - 1;
			const previous = steps[last];
			if (previous !== undefined && stepKey(previous) === stepKey(step)) {
				timestamps[last] = timestamp;
				if (text !== undefined) texts[last] = (texts[last] ?? "") + text;
				continue;
			}
			steps.push(step);
			timestamps.push(timestamp);
			texts.push(text);
		}
	}
	const valueDigests = texts.map((text) =>
		text === undefined ? undefined : createHmac("sha256", DIGEST_KEY).update(text).digest("hex"),
	);
	return { steps, timestamps, valueDigests, skipped };
}

/** Greedy left-to-right count of non-overlapping starts; starts must be sorted ascending. */
export function nonOverlappingStarts(starts: readonly number[], length: number): number[] {
	const chosen: number[] = [];
	let nextFree = Number.NEGATIVE_INFINITY;
	for (const start of starts) {
		if (start >= nextFree) {
			chosen.push(start);
			nextFree = start + length;
		}
	}
	return chosen;
}

function slug(value: string): string {
	return value
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function proposeName(steps: readonly HistoryStep[]): string {
	const apps = [...new Set(steps.map((step) => slug(step.app)).filter((part) => part.length > 0))].slice(0, 3);
	const base = apps.length === 0 ? "workflow" : `${apps.join("-")}-workflow`;
	const trimmed = base.slice(0, 64).replace(/-+$/g, "");
	return trimmed.length === 0 ? "workflow" : trimmed;
}

export function describeHistoryStep(step: HistoryStep): string {
	switch (step.action) {
		case "open":
			return `open ${step.detail} in ${step.app}`;
		case "press":
			return `press ${step.role === undefined ? "" : `the ${step.role} `}"${step.detail}" in ${step.app}`;
		case "type":
			return step.detail.length > 0
				? `type into the "${step.detail}" field in ${step.app}`
				: `type text in ${step.app}`;
		case "shortcut": {
			const keys = /^(ctrl|opt|shift|cmd)\+/.test(step.detail) ? step.detail : `cmd/ctrl+${step.detail}`;
			const meaning = shortcutMeaning(step.detail);
			return `press the shortcut "${keys}"${meaning === undefined ? "" : ` (${meaning})`} in ${step.app}`;
		}
	}
}

/** A step that does work: typing into a labeled field, pressing a labeled element, a save/send/print, a document. */
/** Whether a flow does work: a substantive step, or content carried between documents (open plus copy or paste). */
function doesWork(steps: readonly HistoryStep[]): boolean {
	if (steps.some(isSubstantive)) return true;
	const carries = steps.some((step) => step.action === "shortcut" && /(^|\+)(c|x|v)$/.test(step.detail));
	return carries && steps.some((step) => step.action === "open");
}

function isSubstantive(step: HistoryStep): boolean {
	switch (step.action) {
		// Moving between documents and pages is navigation; work is done on them.
		case "open":
			return false;
		case "press":
			return true;
		case "type":
			return step.detail.length > 0;
		case "shortcut":
			return shortcutMeaning(step.detail) !== undefined;
	}
}

/** The shortest shift under which the sequence matches itself, or its length when there is none. */
function smallestPeriod(keys: readonly string[]): number {
	for (let period = 1; period < keys.length; period += 1) {
		let matches = true;
		for (let index = period; index < keys.length && matches; index += 1)
			matches = keys[index] === keys[index - period];
		if (matches) return period;
	}
	return keys.length;
}

/**
 * True when the sequence overlaps a shifted copy of itself by at least `minOverlap` steps, e.g. A>B>C>A>B for
 * minOverlap 2: it is a shorter workflow repeated, which that shorter candidate already represents.
 */
export function isPeriodic(keys: readonly string[], minOverlap = 1): boolean {
	return keys.length - smallestPeriod(keys) >= minOverlap;
}

/** True when `inner` is a contiguous run of `cycle` repeated end to end (covers rotations and wrapped windows). */
function isCyclicRun(inner: readonly string[], cycle: readonly string[]): boolean {
	const repeats = Math.ceil(inner.length / cycle.length) + 1;
	return isContiguousSubsequence(inner, Array.from({ length: repeats }, () => cycle).flat());
}

function isContiguousSubsequence(inner: readonly string[], outer: readonly string[]): boolean {
	for (let start = 0; start + inner.length <= outer.length; start += 1) {
		if (inner.every((key, index) => outer[start + index] === key)) return true;
	}
	return false;
}

export function detectHistorySkillCandidates(
	segments: readonly HistorySegmentEvents[],
	options: HistorySkillDetectionOptions = {},
): HistorySkillDetection {
	const minSteps = Math.max(2, options.minSteps ?? 3);
	const maxSteps = Math.max(minSteps, options.maxSteps ?? 12);
	const minOccurrences = Math.max(2, options.minOccurrences ?? 2);
	const limit = Math.max(1, options.limit ?? 10);
	const maxEvents = Math.max(1, options.maxEvents ?? 50_000);

	const ordered = [...segments].sort((left, right) => left.id.localeCompare(right.id));
	const keys: (string | undefined)[] = [];
	const steps: (HistoryStep | undefined)[] = [];
	const digests: (string | undefined)[] = [];
	const owners: string[] = [];
	const times: string[] = [];
	let scannedEvents = 0;
	let skippedEvents = 0;
	for (const segment of ordered) {
		const remaining = maxEvents - scannedEvents;
		if (remaining <= 0) break;
		const events = segment.events.slice(0, remaining);
		scannedEvents += events.length;
		const parsed = historyStepsForSegment(events);
		skippedEvents += parsed.skipped;
		for (const [index, step] of parsed.steps.entries()) {
			keys.push(stepKey(step));
			steps.push(step);
			digests.push(parsed.valueDigests[index]);
			owners.push(segment.id);
			times.push(parsed.timestamps[index] ?? "");
		}
		// A sentinel stops any n-gram from spanning two segments.
		keys.push(undefined);
		steps.push(undefined);
		digests.push(undefined);
		owners.push(segment.id);
		times.push("");
	}

	const interned = new Map<string, number>();
	const ids = keys.map((key) => {
		if (key === undefined) return undefined;
		let id = interned.get(key);
		if (id === undefined) {
			id = interned.size;
			interned.set(key, id);
		}
		return id;
	});
	type Gram = { readonly length: number; readonly starts: number[] };
	const grams = new Map<string, Gram>();
	for (let start = 0; start < ids.length; start += 1) {
		let gramId = "";
		for (let length = 1; length <= maxSteps && start + length <= ids.length; length += 1) {
			const id = ids[start + length - 1];
			if (id === undefined) break;
			gramId = length === 1 ? String(id) : `${gramId},${id}`;
			if (length < minSteps) continue;
			const gram = grams.get(gramId);
			if (gram === undefined) grams.set(gramId, { length, starts: [start] });
			else gram.starts.push(start);
		}
	}

	type Scored = {
		readonly keys: readonly string[];
		readonly starts: readonly number[];
		readonly steps: readonly HistoryStep[];
		readonly tie: string;
	};
	const scored: Scored[] = [];
	for (const gram of grams.values()) {
		if (gram.starts.length < minOccurrences) continue;
		const chosen = nonOverlappingStarts(gram.starts, gram.length);
		if (chosen.length < minOccurrences) continue;
		if (new Set(chosen.map((start) => owners[start])).size < MIN_SEGMENTS) continue;
		const first = chosen[0] ?? 0;
		const gramSteps = steps
			.slice(first, first + gram.length)
			.filter((step): step is HistoryStep => step !== undefined);
		if (!doesWork(gramSteps)) continue;
		const gramKeys = keys.slice(first, first + gram.length).filter((key): key is string => key !== undefined);
		// A shorter repeating unit is either too short to be a workflow (an alternation) or already its own candidate.
		const period = smallestPeriod(gramKeys);
		if (period < minSteps || gramKeys.length - period >= minSteps) continue;
		scored.push({ keys: gramKeys, starts: chosen, steps: gramSteps, tie: gramKeys.join("\u0001") });
	}
	scored.sort(
		(left, right) =>
			right.starts.length * right.keys.length - left.starts.length * left.keys.length ||
			right.keys.length - left.keys.length ||
			(left.tie < right.tie ? -1 : left.tie > right.tie ? 1 : 0),
	);

	const accepted: Scored[] = [];
	for (const candidate of scored) {
		const subsumed = accepted.some(
			(existing) =>
				existing.starts.length >= candidate.starts.length && isContiguousSubsequence(candidate.keys, existing.keys),
		);
		const wrapped = accepted.some(
			(existing) =>
				existing.starts.length + 1 >= candidate.starts.length && isCyclicRun(candidate.keys, existing.keys),
		);
		if (subsumed || wrapped) continue;
		accepted.push(candidate);
		if (accepted.length >= limit) break;
	}

	const candidates = accepted.map((candidate): HistorySkillCandidate => {
		const segmentIds = [...new Set(candidate.starts.map((start) => owners[start] ?? ""))].sort();
		const lastStart = candidate.starts.at(-1) ?? 0;
		const apps = [...new Set(candidate.steps.map((step) => step.app))].sort();
		const parameters = candidate.steps.flatMap((step, index): HistorySkillParameter[] => {
			if (step.action !== "type") return [];
			const distinctValues = new Set(candidate.starts.map((start) => digests[start + index])).size;
			return [
				{
					step: index + 1,
					app: step.app,
					field: step.detail,
					samples: candidate.starts.length,
					distinctValues,
					varies: distinctValues > 1,
				},
			];
		});
		const varying = parameters.filter((parameter) => parameter.varies).map((parameter) => `"${parameter.field}"`);
		return {
			id: createHash("sha256").update(candidate.keys.join("\u0001")).digest("hex").slice(0, 12),
			proposedName: proposeName(candidate.steps),
			description: [
				`Repeated ${candidate.starts.length} times in ${segmentIds.length} sessions: ${candidate.steps.map(describeHistoryStep).join(", then ")}.`,
				...(varying.length === 0 ? [] : [`Typed values that change each time: ${varying.join(", ")}.`]),
			].join(" "),
			occurrences: candidate.starts.length,
			apps,
			steps: candidate.steps,
			parameters,
			segmentIds,
			lastSeenAt: times[lastStart + candidate.keys.length - 1] ?? "",
		};
	});

	return { candidates, scannedSegments: ordered.length, scannedEvents, skippedEvents };
}
