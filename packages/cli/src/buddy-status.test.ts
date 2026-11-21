import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActivityFeed } from "@opencua/core/light";
import { BuddyStatus } from "./buddy-status.js";

describe("BuddyStatus #given the activity feed", () => {
	let root = "";
	afterEach(() => {
		if (root !== "") rmSync(root, { recursive: true, force: true });
	});

	it("#when buddy moves through a question #then its entry and the pill follow, and close clears it", () => {
		root = mkdtempSync(join(tmpdir(), "buddy-status-"));
		const dir = join(root, "hud");
		const started: string[] = [];
		const status = new BuddyStatus(new ActivityFeed(dir, { startHud: (folder) => started.push(folder) }));
		status.set({ state: "listening", text: "Listening" });
		status.set({ state: "error", text: "Didn't catch that.", ttl: 6 });
		expect(status.current.state).toBe("error");
		const entry = JSON.parse(readFileSync(join(dir, "buddy.json"), "utf8")) as Record<string, unknown>;
		expect(entry).toMatchObject({
			source: "buddy",
			state: "error",
			text: "Didn't catch that.",
			ttl: 6,
			pid: process.pid,
		});
		expect(JSON.parse(readFileSync(join(dir, "current.json"), "utf8"))).toMatchObject({ state: "error", ttl: 6 });
		status.close();
		expect(JSON.parse(readFileSync(join(dir, "current.json"), "utf8"))).toEqual({ state: "idle" });
		expect(started.length).toBeGreaterThan(0);
	});

	it("#when the feed cannot be written #then buddy keeps going", () => {
		root = mkdtempSync(join(tmpdir(), "buddy-status-"));
		const status = new BuddyStatus(new ActivityFeed(join("/dev/null", "hud")));
		expect(() => status.set({ state: "thinking" })).not.toThrow();
		expect(status.current.state).toBe("thinking");
	});
});
