import { describe, expect, it } from "bun:test";
import {
	AppleScriptGuardSession,
	appleScriptRefusal,
	describeOsascriptError,
	scriptTargets,
} from "./applescript-session.js";
import type { OsascriptRunner } from "./applescript-session.js";

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
		expect(appleScriptRefusal('Application("com.apple.Notes").notes.length', restricted)).toBeUndefined();
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
});
