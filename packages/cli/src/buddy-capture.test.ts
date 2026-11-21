import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BuddyCommandDeps, CaptureUnavailable, askAboutScreen, daemonCapture } from "./buddy-commands.js";
import { DEFAULT_BUDDY_SETTINGS, writeBuddySettings } from "./buddy-settings.js";
import { runDaemon } from "./daemon.js";

const roots: string[] = [];
function scratch(): string {
	const root = mkdtempSync(join(tmpdir(), "buddy-capture-"));
	roots.push(root);
	return root;
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

function deps(stateDir: string): BuddyCommandDeps {
	return {
		isJsonOutput: () => true,
		stateDir,
		entryScript: "",
		withComputer: async () => {
			throw new Error("the in-process computer must not be used");
		},
		overlay: async () => {
			throw new Error("no overlay");
		},
	};
}

describe("daemonCapture #given the warm opencua daemon", () => {
	it("#when a question needs the screen #then one screenshot and the screen size come from the daemon", async () => {
		const state = scratch();
		const folder = scratch();
		const seen: string[][] = [];
		const daemon = await runDaemon(state, async (request) => {
			seen.push([...request.argv]);
			if (request.argv[1] === "screen") return { stdout: '{"width":1440,"height":900}', stderr: "", exitCode: 0 };
			const output = request.argv[request.argv.indexOf("-o") + 1] ?? "";
			writeFileSync(output, JPEG);
			return { stdout: '{"mimeType":"image/jpeg","width":1440,"height":900}', stderr: "", exitCode: 0 };
		});
		try {
			const captured = await daemonCapture(state, {})(folder);
			expect(captured.screen).toEqual({ width: 1440, height: 900 });
			expect(captured.image).toMatchObject({ mimeType: "image/jpeg", width: 1440, height: 900 });
			expect([...captured.image.data]).toEqual([...JPEG]);
			expect(seen.sort()).toEqual([
				["--json", "screen"],
				["--json", "screenshot", "-f", "jpeg", "-q", "85", "-o", join(folder, "screen.jpg")],
			]);
		} finally {
			daemon.stop();
			await daemon.closed;
		}
	});

	it("#when the daemon refuses #then its reason is the error; when none runs #then the slower path is signalled", async () => {
		const state = scratch();
		const daemon = await runDaemon(state, async () => ({
			stdout: "",
			stderr: "Screen Recording permission is not granted\n",
			exitCode: 1,
		}));
		try {
			await expect(daemonCapture(state, {})(scratch())).rejects.toThrow(
				"Screen Recording permission is not granted",
			);
		} finally {
			daemon.stop();
			await daemon.closed;
		}
		await expect(daemonCapture(scratch(), {})(scratch())).rejects.toBeInstanceOf(CaptureUnavailable);
	});
});

describe("askAboutScreen #given the person talks over buddy while the agent works", () => {
	it("#when the question is aborted #then the agent process is stopped and no answer is given", async () => {
		const state = scratch();
		// The stub agent writes to a named pipe once it runs; reading the pipe waits for exactly that, with no timing.
		const pipe = join(scratch(), "started");
		execFileSync("mkfifo", [pipe]);
		const agent = join(scratch(), "slow-agent.sh");
		writeFileSync(agent, `#!/bin/sh\necho started > "${pipe}"\nexec sleep 30\n`);
		chmodSync(agent, 0o755);
		writeBuddySettings(state, { ...DEFAULT_BUDDY_SETTINGS, agent });
		const abort = new AbortController();
		const started = readFile(pipe, "utf8");
		const asking = askAboutScreen(
			"what is this?",
			{
				voice: false,
				point: false,
				signal: abort.signal,
				capture: async () => ({
					image: { data: JPEG, mimeType: "image/jpeg", width: 1440, height: 900 },
					screen: { width: 1440, height: 900 },
				}),
			},
			{ ...deps(state) },
		);
		await started;
		const begun = performance.now();
		abort.abort();
		await expect(asking).rejects.toThrow("aborted");
		expect(performance.now() - begun).toBeLessThan(5_000);
	});
});
