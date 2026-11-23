import { appendFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type HistoryEvent, encodeHistoryEvent } from "./history-events.js";

export const SEGMENT_WINDOW_MS = 10 * 60 * 1000;
/** Raw events are kept 48 hours, as Codex Computer History keeps its event files; memories stay until deleted. */
export const DEFAULT_RETENTION_MS = 48 * 60 * 60 * 1000;

export interface HistoryFs {
	ensureDir(path: string): Promise<void>;
	appendLine(path: string, line: string): Promise<void>;
	writeText(path: string, text: string): Promise<void>;
	listDir(path: string): Promise<readonly string[]>;
	removeDir(path: string): Promise<void>;
}

export const nodeHistoryFs: HistoryFs = {
	async ensureDir(path) {
		await mkdir(path, { recursive: true, mode: 0o700 });
	},
	async appendLine(path, line) {
		await appendFile(path, `${line}\n`, { mode: 0o600 });
	},
	async writeText(path, text) {
		await writeFile(path, text, { mode: 0o600 });
	},
	async listDir(path) {
		try {
			return await readdir(path);
		} catch {
			return [];
		}
	},
	async removeDir(path) {
		await rm(path, { recursive: true, force: true });
	},
};

export interface SegmentMetadata {
	readonly id: string;
	readonly startedAt: string;
	readonly endedAt: string;
	readonly eventCount: number;
	readonly suppressedEventCount: number;
	readonly eventsPath: string;
}

function isoAt(ms: number): string {
	return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function windowStartMs(ms: number): number {
	return Math.floor(ms / SEGMENT_WINDOW_MS) * SEGMENT_WINDOW_MS;
}

export function segmentIdForTimestamp(ms: number): string {
	return isoAt(windowStartMs(ms)).replaceAll(":", "-");
}

export function segmentStartMs(id: string): number | undefined {
	const normalized = id.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z$/, "$1T$2:$3:$4Z");
	const ms = Date.parse(normalized);
	return Number.isNaN(ms) ? undefined : ms;
}

interface CurrentSegment {
	readonly id: string;
	readonly start: number;
	events: number;
	suppressed: number;
}

export class HistorySegmentStore {
	private current: CurrentSegment | undefined;

	constructor(
		private readonly root: string,
		private readonly fs: HistoryFs = nodeHistoryFs,
		private readonly now: () => number = Date.now,
		private readonly retentionMs: number = DEFAULT_RETENTION_MS,
	) {}

	get segmentsDir(): string {
		return join(this.root, "segments");
	}

	private segmentDir(id: string): string {
		return join(this.segmentsDir, id);
	}

	private async rollTo(timestampMs: number): Promise<CurrentSegment> {
		const start = windowStartMs(timestampMs);
		const id = segmentIdForTimestamp(timestampMs);
		if (this.current?.id !== id) {
			this.current = { id, start, events: 0, suppressed: 0 };
			await this.fs.ensureDir(this.segmentDir(id));
			await this.flushMetadata(this.current);
		}
		return this.current;
	}

	private async flushMetadata(segment: CurrentSegment): Promise<void> {
		const metadata: SegmentMetadata = {
			id: segment.id,
			startedAt: isoAt(segment.start),
			endedAt: isoAt(segment.start + SEGMENT_WINDOW_MS),
			eventCount: segment.events,
			suppressedEventCount: segment.suppressed,
			eventsPath: join(this.segmentDir(segment.id), "events.jsonl"),
		};
		await this.fs.writeText(join(this.segmentDir(segment.id), "metadata.json"), JSON.stringify(metadata, null, 2));
	}

	async append(event: HistoryEvent): Promise<void> {
		const parsed = Date.parse(event.timestamp);
		const segment = await this.rollTo(Number.isNaN(parsed) ? this.now() : parsed);
		segment.events += 1;
		await this.fs.appendLine(join(this.segmentDir(segment.id), "events.jsonl"), encodeHistoryEvent(event));
		await this.flushMetadata(segment);
	}

	async recordSuppressed(): Promise<void> {
		const segment = await this.rollTo(this.now());
		segment.suppressed += 1;
		await this.flushMetadata(segment);
	}

	async prune(): Promise<readonly string[]> {
		const cutoff = this.now() - this.retentionMs;
		const removed: string[] = [];
		for (const id of await this.fs.listDir(this.segmentsDir)) {
			const start = segmentStartMs(id);
			if (start !== undefined && start + SEGMENT_WINDOW_MS < cutoff) {
				await this.fs.removeDir(this.segmentDir(id));
				removed.push(id);
				if (this.current?.id === id) {
					this.current = undefined;
				}
			}
		}
		return removed;
	}

	currentSegmentId(): string | undefined {
		return this.current?.id;
	}
}
