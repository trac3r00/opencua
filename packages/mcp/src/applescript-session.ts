import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import type { StopStatusSource } from "@opencua/core";
import { describeUserStop } from "@opencua/core";
import type { AppLeaseGate } from "./lease-gate.js";
import type { ToolResult } from "./tool-result.js";
import { refusalResult, textResult } from "./tool-result.js";

export type ScriptLanguage = "applescript" | "javascript";

export interface OsascriptRun {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
}

export type OsascriptRunner = (
	source: string,
	language: ScriptLanguage,
	args: readonly string[],
	timeoutMs: number,
) => Promise<OsascriptRun>;

/** Starts one process with the script on its stdin; the seam the tests replace. */
export type ProcessRunner = (
	file: string,
	args: readonly string[],
	input: string,
	timeoutMs: number,
) => Promise<OsascriptRun>;

export interface OsascriptRunnerDeps {
	readonly spawn: ProcessRunner;
	readonly canLimit: () => boolean;
	readonly warn: (message: string) => void;
}

export interface AppleScriptGuardOptions {
	readonly allowedBundleIds: readonly string[] | undefined;
	readonly delivery: "background" | "attended";
	readonly stopSwitch?: StopStatusSource;
	readonly runner?: OsascriptRunner;
	/** Window leases are on: every app a script names needs the holder's `script` lease. */
	readonly leases?: AppLeaseGate;
}

export const MAX_APPLESCRIPT_SOURCE = 20_000;
export const DEFAULT_APPLESCRIPT_TIMEOUT_MS = 30_000;
export const MAX_APPLESCRIPT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 20_000;

/**
 * Statements that act on the person's screen instead of on an app: bringing an app forward, posting global keystrokes
 * or key codes, and clicking screen points through System Events. Background delivery never takes the foreground, so a
 * script that would is refused before it runs.
 */
