import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const nativeDirectory = fileURLToPath(new URL("../../native/", import.meta.url));
let scratch: string;
let binary: string;
const supportedSettings = {
	defaultApplicationBehavior: "observe",
	defaultURLBehavior: "observe",
	observePrivateBrowsing: true,
	rules: [],
};

beforeAll(async () => {
	scratch = await mkdtemp(join(nativeDirectory, ".history-native-test-"));
	binary = join(scratch, "history-native");
	try {
		const compiler = Bun.spawn(
			[
				"clang",
				"-fobjc-arc",
				"-Wall",
				"-Wextra",
				"-Werror",
				join(nativeDirectory, "test/history-native.m"),
				"-framework",
				"AppKit",
				"-framework",
				"ApplicationServices",
				"-framework",
				"Carbon",
				"-o",
				binary,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const [exitCode, stdout, stderr] = await Promise.all([
			compiler.exited,
			new Response(compiler.stdout).text(),
			new Response(compiler.stderr).text(),
		]);
		expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "", stderr: "" });
	} catch (error) {
		await rm(scratch, { recursive: true, force: true });
		throw error;
	}
}, 30_000);

afterAll(async () => {
	if (scratch !== undefined) {
		await rm(scratch, { recursive: true, force: true });
	}
});

async function runNative(mode: string, root: string) {
	const child = Bun.spawn([binary, mode, root], {
		env: { ...process.env, OPENCUA_STATE_DIR: root },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
	expect(stdout).toMatch(/^\d+\n$/);
	return Number(stdout.trim());
}

describe("#given native retention #when pruning offline #then only expired segment directories are removed", () => {
	it("prunes expired history on the timer even while capture is paused", async () => {
		const root = await mkdtemp(join(scratch, "paused-retention-"));
		try {
			const historyRoot = join(root, "cua-history");
			const segments = join(historyRoot, "segments");
			// The offline clock is 2026-11-01T12:00Z and raw segments are kept 48 hours.
			await mkdir(join(segments, "2026-10-30T11-40-00Z"), { recursive: true });
			await mkdir(join(segments, "2026-10-30T11-50-00Z"));
			await writeFile(join(historyRoot, "state.json"), JSON.stringify({ state: "paused" }));
			await writeFile(join(historyRoot, "settings.json"), JSON.stringify(supportedSettings));

			expect(await runNative("tick", root)).toBe(0);
			expect(await readdir(segments)).toEqual(["2026-10-30T11-50-00Z"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("preserves unrelated entries and the exact retention boundary", async () => {
		const root = await mkdtemp(join(scratch, "prune-"));
		try {
			const segments = join(root, "segments");
			const keepDirectories = [
				"x",
				"2026-10-31T00-00-00Z-backup",
				"2026-02-30T00-00-00Z",
				"2026-10-30T11-50-00Z",
				"2026-10-30T12-00-00Z",
				"2026-11-01T05-40-00Z",
				"2026-11-01T12-00-00Z",
			];
			await mkdir(segments);
			for (const entry of [...keepDirectories, "2026-10-30T11-40-00Z"]) {
				await mkdir(join(segments, entry));
			}
			const keepFiles = [".DS_Store", "2026-10-31T00-00-00Z"];
			for (const entry of keepFiles) {
				await writeFile(join(segments, entry), "unrelated");
			}
			const target = join(root, "unrelated");
			await mkdir(target);
			const link = "2026-10-31T00-10-00Z";
			await symlink(target, join(segments, link));

			await runNative("prune", root);

			expect((await readdir(segments)).sort()).toEqual([...keepDirectories, ...keepFiles, link].sort());
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("#given persisted native state #when launching offline #then pause survives restart", () => {
	it.each(["paused", "running", "missing"])("preserves the %s startup contract", async (state) => {
		const root = await mkdtemp(join(scratch, "startup-"));
		try {
			const historyRoot = join(root, "cua-history");
			await mkdir(historyRoot);
			await writeFile(join(historyRoot, "settings.json"), JSON.stringify(supportedSettings));
			if (state !== "missing") {
				await writeFile(join(historyRoot, "state.json"), JSON.stringify({ state }));
			}

			await runNative("startup", root);

			const result: unknown = JSON.parse(await readFile(join(historyRoot, "state.json"), "utf8"));
			expect(result).toMatchObject({ state: state === "paused" ? "paused" : "running" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("#given unsupported native privacy rules #when starting or resuming #then capture is blocked", () => {
	it("pauses an active recorder when private-browsing exclusion is enabled", async () => {
		const root = await mkdtemp(join(scratch, "revoke-"));
		try {
			const historyRoot = join(root, "cua-history");
			await mkdir(historyRoot);
			await writeFile(join(historyRoot, "settings.json"), JSON.stringify(supportedSettings));
			await writeFile(
				join(root, "next-settings.json"),
				JSON.stringify({ ...supportedSettings, observePrivateBrowsing: false }),
			);

			expect(await runNative("revoke", root)).toBe(1);
			const state: unknown = JSON.parse(await readFile(join(historyRoot, "state.json"), "utf8"));
			expect(state).toMatchObject({
				state: "paused",
				error: "Native capture cannot enforce URL or private-browsing exclusions.",
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it.each([
		{},
		{ defaultURLBehavior: "observe", observePrivateBrowsing: false, rules: [] },
		{ defaultURLBehavior: "do_not_observe", observePrivateBrowsing: true, rules: [] },
		{
			defaultURLBehavior: "observe",
			observePrivateBrowsing: true,
			rules: [{ scope: "url", urlDomain: "example.com", behavior: "do_not_observe" }],
		},
	])("does not request an event tap for policy %j", async (settings) => {
		const root = await mkdtemp(join(scratch, "policy-"));
		try {
			const historyRoot = join(root, "cua-history");
			await mkdir(historyRoot);
			if (settings !== undefined) {
				await writeFile(join(historyRoot, "settings.json"), JSON.stringify(settings));
			}

			expect(await runNative("policy", root)).toBe(0);
			const state: unknown = JSON.parse(await readFile(join(historyRoot, "state.json"), "utf8"));
			expect(state).toMatchObject({
				state: "paused",
				error: "Native capture cannot enforce URL or private-browsing exclusions.",
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("#given a fresh install without settings #when the recorder starts #then it records right away", () => {
	it("starts capture instead of blocking on a missing policy", async () => {
		const root = await mkdtemp(join(scratch, "fresh-"));
		try {
			await mkdir(join(root, "cua-history"));

			expect(await runNative("startup", root)).toBe(1);
			const state: unknown = JSON.parse(await readFile(join(root, "cua-history", "state.json"), "utf8"));
			expect(state).toMatchObject({ state: "running" });
			expect(state).not.toHaveProperty("error");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("#given the menu's Don't record item #when an app is excluded #then only that app stops being recorded", () => {
	it("writes an app rule into fresh settings and keeps recording other apps", async () => {
		const root = await mkdtemp(join(scratch, "exclude-"));
		try {
			const child = Bun.spawn([binary, "exclude", root], { stdout: "pipe", stderr: "pipe" });
			const [exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "skip observe\n", stderr: "" });
			expect(JSON.parse(await readFile(join(root, "cua-history", "settings.json"), "utf8"))).toMatchObject({
				observePrivateBrowsing: true,
				rules: [{ scope: "app", bundleID: "com.example.Notes", behavior: "do_not_observe" }],
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("#given a recorder paused only by the old missing-settings block #when it starts again #then it resumes", () => {
	it("clears the policy hold but keeps a pause the person chose", async () => {
		for (const [stored, expected] of [
			[{ state: "paused", error: "Native capture cannot enforce URL or private-browsing exclusions." }, "running"],
			[{ state: "paused" }, "paused"],
		] as const) {
			const root = await mkdtemp(join(scratch, "hold-"));
			try {
				await mkdir(join(root, "cua-history"));
				await writeFile(join(root, "cua-history", "state.json"), JSON.stringify(stored));

				await runNative("startup", root);

				const state: unknown = JSON.parse(await readFile(join(root, "cua-history", "state.json"), "utf8"));
				expect(state).toMatchObject({ state: expected });
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		}
	});
});

describe("#given the segment being recorded was deleted #when the next event arrives #then recording continues in a fresh segment", () => {
	it("recreates the directory and counts only the events written after the delete", async () => {
		const root = await mkdtemp(join(scratch, "forget-"));
		try {
			expect(await runNative("forget-current", root)).toBe(1);
			const segmentsDir = join(root, "cua-history", "segments");
			const segments = await readdir(segmentsDir);
			expect(segments).toHaveLength(1);
			const [segment] = segments;
			const events = (await readFile(join(segmentsDir, String(segment), "events.jsonl"), "utf8")).trim().split("\n");
			const metadata: unknown = JSON.parse(
				await readFile(join(segmentsDir, String(segment), "metadata.json"), "utf8"),
			);
			expect(events).toHaveLength(1);
			expect(metadata).toMatchObject({ eventCount: 1 });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

async function runMode(mode: string, root: string): Promise<string> {
	const child = Bun.spawn([binary, mode, root], {
		env: { ...process.env, OPENCUA_STATE_DIR: root, OPENCUA_HISTORY_LAUNCHER: "/fake/opencua" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
	return stdout;
}

describe("#given the one opencua menu #when it is built #then it carries history, agent and buddy controls", () => {
	it("lists every item with its action and the clear spans", async () => {
		const root = await mkdtemp(join(scratch, "menu-"));
		try {
			expect((await runMode("menu", root)).split("\n")).toEqual([
				"cua-history recording|",
				"Don't record this app|excludeFrontApp:",
				"---",
				"Open timeline|openTimeline:",
				"Suggested skills|submenuAction:",
				"Record a skill|recordSkill:",
				"---",
				"Stop all agents|stopAgents:",
				"Resume agents|resumeAgents:",
				"Stop buddy talking|stopBuddyTalking:",
				"Buddy settings\u2026|openBuddySettings:",
				"---",
				"Pause recording|pause:",
				"Resume recording|resume:",
				"Clear history|submenuAction:",
				"  Last 10 minutes|clearHistory: 10m",
				"  Last hour|clearHistory: 1h",
				"  Last day|clearHistory: 1d",
				"  All|clearHistory: all",
				"---",
				"Reveal data folder|reveal:",
				"---",
				"Quit cua-history|quit:",
				"",
			]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("#when items are chosen #then the launcher runs disclaimed, and clear runs only after confirmation", async () => {
		const root = await mkdtemp(join(scratch, "launcher-"));
		try {
			expect((await runMode("launcher", root)).split("\n")).toEqual([
				"spawn disclaim=1 /fake/opencua history timeline --open",
				"spawn disclaim=1 /fake/opencua buddy stop",
				"spawn disclaim=1 /fake/opencua buddy settings",
				"alert Clear history from the last hour?",
				"alert Clear history from the last 10 minutes?",
				"spawn disclaim=1 /fake/opencua history clear --last 10m",
				"alert Clear all recorded history?",
				"spawn disclaim=1 /fake/opencua history clear --last all",
				"",
			]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("#given AX attribute values #when mapped to the event contract #then only labels and documents are kept", () => {
	it("bounds labels, drops role-less elements, splits files from URLs and names held modifiers", async () => {
		const root = await mkdtemp(join(scratch, "fields-"));
		try {
			const lines = (await runMode("fields", root)).trim().split("\n");
			expect(lines.slice(0, 5).map((line) => JSON.parse(line))).toEqual([
				{
					role: "AXTextField",
					title: "t".repeat(200),
					description: "Search",
					identifier: "q",
					placeholder: "Search mail",
				},
				null,
				{ path: "/Users/me/Notes/plan.txt" },
				{ url: "https://example.com/inbox?x=1" },
				null,
			]);
			expect(lines.slice(5)).toEqual(["1 1 0", '["command","shift","option","control"] ["control"]']);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("#given typed keys #when they reach the recorder #then each field's run is one keyboard.text_input", () => {
	it("coalesces runs, ends them on element change, click, idle, shortcut or a non-text key, and never writes secure fields", async () => {
		const root = await mkdtemp(join(scratch, "runs-"));
		try {
			expect(await runMode("text-runs", root)).toBe("9\n");
			const segmentsDir = join(root, "cua-history", "segments");
			const [segment] = await readdir(segmentsDir);
			const events = (await readFile(join(segmentsDir, String(segment), "events.jsonl"), "utf8"))
				.trim()
				.split("\n")
				.map((line): unknown => JSON.parse(line));
			const notes = { bundleIdentifier: "com.example.Notes", name: "Notes", processIdentifier: 4242 };
			const window = { title: "Plan", windowID: 512 };
			const body = { role: "AXTextArea", description: "Body" };
			const text = (id: number, value: string, second: number) => ({
				id,
				kind: "keyboard.text_input",
				timestamp: `2026-11-01T12:00:${String(second).padStart(2, "0")}Z`,
				app: notes,
				window,
				element: body,
				keyboard: { text: value },
			});
			expect(events).toEqual([
				{
					...text(1, "Ho!", 0),
					element: { role: "AXTextField", placeholder: "Title" },
					document: { path: "/Users/me/Notes/plan.txt" },
				},
				text(2, "ab", 10),
				text(3, "c", 10),
				{
					id: 4,
					kind: "mouse.click",
					timestamp: "2026-11-01T12:00:10Z",
					app: notes,
					window,
					element: body,
					mouse: { button: "left" },
				},
				text(5, "d", 20),
				text(6, "e", 23),
				{
					id: 7,
					kind: "keyboard.shortcut",
					timestamp: "2026-11-01T12:00:23Z",
					app: notes,
					window,
					element: body,
					keyboard: { keyEquivalent: "s", modifiers: ["command"] },
				},
				text(8, "f", 30),
				text(9, "g", 30),
			]);
			expect(JSON.stringify(events)).not.toContain("hunter2");
			expect(JSON.stringify(events)).not.toContain("secret");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
