import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// One status pill for everything working on the person's Mac: buddy, its background jobs, and any agent driving
// OpenCUA (Claude Code, Codex, OmO...). Each writer keeps one entry file in the feed folder and then rewrites
// current.json, the composed state that the single `buddy-hud --status --feed <dir>` process draws.

export type ActivityState = "idle" | "listening" | "hearing" | "thinking" | "working" | "speaking" | "done" | "error";

export interface ActivityEntry {
	/** Who wrote it, unique per writer: "buddy", "mcp-1234", "job-<id>", "claude-code". */
	readonly source: string;
	/** The name the person knows the worker by, such as "Claude Code". */
	readonly agent: string;
	readonly state: ActivityState;
	readonly text?: string;
	readonly detail?: string;
	/** Epoch milliseconds. */
	readonly updatedAt: number;
	/** Seconds after updatedAt that the entry stops counting; none means until it is cleared or its process ends. */
	readonly ttl?: number;
	/** The process the entry belongs to; once it is gone the entry no longer counts. */
	readonly pid?: number;
}

export interface ComposedActivity {
	readonly state: ActivityState;
	readonly text?: string;
	readonly detail?: string;
	/** Seconds until the pill hides itself unless the feed changes first. */
	readonly ttl?: number;
}

const BUDDY_SOURCE = "buddy";
const CURRENT_FILE = "current.json";
const PID_FILE = ".hud.pid";
const MAX_TEXT = 160;

export function activityFeedDir(stateDir: string): string {
	return join(stateDir, "hud");
}

/** OPENCUA_HUD=off keeps the status pill off the screen. */
export function activityHudDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env["OPENCUA_HUD"] === "off";
}

function clip(text: string | undefined): string | undefined {
	if (text === undefined) return undefined;
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length === 0) return undefined;
	return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT - 1)}…` : flat;
}

function counts(entry: ActivityEntry, now: number, isAlive: (pid: number) => boolean): boolean {
	if (entry.state === "idle") return false;
	if (entry.ttl !== undefined && entry.updatedAt + entry.ttl * 1000 <= now) return false;
	return entry.pid === undefined || isAlive(entry.pid);
}

function remaining(entry: ActivityEntry, now: number): number | undefined {
	if (entry.ttl === undefined) return undefined;
	return Math.max(0.1, Math.round((entry.updatedAt + entry.ttl * 1000 - now) / 100) / 10);
}

function othersLine(others: readonly ActivityEntry[]): string | undefined {
	if (others.length === 0) return undefined;
	const [first] = others;
	if (others.length === 1 && first !== undefined) {
		return first.text === undefined ? `${first.agent} working` : `${first.agent} · ${first.text}`;
	}
	return `${others.length} agents working`;
}

/**
 * What the pill shows: buddy's own state when it is doing something (the person just talked to it), else the
 * most recent agent; whatever else is working goes on the second line.
 */
export function composeActivity(
	entries: readonly ActivityEntry[],
	now: number,
	isAlive: (pid: number) => boolean,
): ComposedActivity {
	const live = entries.filter((entry) => counts(entry, now, isAlive)).sort((a, b) => b.updatedAt - a.updatedAt);
	const lead = live.find((entry) => entry.source === BUDDY_SOURCE) ?? live[0];
	if (lead === undefined) return { state: "idle" };
	const others = live.filter((entry) => entry !== lead);
	const text = clip(
		lead.source === BUDDY_SOURCE || lead.text === undefined ? lead.text : `${lead.agent} · ${lead.text}`,
	);
	const detail = clip(lead.detail ?? othersLine(others));
	// The pill hides by itself only when every live entry expires; it stays until the last one does.
	const ttls = live.map((entry) => remaining(entry, now));
	const ttl = ttls.every((value) => value !== undefined)
		? Math.max(...ttls.filter((value) => value !== undefined))
		: undefined;
	return {
		state: lead.state,
		...(text === undefined ? {} : { text }),
		...(detail === undefined ? {} : { detail }),
		...(ttl === undefined ? {} : { ttl }),
	};
}

function writeAtomic(path: string, text: string): void {
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, text, { mode: 0o600 });
	renameSync(temporary, path);
}

function readEntries(dir: string): ActivityEntry[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const entries: ActivityEntry[] = [];
	for (const name of names) {
		if (!name.endsWith(".json") || name === CURRENT_FILE) continue;
		try {
			const parsed: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"));
			if (isEntry(parsed)) entries.push(parsed);
		} catch {
			// A file being replaced or a foreign file: skip it, the next write composes again.
		}
	}
	return entries;
}

function isEntry(value: unknown): value is ActivityEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry["source"] === "string" &&
		typeof entry["agent"] === "string" &&
		typeof entry["state"] === "string" &&
		typeof entry["updatedAt"] === "number"
	);
}

function entryFile(dir: string, source: string): string {
	return join(dir, `${source.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: unknown) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export interface ActivityFeedOptions {
	readonly now?: () => number;
	readonly isAlive?: (pid: number) => boolean;
	/** Starts the HUD process; absent means the feed is only written (tests, or no HUD binary). */
	readonly startHud?: (dir: string) => void;
}

