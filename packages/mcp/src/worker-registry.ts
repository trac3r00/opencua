import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { processStartTime } from "@opencua/core";
import { ToolFailure } from "@opencua/core";

/** Worker lookups and claims refused before any read or input: nothing was sent, so asking again is safe. */
export function workerNotAssigned(workerId: string): ToolFailure {
	return new ToolFailure(`worker "${workerId}" is not assigned`, {
		code: "WORKER_NOT_ASSIGNED",
		delivery: "not_sent",
		retry: "safe",
		hint: "Nothing was sent. Check manage_workers status for the worker id, or have the coordinator assign it, then retry.",
		evidence: { worker_id: workerId },
	});
}

export function workerBusy(workerId: string): ToolFailure {
	return new ToolFailure(`worker "${workerId}" is busy`, {
		code: "WORKER_BUSY",
		delivery: "not_sent",
		retry: "safe",
		hint: "Nothing was sent. Wait for the worker's current run to finish, then retry.",
		evidence: { worker_id: workerId },
	});
}

export function workerConflict(message: string): ToolFailure {
	return new ToolFailure(message, {
		code: "WORKER_CONFLICT",
		delivery: "not_sent",
		retry: "safe",
		hint: "Nothing was sent. Pick another app or worker id, or release the worker that holds it, then retry.",
	});
}

/** A call outside the owning worker on a worker's app, refused before it runs. */
export function appOwnedByWorker(message: string): ToolFailure {
	return new ToolFailure(message, {
		code: "APP_OWNED_BY_WORKER",
		delivery: "not_sent",
		retry: "safe",
		hint: "Nothing was sent. Act through run_worker or manage_workers observe for the worker named, or release it first.",
	});
}

/** One assignment as its assigning process submits it; the registry stamps the lease. */
export interface SharedWorkerClaim {
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
 * Which process holds a pid now: a value that differs for every process that ever holds it, or undefined when none
 * runs. A pid alone would let a later process that reuses it pass for the one that wrote a claim.
 */
export type ProcessIdentity = (pid: number) => string | undefined;

/** One assignment as every opencua-mcp process on this Mac sees it. */
export interface SharedWorkerEntry extends SharedWorkerClaim {
	/**
	 * Minted when the claim is written: a worker id released and claimed again is a different lease, so a process
	 * still holding the old one cannot mistake the new owner's worker for its own. Absent in a file an older
	 * opencua wrote.
	 */
	readonly lease?: string;
	/**
	 * The identity of `ownerPid` when the claim was written: the claim is the owner's only while that process still
	 * holds the pid. Absent in a file an older opencua wrote, where a running pid is all that can be checked.
	 */
	readonly ownerStartedAt?: string;
	/** The process running this worker right now; absent while it is idle. */
	readonly busy?: SharedWorkerRun;
}

/** One run of a worker, in whichever process executes it. */
export interface SharedWorkerRun {
	readonly pid: number;
	readonly run: string;
	/** The identity of `pid` when the run began; absent in a file an older opencua wrote. */
	readonly startedAt?: string;
}

/**
 * Assignments shared across server processes, so a subagent whose session runs its own opencua-mcp can act for a
 * worker its coordinator assigned in another one, while an app still belongs to one worker at a time unless it is a
 * shared opencua-owned surface. A claim belongs to the process that made it, and a run marks the worker busy for
 * every process: release waits for both.
 */
export interface WorkerRegistry {
	/** The process this registry acts for: the owner it compares on release, and the runner it records. */
	readonly ownerPid: number;
	/** Claims every entry or none, each under a fresh lease: refuses a worker id or app another live process already holds. */
	claim(entries: readonly SharedWorkerClaim[]): readonly SharedWorkerEntry[];
	find(workerId: string): SharedWorkerEntry | undefined;
	/** The worker holding app `appPid` alone, in any live process; a shared surface has no single holder. */
	holder(appPid: number): SharedWorkerEntry | undefined;
	/**
	 * Drops this process's claim. Refused when another live process owns the claim, or is running the worker:
	 * the refusal names that process. A claim that is already gone is nothing to release.
	 */
	release(workerId: string): void;
	/** Marks the worker busy in this process; refused while another live process runs it, or when its claim is gone. */
	beginRun(workerId: string): SharedWorkerRun;
	/** Clears the busy marker `run` set; a marker another run set since is left alone. */
	endRun(workerId: string, run: SharedWorkerRun): void;
}

/** A release or run the shared registry refused: nothing was sent, and the message names the process in the way. */
export class WorkerLeaseRefusal extends Error {
	readonly actionDispatched = false;