const FOREGROUND_STATEMENTS: readonly { readonly pattern: RegExp; readonly what: string }[] = [
	{ pattern: /\bactivate\b/i, what: "activate (brings an app forward)" },
	{ pattern: /\.activate\s*\(/, what: "activate() (brings an app forward)" },
	{ pattern: /\bkeystroke\b/i, what: "keystroke (types into whichever app is in front)" },
	{ pattern: /\bkey\s+code\b/i, what: "key code (presses keys in whichever app is in front)" },
	{ pattern: /\.keyCode\s*\(/, what: "keyCode() (presses keys in whichever app is in front)" },
	{ pattern: /\bclick\s+at\b/i, what: "click at (clicks a screen point under the person's cursor)" },
];

interface RefusedConstruct {
	readonly pattern: RegExp;
	readonly reason: string;
	readonly what: string;
}

const SHELL_ADVICE =
	"Run shell commands with apple.terminal().run(...) (the terminal tool), which asks the person before it runs.";
const LOADING_ADVICE =
	"Put the whole script in this one source; a script loaded or built at run time cannot be checked.";

/**
 * What a script may not do however it is delivered: run a shell (that goes through the terminal tool, which asks the
 * person), send a raw event no app can be read from, or run script text that was never checked.
 */
const APPLESCRIPT_CONSTRUCTS: readonly RefusedConstruct[] = [
	{ pattern: /\bdo\s+shell\s+script\b/i, reason: "shell-refused", what: `do shell script. ${SHELL_ADVICE}` },
	{
		pattern: /«\s*event\b/i,
		reason: "raw-event-refused",
		what: "a raw «event …» code, which hides the command it sends. Use the app's own command words.",
	},
	{
		pattern: /\b(?:run|load|store)\s+script\b/i,
		reason: "script-loading-refused",
		what: `run script, load script or store script. ${LOADING_ADVICE}`,
	},
];

const JAVASCRIPT_CONSTRUCTS: readonly RefusedConstruct[] = [
	{
		pattern: /\bObjC\b|\$\s*[.(\[]/,
		reason: "shell-refused",
		what: `the Objective-C bridge (ObjC, $), which can start any program. ${SHELL_ADVICE}`,
	},
	{
		pattern: /\bdoShellScript\b|\bcurrentApplication\b/,
		reason: "shell-refused",
		what: `doShellScript or currentApplication(). ${SHELL_ADVICE}`,
	},
	{
		// Code built at run time (eval, Function, a constructor's constructor, a property name glued from strings) is
		// read by no check here, so it could spell any construct above.
		pattern: /\beval\b|\bFunction\b|\bconstructor\b|\[\s*["'`][^"'`]*["'`]\s*\+/,
		reason: "script-loading-refused",
		what: `code built at run time (eval, Function, constructor, a property name joined from strings). ${LOADING_ADVICE}`,
	},
	{
		pattern: /\b(?:run|load|store)Script\b|\bLibrary\s*\(/,
		reason: "script-loading-refused",
		what: `runScript, loadScript, storeScript or Library(). ${LOADING_ADVICE}`,
	},
];

const TERMINAL_APPS: ReadonlySet<string> = new Set(["terminal", "com.apple.terminal"]);
const TERMINAL_COMMAND = /\bdo\s+script\b|\bdoScript\b/i;

/** Every line end AppleScript might honor: a comment is ended at the first, so code is never read as comment. */
const LINE_ENDS = "\n\r\u000B\u000C\u0085\u2028\u2029";

/**
 * AppleScript source with string contents and line comments blanked, same length and quotes kept, so a refusal matches
 * code only and the text of a note never trips one. Block comments, |bar| names and «chevron» forms change what the
 * compiler reads as a string in ways this scan does not follow, so a script that uses one is returned as written.
 * Block comments (which nest) are blanked; a quote inside one is comment text, as the compiler reads it.
 */
export function appleScriptCode(source: string): string {
	let code = "";
	let index = 0;
	while (index < source.length) {
		const char = source.charAt(index);
		const pair = source.slice(index, index + 2);
		if (char === "|" || char === "«") {
			return source;
		}
		if (pair === "(*") {
			let depth = 0;
			let end = index;
			while (end < source.length) {
				const at = source.slice(end, end + 2);
				if (at === "(*") {
					depth += 1;
					end += 2;
				} else if (at === "*)") {
					depth -= 1;
					end += 2;
					if (depth === 0) break;
				} else {
					end += 1;
				}
			}
			// An unclosed comment does not compile; leave the script as written so every check still reads it.
			if (depth !== 0) return source;
			code += " ".repeat(end - index);
			index = end;
		} else if (char === '"') {
			let end = index + 1;
			while (end < source.length && source.charAt(end) !== '"') {
				end += source.charAt(end) === "\\" ? 2 : 1;
			}
			const close = Math.min(end, source.length);
			code += `"${" ".repeat(close - index - 1)}${close < source.length ? '"' : ""}`;
			index = close + 1;
		} else if (pair === "--" || char === "#") {
			let end = index;
			while (end < source.length && !LINE_ENDS.includes(source.charAt(end))) {
				end += 1;
			}
			code += " ".repeat(end - index);
			index = end;
		} else {
			code += char;
			index += 1;
		}
	}
	return code;
}

interface ScriptTarget {
	readonly name: string;
	readonly byId: boolean;
}

const APPLESCRIPT_TARGET = /\b(?:application|app)\s+(id\s+)?"/gi;
/** `application` or `app` that names no app in the text; System Events and Finder class names are not references. */
const APPLESCRIPT_UNNAMED_TARGET =
	/\b(?:application|app)\b(?!\s+(?:id\s+)?"|\s+(?:process(?:es)?|files?|responses|support)\b)/i;
const JAVASCRIPT_TARGET = /\bApplication\(\s*["']([^"']+)["']\s*\)/g;
const JAVASCRIPT_APPLICATION = /\bApplication\b/g;

function appleScriptTargets(source: string, code: string): ScriptTarget[] {
	return [...code.matchAll(APPLESCRIPT_TARGET)].map((match) => {
		const start = (match.index ?? 0) + match[0].length;
		const end = code.indexOf('"', start);
		return { name: source.slice(start, end === -1 ? source.length : end), byId: match[1] !== undefined };
	});
}

function javaScriptTargets(source: string): ScriptTarget[] {
	return [...source.matchAll(JAVASCRIPT_TARGET)].map((match) => {
		const name = match[1] ?? "";
		return { name, byId: /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(name) };
	});
}

/**
 * The apps a script addresses: `application "Name"`, `app "Name"`, `application id "bundle"` (AppleScript) and
 * `Application("…")` (JXA). Without a language both forms are read.
 */
export function scriptTargets(source: string, language?: ScriptLanguage): readonly ScriptTarget[] {
	return [
		...(language === "javascript" ? [] : appleScriptTargets(source, appleScriptCode(source))),
		...(language === "applescript" ? [] : javaScriptTargets(source)),
	];
}

/** Whether the script reaches an app its text does not name, so an app restriction cannot be checked against it. */
function hasUnnamedTarget(source: string, code: string, language: ScriptLanguage): boolean {
	return language === "javascript"
		? (source.match(JAVASCRIPT_APPLICATION)?.length ?? 0) !== javaScriptTargets(source).length
		: APPLESCRIPT_UNNAMED_TARGET.test(code);
}

/**
 * JXA's Objective-C bridge (ObjC, $, Ref, Library) is a set of globals a script cannot delete, so a name computed at
 * run time reaches it past every text check. It cannot be confined in-process, so a host that restricts apps or runs
 * under window leases takes AppleScript only.
 */
const JXA_GUARDED =
	"JXA's Objective-C bridge can run any code and cannot be confined in-process, so with an app restriction or window leases on, use AppleScript instead.";

export function appleScriptRefusal(
	source: string,
	options: Pick<AppleScriptGuardOptions, "allowedBundleIds" | "delivery" | "leases"> & {
		readonly language?: ScriptLanguage;
	},
): { readonly reason: string; readonly message: string } | undefined {
	const language = options.language ?? "applescript";
	if (language === "javascript" && (options.allowedBundleIds !== undefined || options.leases !== undefined)) {
		return { reason: "jxa-refused", message: JXA_GUARDED };
	}
	// JXA is matched as written: telling a JavaScript string from a regex is not worth a wrong guess here.
	const code = language === "javascript" ? source : appleScriptCode(source);
	const targets = scriptTargets(source, language);
	const construct = (language === "javascript" ? JAVASCRIPT_CONSTRUCTS : APPLESCRIPT_CONSTRUCTS).find(({ pattern }) =>
		pattern.test(code),
	);
	if (construct !== undefined) {
		return { reason: construct.reason, message: `The script uses ${construct.what}` };
	}
	if (TERMINAL_COMMAND.test(code) && targets.some((target) => TERMINAL_APPS.has(target.name.toLowerCase()))) {
		return { reason: "shell-refused", message: `The script tells Terminal to run a command. ${SHELL_ADVICE}` };
	}
	if (options.delivery === "background") {
		const statement = FOREGROUND_STATEMENTS.find(({ pattern }) => pattern.test(code));
		if (statement !== undefined) {
			return {
				reason: "foreground-refused",
				message: `The script uses ${statement.what}, which would take over the person's screen. Act on the app's own objects instead (for example make, set or tell document), or use OpenCUA's background input tools.`,
			};
		}
	}
	const allowed = options.allowedBundleIds;
	if (allowed !== undefined) {
		if (targets.length === 0 || hasUnnamedTarget(source, code, language)) {
			return {
				reason: "app-not-approved",
				message:
					'This host restricts apps, so every app the script reaches must be named in its text by an approved bundle id: application id "com.apple.Notes". A computed name, current application, or a script that names no app cannot be checked.',
			};
		}
		const approved = new Set(allowed.map((bundleId) => bundleId.toLowerCase()));
		const refused = targets.filter((target) => !target.byId || !approved.has(target.name.toLowerCase()));
		if (refused.length > 0) {
			return {
				reason: "app-not-approved",
				message: `This host restricts apps. Address each app by an approved bundle id (application id "com.apple.Notes"); not approved: ${refused.map((target) => target.name).join(", ")}.`,
			};
		}
	}
	const leases = options.leases;
	if (leases !== undefined) {
		// A script reaches the app's scripting objects, not one window, so each app it names needs a script lease.
		if (targets.length === 0 || hasUnnamedTarget(source, code, language)) {
			return leases.refuseUnattributed(
				"script",
				'with window leases on, every app a script reaches must be named in its text (tell application "Notes") so its lease can be checked; a computed name, current application, or a script that names no app cannot be',
			);
		}
		for (const name of new Set(targets.map((target) => target.name))) {
			const refusal = leases.refuse(name, "script");
			if (refusal !== undefined) return refusal;
		}
	}
	return undefined;
}

export class AppleScriptGuardSession {
	private stopped = false;
	private readonly runner: OsascriptRunner;

	constructor(private readonly options: AppleScriptGuardOptions) {
		this.runner = options.runner ?? runOsascript;
	}

	async run(
		source: unknown,
		options: { readonly language?: unknown; readonly args?: unknown; readonly timeoutMs?: unknown } = {},
	): Promise<ToolResult> {
		if (this.stopped) return refusalResult("applescript-session-closed");
		const stop = this.options.stopSwitch?.status();
		if (stop?.stopped === true) return refusalResult("user-stopped", describeUserStop(stop));
		if (typeof source !== "string" || source.trim() === "" || source.length > MAX_APPLESCRIPT_SOURCE) {
			return refusalResult(
				"applescript-invalid-source",
				`source must be a non-empty script of at most ${MAX_APPLESCRIPT_SOURCE} characters.`,
			);
		}
		const language = options.language ?? "applescript";
		if (language !== "applescript" && language !== "javascript") {
			return refusalResult("applescript-invalid-language", 'language must be "applescript" or "javascript".');
		}
		const args = options.args ?? [];
		if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
			return refusalResult("applescript-invalid-args", "args must be an array of strings.");
		}
		const timeoutMs = options.timeoutMs ?? DEFAULT_APPLESCRIPT_TIMEOUT_MS;
		if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1) {
			return refusalResult("applescript-invalid-timeout", "timeout_ms must be a positive integer.");
		}
		const refusal = appleScriptRefusal(source, { ...this.options, language });
		if (refusal !== undefined) return refusalResult(refusal.reason, refusal.message);
		const started = Date.now();
		const run = await this.runner(source, language, args, Math.min(timeoutMs, MAX_APPLESCRIPT_TIMEOUT_MS));
		const elapsedMs = Date.now() - started;
		if (run.timedOut) {
			return refusalResult(
				"applescript-timeout",
				`The script did not finish within ${timeoutMs} ms and was stopped.`,
			);
		}
		if (run.exitCode !== 0) {
			return refusalResult("applescript-failed", describeOsascriptError(run.stderr));
		}
		const output = run.stdout.replace(/\n$/, "");
		return textResult(
			JSON.stringify({
				ok: true,
				result: output.slice(0, MAX_OUTPUT_CHARS),
				...(output.length > MAX_OUTPUT_CHARS ? { resultTruncated: true } : {}),
				elapsedMs,
			}),
		);
	}

	close(): void {
		this.stopped = true;
	}
}

/** osascript's error, with what to do about the one that needs the person: Automation permission. */
export function describeOsascriptError(stderr: string): string {
	const message = stderr.trim() || "osascript failed without an error message.";
	return /-1743|not allowed to send Apple events|Not authorized to send Apple events/i.test(message)
		? `${message} Automation permission is missing: ask the person to allow OpenCUA to control that app in System Settings > Privacy & Security > Automation.`
		: message;
}

const OSASCRIPT = "/usr/bin/osascript";
const SHELL = "/bin/sh";

/**
 * The layer under the text checks: the shell lowers its own process limit to zero and then becomes osascript, so a
 * `do shell script`, NSTask or system() the checks did not recognise cannot start a process. Apple events are not
 * affected. A Seatbelt profile (sandbox-exec) is not usable for this: macOS refuses every Apple event from a
 * sandboxed osascript with -10004, because osascript carries no Apple Events entitlement. The limit does not bind
 * root, and it does not stop JXA's bridge replacing osascript itself, which is why the bridge is refused above.
 */
const NO_NEW_PROCESSES = `ulimit -u 0 && exec ${OSASCRIPT} "$@"`;

/** Runs osascript unable to start a process; where that cannot be arranged it runs plainly and says so once. */
export function createOsascriptRunner(deps: OsascriptRunnerDeps): OsascriptRunner {
	let warned = false;
	return (source, language, args, timeoutMs) => {
		const osascriptArgs = ["-l", language === "javascript" ? "JavaScript" : "AppleScript", "-", ...args];
		if (deps.canLimit()) {
			return deps.spawn(SHELL, ["-c", NO_NEW_PROCESSES, "sh", ...osascriptArgs], source, timeoutMs);
		}
		if (!warned) {
			warned = true;
			deps.warn(
				`opencua: ${SHELL} is missing, so osascript runs without its process limit; only the script text checks stand between a script and a shell.`,
			);
		}
		return deps.spawn(OSASCRIPT, osascriptArgs, source, timeoutMs);
	};
}

function runProcess(file: string, args: readonly string[], input: string, timeoutMs: number): Promise<OsascriptRun> {
	return new Promise((resolve) => {
		const child = execFile(
			file,
			[...args],
			{ timeout: timeoutMs, maxBuffer: 4 * MAX_OUTPUT_CHARS, encoding: "utf8" },
			(error, stdout, stderr) => {
				const timedOut = error !== null && "killed" in error && error.killed === true;
				const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
				resolve({ exitCode: code, stdout, stderr, timedOut });
			},
		);
		child.stdin?.end(input);
	});
}

const runOsascript = createOsascriptRunner({
	spawn: runProcess,
	canLimit: () => existsSync(SHELL),
	warn: (message) => {
		process.stderr.write(`${message}\n`);
	},
});
