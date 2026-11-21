import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** A rectangle in global screen points, measured from the top-left corner of the main display. */
export interface SpaceBounds {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

export type PipState = "collapsed" | "expanded" | "minimized";

export type SpaceHelperEvent =
	| { readonly kind: "created"; readonly displayId: number; readonly bounds: SpaceBounds }
	| { readonly kind: "failed"; readonly error: string; readonly message: string }
	| { readonly kind: "takeover" }
	| { readonly kind: "resume" }
	| { readonly kind: "state"; readonly state: PipState };

/** What `<stateDir>/spaces/<id>.json` holds while a space is running. */
export interface SpaceRecord {
	readonly id: string;
	readonly displayId: number;
	readonly bounds: SpaceBounds;
	readonly pid: number;
	readonly createdAt: string;
	readonly takenOver: boolean;
}

/** A request sent to the process that owns a space, over its control socket. */
export type SpaceCommand = "takeover" | "resume" | "stop";

const COMMAND_TIMEOUT_MS = 3_000;

function fieldsOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: undefined;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function parseBounds(value: unknown): SpaceBounds | undefined {
	const fields = fieldsOf(value);
	if (fields === undefined) return undefined;
	const { x, y, width, height } = fields;
	return isFiniteNumber(x) &&
		isFiniteNumber(y) &&
		isFiniteNumber(width) &&
		isFiniteNumber(height) &&
		width > 0 &&
		height > 0
		? { x, y, width, height }
		: undefined;
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** Parses one helper stdout line; anything that is not one of its JSON messages is undefined. */
export function parseSpaceHelperLine(line: string): SpaceHelperEvent | undefined {
	const fields = fieldsOf(parseJson(line));
	if (fields === undefined) return undefined;
	const { event, state, error, message, displayId } = fields;
	if (typeof error === "string") {
		return { kind: "failed", error, message: typeof message === "string" ? message : error };
	}
	if (event === "takeover" || event === "resume") return { kind: event };
	if (event === "state") {
		return state === "collapsed" || state === "expanded" || state === "minimized"
			? { kind: "state", state }
			: undefined;
	}
	const bounds = parseBounds(fields);
	return Number.isSafeInteger(displayId) && typeof displayId === "number" && displayId > 0 && bounds !== undefined
		? { kind: "created", displayId, bounds }
		: undefined;
}

export function parseSpaceRecord(value: unknown): SpaceRecord | undefined {
	const fields = fieldsOf(value);
	if (fields === undefined) return undefined;
	const { id, displayId, pid, createdAt, takenOver } = fields;
	const bounds = parseBounds(fields["bounds"]);
	if (
		typeof id !== "string" ||
		!isFiniteNumber(displayId) ||
		!isFiniteNumber(pid) ||
		typeof createdAt !== "string" ||
		typeof takenOver !== "boolean" ||
		bounds === undefined
	) {
		return undefined;
	}
	return { id, displayId, bounds, pid, createdAt, takenOver };
}

export function parseSpaceCommand(line: string): SpaceCommand | undefined {
	const command = line.trim();
	return command === "takeover" || command === "resume" || command === "stop" ? command : undefined;
}

export function spacesDirectory(stateDir: string): string {
	return join(stateDir, "spaces");
}

export function spaceRecordPath(stateDir: string, id: string): string {
	return join(spacesDirectory(stateDir), `${id}.json`);
}

export function spaceControlPath(stateDir: string, id: string): string {
	return join(spacesDirectory(stateDir), `${id}.sock`);
}

/** Writes the record atomically (temp file, then rename), like the stop switch. */
export function writeSpaceRecord(stateDir: string, record: SpaceRecord): void {
	const path = spaceRecordPath(stateDir, record.id);
	mkdirSync(spacesDirectory(stateDir), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(record)}\n`);
	renameSync(temporary, path);
}

export function removeSpaceRecord(stateDir: string, id: string): void {
	rmSync(spaceRecordPath(stateDir, id), { force: true });
	rmSync(spaceControlPath(stateDir, id), { force: true });
}

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: unknown) {
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}

/**
 * The running spaces, oldest first. A record whose helper process is gone (its owner was killed before it could
 * clean up) is removed on the way.
 */
export function listSpaces(stateDir: string, isAlive: (pid: number) => boolean = isProcessAlive): SpaceRecord[] {
	let names: string[];
	try {
		names = readdirSync(spacesDirectory(stateDir));
	} catch {
		return [];
	}
	const records: SpaceRecord[] = [];
	for (const name of names.filter((entry) => entry.endsWith(".json"))) {
		const id = name.slice(0, -".json".length);
		let record: SpaceRecord | undefined;
		try {
			record = parseSpaceRecord(parseJson(readFileSync(spaceRecordPath(stateDir, id), "utf8")));
		} catch {
			record = undefined;
		}
		if (record !== undefined && record.id === id && isAlive(record.pid)) records.push(record);
		else removeSpaceRecord(stateDir, id);
	}
	return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function sendSpaceCommand(stateDir: string, id: string, command: SpaceCommand): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const socket = createConnection(spaceControlPath(stateDir, id));
		let reply = "";
		const fail = (reason: string) => {
			socket.destroy();
			reject(new Error(`virtual space ${id}: ${reason}`));
		};
		socket.setTimeout(COMMAND_TIMEOUT_MS, () => fail("no answer from its owner"));
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			reply += chunk;
		});
		socket.on("error", (error) => fail(error.message));
		socket.on("end", () => {
			const answer = reply.trim();
			if (answer === "ok") resolve();
			else fail(answer === "" ? "no answer from its owner" : answer);
		});
		socket.end(`${command}\n`);
	});
}

/** The committed helper binary next to this package's sources (src/ and dist/ sit at the same depth). */
export function virtualSpaceBinary(): string {
	return fileURLToPath(new URL("../../native/virtual-space", import.meta.url));
}
