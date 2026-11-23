import { describe, expect, it } from "bun:test";
import {
	AppleScriptGuardSession,
	appleScriptRefusal,
	createOsascriptRunner,
	describeOsascriptError,
	scriptTargets,
} from "./applescript-session.js";
import type { OsascriptRunner, ProcessRunner } from "./applescript-session.js";
import type { AppLeaseGate } from "./lease-gate.js";

const BACKGROUND = { allowedBundleIds: undefined, delivery: "background" } as const;

function payload(result: { content: readonly { type: string; text?: string }[] }): Record<string, unknown> {
	const text = result.content.find((item) => item.type === "text")?.text ?? "{}";
	return JSON.parse(text);
}

describe("appleScriptRefusal #given background delivery #when a script would take the person's screen #then it is refused before it runs", () => {
	it.each([
		['tell application "Notes" to activate'],
		['Application("Notes").activate()'],
		['tell application "System Events" to keystroke "a"'],
		['tell application "System Events" to key code 36'],
		['Application("System Events").keyCode(36)'],
		['tell application "System Events" to click at {10, 10}'],
	])("refuses %s", (source) => {
		expect(appleScriptRefusal(source, BACKGROUND)?.reason).toBe("foreground-refused");
	});

	it("lets a script that works on the app's own objects run", () => {
		const source = 'tell application "Notes" to make new note with properties {body:"<h1>RCA</h1>"}';
		expect(appleScriptRefusal(source, BACKGROUND)).toBeUndefined();
		expect(
			appleScriptRefusal('tell application "Notes" to activate', { ...BACKGROUND, delivery: "attended" }),
		).toBeUndefined();
	});
});

describe("appleScriptRefusal #given a host app restriction #when a script names its apps #then only approved bundle ids may be addressed", () => {
	const restricted = { allowedBundleIds: ["com.apple.Notes"], delivery: "background" } as const;

	it("allows an approved bundle id and refuses a name or an unapproved id", () => {
		expect(appleScriptRefusal('tell application id "com.apple.Notes" to count notes', restricted)).toBeUndefined();
		expect(appleScriptRefusal('tell application "Notes" to count notes', restricted)?.reason).toBe(
			"app-not-approved",
		);
		expect(appleScriptRefusal('tell application id "com.apple.mail" to count messages', restricted)?.reason).toBe(
			"app-not-approved",
		);
	});

	it("reads both AppleScript and JXA app references", () => {
		expect(
			scriptTargets('tell application "Notes"\ntell application id "com.apple.reminders"\nApplication("Mail")'),
		).toEqual([
			{ name: "Notes", byId: false },
			{ name: "com.apple.reminders", byId: true },
			{ name: "Mail", byId: false },
		]);
	});
});

