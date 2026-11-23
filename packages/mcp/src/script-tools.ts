import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseElementIndex } from "@opencua/core";
import {
	type ScreenFrames,
	activeSpaceId,
	managedDisplaySpaces,
	spaceTypeFor,
	visibleScreenFrames,
} from "@opencua/core";
import type { DockAction, DockSnapshot, ElementQuery, GuardedComputerInterface, TopLevelWindow } from "@opencua/core";
import { z } from "zod/v4";
import type { AppleScriptGuardSession } from "./applescript-session.js";
import { BROWSER_TOOLS, BrowserCallError, type BrowserCaller, bskBrowserCaller, resolveBsk } from "./browser-bridge.js";
import { type CleanupDeps, cleanupLedger, nativeCleanupDeps } from "./cleanup-ledger.js";
import type { DockGuardSession } from "./dock-session.js";
import type { ExtrasGuardSession } from "./extras-session.js";
import type { GuardedSession, RunPace, RunStepDriver, VerifyCheckRequest, VerifyRequest } from "./guarded-session.js";
import { handsChunksFrom } from "./hands-tools.js";
import type {
	CallError,
	HostMessage,
	ScriptOutcome,
	WindowSelector,
	WorkerMessage,
	WorkerTarget,
} from "./script-protocol.js";
import { createRunStepDriver } from "./step-actions.js";
import type { TerminalGuardSession } from "./terminal-session.js";
import type { ToolContent, ToolResult } from "./tool-result.js";
import { MAX_RUN_STEPS, elementQuerySchema, handsSpecSchema, runStepSchema } from "./tool-schemas.js";
import type { RunStep } from "./tool-schemas.js";
import { WINDOW_REF_PATTERN, windowForRef } from "./window-refs.js";

const MAX_CODE_LENGTH = 20_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_EXPECT_TIMEOUT_MS = 10_000;
const MAX_LOG_ENTRIES = 200;
const MAX_LOG_CHARS = 2_000;
const MAX_FIND_RESULTS = 25;
const MAX_BATCH_STEPS = MAX_RUN_STEPS;
const dockRunTails = new WeakMap<DockGuardSession, Promise<void>>();
const extrasRunTails = new WeakMap<ExtrasGuardSession, Promise<void>>();
const observationOptionsSchema = z
	.object({
		diffOnly: z.boolean().optional(),
		maxElements: z.number().int().positive().optional(),
		includeScreenshot: z.boolean().optional(),
		includeMenuBar: z.boolean().optional(),
		subtreeOf: z.number().int().nonnegative().optional(),
		visibleOnly: z.boolean().optional(),
		elementFormat: z.enum(["json", "table"]).optional(),
	})
	.strict();

/** snake_case spellings agents write for the observe options, and hints that have no effect here. */
const OBSERVE_OPTION_ALIASES: Readonly<Record<string, string>> = {
	diff_only: "diffOnly",
	max_elements: "maxElements",
	include_screenshot: "includeScreenshot",
	include_menu_bar: "includeMenuBar",
	subtree_of: "subtreeOf",
	visible_only: "visibleOnly",
	element_format: "elementFormat",
};
const IGNORED_OBSERVE_OPTIONS: ReadonlySet<string> = new Set(["profile"]);

function observeOptions(options: unknown): unknown {
	if (!isRecord(options)) {
		return options ?? {};
	}
	return Object.fromEntries(
		Object.entries(options)
			.filter(([key]) => !IGNORED_OBSERVE_OPTIONS.has(key))
			.map(([key, value]) => [OBSERVE_OPTION_ALIASES[key] ?? key, value]),
	);
}

let visibleFramesSource: () => readonly ScreenFrames[] | undefined = visibleScreenFrames;
let cleanupDepsSource: () => CleanupDeps = () => nativeCleanupDeps;
let browserCaller: BrowserCaller | undefined;
let browserCallerSource: () => BrowserCaller | undefined = () => {
	if (browserCaller === undefined) {
		const binary = resolveBsk();
		if (binary !== undefined) browserCaller = bskBrowserCaller(binary);
	}
	return browserCaller;
};

/** Test seam for where apple.browser() calls go (null: not installed); production starts `bsk mcp` on first use. */
export function setBrowserCallerForTesting(caller: BrowserCaller | null | undefined): void {
	const production = browserCallerSource;
	browserCallerSource = caller === undefined ? production : () => caller ?? undefined;
	restoreBrowserCaller = () => {
		browserCallerSource = production;
	};
}
let restoreBrowserCaller = (): void => undefined;

export function restoreBrowserCallerForTesting(): void {
	restoreBrowserCaller();
}

/** Test seam for what cleanUp quits and restores through; production uses the macOS host. */
export function setCleanupDepsForTesting(deps: CleanupDeps | undefined): void {
	cleanupDepsSource = () => deps ?? nativeCleanupDeps;
}

/** Test seam for the screens' usable frames; production asks AppKit. */
export function setVisibleFramesSourceForTesting(
	source: (() => readonly ScreenFrames[] | undefined) | undefined,
): void {
	visibleFramesSource = source ?? visibleScreenFrames;
}

const runScriptSchema = z.object({
	code: z.string().min(1).max(MAX_CODE_LENGTH),
	timeout_ms: z.number().int().min(1).max(MAX_TIMEOUT_MS).optional(),
	read_only: z.boolean().optional(),
	include_screenshot: z.boolean().optional(),
});

const RUN_SCRIPT_DESCRIPTION = `Run trusted async JavaScript with guarded actions; no persistent state or require/process/import (not a security sandbox).
const app=apple.app("Finder",{window:"title or id"}); await apple.apps(); await apple.windows("App"). Window title must match uniquely.
app.observe(options); app.find(query); app.click(target|{x,y},options); app.setValue(target,value); app.type(text); app.press(keys); app.selectText(target,text,options); app.secondaryAction(target,action); app.menu(path); app.scroll(target,direction,pages); app.drag(from,to,options).
Targets are observed ids or unique queries {role,label,label_contains,value_contains,text,index}. IDs/coordinates need observe/find first; queries and keyboard/menu actions observe themselves. Scroll modifiers are refused.
app.waitFor(target|{window_title},options); app.verify(checks,options); app.step(step); app.batch(steps,options); app.chain(steps) (fast; batch verifies intermediate targets by default); app.reveal(query,findOptions) only scrolls.
app.hands({chunks:[{keyboard:[steps],pointer:[steps],vision:{}}...]},{expect}) runs each chunk's lanes at once, chunk after chunk; pointer steps need observed ids or x/y.
Find options: scrollWithin,maxPages,vision,direction. OCR needs Screen Recording; finds click targets only.
const dock=apple.dock(); await dock.observe(); dock.click/showMenu/cancel(target). Dock actions need explicit approval and attended delivery.
apple.terminal(): run/read; approval required. apple.osascript(source,{language,args,timeoutMs}): AppleScript/JXA; screen-taking statements refused.
apple.arrange([a,b]) tiles windows; then use Promise.all. apple.cleanUp({keep}) when done. apple.browser(): open/sync/plan/act/read/tabs/help/stop (bsk; ids carried).
apple.spaces(): active()/displays() read-only; apple.menubar(): observe(), press(observedId), guarded.
Refusals throw ScriptActionError; read_only forbids mutations. Timeout stops input. Background apps overlap. Returns {ok,value,log,actions}.`;

