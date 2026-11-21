import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const nativeDirectory = fileURLToPath(new URL("../../../native/", import.meta.url));
let scratch: string | undefined;
let binary: string;

async function run(command: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const child = Bun.spawn([...command], { stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

beforeAll(async () => {
	scratch = await mkdtemp(join(tmpdir(), "cursor-overlay-stack-"));
	binary = join(scratch, "cursor-overlay-stack");
	const compiled = await run([
		"clang",
		"-fobjc-arc",
		"-Wall",
		// cursor-overlay.m keeps one pre-existing unused local in apply_set.
		"-Wno-unused-variable",
		"-Werror",
		join(nativeDirectory, "test/cursor-overlay-stack.m"),
		"-framework",
		"Cocoa",
		"-o",
		binary,
	]);
	expect(compiled).toEqual({ exitCode: 0, stdout: "", stderr: "" });
}, 60_000);

afterAll(async () => {
	if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
});

describe("#given a background cursor marker #when choosing where to stack it #then it sits only above its own app", () => {
	it("stacks above the target window that holds the marker, and hides a frame whose window closed", async () => {
		const result = await run([binary]);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(
			Object.fromEntries(
				result.stdout
					.trim()
					.split("\n")
					.map((line) => line.split("=")),
			),
		).toEqual({
			"cursor-dialog": "7",
			"cursor-main": "8",
			"cursor-side": "11",
			"cursor-outside": "7",
			"frame-main": "8",
			"frame-closed": "0",
			absent: "0",
			"user-front": "5",
			empty: "0",
			"zero-pid": "0",
			malformed: "9",
		});
	});
});
