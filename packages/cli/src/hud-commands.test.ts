import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActivityFeed } from "@opencua/core/light";
import { Command } from "commander";
import { registerHudCommands, sourceFor } from "./hud-commands.js";

function program(feed: ActivityFeed): Command {
	const root = new Command().exitOverride();
	registerHudCommands(root, { isJsonOutput: () => true, feed: () => feed });
	return root;
}

describe("opencua hud #given a feed folder", () => {
	let root = "";
	afterEach(() => {
		if (root !== "") rmSync(root, { recursive: true, force: true });
	});

	it("#when a hook sets and clears Claude Code's line #then the pill shows it and then goes idle", async () => {
		root = mkdtempSync(join(tmpdir(), "hud-commands-"));
		const feed = new ActivityFeed(join(root, "hud"));
		const output = spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			await program(feed).parseAsync(
				["hud", "set", "thinking", "planning", "the", "fix", "--agent", "Claude Code"],
				{
					from: "user",
				},
			);
			expect(feed.read()).toMatchObject({ state: "thinking", text: "Claude Code · planning the fix", ttl: 600 });
			await program(feed).parseAsync(["hud", "clear", "--agent", "Claude Code"], { from: "user" });
			expect(feed.read()).toEqual({ state: "idle" });
		} finally {
			output.mockRestore();
		}
	});

	it("#when the state is not one the pill knows #then it is refused", async () => {
		root = mkdtempSync(join(tmpdir(), "hud-commands-"));
		const feed = new ActivityFeed(join(root, "hud"));
		await expect(program(feed).parseAsync(["hud", "set", "napping"], { from: "user" })).rejects.toThrow(
			/Unknown state/,
		);
	});

	it("#when agent names have spaces or Hangul #then the line id stays one stable word", () => {
		expect(sourceFor("Claude Code")).toBe("agent-claude-code");
		expect(sourceFor("내 에이전트")).toBe("agent-내-에이전트");
	});
});