describe("appleScriptRefusal #given any delivery #when a script would run a shell, send a raw event or load a script #then it is refused before it runs", () => {
	const ATTENDED = { allowedBundleIds: undefined, delivery: "attended" } as const;

	it.each([
		['do shell script "echo x"', "shell-refused"],
		['tell application "Finder" to do shell script "echo x"', "shell-refused"],
		['tell application "Terminal" to do script "echo x"', "shell-refused"],
		['«event sysoexec» "echo x"', "raw-event-refused"],
		['run script "return 1"', "script-loading-refused"],
		['set helper to load script file "Macintosh HD:tmp:helper.scpt"', "script-loading-refused"],
		['store script helper in file "Macintosh HD:tmp:helper.scpt"', "script-loading-refused"],
		// A quote in a comment, a |bar| name or a block comment must not make the next statement read as a string.
		['-- "\ndo shell script "echo x" -- "', "shell-refused"],
		['-- note\rdo shell script "echo x"', "shell-refused"],
		['set |a"| to 1\ndo shell script "echo x"\nset |b"| to 2', "shell-refused"],
		['(* " *) do shell script "echo x" (* " *)', "shell-refused"],
		['set kind to «class a#b» & (do shell script "echo x")', "shell-refused"],
	])("refuses AppleScript %s", (source, reason) => {
		expect(appleScriptRefusal(source, BACKGROUND)?.reason).toBe(reason);
		expect(appleScriptRefusal(source, ATTENDED)?.reason).toBe(reason);
	});

	it.each([
		['ObjC.import("stdlib")', "shell-refused"],
		['$.system("echo x")', "shell-refused"],
		['$("echo x")', "shell-refused"],
		['Application("Finder").doShellScript("echo x")', "shell-refused"],
		["const me = Application.currentApplication()", "shell-refused"],
		['Application("Terminal").doScript("echo x")', "shell-refused"],
		['Application("Finder").runScript("return 1")', "script-loading-refused"],
		['Library("helper").go()', "script-loading-refused"],
		// Code assembled at run time could spell any refused construct, so it is refused itself.
		['eval("Ob" + "jC.import(\'Foundation\')")', "script-loading-refused"],
		['new Function("return 1")()', "script-loading-refused"],
		["[].map.constructor('return 1')()", "script-loading-refused"],
		['Application("Terminal")["do" + "Script"]("echo x")', "script-loading-refused"],
	])("refuses JXA %s", (source, reason) => {
		expect(appleScriptRefusal(source, { ...ATTENDED, language: "javascript" })?.reason).toBe(reason);
	});

	it.each([
		[
			'tell application "Notes" to make new note with properties {body:"activate it, then do shell script or run script"}',
		],
		['tell application "Notes" to make new note with properties {body:"« event » costs $.50 at ObjC"}'],
		['-- activate is not needed here\ntell application "Notes" to count notes # no keystroke either'],
		['tell application "Finder" to read file "notes.txt" as «class utf8»'],
		['tell application "Adobe InDesign 2025" to do script "app.documents.length" language javascript'],
		["use framework \"Foundation\"\nreturn (current application's NSDate's |date|()) as text"],
		[
			'(* make the weekly note *) tell application id "com.apple.Notes" to make new note with properties {body:"run script later"}',
		],
		['(* outer (* inner *) still comment: do shell script *) tell application "Notes" to count notes'],
	])("lets normal app automation run: %s", (source) => {
		expect(appleScriptRefusal(source, BACKGROUND)).toBeUndefined();
	});

	it("lets normal JXA run", () => {
		const source = 'const notes = Application("Notes"); notes.notes().map((note) => `${note.name()}`)';
		expect(appleScriptRefusal(source, { ...BACKGROUND, language: "javascript" })).toBeUndefined();
	});
});

describe("appleScriptRefusal #given a host app restriction #when a script's target cannot be read from its text #then it is refused", () => {
	const restricted = {
		allowedBundleIds: ["com.apple.Notes", "com.apple.systemevents"],
		delivery: "background",
	} as const;
	const javascript = { ...restricted, language: "javascript" } as const;

	it.each([
		['tell app "Mail" to count messages'],
		['tell app id "com.apple.mail" to count messages'],
		["tell application appName to count notes"],
		['tell application ("Ma" & "il") to count messages'],
		['display dialog "no app is named"'],
		['tell application id "com.apple.Notes" to count notes\ntell current application to beep'],
	])("refuses AppleScript %s", (source) => {
		expect(appleScriptRefusal(source, restricted)?.reason).toBe("app-not-approved");
	});

	it.each([
		["Application(name).notes.length"],
		['const open = Application; open("Mail").accounts.length'],
		['Application("com.apple.Notes").notes.length + Application(`com.apple.mail`).accounts.length'],
		["JSON.stringify([1, 2, 3])"],
	])("refuses JXA %s", (source) => {
		expect(appleScriptRefusal(source, javascript)?.reason).toBe("jxa-refused");
	});

	it("allows approved bundle ids, the app abbreviation and System Events' own classes", () => {
		expect(appleScriptRefusal('tell app id "com.apple.Notes" to count notes', restricted)).toBeUndefined();
		expect(
			appleScriptRefusal(
				'ignoring application responses\ntell application id "com.apple.systemevents" to get name of every application process\nend ignoring',
				restricted,
			),
		).toBeUndefined();
	});

	it("reads the app abbreviation as a target and leaves every target allowed when no restriction is set", () => {
		expect(scriptTargets('tell app "Mail" to count messages', "applescript")).toEqual([
			{ name: "Mail", byId: false },
		]);
		expect(scriptTargets('set body of note 1 to "tell application \\"Mail\\""', "applescript")).toEqual([]);
		expect(appleScriptRefusal("tell application appName to count windows", BACKGROUND)).toBeUndefined();
		expect(appleScriptRefusal('display dialog "hello"', BACKGROUND)).toBeUndefined();
		expect(
			appleScriptRefusal("Application(name).windows.length", { ...BACKGROUND, language: "javascript" }),
		).toBeUndefined();
	});
});

