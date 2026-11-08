import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { type Socket, connect } from "node:net";
import { join } from "node:path";
import { resolveStateDir } from "./stop-switch.js";

/**
 * A window opencua launched itself on the person's desktop. It is the only kind of host window opencua may send
 * input to or capture: the person's own apps stay refused. Ownership is the launched pid plus its process start
 * time, so a later process that reuses the pid is not treated as owned.
 */
export interface OwnedSurface {
	readonly pid: number;
	readonly startedAt: string;
	readonly title: string;
	readonly url: string;
}

export interface OwnedSurfaceOptions {
	readonly stateDir?: string;
	readonly startTime?: (pid: number) => string | undefined;
}

export interface OpenSurfaceRequest {
	readonly url: string;
	readonly title: string;
	/** Top-left screen points. */
	readonly frame: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
	/**
	 * "single" (default): the page sees one mouse that the cursors share. "multi": every cursor is its own page pointer,
	 * so cursors press and drag at the same time; the page must handle pointer events.
	 */
	readonly pointers?: "single" | "multi";
}

export const OWNED_SURFACE_BUNDLE_ID = "dev.opencua.surface";
const REGISTRY = "owned-surfaces.json";
const CURSOR_NAMES = "surface-cursors.json";
const RECHECK_MS = 2_000;
const CURSOR_COLORS = [
	"#ff4d4d",
	"#ffa64d",
	"#ffe14d",
	"#9be15d",
	"#4de1a6",
	"#4dd2ff",
	"#4d7dff",
	"#a64dff",
	"#ff4dd2",
	"#ff8080",
	"#c0ff80",
	"#80ffe0",
	"#80b0ff",
	"#e080ff",
	"#ffd080",
	"#ffffff",
];

export function processStartTime(pid: number): string | undefined {
	try {
		const out = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();
		return out.length > 0 ? out : undefined;
	} catch {
		return undefined;
	}
}

function registryPath(options: OwnedSurfaceOptions): string {
	return join(options.stateDir ?? resolveStateDir(), REGISTRY);
}

function isSurface(value: unknown): value is OwnedSurface {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return (
		Number.isSafeInteger(entry["pid"]) &&
		typeof entry["startedAt"] === "string" &&
		typeof entry["title"] === "string" &&
		typeof entry["url"] === "string"
	);
}

export function readOwnedSurfaces(options: OwnedSurfaceOptions = {}): OwnedSurface[] {
	try {
		const parsed: unknown = JSON.parse(readFileSync(registryPath(options), "utf8"));
		const surfaces = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "surfaces") : undefined;
		return Array.isArray(surfaces) ? surfaces.filter(isSurface) : [];
	} catch {
		return [];
	}
}

