import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Rect } from "../types/index.js";

/**
 * A person's grant that lets one agent holder drive one window of one of their own apps, for a bounded time and a
 * bounded set of tools. Leases are written only by the person (CLI with a presence proof); nothing an agent sends
 * can create or widen one. See docs/plans/2026-11-08-window-lease-contract.md.
 */
export const LEASE_TOOLS = ["click", "drag", "scroll", "key", "type", "set_value", "capture"] as const;
export type LeaseTool = (typeof LEASE_TOOLS)[number];

export interface WindowLease {
	readonly id: string;
	readonly holder: string;
	readonly target: {
		readonly bundleId: string;
		readonly pid: number;
		/** `ps -o lstart=` at grant time, so a later process that reuses the pid holds no lease. */
		readonly startedAt: string;
		readonly windowId: number;
		/** Window-local points, top-left origin; absent means the whole window. */
		readonly region?: Readonly<Rect>;
	};
	readonly tools: readonly LeaseTool[];
	readonly grantedAt: string;
	readonly expiresAt: string;
	readonly grantedBy: "cli" | "menu";
	readonly note?: string;
}

export const LEASE_FILE = "leases.json";
export const LEASE_FILE_VERSION = 1;
export const DEFAULT_LEASE_MS = 30 * 60 * 1000;
export const MAX_LEASE_MS = 8 * 60 * 60 * 1000;
export const MAX_AUDIT_LINE_BYTES = 4096;

export type LeaseRefusalCode =
	| "lease-required"
	| "lease-expired"
	| "lease-tool-forbidden"
	| "lease-region-exceeded"
	| "lease-focus-elsewhere"
	| "lease-window-gone"
	| "lease-wait-timeout"
	| "input-lock-busy";

