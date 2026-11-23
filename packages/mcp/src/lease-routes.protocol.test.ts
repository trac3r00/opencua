import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppOpenLauncher, DockSnapshot, HostCapabilities, MenuExtraSnapshot, WindowLease } from "@opencua/core";
import { writeLeases } from "@opencua/core";
import { vi } from "@opencua/test-support";
import type { OsascriptRunner } from "./applescript-session.js";
import type { WindowLeaseOptions } from "./lease-gate.js";
import { createHarness, jsonPayload, jsonText } from "./protocol-client-harness.js";
import { FakeGuardedComputer } from "./protocol-test-harness.js";

// Finder runs as 1234 with window 71, Terminal as 2222 with window 81; nothing else runs.
const NOW = Date.parse("2026-11-23T10:00:00.000Z");
const STARTED = "1795400000.500";
const FINDER = { bundleId: "com.apple.finder", pid: 1234, startedAt: STARTED, windowId: 71 };
const TERMINAL = { bundleId: "com.apple.Terminal", pid: 2222, startedAt: STARTED, windowId: 81 };

function lease(overrides: Partial<WindowLease> = {}): WindowLease {
	return {
		id: "L-1",
		holder: "qa",
		target: FINDER,
		tools: ["script"],
		grantedAt: new Date(NOW - 60_000).toISOString(),
		expiresAt: new Date(NOW + 30 * 60_000).toISOString(),
		grantedBy: "cli",
		...overrides,
	};
}

let stateDir: string;
let closeHarness: (() => Promise<void>) | undefined;

beforeEach(() => {
	stateDir = mkdtempSync(join(tmpdir(), "opencua-lease-routes-"));
	// The default host: no app restriction, so only the lease decides.
	vi.stubEnv("OPENCUA_ALLOWED_BUNDLE_IDS", undefined);
});

afterEach(async () => {
	await closeHarness?.();
	closeHarness = undefined;
	vi.unstubAllEnvs();
	rmSync(stateDir, { recursive: true, force: true });
});

function gate(): WindowLeaseOptions {
	return {
		holder: "qa",
		stateDir,
		probes: () => ({
			now: NOW,
			startTime: (pid) => (pid === FINDER.pid || pid === TERMINAL.pid ? STARTED : undefined),
			windowOwner: (windowId) =>
				windowId === FINDER.windowId ? FINDER.pid : windowId === TERMINAL.windowId ? TERMINAL.pid : undefined,
		}),
		owned: () => false,
		apps: () => [
			{ name: "Finder", bundleId: FINDER.bundleId, pid: FINDER.pid },
			{ name: "Terminal", bundleId: TERMINAL.bundleId, pid: TERMINAL.pid },
		],
	};
}

const host: HostCapabilities = {
	permissions: { accessibility: true, screenRecording: false },
	session: { screenLocked: false, onConsole: true },
	mainDisplay: { logical: { width: 1, height: 1 }, pixels: { width: 1, height: 1 } },
};

const element = { value: null, children: [], frame: { x: 0, y: 0, width: 10, height: 10 } };