function writeOwnedSurfaces(surfaces: readonly OwnedSurface[], options: OwnedSurfaceOptions): void {
	const path = registryPath(options);
	mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify({ surfaces })}\n`, { mode: 0o600 });
	renameSync(temporary, path);
}

const verified = new Map<number, { readonly owned: boolean; readonly at: number }>();
let cachedRegistry: { readonly path: string; readonly mtimeMs: number; readonly surfaces: OwnedSurface[] } | undefined;

function currentRegistry(options: OwnedSurfaceOptions): OwnedSurface[] {
	const path = registryPath(options);
	let mtimeMs: number;
	try {
		mtimeMs = statSync(path).mtimeMs;
	} catch {
		return [];
	}
	if (cachedRegistry?.path !== path || cachedRegistry.mtimeMs !== mtimeMs) {
		cachedRegistry = { path, mtimeMs, surfaces: readOwnedSurfaces(options) };
		verified.clear();
	}
	return cachedRegistry.surfaces;
}

/** Whether `pid` is a window process opencua launched and still running as the same process. */
export function isOwnedSurfacePid(pid: number, options: OwnedSurfaceOptions = {}, now = Date.now()): boolean {
	const entry = currentRegistry(options).find((surface) => surface.pid === pid);
	if (entry === undefined) return false;
	const cached = verified.get(pid);
	if (cached !== undefined && now - cached.at < RECHECK_MS) return cached.owned;
	const owned = (options.startTime ?? processStartTime)(pid) === entry.startedAt;
	verified.set(pid, { owned, at: now });
	return owned;
}

/** Records a process opencua just launched as an owned surface. */
export function registerOwnedSurface(
	surface: Omit<OwnedSurface, "startedAt">,
	options: OwnedSurfaceOptions = {},
): OwnedSurface {
	const startedAt = (options.startTime ?? processStartTime)(surface.pid);
	if (startedAt === undefined) throw new Error(`owned surface process ${surface.pid} is not running`);
	const live = readOwnedSurfaces(options).filter(
		(entry) => entry.pid !== surface.pid && (options.startTime ?? processStartTime)(entry.pid) === entry.startedAt,
	);
	const registered: OwnedSurface = { ...surface, startedAt };
	writeOwnedSurfaces([...live, registered], options);
	return registered;
}

export function unregisterOwnedSurface(pid: number, options: OwnedSurfaceOptions = {}): void {
	writeOwnedSurfaces(
		readOwnedSurfaces(options).filter((entry) => entry.pid !== pid),
		options,
	);
	verified.delete(pid);
}

/** The opencua-surface binary built next to the other native helpers. */
export function surfaceBinaryPath(): string {
	return new URL("../../native/opencua-surface", import.meta.url).pathname;
}

/** The built-in drawing page where every pointer keeps its own color and brush size. */
export function boardPageUrl(): string {
	return new URL("../../native/surface-pages/board.html", import.meta.url).href;
}

/** Launches an owned surface window showing `url` and records it; the window never takes the person's focus. */
export function openOwnedSurface(request: OpenSurfaceRequest, options: OwnedSurfaceOptions = {}): OwnedSurface {
	const stateDir = options.stateDir ?? resolveStateDir();
	const { x, y, width, height } = request.frame;
	const child = spawn(
		surfaceBinaryPath(),
		[
			request.url,
			request.title,
			`${x},${y},${width},${height}`,
			join(stateDir, CURSOR_NAMES),
			...(request.pointers === "multi" ? ["--multi-pointer"] : []),
		],
		{ stdio: "ignore", detached: true },
	);
	child.unref();
	if (child.pid === undefined) throw new Error("opencua-surface did not start");
	return registerOwnedSurface({ pid: child.pid, title: request.title, url: request.url }, { ...options, stateDir });
}

export function closeOwnedSurface(pid: number, options: OwnedSurfaceOptions = {}): boolean {
	if (!isOwnedSurfacePid(pid, options)) return false;
	process.kill(pid, "SIGTERM");
	rmSync(surfaceSocketPath(pid, options), { force: true });
	rmSync(surfaceAudioStatePath(pid, options), { force: true });
	unregisterOwnedSurface(pid, options);
	return true;
}

/** A small nonzero tag for a cursor identity, stamped into the events it sends so a surface can draw its owner. */
export function surfaceCursorTag(identity: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < identity.length; index += 1) {
		hash ^= identity.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash & 0x7fffffff || 1;
}

/**
 * Input outside a worker's cursor scope belongs to this process's own session: every MCP server process is one agent
 * or subagent connection, so each moves its own cursor on a surface instead of all of them sharing one.
 */
const SESSION_CURSOR_IDENTITY = `process-${process.pid}`;
let sessionCursorName: string | undefined;

/** Names this session's own cursor, shown on surfaces for input sent outside any worker's cursor scope. */
export function setSessionCursorName(name: string): void {
	sessionCursorName = name;
}

/**
 * The surface tag and label for input from `identity` (a worker's cursor) or, without one, this session's cursor.
 * A worker's label is its name and, when it has one, its purpose: "painter 7: draw row 7".
 */
export function surfaceCursorFor(
	identity: string | undefined,
	owner: { readonly agentName: string; readonly purpose?: string } | undefined,
): { readonly tag: number; readonly name: string } {
	const resolved = identity ?? SESSION_CURSOR_IDENTITY;
	const name = owner?.agentName ?? (identity === undefined ? sessionCursorName : undefined) ?? resolved;
	return {
		tag: surfaceCursorTag(resolved),
		name: owner?.purpose === undefined ? name : `${name}: ${owner.purpose}`,
	};
}

const CONTEXT_CLICK_FLAG = 2 ** 32;

/**
 * The source user data an agent event carries: the cursor tag in the low 32 bits, plus bit 32 for a context click
 * (a tool or color pick) that the surface replays for this cursor when another cursor cut in.
 */
export function surfaceCursorUserData(tag: number, contextClick: boolean): number {
	return contextClick ? tag + CONTEXT_CLICK_FLAG : tag;
}

const namedTags = new Set<number>();
const NAMES_LOCK_WAIT_MS = 250;
const NAMES_LOCK_STALE_MS = 2_000;
const lockPause = new Int32Array(new SharedArrayBuffer(4));

/**
 * Many agent processes name their cursors at once when they start on one surface; without this lock each rewrite of
 * the shared file could drop another process's entry. Labels are cosmetic, so a lock not taken in time is skipped
 * rather than holding the input that triggered the naming.
 */
function withNamesLock(path: string, write: () => void): void {
	const lock = `${path}.lock`;
	const started = Date.now();
	for (;;) {
		try {
			mkdirSync(lock);
			break;
		} catch {
			try {
				if (Date.now() - statSync(lock).mtimeMs > NAMES_LOCK_STALE_MS)
					rmSync(lock, { recursive: true, force: true });
			} catch {
				// The holder released it meanwhile.
			}
			// A holder older than the stale limit is removed above, so waiting past that limit means the lock cannot be
			// taken at all; the name is then left unrecorded rather than written over another process's entry.
			if (Date.now() - started > NAMES_LOCK_STALE_MS + NAMES_LOCK_WAIT_MS) return;
			Atomics.wait(lockPause, 0, 0, 2);
		}
	}
	try {
		write();
	} finally {
		rmSync(lock, { recursive: true, force: true });
	}
}

/** Publishes the agent name for a cursor tag so owned surfaces can label it; written once per tag. */
export function nameSurfaceCursor(tag: number, name: string, options: OwnedSurfaceOptions = {}): void {
	if (namedTags.has(tag)) return;
	const path = join(options.stateDir ?? resolveStateDir(), CURSOR_NAMES);
	mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
	withNamesLock(path, () => writeCursorName(path, tag, name));
	namedTags.add(tag);
}

function writeCursorName(path: string, tag: number, name: string): void {
	let names: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed === "object" && parsed !== null) names = parsed as Record<string, unknown>;
	} catch {
		names = {};
	}
	const color = CURSOR_COLORS[Object.keys(names).length % CURSOR_COLORS.length] ?? "#ffffff";
	names[String(tag)] = { name, color };
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(names)}\n`, { mode: 0o600 });
	renameSync(temporary, path);
}

