import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type WindowLease, readLeases, writeLeases } from "@opencua/core/light";
import { Command } from "commander";
import { resolveLease } from "../../core/src/computer/window-lease.js";
import { type LeaseHost, registerLeaseCommands } from "./lease-commands.js";

const NOW = Date.parse("2026-11-23T10:00:00.000Z");
const MINUTE = 60_000;
const startedAt = (pid: number): string => `1795400000.${pid}`;

/** TextEdit has one window; Notes has two; pid 6000 is listed but its process is already gone. */
const host: LeaseHost = {
	apps: () => [
		{ name: "TextEdit", bundleId: "com.apple.TextEdit", pid: 4242 },
		{ name: "Notes", bundleId: "com.apple.Notes", pid: 5151 },
		{ name: "Ghost", bundleId: "com.example.ghost", pid: 6000 },
	],
	windows: async (pid) =>
		pid === 4242
			? [{ id: 77, title: "Untitled" }]
			: pid === 5151
				? [
						{ id: 90, title: "Groceries" },
						{ id: 91, title: "Ideas" },
					]
				: [],
	startTime: (pid) => (pid === 4242 || pid === 5151 ? startedAt(pid) : undefined),
};

let stateDir: string;
let json: boolean;
let nextId: number;

beforeEach(() => {
	stateDir = mkdtempSync(join(tmpdir(), "opencua-lease-cli-"));
	json = false;
	nextId = 1;
});

afterEach(() => {
	rmSync(stateDir, { recursive: true, force: true });
});

async function lease(...args: readonly string[]): Promise<string> {
	const written: string[] = [];
	const program = new Command().exitOverride();
	registerLeaseCommands(program, {
		isJsonOutput: () => json,
		stateDir: () => stateDir,
		now: () => new Date(NOW),
		host: async () => host,
		newId: () => `L-test${nextId++}`,
		write: (text) => written.push(text),
	});
	await program.parseAsync(["lease", ...args], { from: "user" });
	return written.join("");
}

const grant = (...extra: readonly string[]): Promise<string> =>
	lease("grant", "--holder", "qa", "--app", "com.apple.TextEdit", "--tools", "click,type", ...extra);

function auditEvents(): readonly Record<string, unknown>[] {
	const directory = join(stateDir, "audit");
	return readdirSync(directory).flatMap((name) =>
		readFileSync(join(directory, name), "utf8")
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as Record<string, unknown>),
	);
}

function stored(overrides: Partial<WindowLease>): WindowLease {
	return {
		id: "L-old",
		holder: "qa",
		target: { bundleId: "com.apple.TextEdit", pid: 4242, startedAt: startedAt(4242), windowId: 77 },
		tools: ["click"],
		grantedAt: new Date(NOW - 20 * MINUTE).toISOString(),
		expiresAt: new Date(NOW + 10 * MINUTE).toISOString(),
		grantedBy: "cli",
		...overrides,
	};
}

describe("opencua lease grant #given a running app with one window", () => {
	it("#when the person grants it #then the lease on disk names the resolved process and window for 30 minutes", async () => {
		const output = await grant();

		expect(readLeases(stateDir)).toEqual([
			{
				id: "L-test1",
				holder: "qa",
				target: { bundleId: "com.apple.TextEdit", pid: 4242, startedAt: startedAt(4242), windowId: 77 },
				tools: ["click", "type"],
				grantedAt: new Date(NOW).toISOString(),
				expiresAt: new Date(NOW + 30 * MINUTE).toISOString(),
				grantedBy: "cli",
			},
		]);
		expect(statSync(join(stateDir, "leases.json")).mode & 0o777).toBe(0o600);
		expect(output).toContain("L-test1");
	});

	it("#when the grant is written #then the server's own check accepts it for that holder, window and tool only", async () => {
		await grant();
		const probes = { now: NOW + MINUTE, startTime: startedAt, windowOwner: () => 4242 };

		const leases = readLeases(stateDir);

		expect(resolveLease(leases, "qa", { pid: 4242, windowId: 77 }, "type", probes)).toMatchObject({
			lease: { id: "L-test1" },
		});
		expect(resolveLease(leases, "qa", { pid: 4242, windowId: 77 }, "drag", probes)).toMatchObject({
			code: "lease-tool-forbidden",
		});
		expect(resolveLease(leases, "codex", { pid: 4242, windowId: 77 }, "type", probes)).toMatchObject({
			code: "lease-required",
		});
	});

	it("#when it is granted #then the grant is in the audit log", async () => {
		await grant();

		expect(auditEvents()).toEqual([
			expect.objectContaining({
				event: "grant",
				leaseId: "L-test1",
				holder: "qa",
				pid: 4242,
				bundleId: "com.apple.TextEdit",
				windowId: 77,
				by: "cli",
			}),
		]);
	});

	it("#when json output is asked #then the lease itself is printed", async () => {
		json = true;

		expect(JSON.parse(await grant())).toMatchObject({ id: "L-test1", target: { windowId: 77 } });
	});

	it.each([
		["45s", 45_000],
		["90m", 90 * MINUTE],
		["8h", 8 * 60 * MINUTE],
	])("#when --for %s is given #then the lease lasts that long", async (duration, milliseconds) => {
		await grant("--for", duration);

		expect(readLeases(stateDir)[0]?.expiresAt).toBe(new Date(NOW + milliseconds).toISOString());
	});

	it.each(["9h", "0m", "soon", "30"])("#when --for %s is given #then nothing is granted", async (duration) => {
		await expect(grant("--for", duration)).rejects.toThrow(/--for/);
		expect(readLeases(stateDir)).toEqual([]);
	});

	it.each(["TextEdit", "textedit", "4242"])(
		"#when the app is named as %s #then the same process is leased",
		async (app) => {
			await lease("grant", "--holder", "qa", "--app", app, "--tools", "click");

			expect(readLeases(stateDir)[0]?.target).toMatchObject({ bundleId: "com.apple.TextEdit", pid: 4242 });
		},
	);

	it("#when a tool is repeated #then it is listed once", async () => {
		await lease("grant", "--holder", "qa", "--app", "TextEdit", "--tools", "click, click,key");

		expect(readLeases(stateDir)[0]?.tools).toEqual(["click", "key"]);
	});

	it("#when script and terminal are granted #then the lease lists them", async () => {
		await lease("grant", "--holder", "qa", "--app", "TextEdit", "--tools", "script,terminal");

		expect(readLeases(stateDir)[0]?.tools).toEqual(["script", "terminal"]);
	});
});