class ScriptActionError extends Error {
	readonly kind: string;
	readonly payload: unknown;
	readonly refused: string | undefined;

	constructor(
		message: string,
		details: { readonly kind: string; readonly payload?: unknown; readonly refused?: string },
	) {
		super(message);
		this.name = "ScriptActionError";
		this.kind = details.kind;
		this.payload = details.payload;
		this.refused = details.refused;
	}
}

interface ActionRecord {
	readonly n: number;
	readonly app: string;
	readonly kind: string;
	readonly ms: number;
	readonly status: string;
}

interface RunOptions {
	/** Actions on different apps may overlap (background delivery); otherwise they share one queue. */
	readonly parallelApps: boolean;
	readonly readOnly: boolean;
	readonly includeScreenshot: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pick(source: unknown, key: string): unknown {
	return isRecord(source) ? source[key] : undefined;
}

function errorMessage(error: unknown): string {
	if (isRecord(error) && typeof error["message"] === "string") {
		const name = typeof error["name"] === "string" ? error["name"] : "Error";
		return error instanceof ScriptActionError ? error.message : `${name}: ${error["message"]}`;
	}
	return String(error);
}

function dockMatches(element: DockSnapshot["elements"][number], query: ElementQuery): boolean {
	const label = element.label ?? "";
	if (
		query.role !== undefined &&
		element.role.toLowerCase() !== query.role.toLowerCase() &&
		!element.role.toLowerCase().replace(/^ax/, "").includes(query.role.toLowerCase().replace(/^ax/, ""))
	)
		return false;
	if (query.label !== undefined && label !== query.label) return false;
	if (query.labelContains !== undefined && !label.toLowerCase().includes(query.labelContains.toLowerCase()))
		return false;
	if (
		query.valueContains !== undefined &&
		!(typeof element.value === "string" && element.value.toLowerCase().includes(query.valueContains.toLowerCase()))
	)
		return false;
	if (
		query.text !== undefined &&
		!`${label} ${String(element.value ?? "")}`.toLowerCase().includes(query.text.toLowerCase())
	)
		return false;
	return true;
}

function invalid(message: string): ScriptActionError {
	return new ScriptActionError(message, { kind: "invalid-argument", refused: "invalid-argument" });
}

function firstString(...values: readonly unknown[]): string | undefined {
	return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function parseResult(result: ToolResult): { readonly payload: unknown; readonly image: ToolContent | undefined } {
	let text: string | undefined;
	let image: ToolContent | undefined;
	for (const item of result.content) {
		if (item.type === "text") {
			text = item.text;
		} else {
			image = item;
		}
	}
	if (text === undefined) {
		return { payload: null, image };
	}
	try {
		const parsed: unknown = JSON.parse(text);
		return { payload: parsed, image };
	} catch {
		return { payload: text, image };
	}
}

function stepFailureReason(runSteps: unknown): string | undefined {
	const steps = pick(runSteps, "steps");
	if (!Array.isArray(steps)) {
		return undefined;
	}
	for (const step of steps) {
		if (pick(step, "status") === "failed" || pick(step, "status") === "skipped") {
			return firstString(pick(step, "reason"));
		}
	}
	return undefined;
}

function describeFailure(
	result: ToolResult,
	payload: unknown,
): { readonly message: string; readonly refused: string | undefined } | undefined {
	const refusedEffect = pick(payload, "effect") === "refused";
	const runSteps = pick(payload, "runSteps");
	const stopped = pick(runSteps, "stoppedEarly") === true;
	if (result.isError !== true && !refusedEffect && !stopped) {
		return undefined;
	}
	const reason = firstString(pick(payload, "reason"));
	const message =
		firstString(
			pick(payload, "message"),
			pick(payload, "error"),
			stepFailureReason(runSteps),
			typeof payload === "string" ? payload : undefined,
			reason,
		) ?? "the action did not complete";
	return { message, refused: result.isError === true || refusedEffect ? reason : undefined };
}

const QUERY_KEYS: readonly (readonly [string, string])[] = [
	["role", "role"],
	["label", "label"],
	["label_contains", "label_contains"],
	["labelContains", "label_contains"],
	["value_contains", "value_contains"],
	["valueContains", "value_contains"],
	["text", "text"],
];

/** The snake_case element-query fields found in a script-supplied object (camelCase accepted too). */
function queryFields(source: unknown): Record<string, string> {
	const fields: Record<string, string> = {};
	for (const [from, to] of QUERY_KEYS) {
		const value = pick(source, from);
		if (typeof value === "string") {
			fields[to] = value;
		}
	}
	return fields;
}

function toElementQuery(fields: Record<string, string>): ElementQuery {
	const parsed = elementQuerySchema.safeParse(fields);
	if (!parsed.success) {
		throw invalid("a query needs at least one of role, label, label_contains, value_contains, or text");
	}
	const query = parsed.data;
	return {
		...(query.role === undefined ? {} : { role: query.role }),
		...(query.label === undefined ? {} : { label: query.label }),
		...(query.label_contains === undefined ? {} : { labelContains: query.label_contains }),
		...(query.value_contains === undefined ? {} : { valueContains: query.value_contains }),
		...(query.text === undefined ? {} : { text: query.text }),
	};
}

function mutates(step: RunStep): boolean {
	return step.type !== "wait_for";
}

/** Steps that act on ids or coordinates from a specific observation must not run on a silently refreshed one. */
function needsObservedIds(step: RunStep): boolean {
	switch (step.type) {
		case "wait_for":
		case "type_text":
		case "press_keys":
		case "invoke_menu":
		case "set_window_frame":
		case "clipboard_write":
			return false;
		default:
			return !("target" in step && step.target !== undefined) || typeof step.find?.scroll_within === "string";
	}
}

function checksFrom(checks: unknown): VerifyCheckRequest[] | undefined {
	if (checks === undefined) {
		return undefined;
	}
	if (!Array.isArray(checks)) {
		throw invalid("verify checks must be an array of {element_index, exists?, value?, label?}");
	}
	return checks.map((check: unknown): VerifyCheckRequest => {
		const index = pick(check, "element_index") ?? pick(check, "elementIndex");
		if (typeof index !== "number" && typeof index !== "string") {
			throw invalid("each verify check needs an element_index");
		}
		const exists = pick(check, "exists");
		const value = pick(check, "value");
		const label = pick(check, "label");
		return {
			element_index: String(index),
			...(typeof exists === "boolean" ? { exists } : {}),
			...(typeof value === "string" ? { value } : {}),
			...(typeof label === "string" ? { label } : {}),
		};
	});
}

function verifyRequestFrom(checks: unknown, options: unknown): VerifyRequest {
	const parsedChecks = checksFrom(checks);
	const windowTitle = firstString(pick(options, "windowTitle"), pick(options, "window_title"));
	const timeoutMs = pick(options, "timeoutMs") ?? pick(options, "timeout_ms");
	return {
		...(parsedChecks === undefined ? {} : { checks: parsedChecks }),
		...(windowTitle === undefined ? {} : { windowTitle }),
		...(typeof timeoutMs === "number"
			? { timeoutMs: Math.min(Math.max(1, Math.trunc(timeoutMs)), MAX_EXPECT_TIMEOUT_MS) }
			: {}),
	};
}

/** What one `apple.app(...)` handle acts on. */
interface AppTarget {
	readonly app: string;
	readonly window: WindowSelector | undefined;
	/** The id `window` resolved to; kept while that window stays open, even when its title changes. */
	windowId: number | undefined;
}

/** What an action's answer means for the run's tokens. */
interface ExecScope {
	/** The window the action's observation was bound to; undefined when it followed the app's focused window. */
	readonly windowId?: number | undefined;
	/** A listing that observes nothing leaves the app's live token alone. */
	readonly keepsTokens?: boolean;
}

function appTarget(app: string, options: unknown): AppTarget {
	if (options !== undefined && !isRecord(options)) {
		throw invalid('apple.app options are an object such as { window: "Report.txt" }');
	}
	const window = pick(options, "window");
	if (window === undefined) {
		return { app, window: undefined, windowId: undefined };
	}
	if (typeof window === "string" && window.trim() !== "") {
		return { app, window, windowId: undefined };
	}
	if (typeof window === "number" && Number.isSafeInteger(window) && window > 0) {
		return { app, window, windowId: window };
	}
	throw invalid("window is a window title (or a unique part of one) or a window_id from apple.windows()");
}

/** The window an observation made for this handle is bound to: undefined when it follows the focused window. */
function boundId(target: AppTarget): number | undefined {
	return target.window === undefined ? undefined : target.windowId;
}

/** A live token belongs to a handle when it was observed on the handle's own window (or both follow the focused one). */
function sameBinding(target: AppTarget, windowId: number | undefined): boolean {
	return target.window === undefined ? windowId === undefined : windowId !== undefined && windowId === target.windowId;
}

function describeTarget(target: AppTarget): string {
	return target.window === undefined ? target.app : `${target.app} window ${JSON.stringify(target.window)}`;
}

function windowOption(windowId: number | undefined): { readonly windowId?: number } {
	return windowId === undefined ? {} : { windowId };
}

/** One script run: owns the per-app tokens, serializes actions, and records what happened. */
class ScriptRun {
	readonly actions: ActionRecord[] = [];
	readonly logLines: string[] = [];
	logDropped = 0;
	lastImage: ToolContent | undefined;
	lastFailure: ActionRecord | undefined;
	private readonly tokens = new Map<string, { readonly token: string; readonly windowId: number | undefined }>();
	private dockToken: string | undefined;
	private dockElements: DockSnapshot["elements"] | undefined;
	private menubarToken: string | undefined;
	private menubarItems: readonly { readonly id: number }[] | undefined;
	private readonly tails = new Map<string, Promise<unknown>>();
	private nextAction: number;

	constructor(
		private readonly session: GuardedSession,
		private readonly driver: RunStepDriver,
		private readonly options: RunOptions,
		private readonly signal: AbortSignal,
		private readonly dockSession?: DockGuardSession,
		private readonly terminalSession?: TerminalGuardSession,
		private readonly extrasSession?: ExtrasGuardSession,
		private readonly appleScriptSession?: AppleScriptGuardSession,
	) {
		this.nextAction = 1;
	}

	osascript(source: unknown, options: unknown): Promise<unknown> {
		return this.queue("osascript", async () => {
			if (this.options.readOnly) throw this.refuseDock("read-only", "osascript is refused in a read-only run");
			const appleScriptSession = this.appleScriptSession;
			if (appleScriptSession === undefined)
				throw this.refuseDock("applescript-unavailable", "AppleScript is unavailable in this server");
			const fields = isRecord(options) ? options : {};
			return await this.execTerminal(
				"osascript",
				async () =>
					await appleScriptSession.run(source, {
						language: fields["language"],
						args: fields["args"],
						timeoutMs: fields["timeoutMs"] ?? fields["timeout_ms"],
					}),
				"osascript",
			);
		});
	}

	terminalRun(command: unknown): Promise<unknown> {
		return this.queue("terminal", async () => {
			if (this.options.readOnly)
				throw this.refuseDock("read-only", "run_script is read_only: Terminal command was not dispatched");
			if (this.signal.aborted) throw this.stopped();
			const terminalSession = this.terminalSession;
			if (terminalSession === undefined)
				throw this.refuseDock("terminal-unavailable", "Terminal session is unavailable");
			return await this.execTerminal("terminal.run", async () => await terminalSession.run(command));
		});
	}

	terminalRead(windowId: unknown): Promise<unknown> {
		return this.queue("terminal", async () => {
			if (this.signal.aborted) throw this.stopped();
			const terminalSession = this.terminalSession;
			if (terminalSession === undefined)
				throw this.refuseDock("terminal-unavailable", "Terminal session is unavailable");
			const result = terminalSession.read(windowId);
			if (typeof result === "string") return result;
			return await this.execTerminal("terminal.read", () => result);
		});
	}

	spacesActive(): { readonly activeSpaceId: number | undefined; readonly type?: number; readonly reason?: string } {
		try {
			const id = activeSpaceId();
			if (id === undefined) {
				return { activeSpaceId: undefined, reason: "active space is unavailable" };
			}
			const type = spaceTypeFor(id);
			return type === undefined ? { activeSpaceId: id } : { activeSpaceId: id, type };
		} catch (error: unknown) {
			return { activeSpaceId: undefined, reason: errorMessage(error) };
		}
	}

	async browser(tool: unknown, args: unknown): Promise<unknown> {
		if (typeof tool !== "string" || !BROWSER_TOOLS.has(tool)) {
			throw invalid(`apple.browser calls one of: ${[...BROWSER_TOOLS].join(", ")}`);
		}
		const caller = browserCallerSource();
		if (caller === undefined) {
			throw new ScriptActionError("OpenCUA Browser is not installed (no bsk binary). Run: opencua browser setup", {
				kind: "refused",
				refused: "browser-not-installed",
			});
		}
		const startedAt = Date.now();
		const n = this.nextAction++;
		try {
			const value = await caller.call(tool, isRecord(args) ? args : {});
			this.actions.push({ n, app: "browser", kind: tool, ms: Date.now() - startedAt, status: "ok" });
			return value;
		} catch (error: unknown) {
			this.actions.push({ n, app: "browser", kind: tool, ms: Date.now() - startedAt, status: "failed" });
			this.lastFailure = this.actions.at(-1);
			throw new ScriptActionError(errorMessage(error), {
				kind: "failed",
				payload: error instanceof BrowserCallError ? error.payload : undefined,
			});
		}
	}

	async cleanUp(keep: unknown): Promise<unknown> {
		if (this.options.readOnly) {
			throw this.refuseDock("read-only", "run_script is read_only: cleanUp was not run");
		}
		const names = Array.isArray(keep) ? keep.filter((entry): entry is string => typeof entry === "string") : [];
		return await cleanupLedger.cleanUp(cleanupDepsSource(), names);
	}

	visibleFrames(): readonly ScreenFrames[] {
		return visibleFramesSource() ?? [];
	}

	spacesDisplays(): ReturnType<typeof managedDisplaySpaces> {
		try {
			return managedDisplaySpaces();
		} catch {
			return [];
		}
	}

	menubarObserve(): Promise<unknown> {
		return this.queue("menubar", async () => {
			if (this.extrasSession === undefined)
				throw this.refuseDock("menubar-unavailable", "Menu extras are unavailable");
			const result = await this.extrasSession.observe();
			const parsed = parseResult(result).payload;
			const token = pick(parsed, "observation_token");
			this.menubarToken = typeof token === "string" ? token : undefined;
			const items = pick(parsed, "items");
			this.menubarItems = Array.isArray(items)
				? items.filter((item): item is { readonly id: number } => isRecord(item) && typeof item["id"] === "number")
				: undefined;
			const failure = describeFailure(result, parsed);
			if (failure !== undefined) throw this.refuseDock(failure.refused ?? "menubar-observe-failed", failure.message);
			return parsed;
		});
	}

	menubarPress(elementId: unknown): Promise<unknown> {
		return this.queue("menubar", async () => {
			if (this.options.readOnly)
				throw this.refuseDock("read-only", "run_script is read_only: menu extra press was not dispatched");
			if (this.signal.aborted) throw this.stopped();
			if (this.extrasSession === undefined)
				throw this.refuseDock("menubar-unavailable", "Menu extras are unavailable");
			if (typeof elementId !== "number" || !Number.isSafeInteger(elementId) || elementId < 0)
				throw this.refuseDock("invalid-argument", "menu extra id must be a non-negative integer");
			const token = this.menubarToken;
			const observed = this.menubarItems?.some((item) => item.id === elementId);
			this.menubarToken = undefined;
			this.menubarItems = undefined;
			if (token === undefined)
				throw this.refuseDock("needs-observation", "call apple.menubar().observe() before pressing an id");
			if (observed !== true)
				throw this.refuseDock("menubar-element-not-observed", "press only an observed menu extra id");
			const result = await this.queueExtrasSession(
				this.extrasSession,
				() => this.extrasSession?.act(token, elementId) ?? Promise.resolve({ content: [] }),
			);
			const parsed = parseResult(result).payload;
			const failure = describeFailure(result, parsed);
			if (failure !== undefined) throw this.refuseDock(failure.refused ?? "menubar-action-failed", failure.message);
			return parsed;
		});
	}

	private queueExtrasSession<T>(session: ExtrasGuardSession, work: () => Promise<T>): Promise<T> {
		const next = (extrasRunTails.get(session) ?? Promise.resolve()).then(() => {
			if (this.signal.aborted) throw this.stopped();
			return work();
		});
		extrasRunTails.set(
			session,
			next.then(
				() => undefined,
				() => undefined,
			),
		);
		return next;
	}

	private async execTerminal(
		kind: string,
		call: () => Promise<ToolResult> | ToolResult,
		app = "Terminal",
	): Promise<unknown> {
		const startedAt = Date.now();
		const n = this.nextAction++;
		const result = await call();
		const payload = parseResult(result).payload;
		const failure = describeFailure(result, isRecord(payload) ? payload : {});
		this.actions.push({
			n,
			app,
			kind,
			ms: Date.now() - startedAt,
			status: failure === undefined ? "ok" : `refused:${failure.refused ?? "failed"}`,
		});
		if (failure !== undefined) {
			this.lastFailure = this.actions.at(-1);
			throw new ScriptActionError(failure.message, {
				kind: failure.refused === undefined ? "failed" : "refused",
				payload,
				...(failure.refused === undefined ? {} : { refused: failure.refused }),
			});
		}
		return payload;
	}

	dockObserve(): Promise<unknown> {
		return this.queue("dock", async () => {
			if (this.dockSession === undefined) throw this.refuseDock("dock-unavailable", "Dock is unavailable");
			const dockSession = this.dockSession;
			return await this.queueDockSession(
				dockSession,
				async () => await this.execDock("dock.observe", async () => await dockSession.observe()),
			);
		});
	}

	dockAct(rawTarget: unknown, action: DockAction): Promise<unknown> {
		return this.queue("dock", async () => {
			if (this.options.readOnly) {
				throw this.refuseDock("read-only", "run_script is read_only: Dock action was not dispatched");
			}
			if (this.signal.aborted) throw this.stopped();
			if (this.dockSession === undefined) throw this.refuseDock("dock-unavailable", "Dock is unavailable");
			const dockSession = this.dockSession;
			return await this.queueDockSession(
				dockSession,
				async () => await this.actDockInSession(dockSession, rawTarget, action),
			);
		});
	}

	private async actDockInSession(
		dockSession: DockGuardSession,
		rawTarget: unknown,
		action: DockAction,
	): Promise<unknown> {
		let token = this.dockToken;
		let elementId: number;
		if (typeof rawTarget === "number" || typeof rawTarget === "string") {
			if (this.dockElements === undefined || token === undefined)
				throw this.refuseDock("needs-observation", "call apple.dock().observe() before acting on a Dock id");
			if (typeof rawTarget === "string" && rawTarget.trim() === "")
				throw this.refuseDock("invalid-argument", "Dock id must be a non-negative integer");
			try {
				elementId = parseElementIndex(rawTarget);
			} catch {
				throw this.refuseDock("invalid-argument", "Dock id must be a non-negative integer");
			}
		} else if (isRecord(rawTarget)) {
			const allowed = new Set(["role", "label", "label_contains", "value_contains", "text", "index"]);
			if (Object.keys(rawTarget).some((key) => !allowed.has(key)))
				throw this.refuseDock("invalid-argument", "invalid Dock query target");
			const fields = queryFields(rawTarget);
			const query = toElementQuery(fields);
			if (token === undefined || dockSession.observedElements(token) === undefined) {
				this.clearDockObservation();
				await this.execDock("dock.observe", async () => await dockSession.observe());
				token = this.dockToken;
			}
			if (this.dockElements === undefined || token === undefined)
				throw this.refuseDock("needs-observation", "Dock observation returned no token");
			const matches = this.dockElements.filter((element) => dockMatches(element, query));
			const index = rawTarget["index"];
			if (index !== undefined && (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0))
				throw this.refuseDock("invalid-argument", "Dock query index must be a non-negative integer");
			const selected = index === undefined ? (matches.length === 1 ? matches[0] : undefined) : matches[index];
			if (selected === undefined || (index === undefined && matches.length !== 1))
				throw this.refuseDock(
					matches.length === 0 ? "dock-element-not-observed" : "dock-target-ambiguous",
					"Dock query must resolve to exactly one observed element",
				);
			elementId = selected.id;
		} else {
			throw this.refuseDock("invalid-argument", "Dock target is an observed id or query object");
		}
		if (this.signal.aborted) throw this.stopped();
		if (token === undefined || this.dockElements === undefined)
			throw this.refuseDock("needs-observation", "Dock observation token is unavailable");
		const observedToken = token;
		return await this.execDock(`dock.${action}`, async () => await dockSession.act(observedToken, elementId, action));
	}

	private queueDockSession<T>(dockSession: DockGuardSession, work: () => Promise<T>): Promise<T> {
		const next = (dockRunTails.get(dockSession) ?? Promise.resolve()).then(() => {
			if (this.signal.aborted) throw this.stopped();
			return work();
		});
		dockRunTails.set(
			dockSession,
			next.then(
				() => undefined,
				() => undefined,
			),
		);
		return next;
	}

	private refuseDock(refused: string, message: string): ScriptActionError {
		this.clearDockObservation();
		const entry = { n: this.nextAction++, app: "Dock", kind: "dock", ms: 0, status: `refused:${refused}` };
		this.actions.push(entry);
		this.lastFailure = entry;
		return new ScriptActionError(message, { kind: "refused", refused });
	}

	private async execDock(kind: string, call: () => Promise<ToolResult>): Promise<unknown> {
		if (this.signal.aborted) throw this.stopped();
		const n = this.nextAction++;
		const startedAt = Date.now();
		let result: ToolResult;
		try {
			result = await call();
		} catch (error) {
			this.clearDockObservation();
			this.lastFailure = { n, app: "Dock", kind, ms: Date.now() - startedAt, status: "error" };
			this.actions.push(this.lastFailure);
			throw new ScriptActionError(errorMessage(error), { kind: "error" });
		}
		let parsed: unknown;
		try {
			parsed = parseResult(result).payload;
		} catch (error) {
			this.clearDockObservation();
			this.lastFailure = { n, app: "Dock", kind, ms: Date.now() - startedAt, status: "error" };
			this.actions.push(this.lastFailure);
			throw new ScriptActionError(errorMessage(error), { kind: "error" });
		}
		if (!isRecord(parsed)) {
			this.clearDockObservation();
			this.lastFailure = { n, app: "Dock", kind, ms: Date.now() - startedAt, status: "error" };
			this.actions.push(this.lastFailure);
			throw new ScriptActionError("Dock returned a non-object result", { kind: "error" });
		}
		const payload = parsed;
		const failure = describeFailure(result, payload);
		const record = (status: string): void => {
			const entry = { n, app: "Dock", kind, ms: Date.now() - startedAt, status };
			this.actions.push(entry);
			if (failure !== undefined) this.lastFailure = entry;
		};
		if (failure !== undefined) {
			this.clearDockObservation();
			record(failure.refused === undefined ? "failed" : `refused:${failure.refused}`);
			throw new ScriptActionError(failure.message, {
				kind: failure.refused === undefined ? "failed" : "refused",
				payload,
				...(failure.refused === undefined ? {} : { refused: failure.refused }),
			});
		}
		record(
			firstString(pick(payload, "effect")) ?? (pick(payload, "actionDispatched") === true ? "dispatched" : "ok"),
		);
		const token = pick(payload, "observation_token");
		const dockSession = this.dockSession;
		const elements =
			typeof token === "string" && dockSession !== undefined ? dockSession.observedElements(token) : undefined;
		if (typeof token === "string" && elements !== undefined) {
			this.dockToken = token;
			this.dockElements = elements;
		} else this.clearDockObservation();
		return payload;
	}

	private clearDockObservation(): void {
		this.dockToken = undefined;
		this.dockElements = undefined;
	}

	log(text: string): void {
		if (this.logLines.length >= MAX_LOG_ENTRIES) {
			this.logDropped += 1;
			return;
		}
		this.logLines.push(text.slice(0, MAX_LOG_CHARS));
	}

	private stopped(): ScriptActionError {
		return new ScriptActionError("run_script was stopped; no further actions are dispatched", {
			kind: "aborted",
			refused: "aborted",
		});
	}

	/** One queue per app, so different apps overlap while one app's actions stay in order. */
	private queue<T>(app: string, work: () => Promise<T>): Promise<T> {
		const key = this.options.parallelApps && app.toLowerCase() !== "dock" ? app.toLowerCase() : "";
		const next = (this.tails.get(key) ?? Promise.resolve()).then(() => {
			if (this.signal.aborted) {
				throw this.stopped();
			}
			return work();
		});
		this.tails.set(
			key,
			next.then(
				() => undefined,
				() => undefined,
			),
		);
		return next;
	}

	private async exec(
		app: string,
		kind: string,
		call: () => Promise<ToolResult>,
		scope: ExecScope = {},
	): Promise<unknown> {
		if (this.signal.aborted) {
			throw this.stopped();
		}
		const key = app.toLowerCase();
		const n = this.nextAction++;
		const startedAt = Date.now();
		const record = (status: string): ActionRecord => {
			const entry = { n, app, kind, ms: Date.now() - startedAt, status };
			this.actions.push(entry);
			return entry;
		};
		let result: ToolResult;
		try {
			result = await call();
		} catch (error: unknown) {
			if (scope.keepsTokens !== true) {
				this.tokens.delete(key);
			}
			this.lastFailure = record("error");
			throw new ScriptActionError(errorMessage(error), { kind: "error" });
		}
		const { payload, image } = parseResult(result);
		if (scope.keepsTokens !== true) {
			const token = pick(payload, "observation_token");
			if (typeof token === "string") {
				this.tokens.set(key, { token, windowId: scope.windowId });
			} else {
				this.tokens.delete(key);
			}
		}
		if (this.options.includeScreenshot && image !== undefined) {
			this.lastImage = image;
		}
		const failure = describeFailure(result, payload);
		if (failure !== undefined) {
			this.lastFailure = record(failure.refused === undefined ? "failed" : `refused:${failure.refused}`);
			throw new ScriptActionError(failure.message, {
				kind: failure.refused === undefined ? "failed" : "refused",
				payload,
				...(failure.refused === undefined ? {} : { refused: failure.refused }),
			});
		}
		record(firstString(pick(payload, "effect")) ?? "ok");
		return payload;
	}

	private async tokenFor(target: AppTarget, needsIds: boolean): Promise<string> {
		const key = target.app.toLowerCase();
		const existing = this.tokens.get(key);
		if (existing !== undefined && sameBinding(target, existing.windowId)) {
			return existing.token;
		}
		if (needsIds) {
			throw new ScriptActionError(
				`no live observation of ${describeTarget(target)}: call observe() or find() before acting on an element id or coordinates`,
				{ kind: "refused", refused: "needs-observation" },
			);
		}
		const windowId = await this.windowIdFor(target);
		await this.exec(
			target.app,
			"observe",
			() =>
				this.session.observe({
					app: target.app,
					diffOnly: false,
					includeScreenshot: false,
					...windowOption(windowId),
				}),
			{ windowId },
		);
		const fresh = this.tokens.get(key);
		if (fresh === undefined) {
			throw new ScriptActionError(`observing ${describeTarget(target)} returned no observation token`, {
				kind: "refused",
				refused: "needs-observation",
			});
		}
		return fresh.token;
	}

	/**
	 * The window a bound handle acts on: the one it resolved to before, while that window is still open
	 * (its title may have changed since, as a document's does once edited), else the one window whose
	 * title is `window` exactly or, failing that, contains it in any case. No match, or several, is refused
	 * with the app's windows named. Undefined for a handle that follows the app's focused window.
	 */
	private async windowIdFor(target: AppTarget): Promise<number | undefined> {
		const selector = target.window;
		if (typeof selector !== "string") {
			return selector;
		}
		let windows: readonly TopLevelWindow[];
		let pid: number;
		try {
			({ pid, windows } = await this.session.windowsOf(target.app));
		} catch (error: unknown) {
			throw this.refuseWindow(target, errorMessage(error), "app-not-running");
		}
		if (WINDOW_REF_PATTERN.test(selector)) {
			const named = windowForRef(selector);
			if (named === undefined || named.pid !== pid || !windows.some((window) => window.id === named.windowId)) {
				throw this.refuseWindow(
					target,
					`window ref ${selector} names no open ${target.app} window (it was closed, or belongs to another app); list them again with apple.windows("${target.app}")`,
					"window-not-found",
				);
			}
			target.windowId = named.windowId;
			return named.windowId;
		}
		if (target.windowId !== undefined && windows.some((window) => window.id === target.windowId)) {
			return target.windowId;
		}
		const exact = windows.filter((window) => window.title === selector);
		const part = selector.toLowerCase();
		const matches = exact.length > 0 ? exact : windows.filter((window) => window.title.toLowerCase().includes(part));
		const [only, ...others] = matches;
		if (only !== undefined && others.length === 0) {
			target.windowId = only.id;
			return only.id;
		}
		const listed = windows.map((window) => `${window.id} ${JSON.stringify(window.title)}`).join(", ") || "none";
		throw this.refuseWindow(
			target,
			only === undefined
				? `no ${target.app} window title matches ${JSON.stringify(selector)}; its windows: ${listed}`
				: `${matches.length} ${target.app} windows match ${JSON.stringify(selector)}; name one exactly or by window_id. Its windows: ${listed}`,
			only === undefined ? "window-not-found" : "window-ambiguous",
		);
	}

	/** A window binding that cannot be resolved: recorded as a refused action, and nothing is dispatched. */
	private refuseWindow(target: AppTarget, message: string, refused: string): ScriptActionError {
		const entry = { n: this.nextAction++, app: target.app, kind: "window", ms: 0, status: `refused:${refused}` };
		this.actions.push(entry);
		this.lastFailure = entry;
		return new ScriptActionError(message, { kind: "refused", refused });
	}

	observe(target: AppTarget, options: unknown): Promise<unknown> {
		const parsed = observationOptionsSchema.safeParse(observeOptions(options));
		if (!parsed.success) {
			const valid = Object.keys(observationOptionsSchema.shape).join(", ");
			throw invalid(
				`invalid observe options: ${parsed.error.issues
					.map((issue) =>
						issue.code === "unrecognized_keys"
							? `unknown key ${issue.keys.map((key) => JSON.stringify(key)).join(", ")}`
							: `${issue.path.join(".")}: ${issue.message}`,
					)
					.join("; ")}; valid keys: ${valid}`,
			);
		}
		const { diffOnly, maxElements, includeScreenshot, includeMenuBar, subtreeOf, visibleOnly, elementFormat } =
			parsed.data;
		return this.queue(target.app, async () => {
			const windowId = await this.windowIdFor(target);
			return await this.exec(
				target.app,
				"observe",
				() =>
					this.session.observe({
						app: target.app,
						diffOnly: diffOnly === true,
						includeScreenshot: this.options.includeScreenshot && includeScreenshot !== false,
						...(typeof maxElements === "number" ? { maxElements } : {}),
						...(includeMenuBar === undefined ? {} : { includeMenuBar }),
						...(subtreeOf === undefined ? {} : { subtreeOf }),
						...(visibleOnly === undefined ? {} : { visibleOnly }),
						...(elementFormat === undefined ? {} : { elementFormat }),
						...windowOption(windowId),
					}),
				{ windowId },
			);
		});
	}

	find(target: AppTarget, query: unknown, options: unknown): Promise<unknown> {
		const maxResults = pick(options, "maxResults");
		const maxElements = pick(options, "maxElements");
		return this.queue(target.app, async () => {
			const windowId = await this.windowIdFor(target);
			return await this.exec(
				target.app,
				"find",
				() =>
					this.session.findElements({
						app: target.app,
						query: toElementQuery(queryFields(query)),
						includeScreenshot: this.options.includeScreenshot,
						...(typeof maxResults === "number" ? { maxResults: Math.min(maxResults, MAX_FIND_RESULTS) } : {}),
						...(typeof maxElements === "number" ? { maxElements } : {}),
						...windowOption(windowId),
					}),
				{ windowId },
			);
		});
	}

	/** Every on-screen window, or `app`'s, as list_windows answers (titles filled in from the apps). */
	windows(app: unknown): Promise<unknown> {
		if (app !== undefined && (typeof app !== "string" || app === "")) {
			throw invalid("apple.windows takes an app name, or nothing for every app's windows");
		}
		const label = app ?? "*";
		return this.queue(label, async () => {
			const payload = await this.exec(
				label,
				"list_windows",
				() => this.session.listWindows(app === undefined ? {} : { app }),
				{ keepsTokens: true },
			);
			return pick(payload, "windows") ?? [];
		});
	}

	apps(): Promise<unknown> {
		return this.queue("*", () => this.exec("*", "list_apps", () => this.session.listApps()));
	}

	private parseStep(app: string, raw: StepObject): RunStep {
		const parsed = runStepSchema.safeParse(raw);
		if (!parsed.success) {
			throw invalid(
				`invalid step: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
			);
		}
		const step = parsed.data;
		if (mutates(step) && this.options.readOnly) {
			const entry = { n: this.nextAction++, app, kind: step.type, ms: 0, status: "refused:read-only" };
			this.actions.push(entry);
			this.lastFailure = entry;
			throw new ScriptActionError(`run_script is read_only: ${step.type} was not dispatched`, {
				kind: "refused",
				refused: "read-only",
			});
		}
		return step;
	}

	private async runParsed(
		target: AppTarget,
		kind: string,
		steps: readonly RunStep[],
		expectOptions: unknown,
		pace?: RunPace,
	): Promise<unknown> {
		const expectInput = pick(expectOptions, "expect");
		const expectation =
			expectInput === undefined ? undefined : verifyRequestFrom(pick(expectInput, "checks"), expectInput);
		const token = await this.tokenFor(target, steps.some(needsObservedIds));
		return await this.exec(
			target.app,
			kind,
			() =>
				this.session.runSteps(
					token,
					target.app,
					steps,
					expectation,
					this.driver,
					{ fullState: false, includeScreenshot: this.options.includeScreenshot, retainTree: true },
					{ signal: this.signal, ...(pace === undefined ? {} : { pace }) },
				),
			{ windowId: boundId(target) },
		);
	}

	step(target: AppTarget, raw: StepObject, expectOptions?: unknown): Promise<unknown> {
		return this.queue(target.app, async () => {
			const step = this.parseStep(target.app, raw);
			return await this.runParsed(target, step.type, [step], expectOptions);
		});
	}

	/**
	 * Several steps in one guarded call: one token, one preflight, one outcome read, stops at the first failure.
	 * With pace "fast" they dispatch back to back, guarded by cheap checks instead of a read before each step.
	 */
	batch(target: AppTarget, raws: unknown, options?: unknown, forcedPace?: RunPace): Promise<unknown> {
		return this.queue(target.app, async () => {
			const requested = pick(options, "pace");
			if (requested !== undefined && requested !== "fast" && requested !== "verified") {
				throw invalid('pace is "verified" or "fast"');
			}
			const pace: RunPace | undefined = forcedPace ?? requested;
			if (!Array.isArray(raws) || raws.length === 0 || raws.length > MAX_BATCH_STEPS) {
				throw invalid(`batch needs an array of 1 to ${MAX_BATCH_STEPS} step objects`);
			}
			const steps = raws.map((raw: unknown) => {
				if (!isRecord(raw)) {
					throw invalid("each batch entry is a step object such as apple.steps.click({label:'OK'})");
				}
				return this.parseStep(target.app, raw);
			});
			return await this.runParsed(target, "batch", steps, options, pace);
		});
	}

	/** run_hands from a script: each chunk's keyboard, pointer and vision lanes run at once, chunk after chunk. */
	hands(target: AppTarget, spec: unknown, options?: unknown): Promise<unknown> {
		return this.queue(target.app, async () => {
			const parsed = handsSpecSchema.safeParse(spec);
			if (!parsed.success) {
				throw invalid(
					`invalid hands spec: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
				);
			}
			let chunks: ReturnType<typeof handsChunksFrom>;
			try {
				chunks = handsChunksFrom(parsed.data, "app.hands");
			} catch (error: unknown) {
				throw invalid(errorMessage(error));
			}
			const steps = chunks.flatMap((chunk) => [...chunk.keyboard, ...chunk.pointer]);
			if (steps.length > 0 && this.options.readOnly) {
				const entry = { n: this.nextAction++, app: target.app, kind: "hands", ms: 0, status: "refused:read-only" };
				this.actions.push(entry);
				this.lastFailure = entry;
				throw new ScriptActionError("run_script is read_only: hands was not dispatched", {
					kind: "refused",
					refused: "read-only",
				});
			}
			const expectInput = pick(options, "expect");
			const expectation =
				expectInput === undefined ? undefined : verifyRequestFrom(pick(expectInput, "checks"), expectInput);
			const token = await this.tokenFor(target, steps.some(needsObservedIds));
			return await this.exec(
				target.app,
				"hands",
				() =>
					this.session.runHands(
						{
							app: target.app,
							token,
							chunks,
							overlap: parsed.data.overlap ?? "auto",
							...(expectation === undefined ? {} : { expect: expectation }),
							fullState: false,
							includeScreenshot: this.options.includeScreenshot,
						},
						this.driver,
						{ signal: this.signal },
					),
				{ windowId: boundId(target) },
			);
		});
	}