/** Whether an owned surface's page is playing sound, as WebKit reports it, and when that last changed (epoch ms). */
export interface SurfaceAudioState {
	readonly playing: boolean;
	readonly changedAt: number;
	/** The page's WebAudio output level, in dBFS, when it has played through an AudioContext; media elements are not measured. */
	readonly level?: SurfaceAudioLevel;
	/** The WebKit GPU process that plays the page's sound, once the page has used audio. */
	readonly gpuPid?: number;
}

export interface SurfaceAudioLevel {
	readonly rmsDb: number;
	readonly peakDb: number;
	/** Peak dB in eight log-spaced bands from 20 Hz to the Nyquist frequency. */
	readonly bands: readonly number[];
	/** When the level was measured (epoch ms). */
	readonly at: number;
}

function parseAudioLevel(value: unknown): SurfaceAudioLevel | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { rmsDb, peakDb, bands, at } = value as Record<string, unknown>;
	const finite = (number: unknown): number is number => typeof number === "number" && Number.isFinite(number);
	if (!finite(rmsDb) || !finite(peakDb) || !finite(at) || !Array.isArray(bands) || bands.length !== 8)
		return undefined;
	if (!bands.every(finite)) return undefined;
	return { rmsDb, peakDb, bands: bands.slice(), at };
}

/** The file an owned surface writes its audio state to on every change. */
export function surfaceAudioStatePath(pid: number, options: OwnedSurfaceOptions = {}): string {
	return join(options.stateDir ?? resolveStateDir(), `surface-${pid}.audio.json`);
}

/** The surface's last reported audio state; undefined when it reports none (an older surface build) or the file is unreadable. */
export function surfaceAudioState(pid: number, options: OwnedSurfaceOptions = {}): SurfaceAudioState | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(surfaceAudioStatePath(pid, options), "utf8"));
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || !("playing" in parsed) || !("changedAt" in parsed)) {
		return undefined;
	}
	const { playing, changedAt } = parsed;
	if (typeof playing !== "boolean" || typeof changedAt !== "number" || !Number.isFinite(changedAt)) return undefined;
	const level = "level" in parsed ? parseAudioLevel(parsed.level) : undefined;
	const gpuPid =
		"gpuPid" in parsed && Number.isSafeInteger(parsed.gpuPid) && Number(parsed.gpuPid) > 0
			? Number(parsed.gpuPid)
			: undefined;
	return {
		playing,
		changedAt,
		...(level === undefined ? {} : { level }),
		...(gpuPid === undefined ? {} : { gpuPid }),
	};
}

/** The socket an owned surface listens on for its agents' pointer input. */
export function surfaceSocketPath(pid: number, options: OwnedSurfaceOptions = {}): string {
	return join(options.stateDir ?? resolveStateDir(), `surface-${pid}.sock`);
}

/** One agent pointer event for an owned surface, at a point in window coordinates from its top-left corner. */
export interface SurfacePointerEvent {
	readonly tag: number;
	readonly context: boolean;
	readonly kind: "down" | "drag" | "up" | "move";
	readonly x: number;
	readonly y: number;
}

const POINTER_KINDS = { down: "D", drag: "G", up: "U", move: "M" } as const;
const channels = new Map<string, Socket>();

/**
 * Sends an agent's pointer event straight to an owned surface. The window server merges consecutive drag events
 * posted to one app, which would mix one cursor's tag with another cursor's position; the surface's own socket keeps
 * each cursor's events whole and in order. False when the surface has no socket, so the caller posts the event.
 */
export function sendSurfacePointer(
	pid: number,
	event: SurfacePointerEvent,
	options: OwnedSurfaceOptions = {},
): boolean {
	const path = surfaceSocketPath(pid, options);
	let channel = channels.get(path);
	if (channel === undefined) {
		if (!existsSync(path)) return false;
		const socket = connect(path);
		socket.on("error", () => {
			channels.delete(path);
			socket.destroy();
		});
		socket.on("close", () => channels.delete(path));
		socket.unref();
		channels.set(path, socket);
		channel = socket;
	}
	const x = Math.round(event.x * 10) / 10;
	const y = Math.round(event.y * 10) / 10;
	channel.write(`${event.tag} ${event.context ? 1 : 0} ${POINTER_KINDS[event.kind]} ${x} ${y}\n`);
	return true;
}
