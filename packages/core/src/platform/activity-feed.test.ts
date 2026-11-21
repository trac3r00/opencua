import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ActivityEntry, ActivityFeed, composeActivity, hudStarter } from "./activity-feed.js";

const NOW = 1_000_000;
const alive = () => true;

function entry(fields: Partial<ActivityEntry> & Pick<ActivityEntry, "source" | "state">): ActivityEntry {
	return { agent: fields.source, updatedAt: NOW, ...fields };
}

describe("composeActivity #given entries from buddy and agents", () => {
	it("#when nothing is live #then the pill is idle", () => {
		expect(
			composeActivity(
				[
					entry({ source: "buddy", state: "idle" }),
					entry({ source: "mcp-1", state: "working", ttl: 5, updatedAt: NOW - 6_000 }),
					entry({ source: "job-a", state: "working", pid: 42 }),
				],
				NOW,
				(pid) => pid !== 42,
			),
		).toEqual({ state: "idle" });
	});

	it("#when buddy is busy and an agent works #then buddy leads and the agent is on the second line", () => {
		expect(
			composeActivity(
				[
					entry({
						source: "mcp-1",
						agent: "Claude Code",
						state: "working",
						text: "clicking Export",
						ttl: 20,
						updatedAt: NOW,
					}),
					entry({ source: "buddy", state: "thinking", text: "where is export", updatedAt: NOW - 1_000 }),
				],
				NOW,
				alive,
			),
		).toEqual({ state: "thinking", text: "where is export", detail: "Claude Code · clicking Export" });
	});

	it("#when only agents work #then the newest leads with its name and the rest are counted", () => {
		expect(
			composeActivity(
				[
					entry({
						source: "mcp-1",
						agent: "Claude Code",
						state: "working",
						text: "typing in Notes",
						ttl: 20,
						updatedAt: NOW - 2_000,
					}),
					entry({
						source: "mcp-2",
						agent: "Codex",
						state: "working",
						text: "reading Safari",
						ttl: 20,
						updatedAt: NOW - 500,
					}),
					entry({ source: "mcp-3", agent: "OmO", state: "working", ttl: 20, updatedAt: NOW - 900 }),
				],
				NOW,
				alive,
			),
		).toEqual({ state: "working", text: "Codex · reading Safari", detail: "2 agents working", ttl: 19.5 });
	});

	it("#when an entry has no ttl #then the pill does not hide by itself", () => {
		const composed = composeActivity(
			[
				entry({
					source: "job-a",
					agent: "Buddy agent",
					state: "working",
					text: "desks",
					pid: 7,
					updatedAt: NOW - 100,
				}),
				entry({ source: "mcp-1", agent: "Codex", state: "working", text: "x", ttl: 3, updatedAt: NOW }),
			],
			NOW,
			alive,
		);
		expect(composed.ttl).toBeUndefined();
		expect(composed.text).toBe("Codex · x");
		expect(composed.detail).toBe("Buddy agent · desks");
	});
});

describe("ActivityFeed #given a feed folder", () => {
	let dir = "";
	afterEach(() => {
		if (dir !== "") rmSync(dir, { recursive: true, force: true });
	});

	it("#when entries are written and cleared #then current.json follows and the HUD is started only while busy", () => {
		dir = join(mkdtempSync(join(tmpdir(), "activity-feed-")), "hud");
		const started: string[] = [];
		const feed = new ActivityFeed(dir, {
			now: () => NOW,
			isAlive: alive,
			startHud: (folder) => started.push(folder),
		});
		feed.write({ source: "buddy", agent: "buddy", state: "listening", text: "Listening" });
		expect(JSON.parse(readFileSync(join(dir, "current.json"), "utf8"))).toEqual({
			state: "listening",
			text: "Listening",
		});
		feed.clear("buddy");
		expect(JSON.parse(readFileSync(join(dir, "current.json"), "utf8"))).toEqual({ state: "idle" });
		expect(started).toEqual([dir]);
	});

	it("#when a stray file sits in the folder #then it is ignored", () => {
		dir = join(mkdtempSync(join(tmpdir(), "activity-feed-")), "hud");
		const feed = new ActivityFeed(dir, { now: () => NOW, isAlive: alive });
		feed.write({ source: "a/b", agent: "Codex", state: "working", text: "x", ttl: 5 });
		writeFileSync(join(dir, "junk.json"), "{not json");
		expect(existsSync(join(dir, "a_b.json"))).toBe(true);
		expect(feed.read()).toEqual({ state: "working", text: "Codex · x", ttl: 5 });
	});
});

describe("hudStarter #given a HUD binary", () => {
	let dir = "";
	afterEach(() => {
		if (dir !== "") rmSync(dir, { recursive: true, force: true });
	});

	it("#when the recorded HUD still runs #then no second one starts; when it is gone #then one starts", () => {
		dir = mkdtempSync(join(tmpdir(), "hud-starter-"));
		const spawned: (readonly string[])[] = [];
		let running = true;
		const start = hudStarter("/bin/buddy-hud", {
			env: {},
			isAlive: () => running,
			spawn: (_binary, args) => {
				spawned.push(args);
				return { pid: 9, unref: () => undefined };
			},
		});
		writeFileSync(join(dir, ".hud.pid"), "123");
		start?.(dir);
		expect(spawned).toEqual([]);
		running = false;
		start?.(dir);
		expect(spawned).toEqual([["--status", "--feed", dir]]);
	});

	it("#when OPENCUA_HUD=off or there is no binary #then there is no starter", () => {
		expect(hudStarter("/bin/buddy-hud", { env: { OPENCUA_HUD: "off" } })).toBeUndefined();
		expect(hudStarter(undefined, { env: {} })).toBeUndefined();
	});
});
