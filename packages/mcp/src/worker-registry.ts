import { randomUUID } from "node:crypto";
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

function errorCode(error: unknown): unknown {
	return error instanceof Error && "code" in error ? error.code : undefined;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: unknown) {
		return errorCode(error) === "EPERM";
	}
}

/** The "<pid> <nonce>" token a lock holder wrote, or undefined when the lock has none (yet) or is gone. */
function lockOwner(lock: string): string | undefined {
	try {
		return readFileSync(join(lock, "owner"), "utf8");
	} catch {
		return undefined;
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

	// A held lock is never taken from a live owner.
	const abandoned = (owner: string | undefined): boolean => {
		if (owner === undefined) {
			// No owner yet: a holder between mkdir and writing its token, or one that crashed there long ago.
			try {
				return Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS;
			} catch {
				return false;
			}
		}
		const pid = Number(owner.split(" ")[0]);
		return Number.isSafeInteger(pid) && !ownAlive(pid);
	};

	// Moves an abandoned lock aside atomically, then confirms it moved the one it judged; a lock someone acquired in
	// between goes back.
	const takeOver = (owner: string | undefined): void => {
		const aside = `${lock}.abandoned-${randomUUID()}`;
		try {
			renameSync(lock, aside);
		} catch {
			return; // Released or taken over by another process first.
		}
		if (lockOwner(aside) === owner) {
			rmSync(aside, { recursive: true, force: true });
			return;
		}
		try {
			renameSync(aside, lock);
		} catch {
			rmSync(aside, { recursive: true, force: true });
		}
	};

	// mkdir is atomic, so the directory is the lock, and the token inside it says who holds it.
	const locked = <T>(work: () => T): T => {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const token = `${process.pid} ${randomUUID()}`;
		const deadline = Date.now() + LOCK_WAIT_MS;
		for (;;) {
			try {
				mkdirSync(lock);
				writeFileSync(join(lock, "owner"), token, { mode: 0o600 });
				break;
			} catch (error: unknown) {
				if (errorCode(error) !== "EEXIST") throw error;
				const owner = lockOwner(lock);
				if (abandoned(owner)) takeOver(owner);
				if (Date.now() > deadline) throw new Error("the shared worker registry is busy; retry");
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
			}
		}
		try {
			return work();
		} finally {
			// Another process holds it now if this one lost it; that lock is not this one's to remove.
			if (lockOwner(lock) === token) rmSync(lock, { recursive: true, force: true });
		}
	};

	// Fails closed: a registry that cannot be read must not look empty, or another session's apps would look free.
	const read = (): SharedWorkerEntry[] => {
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch (error: unknown) {
			if (errorCode(error) === "ENOENT") return [];
			throw error;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (error: unknown) {
			throw new Error(
				`the shared worker registry ${file} is not valid JSON (${error instanceof Error ? error.message : String(error)}); remove it once no opencua session is running`,
			);
		}
		const entries = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "workers") : undefined;
		if (!Array.isArray(entries) || !entries.every(isEntry)) {
			throw new Error(
				`the shared worker registry ${file} does not hold a valid worker list; remove it once no opencua session is running`,
			);
		}
		return entries.filter((entry) => ownAlive(entry.ownerPid));
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