	constructor(
		readonly reason: "worker-owned-elsewhere" | "worker-running-elsewhere",
		message: string,
	) {
		super(message);
		this.name = "WorkerLeaseRefusal";
	}
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

/** Stands in for a start time on a platform that reports none, so a running process there is told only from none. */
const UNKNOWN_START = "unknown-start";

/** The kernel start time of the process at `pid`; a pid that runs without one to read is known only to run. */
function runningProcess(pid: number): string | undefined {
	return alive(pid) ? (processStartTime(pid) ?? UNKNOWN_START) : undefined;
}

/** The "<pid> <nonce> <start time>" token a lock holder wrote, or undefined when the lock has none (yet) or is gone. */
function lockOwner(lock: string): string | undefined {
	try {
		return readFileSync(join(lock, "owner"), "utf8");
	} catch {
		return undefined;
	}
}

/** `entry` with its busy marker cleared. */
function idle({ busy: _busy, ...entry }: SharedWorkerEntry): SharedWorkerEntry {
	return entry;
}

function isRun(value: unknown): value is SharedWorkerRun {
	if (typeof value !== "object" || value === null) return false;
	const run = value as Record<string, unknown>;
	return (
		Number.isSafeInteger(run["pid"]) &&
		typeof run["run"] === "string" &&
		(run["startedAt"] === undefined || typeof run["startedAt"] === "string")
	);
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
		(entry["region"] === undefined || isRegion(entry["region"])) &&
		(entry["lease"] === undefined || typeof entry["lease"] === "string") &&
		(entry["ownerStartedAt"] === undefined || typeof entry["ownerStartedAt"] === "string") &&
		(entry["busy"] === undefined || isRun(entry["busy"]))
	);
}

/**
 * `identify` says which process holds a pid now, and `ownerPid` is the process this registry acts for; tests model
 * several opencua processes over one directory by giving each registry its own.
 */
export function fileWorkerRegistry(
	directory: string,
	identify: ProcessIdentity = runningProcess,
	ownerPid: number = process.pid,
): WorkerRegistry {
	const file = join(directory, "registry.json");
	const lock = join(directory, "registry.lock");

	/**
	 * Whether the process that wrote a record for `pid` still holds that pid. A record without a start time comes
	 * from an older opencua and is judged by the pid running at all; this process stamps everything it writes, so
	 * such a record naming its own pid was left by an earlier process that had the pid.
	 */
	const stillRuns = (
		pid: number,
		startedAt: string | undefined,
		current: string | undefined = identify(pid),
	): boolean => current !== undefined && (startedAt === undefined ? pid !== ownerPid : current === startedAt);

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
		const [holder, , ...started] = owner.split(" ");
		const pid = Number(holder);
		if (!Number.isSafeInteger(pid)) return false;
		const current = identify(pid);
		// A token without a start time is an older opencua's; its holder is judged by the pid running at all.
		return current === undefined || (started.length > 0 && current !== started.join(" "));
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
		const nonce = randomUUID();
		let token = "";
		const deadline = Date.now() + LOCK_WAIT_MS;
		for (;;) {
			try {
				mkdirSync(lock);
				token = `${ownerPid} ${nonce} ${identify(ownerPid) ?? UNKNOWN_START}`;
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
		// One answer per pid for the whole read, so every record of a process is judged against the same identity.
		const identities = new Map<number, string | undefined>();
		const current = (pid: number): string | undefined => {
			if (!identities.has(pid)) identities.set(pid, identify(pid));
			return identities.get(pid);
		};
		// A claim or run of a process that exited is over, whatever the file still says, and so is one whose pid
		// another process holds now.
		return entries
			.filter((entry) => stillRuns(entry.ownerPid, entry.ownerStartedAt, current(entry.ownerPid)))
			.map((entry) =>
				entry.busy !== undefined && !stillRuns(entry.busy.pid, entry.busy.startedAt, current(entry.busy.pid))
					? idle(entry)
					: entry,
			);
	};

	/** The one process in the way of releasing or running `entry`, or undefined when this process may go ahead. */
	const heldElsewhere = (entry: SharedWorkerEntry, action: "release" | "run"): WorkerLeaseRefusal | undefined => {
		if (entry.busy !== undefined && entry.busy.pid !== ownerPid) {
			return new WorkerLeaseRefusal(
				"worker-running-elsewhere",
				`worker "${entry.worker_id}" is running in another opencua session (process ${entry.busy.pid}); wait for that run to finish before you ${action} it`,
			);
		}
		if (action === "release" && entry.ownerPid !== ownerPid) {
			return new WorkerLeaseRefusal(
				"worker-owned-elsewhere",
				`worker "${entry.worker_id}" was assigned by another opencua session (process ${entry.ownerPid}); only that session can release it`,
			);
		}
		return undefined;
	};

	const write = (entries: readonly SharedWorkerEntry[]): void => {
		const temporary = `${file}.${process.pid}.tmp`;
		writeFileSync(temporary, `${JSON.stringify({ workers: entries })}\n`, { mode: 0o600 });
		renameSync(temporary, file);
	};

	return {
		ownerPid,
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
						throw workerConflict(
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
				const leased = entries.map((entry) => {
					const ownerStartedAt = identify(entry.ownerPid);
					return {
						...entry,
						lease: randomUUID(),
						...(ownerStartedAt === undefined ? {} : { ownerStartedAt }),
					};
				});
				write([...current.filter((entry) => !claimed.has(entry.worker_id)), ...leased]);
				return leased;
			}),
		find: (workerId) => read().find((entry) => entry.worker_id === workerId),
		holder: (appPid) => read().find((entry) => entry.appPid === appPid && entry.shared !== true),
		release: (workerId) =>
			locked(() => {
				const current = read();
				const entry = current.find((candidate) => candidate.worker_id === workerId);
				if (entry === undefined) return;
				const refusal = heldElsewhere(entry, "release");
				if (refusal !== undefined) throw refusal;
				write(current.filter((candidate) => candidate !== entry));
			}),
		beginRun: (workerId) =>
			locked(() => {
				const current = read();
				const entry = current.find((candidate) => candidate.worker_id === workerId);
				if (entry === undefined) {
					throw workerNotAssigned(workerId);
				}
				const refusal = heldElsewhere(entry, "run");
				if (refusal !== undefined) throw refusal;
				const startedAt = identify(ownerPid);
				const busy: SharedWorkerRun = {
					pid: ownerPid,
					run: randomUUID(),
					...(startedAt === undefined ? {} : { startedAt }),
				};
				write(current.map((candidate) => (candidate === entry ? { ...entry, busy } : candidate)));
				return busy;
			}),
		endRun: (workerId, run) =>
			locked(() => {
				const current = read();
				const entry = current.find((candidate) => candidate.worker_id === workerId);
				if (entry === undefined || entry.busy?.run !== run.run) return;
				write(current.map((candidate) => (candidate === entry ? idle(entry) : candidate)));
			}),
	};
}