/** A server on attended delivery with fake Dock, Terminal, osascript, menu extras and launcher; leases as given. */
async function server(windowLeases: WindowLeaseOptions | undefined) {
	const scripts: string[] = [];
	const commands: string[] = [];
	const dock: string[] = [];
	const extras: number[] = [];
	const launched: string[] = [];
	let generation = 0;
	const dockSnapshot = (): DockSnapshot => ({
		pid: 4242,
		observationKey: `dock:${generation}`,
		elements: [
			{ ...element, id: 3, role: "AXDockItem", label: "Finder", actions: ["AXPress", "AXShowMenu", "AXCancel"] },
			{ ...element, id: 5, role: "AXMenuItem", label: "Quit", actions: ["AXPress"] },
		],
		truncated: false,
	});
	const extrasSnapshot: MenuExtraSnapshot = {
		pid: 9001,
		observationKey: "extras:1",
		items: [{ ...element, id: 17, role: "AXStatusBarItem", label: "Wi-Fi", actions: ["AXPress"] }],
		truncated: false,
	};
	const runner: OsascriptRunner = async (source) => {
		scripts.push(source);
		return { exitCode: 0, stdout: "ok\n", stderr: "", timedOut: false };
	};
	const launcher: AppOpenLauncher = {
		background: false,
		launch: async (target) => {
			launched.push(target);
		},
	};
	const computer = new FakeGuardedComputer();
	computer.delivery = "attended";
	const harness = await createHarness(computer, undefined, launcher, {
		serverOptions: {
			toolset: "full",
			...(windowLeases === undefined ? {} : { windowLeases }),
			osascriptRunner: runner,
			dockSource: {
				read: async () => {
					generation += 1;
					return dockSnapshot();
				},
				act: async (_snapshot, id, action) => {
					dock.push(`${id}:${action}`);
				},
			},
			dockHostProbe: () => host,
			terminalHostProbe: () => host,
			terminalDispatch: async (command) => {
				commands.push(command);
				return { dispatched: true, marker: "opencua-marker-1" };
			},
			terminalRead: () => "visible terminal output",
			extrasSource: {
				read: async () => extrasSnapshot,
				act: async (_snapshot, id) => {
					extras.push(id);
				},
			},
			extrasHostProbe: () => host,
		},
	});
	closeHarness = harness.close;
	const applescript = async (source: string, language?: "applescript" | "javascript") =>
		await harness.client.callTool({
			name: "run_applescript",
			arguments: { source, ...(language === undefined ? {} : { language }) },
		});
	const script = async (code: string) => await harness.client.callTool({ name: "run_script", arguments: { code } });
	return { harness, applescript, script, scripts, commands, dock, extras, launched };
}

const NOTES_COUNT = 'tell application "Finder" to count windows';

describe("#given a server started without a lease holder #when the app-wide routes act #then they act as they always have", () => {
	it("#when run_applescript runs a script #then it runs", async () => {
		const { applescript, scripts } = await server(undefined);

		const result = await applescript(NOTES_COUNT);

		expect(result.isError).not.toBe(true);
		expect(scripts).toEqual([NOTES_COUNT]);
	});

	it("#when a JXA script runs #then it runs", async () => {
		const { applescript, scripts } = await server(undefined);

		const result = await applescript('Application("Finder").windows.length', "javascript");

		expect(result.isError).not.toBe(true);
		expect(scripts).toEqual(['Application("Finder").windows.length']);
	});

	it("#when a Terminal command runs #then it is dispatched", async () => {
		const { script, commands } = await server(undefined);

		const result = await script('return await apple.terminal().run("ls")');

		expect(result.isError).not.toBe(true);
		expect(commands).toEqual(["ls"]);
	});

	it("#when a Dock menu item is pressed #then it is dispatched", async () => {
		const { script, dock } = await server(undefined);

		const result = await script(
			"const d=apple.dock();await d.observe();await d.showMenu(3);return await d.click(5);",
		);

		expect(result.isError).not.toBe(true);
		expect(dock).toEqual(["3:AXShowMenu", "5:AXPress"]);
	});

	it("#when a menu extra is pressed #then it is dispatched", async () => {
		const { script, extras } = await server(undefined);

		const result = await script(
			"const m=apple.menubar();const o=await m.observe();return await m.press(o.items[0].id);",
		);

		expect(result.isError).not.toBe(true);
		expect(extras).toEqual([17]);
	});

	it("#when open_app opens a running app #then the launcher opens it", async () => {
		const { harness, launched } = await server(undefined);

		const result = await harness.client.callTool({ name: "open_app", arguments: { name: "Other" } });

		expect(result.isError).not.toBe(true);
		expect(launched).toEqual(["com.example.other"]);
	});
});