describe("AppleScriptGuardSession #given JXA #when an app restriction or window leases are on #then it is refused before it runs", () => {
	const jxa = 'Application("com.apple.Notes").notes.length';
	const leases: AppLeaseGate = {
		refuse: () => undefined,
		refuseUnattributed: () => ({ reason: "lease-required", message: "no app" }),
	};

	async function runJxa(options: { allowedBundleIds?: readonly string[]; leases?: AppLeaseGate }) {
		const ran: string[] = [];
		const session = new AppleScriptGuardSession({
			allowedBundleIds: options.allowedBundleIds,
			delivery: "background",
			...(options.leases === undefined ? {} : { leases: options.leases }),
			runner: async (source) => {
				ran.push(source);
				return { exitCode: 0, stdout: "2\n", stderr: "", timedOut: false };
			},
		});
		return { result: await session.run(jxa, { language: "javascript" }), ran };
	}

	it("#given an app restriction that approves the app #then JXA is refused and nothing runs", async () => {
		const { result, ran } = await runJxa({ allowedBundleIds: ["com.apple.Notes"] });

		expect(result.isError).toBe(true);
		expect(payload(result)).toMatchObject({
			reason: "jxa-refused",
			escalation: { target: "session", reason: "route_unavailable" },
		});
		expect(ran).toEqual([]);
	});

	it("#given window leases that would allow the app #then JXA is refused and nothing runs", async () => {
		const { result, ran } = await runJxa({ leases });

		expect(payload(result)).toMatchObject({ reason: "jxa-refused" });
		expect(ran).toEqual([]);
	});

	it("#given neither #then JXA runs as before", async () => {
		const { result, ran } = await runJxa({});

		expect(result.isError).not.toBe(true);
		expect(ran).toEqual([jxa]);
	});
});

