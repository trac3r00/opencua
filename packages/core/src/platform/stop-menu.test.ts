import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type StopMenuProcess, startStopMenu } from "./stop-menu.js";
import { StopSwitch } from "./stop-switch.js";

const nativeDirectory = fileURLToPath(new URL("../../native/", import.meta.url));
let scratch: string | undefined;
let binary: string;

async function run(
	command: readonly string[],
	env: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const child = Bun.spawn([...command], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

beforeAll(async () => {
	scratch = await mkdtemp(join(tmpdir(), "stop-menu-"));
	binary = join(scratch, "cursor-overlay-stop");
	const compiled = await run([
		"clang",
		"-fobjc-arc",
		"-Wall",
		// cursor-overlay.m keeps one pre-existing unused local in apply_set.
		"-Wno-unused-variable",
		"-Werror",
		join(nativeDirectory, "test/cursor-overlay-stop.m"),
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

describe("#given the menu bar control #when the user picks Stop then Resume #then every agent's StopSwitch follows", () => {
	it("shows Stop enabled, then after clicking it shows the stopped state with only Resume enabled, then recovers", async () => {
		if (scratch === undefined) throw new Error("missing scratch directory");
		const stateDir = join(scratch, "state");

		const result = await run([binary, "menu"], { OPENCUA_STATE_DIR: stateDir });

		expect(result).toEqual({
			exitCode: 0,
			stderr: "",
			stdout: [
				"== initial",
				"opencua agent controls|off",
				"State: agents may act|off",
				"Keyboard stop: Control+Option+Command|off",
				"---",
				"Stop all agents|on",
				"Resume agents|off",
				"== after stop (engaged)",
				"opencua agent controls|off",
				"State: all agents stopped|off",
				"Keyboard stop: Control+Option+Command|off",
				"---",
				"Stop all agents|off",
				"Resume agents|on",
				"== after resume (clear)",
				"opencua agent controls|off",
				"State: agents may act|off",
				"Keyboard stop: Control+Option+Command|off",
				"---",
				"Stop all agents|on",
				"Resume agents|off",
				"",
			].join("\n"),
		});
		expect(new StopSwitch(stateDir).status()).toEqual({ stopped: false });
	});

	it("writes a stop every agent's switch reads as a menu stop", async () => {
		if (scratch === undefined) throw new Error("missing scratch directory");
		const stateDir = join(scratch, "state-stop");
		const probe = join(scratch, "probe.m");
		await Bun.write(
			probe,
			`#import <Cocoa/Cocoa.h>\n#define main CursorOverlayMain\n#include "${join(nativeDirectory, "cursor-overlay.m")}"\n#undef main\nint main(void){@autoreleasepool{[[StopMenuTarget new] stopAll:nil];}return 0;}\n`,
		);
		const probeBinary = join(scratch, "probe");
		expect(
			(await run(["clang", "-fobjc-arc", "-Wno-unused-variable", probe, "-framework", "Cocoa", "-o", probeBinary]))
				.exitCode,
		).toBe(0);

		expect((await run([probeBinary], { OPENCUA_STATE_DIR: stateDir })).exitCode).toBe(0);

		expect(new StopSwitch(stateDir).status()).toMatchObject({
			stopped: true,
			source: "menu",
			reason: "stopped from the menu bar",
		});
	}, 60_000);
});

describe("#given a server process #when it starts the stop menu #then the helper is tied to that process", () => {
	it("launches status-only mode with the parent pid and kills it on stop", () => {
		const calls: { command: string; args: readonly string[] }[] = [];
		let killed = 0;
		const child: StopMenuProcess = {
			on: () => child,
			kill: () => {
				killed += 1;
				return true;
			},
		};

		const parents = realpathSync(mkdtempSync(join(tmpdir(), "opencua-stop-parents-")));
		writeFileSync(join(parents, "4242-111"), "");
		writeFileSync(join(parents, "5151-222"), "");
		const menu = startStopMenu(
			(command, args) => {
				calls.push({ command, args });
				return child;
			},
			"/fixture/cursor-overlay",
			4242,
			parents,
		);
		menu?.stop();

		expect(calls).toEqual([{ command: "/fixture/cursor-overlay", args: ["--status-only", "--parent", "4242"] }]);
		expect(killed).toBe(1);
		// Only this server's registration goes, so another server's menu stays.
		expect(readdirSync(parents)).toEqual(["5151-222"]);
		rmSync(parents, { recursive: true, force: true });
		expect(startStopMenu(() => child, null)).toBeUndefined();
	});
});
