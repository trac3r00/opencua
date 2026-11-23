import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	historyPaths,
	readHistorySettings,
	readHistoryState,
	readRawRetentionMs,
	readSkillDescriptions,
	saveHistorySkillDraft,
	segmentIdForTimestamp,
	skillDescriptionsEnabled,
	suggestHistorySkills,
	writeHistorySettings,
	writeHistoryState,
} from "@opencua/core";
import type {
	HistoryMemoryEntry,
	HistoryMemoryFile,
	HistoryStatus,
	HistoryTimeline,
	HistoryToolSource,
	MemoryFieldValue,
} from "./history-tools.js";

export interface HistorySourceOptions {
	readonly stateDir: string;
	readonly retentionHours?: number;
	readonly now?: () => number;
	readonly skillsDirectory?: string;
}

/** Memories live under `<history root>/memories/YYYY-MM-DD/<HHMM>-<slug>.md`. */
const MEMORY_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MEMORY_FILE = /^\d{4}-[^/\\]+\.md$/;
const MEMORY_PATH = /^(\d{4}-\d{2}-\d{2})\/(\d{4}-[^/\\]+\.md)$/;
export const MAX_MEMORY_BYTES = 64 * 1024;
const TIMELINE_READ_BYTES = 16 * 1024;
const MAX_FRONT_MATTER_LINES = 64;
const MAX_SUMMARY_CHARS = 600;

type FieldValue = string | string[] | Record<string, string>;

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function scalar(raw: string): string {
	const text = raw.trim();
	if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
		const value = parseJson(text);
		return typeof value === "string" ? value : text.slice(1, -1);
	}
	if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
		return text.slice(1, -1).replace(/''/g, "'");
	}
	return text;
}

function flowList(raw: string): string[] {
	const value = parseJson(raw);
	if (Array.isArray(value)) return value.map(String);
	const inner = raw.slice(1, -1).trim();
	return inner.length === 0 ? [] : inner.split(",").map(scalar);
}

/**
 * A small YAML front matter reader for the memory format: `key: value`, flow lists `[a, b]`, block lists of `- item`
 * lines, and one level of nested `key: value` lines. Anything else is ignored. Undefined when there is no front matter.
 */