	verify(target: AppTarget, checks: unknown, options: unknown): Promise<unknown> {
		return this.queue(target.app, async () => {
			const request = verifyRequestFrom(checks, options);
			const token = await this.tokenFor(target, request.checks !== undefined && request.checks.length > 0);
			return await this.exec(target.app, "verify", () => this.session.verify(token, target.app, request), {
				windowId: boundId(target),
			});
		});
	}
}

type StepObject = Record<string, unknown>;

/** The compiled worker next to this module, else (running from TypeScript source) the source file. */
const WORKER_URL = ((): URL => {
	const compiled = new URL("./script-worker.js", import.meta.url);
	return existsSync(fileURLToPath(compiled)) ? compiled : new URL("./script-worker.ts", import.meta.url);
})();

/** A runaway script exhausts its own heap, not the server's. */
const WORKER_HEAP_MB = 256;

function spawnWorker(): Worker {
	const worker = new Worker(WORKER_URL, { stdout: true, resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB } });
	worker.unref();
	return worker;
}

/** One idle worker kept ready, so a run does not wait for a thread and module load; every run gets a fresh one. */
let spareWorker: Worker | undefined;

function warmWorker(): void {
	if (spareWorker !== undefined) {
		return;
	}
	const worker = spawnWorker();
	const discard = (): void => {
		if (spareWorker === worker) {
			spareWorker = undefined;
		}
	};
	worker.on("error", discard);
	worker.on("exit", discard);
	spareWorker = worker;
}