describe("opencua lease grant #given a request that cannot be a lease #when it is run #then nothing is written", () => {
	it.each([
		["an app that is not running", ["--holder", "qa", "--app", "com.apple.Safari", "--tools", "click"], /Safari/],
		[
			"a process that already exited",
			["--holder", "qa", "--app", "com.example.ghost", "--tools", "click"],
			/running/,
		],
		["a tool that does not exist", ["--holder", "qa", "--app", "TextEdit", "--tools", "click,paste"], /paste/],
		["capture, which is not enforced", ["--holder", "qa", "--app", "TextEdit", "--tools", "capture"], /capture/],
		["no tools at all", ["--holder", "qa", "--app", "TextEdit", "--tools", " , "], /--tools/],
		["a holder with a control character", ["--holder", "q\na", "--app", "TextEdit", "--tools", "click"], /--holder/],
		["a window of another app", ["--holder", "qa", "--app", "TextEdit", "--window", "90", "--tools", "click"], /90/],
	])("#given %s", async (_, args, message) => {
		await expect(lease("grant", ...args)).rejects.toThrow(message);
		expect(readLeases(stateDir)).toEqual([]);
	});
});

describe("opencua lease grant #given an app with several windows", () => {
	const notes = (...extra: readonly string[]): Promise<string> =>
		lease("grant", "--holder", "qa", "--app", "com.apple.Notes", "--tools", "click", ...extra);

	it("#when no window is named #then it refuses and lists the windows to choose from", async () => {
		await expect(notes()).rejects.toThrow(/90.*91/s);
		expect(readLeases(stateDir)).toEqual([]);
	});

	it.each([
		["91", 91],
		["ideas", 91],
		["Groc", 90],
	])("#when --window %s is given #then that window is leased", async (window, id) => {
		await notes("--window", window);

		expect(readLeases(stateDir)[0]?.target.windowId).toBe(id);
	});

	it("#when a title matches no window #then it refuses", async () => {
		await expect(notes("--window", "Recipes")).rejects.toThrow(/Recipes/);
	});
});

describe("opencua lease list and revoke #given leases on disk", () => {
	const live = stored({ id: "L-live" });
	const other = stored({ id: "L-other", holder: "codex" });
	const expired = stored({ id: "L-gone", expiresAt: new Date(NOW - MINUTE).toISOString() });

	beforeEach(() => {
		writeLeases(stateDir, [live, other, expired]);
	});

	it("#when listed #then expired leases are left out unless --all asks for them", async () => {
		json = true;

		expect((JSON.parse(await lease("list")) as WindowLease[]).map((entry) => entry.id)).toEqual([
			"L-live",
			"L-other",
		]);
		expect((JSON.parse(await lease("list", "--all")) as WindowLease[]).map((entry) => entry.id)).toEqual([
			"L-live",
			"L-other",
			"L-gone",
		]);
	});

	it("#when listed as text #then each lease is one line with its id", async () => {
		const lines = (await lease("list")).trimEnd().split("\n");

		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("L-live");
		expect(lines[1]).toContain("L-other");
	});

	it("#when a new lease is granted #then expired ones are dropped and live ones kept", async () => {
		await grant();

		expect(readLeases(stateDir).map((entry) => entry.id)).toEqual(["L-live", "L-other", "L-test1"]);
	});

	it("#when one is revoked by id #then only it is removed, and the revocation is audited", async () => {
		await lease("revoke", "L-live");

		expect(readLeases(stateDir).map((entry) => entry.id)).toEqual(["L-other", "L-gone"]);
		expect(auditEvents()).toEqual([expect.objectContaining({ event: "revoke", leaseId: "L-live", by: "cli" })]);
	});

	it("#when --all is revoked #then no lease is left and each revocation is audited", async () => {
		await lease("revoke", "--all");

		expect(readLeases(stateDir)).toEqual([]);
		expect(auditEvents().map((entry) => entry["leaseId"])).toEqual(["L-live", "L-other", "L-gone"]);
	});

	it("#when an unknown id, or neither an id nor --all, is given #then nothing changes", async () => {
		await expect(lease("revoke", "L-nope")).rejects.toThrow(/L-nope/);
		await expect(lease("revoke")).rejects.toThrow(/--all/);
		expect(readLeases(stateDir)).toHaveLength(3);
	});
});

describe("opencua lease list #given no leases", () => {
	it("#when listed as json #then the list is empty", async () => {
		json = true;

		expect(JSON.parse(await lease("list"))).toEqual([]);
	});
});
