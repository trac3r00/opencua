/**
 * The run_script worker: runs the agent's JavaScript in a vm context inside a worker thread, so the host can
 * terminate a script that never yields. Every action is an RPC to the host, which performs it through the guarded
 * session. Kept self-contained (type-only relative imports) so it also loads as TypeScript source under test.
 */
import { Script, createContext } from "node:vm";
import { parentPort } from "node:worker_threads";
import type {
	CallError,
	CallMethod,
	HostMessage,
	ScriptOutcome,
	WindowSelector,
	WorkerMessage,
	WorkerTarget,
} from "./script-protocol.js";

const MAX_SLEEP_MS = 10_000;
const MAX_VALUE_CHARS = 20_000;
const MAX_LOG_ENTRIES = 200;
const MAX_LOG_CHARS = 2_000;

const port = parentPort;
if (port === null) {
	throw new Error("script-worker must run inside a worker thread");
}

class ScriptActionError extends Error {
	readonly kind: string;
	readonly payload: unknown;
	readonly refused: string | undefined;

	constructor(
		message: string,
		details: { readonly kind: string; readonly payload?: unknown; readonly refused?: string | undefined },
	) {
		super(message);
		this.name = "ScriptActionError";
		this.kind = details.kind;
		this.payload = details.payload;
		this.refused = details.refused;
	}
}

type StepObject = Record<string, unknown>;

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

function invalid(message: string): ScriptActionError {
	return new ScriptActionError(message, { kind: "invalid-argument", refused: "invalid-argument" });
}

function defined(entries: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined));
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

/** A target is an element id (number or string) or a query object with an optional match index. */
function targetFields(target: unknown): Record<string, unknown> {
	if (
		(typeof target === "number" && Number.isInteger(target) && target >= 0) ||
		(typeof target === "string" && target !== "")
	) {
		return { element_index: String(target) };
	}
	if (isRecord(target)) {
		const fields = queryFields(target);
		if (Object.keys(fields).length === 0) {
			throw invalid("a target object needs at least one of role, label, label_contains, value_contains, or text");
		}
		const index = target["index"];
		return { target: fields, ...(typeof index === "number" ? { target_index: index } : {}) };
	}
	throw invalid("a target is an element id (number or string) or a query object");
}

/** The scroll-until-found `find` field of a step, from the options an app method takes (camelCase or snake_case). */
function findFields(options: unknown): Record<string, unknown> {
	const nested = pick(options, "find");
	const source = isRecord(nested) ? nested : options;
	const within = pick(source, "scrollWithin") ?? pick(source, "scroll_within");
	const fields = defined({
		scroll_within: typeof within === "number" ? String(within) : isRecord(within) ? queryFields(within) : within,
		direction: pick(source, "findDirection") ?? pick(source, "direction"),
		max_pages: pick(source, "maxPages") ?? pick(source, "max_pages"),
		vision: pick(source, "vision"),
	});
	return Object.keys(fields).length === 0 && !isRecord(nested) ? {} : { find: fields };
}

/** A step's target fields with its optional scroll-until-found search; the search needs a described target. */
function targetWithFind(target: unknown, options: unknown): Record<string, unknown> {
	const fields = targetFields(target);
	const find = findFields(options);
	if ("find" in find && !("target" in fields)) {
		throw invalid(
			"scroll-until-found options (scrollWithin, maxPages, vision) need a query target, not an element id",
		);
	}
	return { ...fields, ...find };
}

