import {
	constants,
	type Dirent,
	closeSync,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
	readdirSync,
	rmSync,
} from "node:fs";
import { join } from "node:path";
import type { HistoryPaths } from "./history-control.js";
import { SEGMENT_WINDOW_MS, segmentStartMs } from "./history-store.js";

export interface HistorySegmentSummary {
	readonly id: string;
	readonly startedAt: string;
	readonly endedAt: string;
	/** Lines in events.jsonl, which is what the segment actually holds (metadata can lag a crash). */
	readonly eventCount: number;
	/** Apps seen in the segment, most frequent first, at most five. */
	readonly apps: readonly string[];
}

/** Which segments to delete: exact ids, every segment that overlaps the last `withinMs`, or all of them. */
export type HistoryDeletion =
	| { readonly ids: readonly string[] }
	| { readonly withinMs: number }
	| { readonly all: true };

// The recorder names a segment by its window start, which falls on a 10-minute boundary.
const SEGMENT_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-[0-5]0-00Z$/;
const MAX_EVENTS_BYTES = 8 * 1024 * 1024;
const MAX_SETTINGS_BYTES = 64 * 1024;
const MAX_LISTED_APPS = 5;

/** Raw segments are kept this long unless settings.json sets `rawRetentionHours`; memories are kept until deleted. */
export const DEFAULT_RAW_RETENTION_HOURS = 48;

export function isHistorySegmentId(value: string): boolean {
	return SEGMENT_ID.test(value) && segmentStartMs(value) !== undefined;
}

/**
 * Real segment directories only, oldest first: a symlink or a stray name in segments/ is never listed, so never
 * deleted.
 */
export function historySegmentIds(paths: HistoryPaths): string[] {
	let entries: Dirent[];
	try {
		entries = readdirSync(paths.segmentsDir, { withFileTypes: true });
	} catch (error: unknown) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return [];
		}
		throw error;
	}
	return entries
		.filter((entry) => entry.isDirectory() && isHistorySegmentId(entry.name))
		.map((entry) => entry.name)
		.sort();
}