function takeWorker(): Worker {
	const worker = spareWorker ?? spawnWorker();
	spareWorker = undefined;
	return worker;
}

function callError(error: unknown): CallError {
	if (error instanceof ScriptActionError) {
		return {
			kind: error.kind,
			message: error.message,
			name: error.name,
			refused: error.refused,
			payload: error.payload,
		};
	}
	const name = isRecord(error) && typeof error["name"] === "string" ? error["name"] : "Error";
	const message = isRecord(error) && typeof error["message"] === "string" ? error["message"] : String(error);
	return { kind: "unexpected", message, name, refused: undefined, payload: undefined };
}

/** One worker call, performed through the guarded run exactly as an in-process script's call was. */
async function perform(
	run: ScriptRun,
	targets: Map<number, AppTarget>,
	call: Extract<WorkerMessage, { readonly type: "call" }>,
): Promise<unknown> {
	const handle = (spec: WorkerTarget | undefined): AppTarget => {
		if (spec === undefined) {
			throw invalid("this call needs an app handle");
		}
		const known = targets.get(spec.id);
		if (known !== undefined) {
			return known;
		}
		const created = appTarget(spec.app, spec.window === undefined ? undefined : { window: spec.window });
		targets.set(spec.id, created);
		return created;
	};
	const [first, second] = call.args;
	switch (call.method) {
		case "apps":
			return await run.apps();
		case "windows":
			return await run.windows(first);
		case "observe":
			return await run.observe(handle(call.target), first);
		case "find":
			return await run.find(handle(call.target), first, second);
		case "step":
			if (!isRecord(first)) {
				throw invalid("step needs a step object such as {type:'click', element_index:'9'}");
			}
			return await run.step(handle(call.target), first, second);
		case "batch":
			return await run.batch(handle(call.target), first, second);
		case "chain":
			return await run.batch(handle(call.target), first, second, "fast");
		case "hands":
			return await run.hands(handle(call.target), first, second);
		case "verify":
			return await run.verify(handle(call.target), first, second);
		case "dockObserve":
			return await run.dockObserve();
		case "dockAct":
			if (second !== "AXPress" && second !== "AXShowMenu" && second !== "AXCancel") {
				throw invalid("Dock action must be AXPress, AXShowMenu, or AXCancel");
			}
			return await run.dockAct(first, second);
		case "terminalRun":
			return await run.terminalRun(first);
		case "terminalRead":
			return await run.terminalRead(first);
		case "osascript":
			return await run.osascript(first, second);
		case "spacesActive":
			return run.spacesActive();
		case "spacesDisplays":
			return run.spacesDisplays();
		case "visibleFrames":
			return run.visibleFrames();
		case "cleanUp":
			return await run.cleanUp(first);
		case "browser":
			return await run.browser(first, second);
		case "menubarObserve":
			return await run.menubarObserve();
		case "menubarPress":
			return await run.menubarPress(first);
		default:
			throw new Error(`Unhandled script call method: ${call.method satisfies never}`);
	}
}