/** Build run_steps step objects from the same arguments the app methods take, for `app.batch([...])`. */
const stepBuilders = Object.freeze({
	click: (target: unknown, options?: unknown): StepObject => ({
		type: "click",
		...targetWithFind(target, options),
		...defined({
			click_count: pick(options, "clickCount") ?? pick(options, "click_count"),
			mouse_button: pick(options, "mouseButton") ?? pick(options, "mouse_button"),
			modifiers: pick(options, "modifiers"),
		}),
	}),
	drag: (from: unknown, to: unknown, options?: unknown): StepObject => ({
		type: "drag",
		from_x: pick(from, "x"),
		from_y: pick(from, "y"),
		to_x: pick(to, "x"),
		to_y: pick(to, "y"),
		...defined({
			duration_ms: pick(options, "durationMs") ?? pick(options, "duration_ms"),
			modifiers: pick(options, "modifiers"),
		}),
	}),
	setValue: (target: unknown, value: unknown, options?: unknown): StepObject => ({
		type: "set_value",
		...targetWithFind(target, options),
		value,
	}),
	type: (text: unknown): StepObject => ({ type: "type_text", text }),
	press: (keys: unknown, options?: unknown): StepObject => ({
		type: "press_keys",
		keys: typeof keys === "string" ? [keys] : keys,
		...defined({
			hold_seconds: pick(options, "holdSeconds") ?? pick(options, "hold_seconds"),
			interval_seconds: pick(options, "intervalSeconds") ?? pick(options, "interval_seconds"),
		}),
	}),
	scroll: (target: unknown, direction: unknown, pages?: unknown, options?: unknown): StepObject => ({
		type: "scroll",
		...targetFields(target),
		direction,
		...defined({ pages, modifiers: pick(options, "modifiers") }),
	}),
	selectText: (target: unknown, text?: unknown, options?: unknown): StepObject => ({
		type: "select_text",
		...targetWithFind(target, options),
		...defined({
			text,
			prefix: pick(options, "prefix"),
			suffix: pick(options, "suffix"),
			selection: pick(options, "selection"),
		}),
	}),
	reveal: (target: unknown, options?: unknown): StepObject => {
		const fields = targetWithFind(target, options);
		if (!("target" in fields)) {
			throw invalid("reveal needs a query target to look for, not an element id");
		}
		return { type: "reveal", ...fields };
	},
	menu: (path: unknown): StepObject => ({
		type: "invoke_menu",
		path: typeof path === "string" ? path.split(">").map((part) => part.trim()) : path,
	}),
	secondaryAction: (target: unknown, action: unknown, options?: unknown): StepObject => ({
		type: "perform_secondary_action",
		...targetWithFind(target, options),
		action,
	}),
	waitFor: (target: unknown, options?: unknown): StepObject => {
		if (!isRecord(target)) {
			throw invalid("waitFor needs a query object and/or {window_title}");
		}
		const fields = queryFields(target);
		return {
			type: "wait_for",
			...(Object.keys(fields).length === 0 ? {} : { target: fields }),
			...defined({
				window_title: pick(target, "window_title") ?? pick(target, "windowTitle"),
				gone: pick(options, "gone"),
				timeout_ms: pick(options, "timeoutMs") ?? pick(options, "timeout_ms"),
			}),
		};
	},
});

// --- RPC to the host ---

interface Waiter {
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: unknown) => void;
}

const waiters = new Map<number, Waiter>();
let nextCall = 1;
let nextHandle = 1;
let logSent = 0;
let logDropped = 0;

function send(message: WorkerMessage): void {
	port?.postMessage(message);
}

function errorFrom(error: CallError): Error {
	if (error.kind === "unexpected") {
		const rebuilt = new Error(error.message);
		rebuilt.name = error.name;
		return rebuilt;
	}
	return new ScriptActionError(error.message, { kind: error.kind, payload: error.payload, refused: error.refused });
}

function call(method: CallMethod, target: WorkerTarget | undefined, args: readonly unknown[]): Promise<unknown> {
	return new Promise<unknown>((resolve, reject) => {
		const id = nextCall++;
		try {
			send({ type: "call", id, method, target, args });
		} catch {
			reject(invalid("action arguments must be plain data (no functions or other non-cloneable values)"));
			return;
		}
		waiters.set(id, { resolve, reject });
	});
}

