import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseRulesProfile, rulesForApp, rulesProfileLoader, rulesProfilePath } from "./rules-profile.js";

describe("#given a rules profile #when parsed #then only speed and verification rules are accepted", () => {
	it("reads per-app rules over the default, matching name or bundle id without case", () => {
		const profile = parseRulesProfile({
			default: { pace: "verified" },
			apps: { "Google Chrome": { pace: "fast" }, "com.apple.MobileSMS": { pace: "fast" } },
		});

		expect(rulesForApp(profile, { name: "google chrome" })).toEqual({ pace: "fast" });
		expect(rulesForApp(profile, { name: "Messages", bundleId: "com.apple.mobilesms" })).toEqual({ pace: "fast" });
		expect(rulesForApp(profile, { name: "Finder" })).toEqual({ pace: "verified" });
	});

	it("refuses rules that protect the person, naming why", () => {
		expect(() => parseRulesProfile({ apps: { Safari: { delivery: "attended" } } })).toThrow(
			/apps\.Safari\.delivery protects the person's desktop/,
		);
		expect(() => parseRulesProfile({ allowedApps: ["Safari"] })).toThrow(/allowedApps protects the person's desktop/);
	});

	it("refuses unknown rules and malformed values with their path", () => {
		expect(() => parseRulesProfile({ default: { speed: "max" } })).toThrow(/default\.speed is not a rule/);
		expect(() => parseRulesProfile({ default: { pace: "turbo" } })).toThrow(/default\.pace is "verified" or "fast"/);
		expect(() => parseRulesProfile({ apps: { Safari: { cursor: "jump" } } })).toThrow(
			/apps\.Safari\.cursor is not a rule/,
		);
	});
});

describe("#given a rules file #when it is edited #then the next read applies it", () => {
	let directory: string | undefined;

	afterEach(() => {
		if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
		directory = undefined;
	});

	it("reloads on change, treats a missing file as no rules and reports a broken one", () => {
		directory = mkdtempSync(join(tmpdir(), "opencua-rules-"));
		const path = join(directory, "rules.json");
		const reports: string[] = [];
		const load = rulesProfileLoader(path, (message) => reports.push(message));

		expect(load()).toEqual({ default: {}, apps: {} });
		writeFileSync(path, JSON.stringify({ default: { pace: "fast" } }));
		utimesSync(path, 1, 1);
		expect(load().default).toEqual({ pace: "fast" });
		writeFileSync(path, JSON.stringify({ default: { delivery: "attended" } }));
		utimesSync(path, 2, 2);
		expect(load()).toEqual({ default: {}, apps: {} });
		expect(reports).toHaveLength(1);
		expect(reports[0]).toMatch(/default\.delivery protects/);
	});

	it("uses OPENCUA_RULES when set and ~/.opencua/rules.json otherwise", () => {
		expect(rulesProfilePath({ OPENCUA_RULES: "/tmp/x.json" })).toBe("/tmp/x.json");
		expect(rulesProfilePath({})).toMatch(/\.opencua\/rules\.json$/);
	});
});
