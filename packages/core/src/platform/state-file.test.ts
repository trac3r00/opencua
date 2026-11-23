import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trustedStateFile } from "./state-file.js";

let directory: string;
let file: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "opencua-state-file-"));
	file = join(directory, "state.json");
	writeFileSync(file, "{}\n", { mode: 0o600 });
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

describe("#given a state file opencua takes decisions from #when its trust is checked", () => {
	it("#given a private file this user owns #then it is trusted and its stat comes back", () => {
		expect(trustedStateFile(file)?.size).toBe(3);
	});

	it("#given a file others may read but only this user may write #then it is trusted", () => {
		chmodSync(file, 0o644);

		expect(trustedStateFile(file)).toBeDefined();
	});

	it.each([
		["0620", 0o620],
		["0602", 0o602],
		["0666", 0o666],
	])("#given mode %s, writable by the group or everyone #then it is not trusted", (_, mode) => {
		chmodSync(file, mode);

		expect(trustedStateFile(file)).toBeUndefined();
	});

	it("#given a file another user owns #then it is not trusted", () => {
		const own = process.getuid?.();
		if (own === undefined) throw new Error("this test needs POSIX ownership");

		expect(trustedStateFile(file, own + 1)).toBeUndefined();
	});

	it("#given a symlink, a directory or nothing at the path #then it is not trusted", () => {
		const link = join(directory, "link.json");
		symlinkSync(file, link);
		const folder = join(directory, "folder.json");
		mkdirSync(folder);

		expect(trustedStateFile(link)).toBeUndefined();
		expect(trustedStateFile(folder)).toBeUndefined();
		expect(trustedStateFile(join(directory, "missing.json"))).toBeUndefined();
	});
});
