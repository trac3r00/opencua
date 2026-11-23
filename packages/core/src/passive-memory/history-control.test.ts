import { describe, expect, it } from "bun:test";

import {
	type HistoryControlFs,
	historyPaths,
	readHistorySettings,
	readHistoryState,
	writeHistorySettings,
	writeHistoryState,
} from "./history-control.js";

function memoryFs(): HistoryControlFs & { files: Map<string, string> } {
	const files = new Map<string, string>();
	return {
		files,
		exists: (path) => files.has(path),
		readText: (path) => files.get(path),
		writeText: (path, text) => {
			files.set(path, text);
		},
		ensureDir: () => {},
	};
}

const paths = historyPaths("/state");

describe("#given no state file #when reading history state #then it defaults to stopped", () => {
	it("returns stopped when state.json is absent", () => {
		expect(readHistoryState(paths, memoryFs())).toBe("stopped");
	});
});

describe("#given a written state #when read back #then it round-trips", () => {
	it("writes and reads paused", () => {
		const fs = memoryFs();
		writeHistoryState(paths, "paused", fs);
		expect(readHistoryState(paths, fs)).toBe("paused");
		expect(fs.files.has("/state/cua-history/state.json")).toBe(true);
	});
});

describe("#given no settings file #when reading settings #then it defaults to observe-all", () => {
	it("returns the default observation settings", () => {
		const settings = readHistorySettings(paths, memoryFs());
		expect(settings.defaultApplicationBehavior).toBe("observe");
		expect(settings.rules).toEqual([]);
	});
});

describe("#given written settings with a malformed rule #when read back #then valid rules survive and junk is dropped", () => {
	it("normalizes rules and ignores invalid entries", () => {
		const fs = memoryFs();
		writeHistorySettings(
			paths,
			{
				defaultApplicationBehavior: "do_not_observe",
				defaultURLBehavior: "observe",
				observePrivateBrowsing: false,
				rules: [{ scope: "app", bundleID: "com.apple.Terminal", behavior: "observe" }],
			},
			fs,
		);
		fs.files.set(
			"/state/cua-history/settings.json",
			JSON.stringify({
				defaultApplicationBehavior: "do_not_observe",
				rules: [
					{ scope: "app", bundleID: "com.apple.Terminal", behavior: "observe" },
					{ scope: "folder", bundleID: "bad" },
					{ scope: "url", urlDomain: "example.com", behavior: "do_not_observe" },
				],
			}),
		);

		const settings = readHistorySettings(paths, fs);
		expect(settings.defaultApplicationBehavior).toBe("do_not_observe");
		expect(settings.rules).toEqual([
			{ scope: "app", bundleID: "com.apple.Terminal", behavior: "observe" },
			{ scope: "url", urlDomain: "example.com", behavior: "do_not_observe" },
		]);
	});
});

describe("#given a settings file with a raw retention #when settings are written #then the retention is kept", () => {
	it("keeps rawRetentionHours that the observation settings do not model", () => {
		const fs = memoryFs();
		fs.files.set("/state/cua-history/settings.json", JSON.stringify({ rawRetentionHours: 12 }));
		writeHistorySettings(
			paths,
			{
				defaultApplicationBehavior: "observe",
				defaultURLBehavior: "observe",
				observePrivateBrowsing: true,
				rules: [],
			},
			fs,
		);
		expect(JSON.parse(fs.files.get("/state/cua-history/settings.json") ?? "{}")).toMatchObject({
			rawRetentionHours: 12,
			defaultApplicationBehavior: "observe",
		});
	});
});