describe("#given a lease holder #when AppleScript runs #then every app it names needs the holder's script lease", () => {
	it("#given no lease #when run_applescript runs #then nothing runs and the refusal names the grant command", async () => {
		const { applescript, scripts } = await server(gate());

		const result = await applescript(NOTES_COUNT);
		const payload = jsonPayload(result);

		expect(result.isError).toBe(true);
		expect(payload).toMatchObject({
			actionDispatched: false,
			reason: "lease-required",
			code: "LEASE_REQUIRED",
			retry: "never",
			escalation: { target: "human" },
		});
		expect(String(payload["message"])).toContain('opencua lease grant --holder "qa" --app 1234 --tools script');
		expect(scripts).toEqual([]);
	});

	it("#given a script lease on a window of the app #then the script runs", async () => {
		writeLeases(stateDir, [lease()]);
		const { applescript, scripts } = await server(gate());

		const result = await applescript(NOTES_COUNT);

		expect(result.isError).not.toBe(true);
		expect(scripts).toEqual([NOTES_COUNT]);
	});

	it("#given only a click lease on the app #then the script is refused as a forbidden tool", async () => {
		writeLeases(stateDir, [lease({ tools: ["click"] })]);
		const { applescript, scripts } = await server(gate());

		const result = await applescript(NOTES_COUNT);

		expect(jsonPayload(result)).toMatchObject({ code: "LEASE_TOOL_FORBIDDEN", retry: "never" });
		expect(scripts).toEqual([]);
	});

	it.each([
		[
			"names a leased app and an unleased one",
			'tell application "Finder" to count windows\ntell application "Terminal" to count windows',
		],
		["names an app that is not running", 'tell application id "com.apple.Notes" to count notes'],
		["names no app", 'display dialog "hello"'],
		["computes the app's name", "tell application appName to count windows"],
	])("#given a Finder script lease #when the script %s #then nothing runs", async (_, source) => {
		writeLeases(stateDir, [lease()]);
		const { applescript, scripts } = await server(gate());

		const result = await applescript(source);

		expect(jsonPayload(result)).toMatchObject({ actionDispatched: false, code: "LEASE_REQUIRED", retry: "never" });
		expect(scripts).toEqual([]);
	});

	it("#when run_script calls apple.osascript with no lease #then nothing runs", async () => {
		const { script, scripts } = await server(gate());

		const result = await script(`return await apple.osascript(${JSON.stringify(NOTES_COUNT)})`);

		expect(result.isError).toBe(true);
		expect(jsonText(result)).toContain("lease-required");
		expect(scripts).toEqual([]);
	});
});

describe("#given an app restriction or a lease holder #when a JXA script runs #then it is refused before it runs", () => {
	it("#given a lease holder and a script lease on the app #then JXA is refused", async () => {
		writeLeases(stateDir, [lease()]);
		const { applescript, scripts } = await server(gate());

		const result = await applescript('Application("Finder").windows.length', "javascript");

		expect(jsonPayload(result)).toMatchObject({
			actionDispatched: false,
			reason: "jxa-refused",
			code: "JXA_REFUSED",
			retry: "never",
			escalation: { target: "session", reason: "route_unavailable" },
		});
		expect(scripts).toEqual([]);
	});

	it("#given an app restriction that approves the app #then JXA is refused and AppleScript still runs", async () => {
		vi.stubEnv("OPENCUA_ALLOWED_BUNDLE_IDS", "com.apple.finder");
		const { applescript, script, scripts } = await server(undefined);

		const jxa = await applescript('Application("com.apple.finder").windows.length', "javascript");
		const bridged = await script(
			'return await apple.osascript(\'Application("com.apple.finder").windows.length\', {language: "javascript"})',
		);
		const appleScript = await applescript('tell application id "com.apple.finder" to count windows');

		expect(jsonPayload(jxa)).toMatchObject({ reason: "jxa-refused", code: "JXA_REFUSED", retry: "never" });
		expect(jsonText(bridged)).toContain("jxa-refused");
		expect(appleScript.isError).not.toBe(true);
		expect(scripts).toEqual(['tell application id "com.apple.finder" to count windows']);
	});
});