function parseFrontMatter(text: string): { fields: Map<string, FieldValue>; body: string } | undefined {
	const lines = text.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return undefined;
	const end = lines.findIndex((line, index) => index > 0 && index <= MAX_FRONT_MATTER_LINES && line.trim() === "---");
	if (end < 0) return undefined;
	const fields = new Map<string, FieldValue>();
	let key: string | undefined;
	for (const line of lines.slice(1, end)) {
		if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;
		const item = /^\s*-\s+(.*)$/.exec(line);
		if (item !== null && key !== undefined) {
			const current = fields.get(key);
			fields.set(key, [...(Array.isArray(current) ? current : []), scalar(item[1] ?? "")]);
			continue;
		}
		const nested = /^\s+([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
		if (nested !== null && key !== undefined) {
			const current = fields.get(key);
			const mapping = typeof current === "object" && !Array.isArray(current) ? current : {};
			fields.set(key, { ...mapping, [nested[1] ?? ""]: scalar(nested[2] ?? "") });
			continue;
		}
		const top = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
		if (top === null) continue;
		key = top[1] ?? "";
		const raw = (top[2] ?? "").trim();
		fields.set(key, raw.startsWith("[") && raw.endsWith("]") ? flowList(raw) : scalar(raw));
	}
	return { fields, body: lines.slice(end + 1).join("\n") };
}

function firstParagraph(body: string): string {
	const paragraph: string[] = [];
	for (const line of body.split(/\r?\n/)) {
		const text = line.trim();
		if (text.length === 0 || text.startsWith("#")) {
			if (paragraph.length > 0) break;
			continue;
		}
		paragraph.push(text);
	}
	const joined = paragraph.join(" ");
	return joined.length > MAX_SUMMARY_CHARS ? `${joined.slice(0, MAX_SUMMARY_CHARS - 3)}...` : joined;
}

function textField(value: FieldValue | undefined): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function listField(value: FieldValue | undefined): readonly string[] {
	if (typeof value === "string") return value.length === 0 ? [] : [value];
	return Array.isArray(value) ? value : [];
}

function memoryEntry(path: string, text: string): HistoryMemoryEntry | undefined {
	const parsed = parseFrontMatter(text);
	if (parsed === undefined) return undefined;
	const { fields } = parsed;
	const start = textField(fields.get("start"));
	const end = textField(fields.get("end"));
	const suggested = fields.get("suggestedSkill");
	const suggestedSkill: MemoryFieldValue | undefined =
		suggested === undefined || suggested === "" ? undefined : suggested;
	return {
		path,
		title: textField(fields.get("title")) ?? path,
		...(start === undefined ? {} : { start }),
		...(end === undefined ? {} : { end }),
		apps: listField(fields.get("apps")),
		segments: listField(fields.get("segments")),
		...(suggestedSkill === undefined ? {} : { suggestedSkill }),
		summary: firstParagraph(parsed.body),
	};
}

function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

/** True only for a real directory; a symlink to one is refused. */
async function isRealDirectory(path: string): Promise<boolean> {
	try {
		return (await lstat(path)).isDirectory();
	} catch (error: unknown) {
		if (isMissing(error)) return false;
		throw error;
	}
}

async function namesIn(dir: string, kind: "dir" | "file", pattern: RegExp): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	return entries
		.filter((entry) => (kind === "dir" ? entry.isDirectory() : entry.isFile()) && pattern.test(entry.name))
		.map((entry) => entry.name)
		.sort((left, right) => right.localeCompare(left));
}

/** Reads a regular file without following a symlink, up to `limit` bytes. */
async function readRegularFile(path: string, limit: number): Promise<{ text: string; bytes: number } | undefined> {
	let file: Awaited<ReturnType<typeof open>>;
	try {
		file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch {
		return undefined;
	}
	try {
		const stats = await file.stat();
		if (!stats.isFile()) return undefined;
		const buffer = Buffer.alloc(Math.min(stats.size, limit));
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		const text = buffer.subarray(0, bytesRead).toString("utf8");
		// A cut in the middle of a multi-byte character decodes to a replacement character; drop it.
		return { text: stats.size > limit ? text.replace(/\uFFFD$/, "") : text, bytes: stats.size };
	} finally {
		await file.close();
	}
}

async function readTimeline(
	memoriesPath: string,
	options: { readonly day?: string; readonly limit: number },
): Promise<HistoryTimeline> {
	const entries: HistoryMemoryEntry[] = [];
	let skipped = 0;
	if (!(await isRealDirectory(memoriesPath))) return { memoriesPath, entries, skipped };
	const days =
		options.day === undefined
			? await namesIn(memoriesPath, "dir", MEMORY_DAY)
			: MEMORY_DAY.test(options.day) && (await isRealDirectory(join(memoriesPath, options.day)))
				? [options.day]
				: [];
	for (const day of days) {
		for (const name of await namesIn(join(memoriesPath, day), "file", MEMORY_FILE)) {
			if (entries.length >= options.limit) return { memoriesPath, entries, skipped };
			const path = `${day}/${name}`;
			const read = await readRegularFile(join(memoriesPath, day, name), TIMELINE_READ_BYTES);
			const entry = read === undefined ? undefined : memoryEntry(path, read.text);
			if (entry === undefined) {
				skipped += 1;
			} else {
				entries.push(entry);
			}
		}
	}
	return { memoriesPath, entries, skipped };
}

async function readMemoryFile(memoriesPath: string, path: string): Promise<HistoryMemoryFile> {
	const match = MEMORY_PATH.exec(path);
	const day = match?.[1];
	const name = match?.[2];
	if (day === undefined || name === undefined) {
		throw new Error(
			`"${path}" is not a memory path; use the path from cua_history_timeline, such as 2026-11-23/0930-slug.md`,
		);
	}
	const read =
		(await isRealDirectory(memoriesPath)) && (await isRealDirectory(join(memoriesPath, day)))
			? await readRegularFile(join(memoriesPath, day, name), MAX_MEMORY_BYTES)
			: undefined;
	if (read === undefined) {
		throw new Error(`No memory ${path}; call cua_history_timeline to list them`);
	}
	return { path, bytes: read.bytes, truncated: read.bytes > MAX_MEMORY_BYTES, text: read.text };
}

export function createHistorySource(options: HistorySourceOptions): HistoryToolSource {
	const paths = historyPaths(options.stateDir);
	const memoriesPath = join(paths.root, "memories");
	const now = options.now ?? Date.now;

	const status = (): HistoryStatus => {
		const state = readHistoryState(paths);
		return {
			state,
			eventStreamRootPath: paths.root,
			summariesPath: paths.summariesPath,
			memoriesPath,
			retentionHours: options.retentionHours ?? readRawRetentionMs(paths) / 3_600_000,
			...(state === "stopped" ? {} : { currentSegmentId: segmentIdForTimestamp(now()) }),
		};
	};

	return {
		status,
		getSettings: () => readHistorySettings(paths),
		updateSettings(settings) {
			writeHistorySettings(paths, settings);
			return readHistorySettings(paths);
		},
		pause() {
			if (readHistoryState(paths) === "running") {
				writeHistoryState(paths, "paused");
			}
		},
		resume() {
			if (readHistoryState(paths) === "paused") {
				writeHistoryState(paths, "running");
			}
		},
		suggestSkills: ({ limit }) => suggestHistorySkills(paths.root, { limit }),
		skillDescriptions: async () =>
			(await skillDescriptionsEnabled(paths.root)) ? await readSkillDescriptions(paths.root) : {},
		saveSkill: (draft) =>
			saveHistorySkillDraft(options.skillsDirectory ?? join(homedir(), ".agents", "skills"), draft),
		timeline: (timelineOptions) => readTimeline(memoriesPath, timelineOptions),
		readMemory: (path) => readMemoryFile(memoriesPath, path),
	};
}