function formatLogValue(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

function log(...values: unknown[]): void {
	if (logSent >= MAX_LOG_ENTRIES) {
		logDropped += 1;
		return;
	}
	logSent += 1;
	send({ type: "log", text: values.map(formatLogValue).join(" ").slice(0, MAX_LOG_CHARS) });
}

function sleep(milliseconds: unknown): Promise<void> {
	const duration = typeof milliseconds === "number" && Number.isFinite(milliseconds) ? milliseconds : 0;
	const bounded = Math.min(Math.max(0, duration), MAX_SLEEP_MS);
	return new Promise<void>((resolve) => {
		setTimeout(resolve, bounded);
	});
}

function handleSpec(
	app: string,
	options: unknown,
): { readonly app: string; readonly window: WindowSelector | undefined } {
	if (options !== undefined && !isRecord(options)) {
		throw invalid('apple.app options are an object such as { window: "Report.txt" }');
	}
	const window = pick(options, "window");
	if (window === undefined) {
		return { app, window: undefined };
	}
	if (typeof window === "string" && window.trim() !== "") {
		return { app, window };
	}
	if (typeof window === "number" && Number.isSafeInteger(window) && window > 0) {
		return { app, window };
	}
	throw invalid("window is a window title (or a unique part of one) or a window_id from apple.windows()");
}

function makeAppHandle(target: WorkerTarget): Readonly<Record<string, unknown>> {
	const act = (raw: StepObject, options?: unknown): Promise<unknown> => call("step", target, [raw, options]);
	return Object.freeze({
		name: target.app,
		...(target.window === undefined ? {} : { window: target.window }),
		observe: (options?: unknown) => call("observe", target, [options]),
		find: (query: unknown, options?: unknown) => call("find", target, [query, options]),
		click: (element: unknown, options?: unknown) => act(stepBuilders.click(element, options)),
		drag: (from: unknown, to: unknown, options?: unknown) => act(stepBuilders.drag(from, to, options)),
		setValue: (element: unknown, value: unknown, options?: unknown) =>
			act(stepBuilders.setValue(element, value, options)),
		type: (text: unknown) => act(stepBuilders.type(text)),
		press: (keys: unknown, options?: unknown) => act(stepBuilders.press(keys, options)),
		scroll: (element: unknown, direction: unknown, pages?: unknown, options?: unknown) =>
			act(stepBuilders.scroll(element, direction, pages, options)),
		selectText: (element: unknown, text?: unknown, options?: unknown) =>
			act(stepBuilders.selectText(element, text, options)),
		reveal: (element: unknown, options?: unknown) => act(stepBuilders.reveal(element, options)),
		menu: (path: unknown) => act(stepBuilders.menu(path)),
		secondaryAction: (element: unknown, action: unknown, options?: unknown) =>
			act(stepBuilders.secondaryAction(element, action, options)),
		waitFor: (element: unknown, options?: unknown) => act(stepBuilders.waitFor(element, options)),
		step: (raw: unknown, options?: unknown) => {
			if (!isRecord(raw)) {
				throw invalid("step needs a step object such as {type:'click', element_index:'9'}");
			}
			return act(raw, options);
		},
		batch: (raws: unknown, options?: unknown) => call("batch", target, [raws, options]),
		chain: (raws: unknown, options?: unknown) => call("chain", target, [raws, options]),
		verify: (checks?: unknown, options?: unknown) => call("verify", target, [checks, options]),
	});
}

const apple = Object.freeze({
	app: (name: unknown, options?: unknown) => {
		if (typeof name !== "string" || name === "") {
			throw invalid("apple.app needs an app name string");
		}
		const spec = handleSpec(name, options);
		return makeAppHandle({ id: nextHandle++, ...spec });
	},
	apps: () => call("apps", undefined, []),
	windows: (name?: unknown) => {
		if (name !== undefined && (typeof name !== "string" || name === "")) {
			throw invalid("apple.windows takes an app name, or nothing for every app's windows");
		}
		return call("windows", undefined, [name]);
	},
	steps: stepBuilders,
	dock: () =>
		Object.freeze({
			observe: () => call("dockObserve", undefined, []),
			click: (target: unknown) => call("dockAct", undefined, [target, "AXPress"]),
			showMenu: (target: unknown) => call("dockAct", undefined, [target, "AXShowMenu"]),
			cancel: (target: unknown) => call("dockAct", undefined, [target, "AXCancel"]),
		}),
	terminal: () =>
		Object.freeze({
			run: (command: unknown) => call("terminalRun", undefined, [command]),
			read: (windowId?: unknown) => call("terminalRead", undefined, [windowId]),
		}),
	osascript: (source: unknown, options?: unknown) => call("osascript", undefined, [source, options]),
	spaces: () =>
		Object.freeze({
			active: () => call("spacesActive", undefined, []),
			displays: () => call("spacesDisplays", undefined, []),
		}),
	menubar: () =>
		Object.freeze({
			observe: () => call("menubarObserve", undefined, []),
			press: (elementId: unknown) => call("menubarPress", undefined, [elementId]),
		}),
});

function serializeValue(value: unknown): { readonly value: unknown; readonly valueTruncated: boolean } {
	const text = value === undefined ? undefined : JSON.stringify(value);
	if (text === undefined) {
		return { value: null, valueTruncated: false };
	}
	return text.length <= MAX_VALUE_CHARS
		? { value: JSON.parse(text), valueTruncated: false }
		: { value: text.slice(0, MAX_VALUE_CHARS), valueTruncated: true };
}

async function execute(code: string): Promise<ScriptOutcome> {
	let script: Script;
	try {
		script = new Script(`(async function () {\n${code}\n})()`, { filename: "run_script.js", lineOffset: -1 });
	} catch (error: unknown) {
		return { ok: false, kind: "syntax-error", error: errorMessage(error) };
	}
	const context = createContext(
		{ apple, log, console: { log, info: log, warn: log, error: log }, sleep },
		{ codeGeneration: { strings: false, wasm: false } },
	);
	try {
		const pending: unknown = script.runInContext(context);
		const value: unknown = await Promise.resolve(pending);
		return { ok: true, ...serializeValue(value) };
	} catch (error: unknown) {
		if (error instanceof ScriptActionError) {
			return { ok: false, kind: "action-failed", error: error.message, payload: error.payload };
		}
		return { ok: false, kind: "script-error", error: errorMessage(error) };
	}
}

port.on("message", (message: HostMessage) => {
	if (message.type === "run") {
		void execute(message.code).then((outcome) => send({ type: "done", outcome, logDropped }));
		return;
	}
	const waiter = waiters.get(message.id);
	if (waiter === undefined) {
		return;
	}
	waiters.delete(message.id);
	if (message.ok) {
		waiter.resolve(message.value);
	} else {
		waiter.reject(errorFrom(message.error));
	}
});
