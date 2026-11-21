import { execFile } from "node:child_process";
import type { StopStatusSource } from "@opencua/core";
import { describeUserStop } from "@opencua/core";
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

export interface AppleScriptGuardOptions {
	readonly allowedBundleIds: readonly string[] | undefined;
	readonly delivery: "background" | "attended";
	readonly stopSwitch?: StopStatusSource;
	readonly runner?: OsascriptRunner;
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

/** The apps a script addresses: `application "Name"`, `application id "bundle"`, `Application("…")` (JXA). */
export function scriptTargets(source: string): readonly { readonly name: string; readonly byId: boolean }[] {
	const targets: { name: string; byId: boolean }[] = [];
	for (const match of source.matchAll(/\bapplication\s+(id\s+)?"([^"]+)"/gi)) {
		targets.push({ name: match[2] ?? "", byId: match[1] !== undefined });
	}
	for (const match of source.matchAll(/\bApplication\(\s*["']([^"']+)["']\s*\)/g)) {
		const name = match[1] ?? "";
		targets.push({ name, byId: /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(name) });
	}
	return targets;
}

export function appleScriptRefusal(
	source: string,
	options: Pick<AppleScriptGuardOptions, "allowedBundleIds" | "delivery">,
): { readonly reason: string; readonly message: string } | undefined {
	if (options.delivery === "background") {
		const statement = FOREGROUND_STATEMENTS.find(({ pattern }) => pattern.test(source));
		if (statement !== undefined) {
			return {
				reason: "foreground-refused",
				message: `The script uses ${statement.what}, which would take over the person's screen. Act on the app's own objects instead (for example make, set or tell document), or use OpenCUA's background input tools.`,
			};
		}
	}
	const allowed = options.allowedBundleIds;
	if (allowed !== undefined) {
		const approved = new Set(allowed.map((bundleId) => bundleId.toLowerCase()));
		const refused = scriptTargets(source).filter(
			(target) => !target.byId || !approved.has(target.name.toLowerCase()),
		);
		if (refused.length > 0) {
			return {
				reason: "app-not-approved",
				message: `This host restricts apps. Address each app by an approved bundle id (application id "com.apple.Notes"); not approved: ${refused.map((target) => target.name).join(", ")}.`,
			};
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
		const refusal = appleScriptRefusal(source, this.options);
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

function runOsascript(
	source: string,
	language: ScriptLanguage,
	args: readonly string[],
	timeoutMs: number,
): Promise<OsascriptRun> {
	return new Promise((resolve) => {
		const child = execFile(
			"/usr/bin/osascript",
			["-l", language === "javascript" ? "JavaScript" : "AppleScript", "-", ...args],
			{ timeout: timeoutMs, maxBuffer: 4 * MAX_OUTPUT_CHARS, encoding: "utf8" },
			(error, stdout, stderr) => {
				const timedOut = error !== null && "killed" in error && error.killed === true;
				const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
				resolve({ exitCode: code, stdout, stderr, timedOut });
			},
		);
		child.stdin?.end(source);
	});
}