export class ActivityFeed {
	readonly dir: string;
	private readonly now: () => number;
	private readonly isAlive: (pid: number) => boolean;
	private readonly startHud: ((dir: string) => void) | undefined;

	constructor(dir: string, options: ActivityFeedOptions = {}) {
		this.dir = dir;
		this.now = options.now ?? Date.now;
		this.isAlive = options.isAlive ?? processAlive;
		this.startHud = options.startHud;
	}

	write(entry: Omit<ActivityEntry, "updatedAt"> & { readonly updatedAt?: number }): ComposedActivity {
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		const full: ActivityEntry = { ...entry, updatedAt: entry.updatedAt ?? this.now() };
		writeAtomic(entryFile(this.dir, entry.source), `${JSON.stringify(full)}\n`);
		return this.publish();
	}

	clear(source: string): ComposedActivity {
		rmSync(entryFile(this.dir, source), { force: true });
		return this.publish();
	}

	read(): ComposedActivity {
		return composeActivity(readEntries(this.dir), this.now(), this.isAlive);
	}

	private publish(): ComposedActivity {
		const composed = this.read();
		if (!existsSync(this.dir)) return composed;
		writeAtomic(join(this.dir, CURRENT_FILE), `${JSON.stringify(composed)}\n`);
		if (composed.state !== "idle") this.startHud?.(this.dir);
		return composed;
	}
}

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const hudBinaryCandidates = [
	join(moduleDirectory, "../../native/buddy-hud"),
	join(moduleDirectory, "../../../native/buddy-hud"),
];

export function buddyHudBinary(): string | undefined {
	return hudBinaryCandidates.find((candidate) => existsSync(candidate));
}

export type HudSpawn = (binary: string, args: readonly string[]) => Pick<ChildProcess, "pid" | "unref">;

const detachedSpawn: HudSpawn = (binary, args) => spawn(binary, [...args], { detached: true, stdio: "ignore" });

/**
 * Starts `buddy-hud --status --feed <dir>` unless the one recorded in the pid file still runs. Two writers racing
 * both spawn; the HUD takes a lock on the folder, so the second one exits at once.
 */
export function hudStarter(
	binary: string | undefined,
	options: {
		readonly spawn?: HudSpawn;
		readonly isAlive?: (pid: number) => boolean;
		readonly env?: NodeJS.ProcessEnv;
	} = {},
): ((dir: string) => void) | undefined {
	if (binary === undefined || activityHudDisabled(options.env)) return undefined;
	const start = options.spawn ?? detachedSpawn;
	const isAlive = options.isAlive ?? processAlive;
	return (dir) => {
		const pidFile = join(dir, PID_FILE);
		try {
			const recorded = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
			if (Number.isInteger(recorded) && recorded > 0 && isAlive(recorded)) return;
		} catch {}
		const child = start(binary, ["--status", "--feed", dir]);
		child.unref();
		if (child.pid !== undefined) writeAtomic(pidFile, String(child.pid));
	};
}

export function defaultActivityFeed(stateDir: string, env: NodeJS.ProcessEnv = process.env): ActivityFeed {
	const startHud = hudStarter(buddyHudBinary(), { env });
	return new ActivityFeed(activityFeedDir(stateDir), startHud === undefined ? {} : { startHud });
}