/** Reads a regular file without following a symlink, up to `limit` bytes. */
export function readRegularFile(path: string, limit: number): string | undefined {
	let descriptor: number;
	try {
		descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch {
		return undefined;
	}
	try {
		const stats = fstatSync(descriptor);
		if (!stats.isFile()) {
			return undefined;
		}
		const buffer = Buffer.alloc(Math.min(stats.size, limit));
		const read = readSync(descriptor, buffer, 0, buffer.length, 0);
		return buffer.subarray(0, read).toString("utf8");
	} finally {
		closeSync(descriptor);
	}
}

/** The recorded lines of one segment; a missing or linked events file holds none. */
function segmentLines(paths: HistoryPaths, id: string): string[] {
	const text = readRegularFile(join(paths.segmentsDir, id, "events.jsonl"), MAX_EVENTS_BYTES) ?? "";
	return text.split("\n").filter((line) => line.trim().length > 0);
}

/** The parsed events of one segment, in recorded order. A torn line from a crash is left out. */
export function readHistorySegmentEvents(paths: HistoryPaths, id: string): unknown[] {
	return segmentLines(paths, id).flatMap((line): unknown[] => {
		try {
			return [JSON.parse(line)];
		} catch {
			return [];
		}
	});
}

function summarize(paths: HistoryPaths, id: string): HistorySegmentSummary {
	const start = segmentStartMs(id) ?? 0;
	const appCounts = new Map<string, number>();
	let eventCount = 0;
	for (const line of segmentLines(paths, id)) {
		eventCount += 1;
		try {
			const event: unknown = JSON.parse(line);
			const app = typeof event === "object" && event !== null ? Reflect.get(event, "app") : undefined;
			const name = typeof app === "object" && app !== null ? Reflect.get(app, "name") : undefined;
			if (typeof name === "string" && name.length > 0) {
				appCounts.set(name, (appCounts.get(name) ?? 0) + 1);
			}
		} catch {
			// A torn last line from a crash still counts as recorded; it just names no app.
		}
	}
	const apps = [...appCounts.entries()]
		.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
		.slice(0, MAX_LISTED_APPS)
		.map(([name]) => name);
	return {
		id,
		startedAt: new Date(start).toISOString(),
		endedAt: new Date(start + SEGMENT_WINDOW_MS).toISOString(),
		eventCount,
		apps,
	};
}

export function listHistorySegments(paths: HistoryPaths): HistorySegmentSummary[] {
	return historySegmentIds(paths)
		.reverse()
		.map((id) => summarize(paths, id));
}

function removeSegment(paths: HistoryPaths, id: string): void {
	const target = join(paths.segmentsDir, id);
	// Checked again right before removal: the directory must still be a real directory, not a swapped-in link.
	if (!lstatSync(target).isDirectory()) {
		throw new Error(`History segment ${id} is no longer a directory; nothing more was deleted`);
	}
	rmSync(target, { recursive: true, force: true });
}

/**
 * Deletes recorded segments and returns the ids removed, newest first. Exact ids are checked first, so a typo or a
 * path such as `../x` fails before anything is removed; only real directories directly inside segments/ go.
 */
export function deleteHistorySegments(
	paths: HistoryPaths,
	deletion: HistoryDeletion,
	now: number = Date.now(),
): string[] {
	const present = new Set(historySegmentIds(paths));
	let selected: string[];
	if ("ids" in deletion) {
		for (const id of deletion.ids) {
			if (!isHistorySegmentId(id)) {
				throw new Error(`"${id}" is not a history segment id; run opencua history list to see them`);
			}
			if (!present.has(id)) {
				throw new Error(`No history segment ${id}; run opencua history list to see them`);
			}
		}
		selected = [...new Set(deletion.ids)];
	} else if ("withinMs" in deletion) {
		if (!Number.isFinite(deletion.withinMs) || deletion.withinMs <= 0) {
			throw new Error("The period to delete must be a positive duration");
		}
		const cutoff = now - deletion.withinMs;
		selected = [...present].filter((id) => (segmentStartMs(id) ?? 0) + SEGMENT_WINDOW_MS > cutoff);
	} else {
		selected = [...present];
	}
	selected.sort((left, right) => right.localeCompare(left));
	for (const id of selected) {
		removeSegment(paths, id);
	}
	return selected;
}

/** How long raw segments are kept: `rawRetentionHours` in settings.json when it is a positive number, else 48 hours. */
export function readRawRetentionMs(paths: HistoryPaths): number {
	let hours: unknown;
	try {
		const settings: unknown = JSON.parse(readRegularFile(paths.settingsPath, MAX_SETTINGS_BYTES) ?? "null");
		hours =
			typeof settings === "object" && settings !== null ? Reflect.get(settings, "rawRetentionHours") : undefined;
	} catch {
		hours = undefined;
	}
	const kept = typeof hours === "number" && Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_RAW_RETENTION_HOURS;
	return kept * 3_600_000;
}

/**
 * Deletes the raw segments whose 10-minute window ended more than `retentionMs` ago, oldest first, and returns their
 * ids. Only ids in `summarized` go: a segment whose activity has no memory yet is kept however old it is.
 */
export function deleteExpiredHistorySegments(
	paths: HistoryPaths,
	options: { readonly now: number; readonly retentionMs: number; readonly summarized: ReadonlySet<string> },
): string[] {
	if (!Number.isFinite(options.retentionMs) || options.retentionMs <= 0) {
		throw new Error("The raw history retention must be a positive duration");
	}
	const cutoff = options.now - options.retentionMs;
	const expired = historySegmentIds(paths).filter((id) => {
		const start = segmentStartMs(id);
		return start !== undefined && start + SEGMENT_WINDOW_MS <= cutoff && options.summarized.has(id);
	});
	for (const id of expired) {
		removeSegment(paths, id);
	}
	return expired;
}

/** Parses a duration such as 15m, 2h or 1d for `opencua history delete --last`. */
export function parseHistoryDuration(value: string): number {
	const match = /^(\d+)([mhd])$/.exec(value.trim());
	const amount = match === null ? Number.NaN : Number(match[1]);
	if (match === null || !Number.isSafeInteger(amount) || amount <= 0) {
		throw new Error(`"${value}" is not a duration; use minutes, hours or days such as 15m, 2h or 1d`);
	}
	const unit = match[2] === "m" ? 60_000 : match[2] === "h" ? 3_600_000 : 86_400_000;
	return amount * unit;
}