/**
 * Runs the script in a worker thread and answers its action calls. The abort signal (timeout or cancellation)
 * terminates the worker, so a script that never yields cannot stall this thread.
 */
function runInWorker(code: string, run: ScriptRun, signal: AbortSignal, timeoutMs: number): Promise<ScriptOutcome> {
	const worker = takeWorker();
	const targets = new Map<number, AppTarget>();
	return new Promise<ScriptOutcome>((resolve) => {
		let settled = false;
		const finish = (outcome: ScriptOutcome): void => {
			if (settled) {
				return;
			}
			settled = true;
			signal.removeEventListener("abort", onAbort);
			void worker.terminate();
			resolve(outcome);
		};
		const onAbort = (): void => {
			if (signal.reason === "timeout") {
				finish({
					ok: false,
					kind: "timeout",
					error: `run_script timed out after ${timeoutMs} ms; no further actions were dispatched`,
				});
				return;
			}
			finish({
				ok: false,
				kind: "cancelled",
				error: "run_script was cancelled; no further actions were dispatched",
			});
		};
		const answer = async (call: Extract<WorkerMessage, { readonly type: "call" }>): Promise<void> => {
			let reply: HostMessage;
			try {
				reply = { type: "reply", id: call.id, ok: true, value: await perform(run, targets, call) };
			} catch (error: unknown) {
				reply = { type: "reply", id: call.id, ok: false, error: callError(error) };
			}
			if (!settled) {
				worker.postMessage(reply);
			}
		};
		worker.on("message", (message: WorkerMessage) => {
			if (settled) {
				return;
			}
			if (message.type === "log") {
				run.log(message.text);
			} else if (message.type === "done") {
				run.logDropped += message.logDropped;
				finish(message.outcome);
			} else {
				void answer(message);
			}
		});
		worker.on("error", (error: Error) => finish({ ok: false, kind: "script-error", error: errorMessage(error) }));
		worker.on("exit", () =>
			finish({ ok: false, kind: "script-error", error: "the run_script worker exited before the script finished" }),
		);
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
		worker.postMessage({ type: "run", code } satisfies HostMessage);
	});
}

