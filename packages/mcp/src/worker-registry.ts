import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One assignment as every opencua-mcp process on this Mac sees it. */
export interface SharedWorkerEntry {
	readonly worker_id: string;
	readonly task: string;
	readonly app: string;
	readonly agent_name?: string;
	readonly parent_agent_name?: string;
	readonly appPid: number;
	/** An opencua-owned surface several workers may share, each with its own cursor. */
	readonly shared?: boolean;
	/** The part of a shared surface this worker is confined to, in window screenshot pixels; absent means the whole window. */
	readonly region?: SharedRegion;
	/** The opencua-mcp process that assigned it; its exit frees the claim. */
	readonly ownerPid: number;
}

/**
 * Assignments shared across server processes, so a subagent whose session runs its own opencua-mcp can act for a
 * worker its coordinator assigned in another one, while an app still belongs to one worker at a time unless it is a
 * shared opencua-owned surface.
 */
export interface WorkerRegistry {
	/** Claims every entry or none: refuses a worker id or app another live process already holds. */
	claim(entries: readonly SharedWorkerEntry[]): void;
	find(workerId: string): SharedWorkerEntry | undefined;
	release(workerId: string): void;
}

export interface SharedRegion {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

function isRegion(value: unknown): value is SharedRegion {
	if (typeof value !== "object" || value === null) return false;
	const region = value as Record<string, unknown>;
	const numbers = [region["x"], region["y"], region["width"], region["height"]];
	return (
		numbers.every((number) => typeof number === "number" && Number.isFinite(number)) &&
		(region["width"] as number) > 0 &&
		(region["height"] as number) > 0
	);
}

/** Why two workers cannot share one surface: a whole-window worker beside a confined one, or overlapping regions. */
function regionConflict(a: SharedWorkerEntry, b: SharedWorkerEntry): string | undefined {
	if (a.region === undefined && b.region === undefined) return undefined;
	if (a.region === undefined || b.region === undefined)
		return "one owns the whole window while the other is confined to a region";
	const overlaps =
		Math.min(a.region.x + a.region.width, b.region.x + b.region.width) > Math.max(a.region.x, b.region.x) &&
		Math.min(a.region.y + a.region.height, b.region.y + b.region.height) > Math.max(a.region.y, b.region.y);
	return overlaps ? "their regions overlap" : undefined;
}

const LOCK_STALE_MS = 5_000;
const LOCK_WAIT_MS = 2_000;

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: unknown) {
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}

function isEntry(value: unknown): value is SharedWorkerEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry["worker_id"] === "string" &&
		typeof entry["task"] === "string" &&
		typeof entry["app"] === "string" &&
		Number.isSafeInteger(entry["appPid"]) &&
		Number.isSafeInteger(entry["ownerPid"]) &&
		(entry["region"] === undefined || isRegion(entry["region"]))
	);
}

export function fileWorkerRegistry(directory: string, ownAlive: (pid: number) => boolean = alive): WorkerRegistry {
	const file = join(directory, "registry.json");
	const lock = join(directory, "registry.lock");

	// mkdir is atomic, so the directory is the lock; one left by a crashed process is taken over once stale.
	const locked = <T>(work: () => T): T => {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const deadline = Date.now() + LOCK_WAIT_MS;
		for (;;) {
			try {
				mkdirSync(lock);
				break;
			} catch {
				try {
					if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true });
				} catch {
					// The holder released it between the two calls.
				}
				if (Date.now() > deadline) throw new Error("the shared worker registry is busy; retry");
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
			}
		}
		try {
			return work();
		} finally {
			rmSync(lock, { recursive: true, force: true });
		}
	};

	const read = (): SharedWorkerEntry[] => {
		try {
			const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
			const entries = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "workers") : undefined;
			return Array.isArray(entries) ? entries.filter(isEntry).filter((entry) => ownAlive(entry.ownerPid)) : [];
		} catch {
			return [];
		}
	};

	const write = (entries: readonly SharedWorkerEntry[]): void => {
		const temporary = `${file}.${process.pid}.tmp`;
		writeFileSync(temporary, `${JSON.stringify({ workers: entries })}\n`, { mode: 0o600 });
		renameSync(temporary, file);
	};

	return {
		claim: (entries) =>
			locked(() => {
				const current = read();
				for (const entry of entries) {
					const held = current.find(
						(other) =>
							other.ownerPid !== entry.ownerPid &&
							(other.worker_id === entry.worker_id ||
								(other.appPid === entry.appPid && !(other.shared === true && entry.shared === true))),
					);
					if (held !== undefined) {
						throw new Error(
							held.worker_id === entry.worker_id
								? `worker "${entry.worker_id}" is already assigned by another opencua session`
								: `app "${entry.app}" is already owned by worker "${held.worker_id}" in another opencua session`,
						);
					}
					for (const other of current) {
						if (other.ownerPid === entry.ownerPid || other.appPid !== entry.appPid) continue;
						const conflict = regionConflict(entry, other);
						if (conflict !== undefined) {
							throw new Error(
								`worker "${entry.worker_id}" cannot share app "${entry.app}" with worker "${other.worker_id}" in another opencua session: ${conflict}`,
							);
						}
					}
				}
				const claimed = new Set(entries.map((entry) => entry.worker_id));
				write([...current.filter((entry) => !claimed.has(entry.worker_id)), ...entries]);
			}),
		find: (workerId) => read().find((entry) => entry.worker_id === workerId),
		release: (workerId) =>
			locked(() => {
				write(read().filter((entry) => entry.worker_id !== workerId));
			}),
	};
}