describe("AppleScriptGuardSession #given a runner #when a script runs #then its result or failure comes back in the tool envelope", () => {
	const calls: unknown[][] = [];
	const runner: OsascriptRunner = async (...args) => {
		calls.push(args);
		return { exitCode: 0, stdout: "3\n", stderr: "", timedOut: false };
	};

	it("passes language, args and timeout through and returns the trimmed result", async () => {
		calls.length = 0;
		const session = new AppleScriptGuardSession({ ...BACKGROUND, runner });
		const result = await session.run("count notes", { language: "javascript", args: ["a"], timeoutMs: 5_000 });

		expect(payload(result)).toMatchObject({ ok: true, result: "3" });
		expect(calls).toEqual([["count notes", "javascript", ["a"], 5_000]]);
	});

	it("refuses without running when the person stopped agents, the session closed, or the script takes the screen", async () => {
		calls.length = 0;
		const stopped = new AppleScriptGuardSession({
			...BACKGROUND,
			runner,
			stopSwitch: {
				status: () => ({ stopped: true, stoppedAt: new Date(0).toISOString(), reason: "test", source: "menu" }),
			},
		});
		expect(payload(await stopped.run("count notes"))["reason"]).toBe("user-stopped");
		const screen = new AppleScriptGuardSession({ ...BACKGROUND, runner });
		expect(payload(await screen.run('tell application "Notes" to activate'))["reason"]).toBe("foreground-refused");
		screen.close();
		expect(payload(await screen.run("count notes"))["reason"]).toBe("applescript-session-closed");
		expect(calls).toEqual([]);
	});

	it("reports a failed or stalled script, naming the Automation permission when that is the cause", async () => {
		const failing = new AppleScriptGuardSession({
			...BACKGROUND,
			runner: async () => ({
				exitCode: 1,
				stdout: "",
				stderr: "execution error: Not authorized to send Apple events to Notes. (-1743)",
				timedOut: false,
			}),
		});
		const failed = payload(await failing.run("count notes"));
		expect(failed["reason"]).toBe("applescript-failed");
		expect(String(failed["message"])).toContain("Automation");
		const stalled = new AppleScriptGuardSession({
			...BACKGROUND,
			runner: async () => ({ exitCode: 1, stdout: "", stderr: "", timedOut: true }),
		});
		expect(payload(await stalled.run("delay 100"))["reason"]).toBe("applescript-timeout");
		expect(describeOsascriptError("")).toContain("without an error message");
	});

	it("checks the script as the language it runs in and never starts a refused one", async () => {
		calls.length = 0;
		const session = new AppleScriptGuardSession({ ...BACKGROUND, runner });

		expect(payload(await session.run('$.system("echo x")', { language: "javascript" }))["reason"]).toBe(
			"shell-refused",
		);
		expect(payload(await session.run('do shell script "echo x"'))["reason"]).toBe("shell-refused");
		expect(payload(await session.run('set price to "$.50"'))).toMatchObject({ ok: true });
		expect(calls).toEqual([['set price to "$.50"', "applescript", [], 30_000]]);
	});
});

describe("createOsascriptRunner #given the process limit #when a script runs #then osascript is started unable to start a process", () => {
	const DONE = { exitCode: 0, stdout: "", stderr: "", timedOut: false } as const;

	function recorder() {
		const spawned: Parameters<ProcessRunner>[] = [];
		const warnings: string[] = [];
		const spawn: ProcessRunner = async (...args) => {
			spawned.push(args);
			return DONE;
		};
		return { spawned, warnings, spawn, warn: (message: string) => warnings.push(message) };
	}

	it("lowers the limit in a shell that then becomes osascript, with the script on stdin and its args untouched", async () => {
		const { spawned, warnings, spawn, warn } = recorder();
		const run = createOsascriptRunner({ spawn, canLimit: () => true, warn });

		await run("count notes", "javascript", ["a b", "$(c)"], 5_000);

		expect(spawned).toEqual([
			[
				"/bin/sh",
				["-c", 'ulimit -u 0 && exec /usr/bin/osascript "$@"', "sh", "-l", "JavaScript", "-", "a b", "$(c)"],
				"count notes",
				5_000,
			],
		]);
		expect(warnings).toEqual([]);
	});

	it("runs osascript plainly and warns once when the limit cannot be set", async () => {
		const { spawned, warnings, spawn, warn } = recorder();
		const run = createOsascriptRunner({ spawn, canLimit: () => false, warn });

		await run("count notes", "applescript", [], 1_000);
		await run("count notes", "applescript", [], 1_000);

		expect(spawned).toEqual([
			["/usr/bin/osascript", ["-l", "AppleScript", "-"], "count notes", 1_000],
			["/usr/bin/osascript", ["-l", "AppleScript", "-"], "count notes", 1_000],
		]);
		expect(warnings).toHaveLength(1);
	});
});
