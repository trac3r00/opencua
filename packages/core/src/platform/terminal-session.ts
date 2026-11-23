import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extractAccessibilityTree } from "./macos-ffi/accessibility.js";
import { findRunningApplication } from "./macos-ffi/workspace.js";

const TERMINAL_BUNDLE_ID = "com.apple.Terminal";
const DEFAULT_TAIL_CHARS = 4_000;
const DEFAULT_ATTEMPTS = 20;
const POLL_INTERVAL_MS = 100;
const execute = promisify(execFile);

export interface TerminalApplication {
	readonly pid: number;
	readonly bundleId: string;
}

export interface TerminalRunOptions {
	readonly command: string;
	readonly windowId?: number;
	readonly activate?: boolean;
}

export interface TerminalRunResult {
	readonly dispatched: true;
	readonly windowId?: number;
	readonly marker: string;
}

export interface TerminalCaptureOptions {
	readonly windowId?: number;
	readonly attempts?: number;
	readonly pollIntervalMs?: number;
	readonly delay?: (milliseconds: number) => Promise<void>;
	readonly createMarker?: () => string;
}

export interface TerminalCapture {
	readonly text: string;
	readonly markerSeen: boolean;
}

export interface TerminalAccess {
	find(): TerminalApplication | undefined;
	run(script: string): Promise<number | undefined>;
	read(pid: number, windowId?: number): string;
}

const nativeAccess: TerminalAccess = {
	find: () => {
		const application = findRunningApplication(TERMINAL_BUNDLE_ID);
		return application === undefined ? undefined : { pid: application.pid, bundleId: application.bundleId };
	},
	run: async (script) => {
		const result = await execute("/usr/bin/osascript", ["-e", script], { timeout: 10_000 });
		const windowId = Number(result.stdout.trim());
		return Number.isSafeInteger(windowId) && windowId > 0 ? windowId : undefined;
	},
	read: (pid, windowId) => {
		const tree = extractAccessibilityTree(pid, ...(windowId === undefined ? [] : [{ windowId }]));
		return tree.elements
			.filter((element) => element.role === "AXTextArea")
			.map((element) => element.value ?? "")
			.join("\n");
	},
};

export class TerminalNotRunningError extends Error {
	constructor() {
		super("Terminal.app is not running; open Terminal.app before using a terminal session.");
		this.name = "TerminalNotRunningError";
	}
}

export class TerminalAutomationPermissionError extends Error {
	constructor() {
		super("Terminal automation is not authorized; allow Apple Events access to Terminal.app in Privacy & Security.");
		this.name = "TerminalAutomationPermissionError";
	}
}

function escapeAppleScriptString(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n").replaceAll("\r", "\\r")}"`;
}

function isAutomationDenied(error: unknown): boolean {
	return (
		error instanceof Error && (error.message.includes("-1743") || error.message.toLowerCase().includes("not allowed"))
	);
}

function markerForCommand(command: string, marker: string): string {
	return `${command}\necho ${marker}`;
}

export function createTerminalSession(access: TerminalAccess = nativeAccess) {
	return {
		findTerminal(): TerminalApplication {
			const application = access.find();
			if (application === undefined || application.bundleId !== TERMINAL_BUNDLE_ID) {
				throw new TerminalNotRunningError();
			}
			return application;
		},

		async runCommand(options: TerminalRunOptions): Promise<number | undefined> {
			this.findTerminal();
			// On macOS 26 builds Terminal never answers a `do script` Apple Event, so the dispatch must not
			// wait for its reply; the window is resolved afterwards with reply-capable plain queries.
			const target = options.windowId === undefined ? "" : ` in window id ${options.windowId}`;
			const activate = options.activate === true ? "\n\tactivate" : "";
			const dispatchScript = `ignoring application responses\n\ttell application id ${escapeAppleScriptString(TERMINAL_BUNDLE_ID)}${activate}\n\t\tdo script ${escapeAppleScriptString(options.command)}${target}\n\tend tell\nend ignoring`;
			try {
				await access.run(dispatchScript);
			} catch (error) {
				if (isAutomationDenied(error)) {
					throw new TerminalAutomationPermissionError();
				}
				throw error;
			}
			const resolveScript =
				options.windowId === undefined
					? `tell application id ${escapeAppleScriptString(TERMINAL_BUNDLE_ID)}\n\trepeat 30 times\n\t\ttry\n\t\t\treturn id of window 1\n\t\tend try\n\t\tdelay 0.2\n\tend repeat\n\treturn 0\nend tell`
					: `tell application id ${escapeAppleScriptString(TERMINAL_BUNDLE_ID)}\n\treturn id of window id ${options.windowId}\nend tell`;
			// The dispatch already happened; resolving the window is best-effort.
			try {
				return await access.run(resolveScript);
			} catch {
				return undefined;
			}
		},

		readVisibleText(windowId?: number, tailChars = DEFAULT_TAIL_CHARS): string {
			const terminal = this.findTerminal();
			return access.read(terminal.pid, windowId).slice(-tailChars);
		},

		async runAndCapture(command: string, options: TerminalCaptureOptions = {}): Promise<TerminalCapture> {
			this.findTerminal();
			const marker = options.createMarker?.() ?? `opencua-marker-${crypto.randomUUID().replaceAll("-", "")}`;
			const windowId = await this.runCommand({
				command: markerForCommand(command, marker),
				...(options.windowId === undefined ? {} : { windowId: options.windowId }),
			});
			const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
			let text = "";
			for (let attempt = 0; attempt < attempts; attempt += 1) {
				text = this.readVisibleText(windowId);
				if (text.split(/\r?\n/).includes(marker)) {
					return { text, markerSeen: true };
				}
				if (attempt + 1 < attempts) {
					await (
						options.delay ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
					)(options.pollIntervalMs ?? POLL_INTERVAL_MS);
				}
			}
			return { text, markerSeen: false };
		},
	};
}

const nativeTerminalSession = createTerminalSession();

export function findTerminal(): TerminalApplication {
	return nativeTerminalSession.findTerminal();
}

export function runCommand(options: TerminalRunOptions): Promise<number | undefined> {
	return nativeTerminalSession.runCommand(options);
}

export async function dispatchTerminalCommand(options: TerminalRunOptions): Promise<TerminalRunResult> {
	const marker = `opencua-marker-${crypto.randomUUID().replaceAll("-", "")}`;
	const windowId = await nativeTerminalSession.runCommand({
		...options,
		command: markerForCommand(options.command, marker),
	});
	return {
		dispatched: true,
		...(windowId === undefined ? {} : { windowId }),
		marker,
	};
}

export function readVisibleText(windowId?: number, tailChars = DEFAULT_TAIL_CHARS): string {
	return nativeTerminalSession.readVisibleText(windowId, tailChars);
}

export function runAndCapture(command: string, options?: TerminalCaptureOptions): Promise<TerminalCapture> {
	return nativeTerminalSession.runAndCapture(command, options);
}