function jsonResult(body: Record<string, unknown>, isError: boolean, image: ToolContent | undefined): ToolResult {
	const content: ToolContent[] = [{ type: "text", text: JSON.stringify(body) }];
	if (image !== undefined) {
		content.push(image);
	}
	return isError ? { isError: true, content } : { content };
}

export function registerScriptTools(
	server: McpServer,
	session: GuardedSession,
	computer: GuardedComputerInterface,
	dockSession?: DockGuardSession,
	terminalSession?: TerminalGuardSession,
	extrasSession?: ExtrasGuardSession,
	appleScriptSession?: AppleScriptGuardSession,
): void {
	warmWorker();
	server.registerTool(
		"run_script",
		{
			description: RUN_SCRIPT_DESCRIPTION,
			inputSchema: runScriptSchema,
			annotations: { readOnlyHint: false, destructiveHint: true },
		},
		async (input, extra) => {
			const startedAt = Date.now();
			const timeoutMs = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;
			const controller = new AbortController();
			const onRequestAbort = (): void => controller.abort("cancelled");
			if (extra.signal.aborted) {
				controller.abort("cancelled");
			} else {
				extra.signal.addEventListener("abort", onRequestAbort, { once: true });
			}
			const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
			const run = new ScriptRun(
				session,
				createRunStepDriver(computer),
				{
					parallelApps: computer.delivery === "background",
					readOnly: input.read_only === true,
					includeScreenshot: input.include_screenshot === true,
				},
				controller.signal,
				dockSession,
				terminalSession,
				extrasSession,
				appleScriptSession,
			);
			try {
				const outcome = controller.signal.aborted
					? ({ ok: false, kind: "cancelled", error: "run_script was cancelled before it started" } as const)
					: await runInWorker(input.code, run, controller.signal, timeoutMs);
				const common = {
					log: run.logLines,
					...(run.logDropped === 0 ? {} : { logDropped: run.logDropped }),
					actions: run.actions,
					elapsedMs: Date.now() - startedAt,
				};
				const image = input.include_screenshot === true ? run.lastImage : undefined;
				if (outcome.ok) {
					return jsonResult(
						{
							ok: true,
							value: outcome.value,
							...(outcome.valueTruncated ? { valueTruncated: true } : {}),
							...common,
						},
						false,
						image,
					);
				}
				return jsonResult(
					{
						ok: false,
						kind: outcome.kind,
						error: outcome.error,
						...(run.lastFailure === undefined ? {} : { failedAction: run.lastFailure }),
						...(outcome.payload === undefined ? {} : { payload: outcome.payload }),
						...common,
					},
					true,
					image,
				);
			} finally {
				clearTimeout(timer);
				extra.signal.removeEventListener("abort", onRequestAbort);
				controller.abort("finished");
				warmWorker();
			}
		},
	);
}