export class LeaseRefusal extends Error {
	constructor(
		readonly code: LeaseRefusalCode,
		detail: string,
	) {
		super(`${code}: ${detail}; only the person can grant a lease (opencua lease grant)`);
		this.name = "LeaseRefusal";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

function isRegion(value: unknown): value is Rect {
	if (!isRecord(value)) return false;
	const { x, y, width, height } = value;
	return (
		typeof x === "number" &&
		typeof y === "number" &&
		typeof width === "number" &&
		typeof height === "number" &&
		Number.isFinite(x) &&
		Number.isFinite(y) &&
		Number.isFinite(width) &&
		Number.isFinite(height) &&
		x >= 0 &&
		y >= 0 &&
		width > 0 &&
		height > 0
	);
}

function isLeaseTool(value: unknown): value is LeaseTool {
	return typeof value === "string" && (LEASE_TOOLS as readonly string[]).includes(value);
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** Only canonical UTC ISO 8601, so a hand-edited lease cannot carry a locale-dependent time. */
function timestamp(value: unknown): number | undefined {
	if (typeof value !== "string" || !ISO_UTC.test(value)) return undefined;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : undefined;
}

/** One entry, all or nothing: any missing or malformed field drops the whole lease rather than a weaker one. */
function parseLease(value: unknown): WindowLease | undefined {
	if (!isRecord(value) || !isRecord(value["target"])) return undefined;
	const target = value["target"];
	const tools = value["tools"];
	const granted = timestamp(value["grantedAt"]);
	const expires = timestamp(value["expiresAt"]);
	if (
		!isNonEmptyString(value["id"]) ||
		!isNonEmptyString(value["holder"]) ||
		!isNonEmptyString(target["bundleId"]) ||
		!isPositiveInteger(target["pid"]) ||
		!isNonEmptyString(target["startedAt"]) ||
		!isPositiveInteger(target["windowId"]) ||
		(target["region"] !== undefined && !isRegion(target["region"])) ||
		!Array.isArray(tools) ||
		tools.length === 0 ||
		!tools.every(isLeaseTool) ||
		granted === undefined ||
		expires === undefined ||
		expires <= granted ||
		expires - granted > MAX_LEASE_MS ||
		(value["grantedBy"] !== "cli" && value["grantedBy"] !== "menu") ||
		(value["note"] !== undefined && typeof value["note"] !== "string")
	) {
		return undefined;
	}
	const region = target["region"] as Rect | undefined;
	const note = value["note"] as string | undefined;
	return Object.freeze({
		id: value["id"],
		holder: value["holder"],
		target: Object.freeze({
			bundleId: target["bundleId"],
			pid: target["pid"],
			startedAt: target["startedAt"],
			windowId: target["windowId"],
			...(region === undefined
				? {}
				: { region: Object.freeze({ x: region.x, y: region.y, width: region.width, height: region.height }) }),
		}),
		tools: Object.freeze([...new Set(tools)]),
		grantedAt: value["grantedAt"] as string,
		expiresAt: value["expiresAt"] as string,
		grantedBy: value["grantedBy"],
		...(note === undefined ? {} : { note }),
	});
}

/** A file that is not exactly version 1 with a lease array yields no leases: fail closed. The result is frozen. */
export function parseLeaseFile(text: string): readonly WindowLease[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return [];
	}
	if (!isRecord(parsed) || parsed["version"] !== LEASE_FILE_VERSION || !Array.isArray(parsed["leases"])) return [];
	const leases: WindowLease[] = [];
	const seen = new Set<string>();
	for (const entry of parsed["leases"]) {
		const lease = parseLease(entry);
		if (lease === undefined || seen.has(lease.id)) continue;
		seen.add(lease.id);
		leases.push(lease);
	}
	return Object.freeze(leases);
}

function leasePath(stateDir: string): string {
	return join(stateDir, LEASE_FILE);
}

let cached: { readonly path: string; readonly stamp: string; readonly leases: readonly WindowLease[] } | undefined;

/**
 * The leases on disk, re-read whenever the file's inode, size, mtime or ctime changes (ctime catches a chmod that
 * makes it unreadable). A missing or unreadable file means none.
 */
export function readLeases(stateDir: string): readonly WindowLease[] {
	const path = leasePath(stateDir);
	let stamp: string;
	try {
		const stat = statSync(path);
		stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
	} catch {
		cached = undefined;
		return [];
	}
	if (cached?.path !== path || cached.stamp !== stamp) {
		let text: string;
		try {
			text = readFileSync(path, "utf8");
		} catch {
			cached = undefined;
			return [];
		}
		cached = { path, stamp, leases: parseLeaseFile(text) };
	}
	return cached.leases;
}

/** Atomic replace (temp file + rename), 0600 in a 0700 directory. For the person's CLI only. */
export function writeLeases(stateDir: string, leases: readonly WindowLease[]): void {
	const path = leasePath(stateDir);
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	chmodSync(stateDir, 0o700);
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify({ version: LEASE_FILE_VERSION, leases }, null, "\t")}\n`, {
		mode: 0o600,
	});
	// `mode` applies only when the file is created; a stale temp file keeps its old mode unless reset.
	chmodSync(temporary, 0o600);
	renameSync(temporary, path);
	cached = undefined;
}

export interface LeaseProbes {
	readonly now: number;
	/** Current `ps -o lstart=` of a pid, undefined when it is gone. */
	readonly startTime: (pid: number) => string | undefined;
	/** The pid that owns a window now, undefined when the window is gone. */
	readonly windowOwner: (windowId: number) => number | undefined;
}

export type LeaseLiveness =
	| { readonly live: true }
	| { readonly live: false; readonly code: "lease-expired" | "lease-window-gone" };

export function leaseLiveness(lease: WindowLease, probes: LeaseProbes): LeaseLiveness {
	const granted = Date.parse(lease.grantedAt);
	const expires = Date.parse(lease.expiresAt);
	if (!(probes.now >= granted && probes.now < expires)) return { live: false, code: "lease-expired" };
	if (probes.startTime(lease.target.pid) !== lease.target.startedAt) return { live: false, code: "lease-window-gone" };
	if (probes.windowOwner(lease.target.windowId) !== lease.target.pid)
		return { live: false, code: "lease-window-gone" };
	return { live: true };
}

/**
 * The live lease that lets `holder` act on this exact window of this exact process. A lease on one window never
 * covers another window of the same process. No holder (no OPENCUA_LEASE_HOLDER) matches nothing.
 */
export function findLiveLease(
	leases: readonly WindowLease[],
	holder: string | undefined,
	target: { readonly pid: number; readonly windowId: number },
	probes: LeaseProbes,
): WindowLease | undefined {
	if (holder === undefined || holder.trim() === "") return undefined;
	return leases.find(
		(lease) =>
			lease.holder === holder &&
			lease.target.pid === target.pid &&
			lease.target.windowId === target.windowId &&
			leaseLiveness(lease, probes).live,
	);
}

const activeLease = new AsyncLocalStorage<WindowLease>();

/** Run `action` with `lease` as the permission for this flow; it is visible across awaits inside, never outside. */
export function withLease<T>(lease: WindowLease, action: () => T): T {
	return activeLease.run(lease, action);
}

export function currentLease(): WindowLease | undefined {
	return activeLease.getStore();
}

/** Whether the flow running now holds a lease for `pid` (and, when given, for exactly `windowId`). */
export function leasedHere(pid: number, windowId?: number): boolean {
	const lease = activeLease.getStore();
	return (
		lease !== undefined && lease.target.pid === pid && (windowId === undefined || lease.target.windowId === windowId)
	);
}

export type LeaseAuditEvent = "grant" | "revoke" | "expire" | "acquire" | "wait" | "admit" | "refuse" | "release";

export interface LeaseAuditEntry {
	readonly event: LeaseAuditEvent;
	readonly leaseId?: string;
	readonly holder?: string;
	readonly session?: string;
	readonly worker?: string;
	readonly cursor?: string;
	readonly pid?: number;
	readonly bundleId?: string;
	readonly windowId?: number;
	readonly region?: Readonly<Rect>;
	readonly tool?: string;
	readonly step?: number;
	readonly code?: LeaseRefusalCode | "person-active";
	readonly reason?: string;
	readonly waitedMs?: number;
	readonly blockedBy?: string;
	readonly by: "cli" | "menu" | "server";
}

export function leaseAuditPath(stateDir: string, at: Date): string {
	return join(stateDir, "audit", `lease-${at.toISOString().slice(0, 10)}.jsonl`);
}

const MAX_REASON_CHARS = 512;

/**
 * Append one JSON line to the day's audit file (UTC date), 0600 in a 0700 directory. A line is kept under
 * MAX_AUDIT_LINE_BYTES: a long reason is cut, and a line still over the limit is refused rather than split.
 */
export function appendLeaseAudit(stateDir: string, entry: LeaseAuditEntry, at: Date = new Date()): string {
	const reason =
		entry.reason !== undefined && entry.reason.length > MAX_REASON_CHARS
			? `${entry.reason.slice(0, MAX_REASON_CHARS)}...`
			: entry.reason;
	const line = `${JSON.stringify({ at: at.toISOString(), ...entry, ...(reason === undefined ? {} : { reason }) })}\n`;
	if (Buffer.byteLength(line, "utf8") >= MAX_AUDIT_LINE_BYTES) {
		throw new RangeError(`lease audit line is ${Buffer.byteLength(line, "utf8")} bytes, over the limit`);
	}
	const path = leaseAuditPath(stateDir, at);
	const directory = join(stateDir, "audit");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	chmodSync(directory, 0o700);
	appendFileSync(path, line, { mode: 0o600 });
	chmodSync(path, 0o600);
	return path;
}