describe("#given a lease holder #when a Terminal command runs #then it needs the holder's terminal lease on Terminal.app", () => {
	it("#given no lease #then nothing is dispatched and the refusal names the grant command", async () => {
		const { script, commands } = await server(gate());

		const result = await script('return await apple.terminal().run("ls")');

		expect(result.isError).toBe(true);
		expect(jsonText(result)).toContain('opencua lease grant --holder \\"qa\\" --app 2222 --tools terminal');
		expect(commands).toEqual([]);
	});

	it("#given a type lease on a Terminal window #then the command is refused as a forbidden tool", async () => {
		writeLeases(stateDir, [lease({ target: TERMINAL, tools: ["type"] })]);
		const { script, commands } = await server(gate());

		const result = await script('return await apple.terminal().run("ls")');

		expect(jsonText(result)).toContain("lease-tool-forbidden");
		expect(commands).toEqual([]);
	});

	it("#given a terminal lease #then the command is dispatched, and reading needs no lease", async () => {
		writeLeases(stateDir, [lease({ target: TERMINAL, tools: ["terminal"] })]);
		const { script, commands } = await server(gate());

		const ran = await script('return await apple.terminal().run("ls")');
		writeLeases(stateDir, []);
		const read = await script("return await apple.terminal().read()");

		expect(ran.isError).not.toBe(true);
		expect(commands).toEqual(["ls"]);
		expect(read.isError).not.toBe(true);
		expect(jsonText(read)).toContain("visible terminal output");
	});
});

describe("#given a lease holder #when the Dock is used #then only a command on an app's Dock menu needs that app's click lease", () => {
	it("#given no lease #when a Dock item is pressed and its menu opened #then both go out", async () => {
		const { script, dock } = await server(gate());

		const result = await script(
			"const d=apple.dock();await d.observe();await d.click(3);return await d.showMenu(3);",
		);

		expect(result.isError).not.toBe(true);
		expect(dock).toEqual(["3:AXPress", "3:AXShowMenu"]);
	});

	it("#given no lease #when an item of Finder's Dock menu is pressed #then it is not sent", async () => {
		const { script, dock } = await server(gate());

		const result = await script(
			"const d=apple.dock();await d.observe();await d.showMenu(3);return await d.click(5);",
		);

		expect(result.isError).toBe(true);
		expect(jsonText(result)).toContain('opencua lease grant --holder \\"qa\\" --app 1234 --tools click');
		expect(dock).toEqual(["3:AXShowMenu"]);
	});

	it("#given a menu this session did not open #when one of its items is pressed #then it is not sent", async () => {
		writeLeases(stateDir, [lease({ tools: ["click"] })]);
		const { script, dock } = await server(gate());

		const result = await script("const d=apple.dock();await d.observe();return await d.click(5);");

		expect(result.isError).toBe(true);
		expect(jsonText(result)).toContain("--app <app> --tools click");
		expect(dock).toEqual([]);
	});

	it("#given a click lease on Finder #when an item of Finder's Dock menu is pressed #then it goes out", async () => {
		writeLeases(stateDir, [lease({ tools: ["click"] })]);
		const { script, dock } = await server(gate());

		const result = await script(
			"const d=apple.dock();await d.observe();await d.showMenu(3);return await d.click(5);",
		);

		expect(result.isError).not.toBe(true);
		expect(dock).toEqual(["3:AXShowMenu", "5:AXPress"]);
	});
});

describe("#given a lease holder and no lease #when system UI is opened or an app is launched #then no lease is needed", () => {
	it("#when a menu extra is pressed #then it is dispatched", async () => {
		const { script, extras } = await server(gate());

		const result = await script(
			"const m=apple.menubar();const o=await m.observe();return await m.press(o.items[0].id);",
		);

		expect(result.isError).not.toBe(true);
		expect(extras).toEqual([17]);
	});

	it("#when open_app opens an app #then the launcher opens it", async () => {
		const { harness, launched } = await server(gate());

		const result = await harness.client.callTool({ name: "open_app", arguments: { name: "Other" } });

		expect(result.isError).not.toBe(true);
		expect(launched).toEqual(["com.example.other"]);
	});
});
