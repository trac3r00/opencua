import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type SpaceCommand,
	type SpaceHelperEvent,
	type SpaceRecord,
	listSpaces,
	parseSpaceCommand,
	parseSpaceHelperLine,
	parseSpaceRecord,
	spaceRecordPath,
	writeSpaceRecord,
} from "./virtual-space.js";

const record: SpaceRecord = {
	id: "a1b2c3d4",
	displayId: 7,
	bounds: { x: 3008, y: 0, width: 1920, height: 1080 },
	pid: 4242,
	createdAt: "2026-11-21T09:00:00.000Z",
	takenOver: false,
};

const HELPER_LINES: readonly (readonly [string, SpaceHelperEvent])[] = [
	[
		'{"displayId":7,"width":1920,"height":1080,"x":3008,"y":0}',
		{ kind: "created", displayId: 7, bounds: { x: 3008, y: 0, width: 1920, height: 1080 } },
	],
	['{"event":"takeover"}', { kind: "takeover" }],
	['{"event":"resume"}', { kind: "resume" }],
	['{"event":"state","state":"minimized"}', { kind: "state", state: "minimized" }],
	[
		'{"error":"unsupported","message":"no CGVirtualDisplay"}',
		{ kind: "failed", error: "unsupported", message: "no CGVirtualDisplay" },
	],
];

const CONTROL_LINES: readonly (readonly [string, SpaceCommand | undefined])[] = [
	["takeover\n", "takeover"],
	[" resume ", "resume"],
	["stop", "stop"],
	["quit", undefined],
];

describe("#given helper stdout lines #when parsed #then each protocol message maps to one event", () => {
	it.each(HELPER_LINES)("parses %s", (line, event) => {
		expect(parseSpaceHelperLine(line)).toEqual(event);
	});

	it.each([
		"not json",
		"[]",
		'{"event":"state","state":"fullscreen"}',
		'{"displayId":0,"width":1920,"height":1080,"x":0,"y":0}',
		'{"displayId":7,"width":0,"height":1080,"x":0,"y":0}',
		'{"event":"wave"}',
	])("ignores %s", (line) => {
		expect(parseSpaceHelperLine(line)).toBeUndefined();
	});
});

describe("#given a space record or control line #when parsed #then only well-formed values pass", () => {
	it("round-trips a record through JSON", () => {
		expect(parseSpaceRecord(JSON.parse(JSON.stringify(record)))).toEqual(record);
	});

	it.each([
		["a missing id", { ...record, id: undefined }],
		["a non-boolean takenOver", { ...record, takenOver: "yes" }],
		["empty bounds", { ...record, bounds: { x: 0, y: 0, width: 0, height: 0 } }],
	])("rejects %s", (_label, value) => {
		expect(parseSpaceRecord(value)).toBeUndefined();
	});

	it.each(CONTROL_LINES)("reads control line %j as %j", (line, command) => {
		expect(parseSpaceCommand(line)).toBe(command);
	});
});

describe("#given space records on disk #when listed #then records of gone helpers are dropped and deleted", () => {
	const directories: string[] = [];
	afterEach(() => {
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	it("returns live spaces oldest first and removes the stale record", () => {
		const stateDir = mkdtempSync(join(tmpdir(), "opencua-spaces-"));
		directories.push(stateDir);
		const newer = { ...record, id: "newer001", pid: 11, createdAt: "2026-11-21T10:00:00.000Z" };
		const stale = { ...record, id: "stale001", pid: 12 };
		writeSpaceRecord(stateDir, newer);
		writeSpaceRecord(stateDir, record);
		writeSpaceRecord(stateDir, stale);
		writeFileSync(spaceRecordPath(stateDir, "garbage1"), "{");

		const spaces = listSpaces(stateDir, (pid) => pid !== stale.pid);

		expect(spaces.map((space) => space.id)).toEqual([record.id, newer.id]);
		expect(existsSync(spaceRecordPath(stateDir, stale.id))).toBe(false);
		expect(existsSync(spaceRecordPath(stateDir, "garbage1"))).toBe(false);
	});

	it("lists nothing when no space ever ran", () => {
		expect(listSpaces(join(tmpdir(), "opencua-spaces-never-created"))).toEqual([]);
	});
});
