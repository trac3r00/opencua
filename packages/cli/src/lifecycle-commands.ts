import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { ReadStream, WriteStream } from "node:tty";
import type { AutomationStatus, CursorMotionConfig } from "@opencua/core";
import {
	CURSOR_MOTION_ENV,
	StopSwitch,
	cursorMotionFromEnvironment,
	isBrowserBundle,
	parseCursorMotion,
} from "@opencua/core/light";
import type { Command } from "commander";
import { syncSkillLinks } from "./client-skills.js";
import {
	CLIENT_LABELS,
	CLIENT_NAMES,
	type ClientChange,
	type ClientContext,
	type ClientInspection,
	type ClientName,
	type DesiredRegistration,
	describeChange,
	detectClients,
	entryAlive,
	entryRunsCheckout,
	inspectClient,
	isClientName,
	readClientEntry,
	unregisterClient,
} from "./clients.js";
import { linkDevCheckout, unlinkDevCheckout } from "./dev-link.js";
import { runDoctorFix } from "./doctor-fix.js";
import {
	evaluateDoctor,
	formatDoctorReport,
	gatherDoctorFacts,
	requestHelperPermissions,
	runSelfCheck,
} from "./doctor.js";
import { historyLaunchAgentPath, uninstallHistoryService } from "./history-service.js";
import { type Layout, displayPath, readInstallMarker, resolveLayout } from "./layout.js";
import {
	type GrantDependencies,
	type GrantMode,
	type GrantOutcome,
	type PermissionRequestAnswer,
	grantPermissions,
} from "./permission-guide.js";
import { portableDoctor, runPlatformSetup } from "./platform-onboarding.js";
import {
	type Delivery,
	type Settings,
	type SettingsChange,
	type Toolset,
	adoptRegistrations,
	applyToClients,
	changeSettings,
	findAppBundleId,
	loadSettings,
	plannedRegistration,
	prepareRegistration,
	sameSettings,
	saveSettings,
} from "./settings.js";
import {
	executeUninstall,
	formatPlan,
	gatherUninstallFacts,
	launchServicesWithLsregister,
	planUninstall,
	resetPermissionWithTccutil,
} from "./uninstall.js";
import { gitIn, runUpdate } from "./update.js";

export type Ask = (question: string) => Promise<string>;
type Say = (text: string) => void;

export interface LifecycleCommandOptions {
	readonly isJsonOutput: () => boolean;
	readonly platform?: NodeJS.Platform;
}

const print: Say = (text) => {
	process.stdout.write(`${text}\n`);
};

const quiet: Say = () => undefined;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function indent(text: string): string {
	return text
		.split("\n")
		.map((line) => `  ${line}`)
		.join("\n");
}

interface Terminal {
	readonly input: NodeJS.ReadableStream;
	readonly output: NodeJS.WritableStream;
	readonly close: () => void;
}

/**
 * Where a question reaches a person: stdin and stdout when they are the terminal, else the terminal itself
 * (/dev/tty) when stdin is a pipe, as it is under `curl ... | bash`. Undefined when there is no terminal at all (CI).
 */
function openTerminal(): Terminal | undefined {
	if (process.stdin.isTTY === true && process.stdout.isTTY === true) {
		return { input: process.stdin, output: process.stdout, close: () => undefined };
	}
	let inputFd: number | undefined;
	try {
		inputFd = openSync("/dev/tty", "r");
		const input = new ReadStream(inputFd);
		const output = new WriteStream(openSync("/dev/tty", "w"));
		return {
			input,
			output,
			close: () => {
				input.destroy();
				output.destroy();
			},
		};
	} catch {
		if (inputFd !== undefined) {
			closeSync(inputFd);
		}
		return undefined;
	}
}

function isInteractive(): boolean {
	const terminal = openTerminal();
	terminal?.close();
	return terminal !== undefined;
}

async function withPrompt<T>(use: (ask: Ask, say: Say) => Promise<T>): Promise<T> {
	const terminal = openTerminal();
	if (terminal === undefined) {
		throw new Error("there is no terminal to ask on; pass the answers as flags");
	}
	const prompt = createInterface({ input: terminal.input, output: terminal.output });
	try {
		return await use(
			(question) => prompt.question(question),
			(text) => {
				terminal.output.write(`${text}\n`);
			},
		);
	} finally {
		prompt.close();
		terminal.close();
	}
}

/** A yes/no question whose default is no. */
function confirm(question: string): Promise<boolean> {
	return withPrompt(async (ask) => /^y(?:es)?$/i.test((await ask(`${question}? [y/N] `)).trim()));
}

function clientContext(layout: Layout): ClientContext {
	return { home: layout.home, env: process.env, now: new Date() };
}

export function parseClients(value: string): ClientName[] {
	const names = value
		.split(",")
		.map((name) => name.trim())
		.filter((name) => name !== "");
	const unknown = names.filter((name) => !isClientName(name));
	if (unknown.length > 0) {
		throw new Error(`unknown MCP client ${unknown.join(", ")} (expected ${CLIENT_NAMES.join(", ")})`);
	}
	return names.filter(isClientName);
}

function collect(value: string, previous: string[] | undefined): string[] {
	return [...(previous ?? []), value];
}

function collectClients(value: string, previous: ClientName[] | undefined): ClientName[] {
	const merged = [...(previous ?? [])];
	for (const name of parseClients(value)) {
		if (!merged.includes(name)) {
			merged.push(name);
		}
	}
	return merged;
}

function parseDelivery(value: string): Delivery {
	if (value === "background" || value === "attended") {
		return value;
	}
	throw new Error("--delivery must be background or attended");
}

function parseToolset(value: string): Toolset {
	if (value === "full" || value === "lean") {
		return value;
	}
	throw new Error("--toolset must be full or lean");
}

function parseCursorMotionFlag(value: string): CursorMotionConfig | "off" {
	const text = value.trim();
	let parsed: unknown = text;
	if (text.startsWith("{")) {
		try {
			parsed = JSON.parse(text);
		} catch (error) {
			throw new Error(`--cursor-motion: invalid JSON (${errorMessage(error)})`);
		}
	}
	// Commander coerces null from a required option parser to an empty string.
	return parseCursorMotion(parsed, "--cursor-motion") ?? "off";
}

function parseCursorMotionTimingFlag(value: string): NonNullable<CursorMotionConfig["timing"]> {
	if (value === "native" || value === "fitts" || value === "fixed") {
		return value;
	}
	throw new Error("--cursor-motion-timing must be native, fitts or fixed");
}

function parseCursorMotionDurationFlag(value: string): number {
	const milliseconds = value.trim() === "" ? Number.NaN : Number(value);
	if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 5000) {
		throw new Error("--cursor-motion-duration must be a number of milliseconds from 0 to 5000");
	}
	return milliseconds;
}

/**
 * The motion the low-level commands use: OPENCUA_CURSOR_MOTION when it is set (including "off"), else the saved
 * setting. null means disabled.
 */
export function resolveCursorMotion(
	configPath: string,
	env: Readonly<Record<string, string | undefined>> = process.env,
): CursorMotionConfig | null {
	if (env[CURSOR_MOTION_ENV] !== undefined) {
		return cursorMotionFromEnvironment(env) ?? null;
	}
	return loadSettings(configPath).settings.cursorMotion ?? null;
}

// --- config --------------------------------------------------------------------------------------------------------

export interface ConfigCommandOptions {
	readonly allow?: string[];
	readonly disallow?: string[];
	readonly delivery?: Delivery;
	readonly toolset?: Toolset;
	readonly iphone?: boolean;
	readonly cursorMotion?: CursorMotionConfig | "off" | null;
	readonly cursorMotionTiming?: NonNullable<CursorMotionConfig["timing"]>;
	readonly cursorMotionDuration?: number;
	readonly register?: ClientName[];
	readonly unregister?: ClientName[];
	readonly apply?: boolean;
	readonly show?: boolean;
	readonly detect?: boolean;
}

/** The motion a config run asks for: a config enables or replaces it, null disables it, undefined leaves it. */
function requestedMotion(options: ConfigCommandOptions, current: Settings): CursorMotionConfig | null | undefined {
	const { cursorMotion: selection, cursorMotionTiming: timing, cursorMotionDuration: duration } = options;
	const cursorMotion = selection === "off" ? null : selection;
	if (timing === undefined && duration === undefined) {
		return cursorMotion;
	}
	const base = cursorMotion === undefined ? current.cursorMotion : cursorMotion;
	if (base === undefined || base === null) {
		throw new Error(
			"--cursor-motion-timing and --cursor-motion-duration need an enabled cursor motion: pass --cursor-motion <style> too, or save one first",
		);
	}
	return (
		parseCursorMotion(
			{
				...base,
				...(timing === undefined ? {} : { timing }),
				...(duration === undefined ? {} : { glideDurationMs: duration }),
			},
			"cursor motion",
		) ?? null
	);
}

export function requestedChange(options: ConfigCommandOptions, current: Settings): SettingsChange | undefined {
	const change: SettingsChange = {
		allow: options.allow ?? [],
		disallow: options.disallow ?? [],
		delivery: options.delivery,
		toolset: options.toolset,
		iphone: options.iphone,
		cursorMotion: requestedMotion(options, current),
		register: options.register ?? [],
		unregister: options.unregister ?? [],
	};
	const given =
		(change.allow ?? []).length > 0 ||
		(change.disallow ?? []).length > 0 ||
		change.delivery !== undefined ||
		change.toolset !== undefined ||
		change.iphone !== undefined ||
		change.cursorMotion !== undefined ||
		(change.register ?? []).length > 0 ||
		(change.unregister ?? []).length > 0;
	return given ? change : undefined;
}

async function askChoice<T extends string>(
	ask: Ask,
	say: Say,
	label: string,
	choices: readonly T[],
	current: T,
): Promise<T> {
	while (true) {
		const answer = (await ask(`${label}, ${choices.join(" or ")} [${current}]: `)).trim().toLowerCase();
		if (answer === "") {
			return current;
		}
		const match = choices.find((choice) => choice === answer);
		if (match !== undefined) {
			return match;
		}
		say(`  please answer ${choices.join(" or ")}`);
	}
}

async function askClients(
	ask: Ask,
	say: Say,
	question: string,
	onEnter: readonly ClientName[] = [],
): Promise<ClientName[]> {
	while (true) {
		try {
			const answer = (await ask(question)).trim();
			if (answer === "") {
				return [...onEnter];
			}
			return answer.toLowerCase() === "none" ? [] : parseClients(answer);
		} catch (error) {
			say(`  ${errorMessage(error)}`);
		}
	}
}

/** The friendly mode of `opencua config`: one question per setting, Enter keeps the current value. */
export async function askForChanges(
	settings: Settings,
	ask: Ask,
	say: Say,
	installed: readonly ClientName[] = [],
): Promise<SettingsChange> {
	say(`App restriction: ${settings.allowedApps.join(", ") || "none (any explicitly named app)"}`);
	const allow = (await ask("  Restrict to apps (names or bundle ids; comma-separated; Enter skips): ")).trim();
	const disallow =
		settings.allowedApps.length === 0
			? ""
			: (await ask('  Remove apps (comma-separated, "all" empties the list; Enter skips): ')).trim();
	const delivery = await askChoice(ask, say, "Delivery", ["background", "attended"] as const, settings.delivery);
	const toolset = await askChoice(ask, say, "Toolset", ["full", "lean"] as const, settings.toolset);
	const iphoneChoice = settings.iphone ? "on" : "off";
	const iphone = (await askChoice(ask, say, "iPhone Mirroring tools", ["on", "off"] as const, iphoneChoice)) === "on";
	say(`MCP clients: ${CLIENT_NAMES.join(", ")}; registered with: ${settings.clients.join(", ") || "none yet"}`);
	const suggested = settings.clients.length === 0 ? installed : [];
	const register = await askClients(
		ask,
		say,
		suggested.length === 0
			? "  Register with (comma-separated; Enter skips): "
			: `  Register with (comma-separated; Enter registers with the installed ${suggested.join(", ")}; "none" skips): `,
		suggested,
	);
	const unregister =
		settings.clients.length === 0
			? []
			: await askClients(ask, say, "  Unregister from (comma-separated; Enter skips): ");
	return {
		allow: allow === "" ? [] : [allow],
		disallow: disallow === "" ? [] : [disallow],
		delivery,
		toolset,
		iphone,
		register,
		unregister,
	};
}

function formatSettings(
	settings: Settings,
	state: { readonly saved: boolean; readonly adopted: boolean },
	layout: Layout,
	registrations: readonly ClientInspection[],
): string {
	const show = (path: string) => displayPath(path, layout.home);
	const origin = state.saved
		? ""
		: state.adopted
			? " (not saved yet: read from your existing registration)"
			: " (not saved yet: the defaults)";
	const lines = [
		`opencua settings in ${show(layout.configPath)}${origin}`,
		`  apps       ${settings.allowedApps.join(", ") || "any explicitly named app (no restriction)"}`,
		`  delivery   ${settings.delivery}`,
		`  toolset    ${settings.toolset}`,
		`  iphone     ${settings.iphone ? "on" : "off"}`,
		`  motion     ${settings.cursorMotion === undefined ? "off" : JSON.stringify(settings.cursorMotion)}`,
		`  clients    ${settings.clients.join(", ") || "none"}`,
		`Registrations of ${show(layout.checkout)}:`,
	];
	if (registrations.length === 0) {
		lines.push(`  none yet: opencua config --register ${CLIENT_NAMES.join("|")}`);
	}
	for (const inspection of registrations) {
		const where = inspection.path === undefined ? "" : `${show(inspection.path)}: `;
		lines.push(`  ${inspection.client.padEnd(7)}${where}${inspection.detail}`);
	}
	return lines.join("\n");
}

async function runDetect(json: boolean): Promise<number> {
	const layout = resolveLayout();
	const context = clientContext(layout);
	let registered: readonly ClientName[];
	try {
		registered = loadSettings(layout.configPath).settings.clients;
	} catch (error) {
		print(`${errorMessage(error)}\nFix or delete it, then run opencua config again.`);
		return 1;
	}
	const detected = detectClients(context);
	const fresh = detected.filter((found) => !registered.includes(found.client));
	if (json) {
		print(JSON.stringify({ detected, registered, unregistered: fresh.map((found) => found.client) }));
		return 0;
	}
	if (detected.length === 0) {
		print(
			"No agent client found on this Mac (Codex, Claude Code, OmO, Gemini CLI, Cursor, Hermes Agent, OpenClaw, pi). Register one by hand: opencua config --register json",
		);
		return 0;
	}
	for (const found of detected) {
		const state = registered.includes(found.client) ? "registered" : "not registered";
		print(`${CLIENT_LABELS[found.client].padEnd(12)} ${state.padEnd(15)} found by ${found.how}`);
	}
	if (fresh.length === 0) {
		print("Every agent client found here already has opencua.");
		return 0;
	}
	const names = fresh.map((found) => CLIENT_LABELS[found.client]).join(", ");
	if (!isInteractive()) {
		print(
			`Not registered yet: ${names}. Register with: opencua config --register ${fresh.map((found) => found.client).join(",")}`,
		);
		return 0;
	}
	const yes = await withPrompt(
		async (ask) => !/^n(?:o)?$/i.test((await ask(`Add opencua to ${names}? [Y/n] `)).trim()),
	);
	if (!yes) {
		print(
			`Left them out. Add them later with: opencua config --register ${fresh.map((found) => found.client).join(",")}`,
		);
		return 0;
	}
	return runConfig({ register: fresh.map((found) => found.client) }, false);
}

async function runConfig(options: ConfigCommandOptions, json: boolean): Promise<number> {
	if (options.detect === true) {
		return runDetect(json);
	}
	const layout = resolveLayout();
	const context = clientContext(layout);
	const show = (path: string) => displayPath(path, layout.home);
	const say = json ? quiet : print;
	let loaded: ReturnType<typeof loadSettings>;
	try {
		loaded = loadSettings(layout.configPath);
	} catch (error) {
		print(`${errorMessage(error)}\nFix or delete it, then run opencua config again.`);
		return 1;
	}
	let current = loaded.settings;
	let adopted = false;
	if (!loaded.saved) {
		const found = adoptRegistrations(layout, context);
		if (found !== undefined) {
			current = found;
			adopted = true;
		}
	}

	let change: SettingsChange | undefined;
	try {
		change = requestedChange(options, current);
	} catch (error) {
		const message = errorMessage(error);
		print(json ? JSON.stringify({ ok: false, error: message }) : message);
		return 1;
	}
	const apply = options.apply === true;
	if (options.show === true || (change === undefined && !apply && (json || !isInteractive()))) {
		const desired = plannedRegistration(layout, current);
		const registrations = current.clients.map((client) => inspectClient(client, desired, context));
		const status = {
			configPath: layout.configPath,
			saved: loaded.saved,
			checkout: layout.checkout,
			settings: current,
			registrations,
		};
		print(
			json
				? JSON.stringify(status)
				: formatSettings(current, { saved: loaded.saved, adopted }, layout, registrations),
		);
		return 0;
	}
	if (change === undefined && !apply) {
		change = await withPrompt((ask, tell) => {
			tell(
				`Settings live in ${show(layout.configPath)} and apply to every MCP client opencua is registered with. Enter keeps a value.\n`,
			);
			return askForChanges(
				current,
				ask,
				tell,
				detectClients(context).map((found) => found.client),
			);
		});
	}
	if (change === undefined && !loaded.saved && !adopted) {
		say(`No MCP client is registered yet. Register one with: opencua config --register ${CLIENT_NAMES.join("|")}`);
		if (json) {
			print(JSON.stringify({ ok: true, settings: current, changes: [], failures: [] }));
		}
		return 0;
	}

	const requested = change ?? {};
	const { settings: next, unknown } = changeSettings(current, requested, (name) => findAppBundleId(name, layout.home));
	if (unknown.length > 0) {
		const message = `No installed app is named ${unknown.map((name) => `"${name}"`).join(", ")}; pass its bundle id instead (for example com.apple.TextEdit). Nothing was changed.`;
		print(json ? JSON.stringify({ ok: false, error: message }) : message);
		return 1;
	}
	if (!loaded.saved || !sameSettings(loaded.settings, next)) {
		saveSettings(layout.configPath, next);
		say(
			`Saved ${show(layout.configPath)}${adopted && !loaded.saved ? " (starting from your existing registration)" : ""}.`,
		);
	}

	const changes: ClientChange[] = [];
	const failures: { client: ClientName; error: string }[] = [];
	for (const client of requested.unregister ?? []) {
		const entry = readClientEntry(client, context).entry;
		if (entry !== undefined && entryAlive(entry) && !entryRunsCheckout(entry, layout.checkout)) {
			say(
				`${client.padEnd(7)}left alone: its opencua entry runs ${entry.command ?? "something else"}, another installation`,
			);
			continue;
		}
		try {
			changes.push(unregisterClient(client, context, layout.checkout));
		} catch (error) {
			failures.push({ client, error: errorMessage(error) });
		}
	}
	// A printed json block only needs printing again when what it says changed.
	const settingsChanged = !sameSettings({ ...current, clients: [] }, { ...next, clients: [] });
	const targets = next.clients.filter(
		(client) => client !== "json" || settingsChanged || (requested.register ?? []).includes("json"),
	);
	let prepared: ReturnType<typeof prepareRegistration>;
	try {
		prepared = prepareRegistration(layout, next, false);
	} catch (error) {
		print(json ? JSON.stringify({ ok: false, error: errorMessage(error) }) : errorMessage(error));
		return 1;
	}
	if (prepared.previousCheckout !== undefined) {
		say(
			`The bundle in ${show(layout.bundleDir)} now comes from this checkout (it came from ${show(prepared.previousCheckout)}).`,
		);
	}
	const named = requested.register ?? [];
	for (const [clients, explicit] of [
		[targets.filter((client) => named.includes(client)), true],
		[targets.filter((client) => !named.includes(client)), false],
	] as const) {
		const outcome = applyToClients(clients, { ...prepared.desired, explicit }, context);
		changes.push(...outcome.changes);
		failures.push(...outcome.failures);
	}
	const skillLinks = syncSkillLinks(next.clients, layout.bundleDir, context);
	if (json) {
		print(
			JSON.stringify({
				ok: failures.length === 0,
				configPath: layout.configPath,
				settings: next,
				changes,
				failures,
			}),
		);
		return failures.length === 0 ? 0 : 1;
	}
	for (const item of changes) {
		print(describeChange(item, show));
	}
	for (const failure of failures) {
		print(`${failure.client.padEnd(7)}failed: ${failure.error}`);
	}
	for (const link of skillLinks) {
		if (link.action !== "unchanged") {
			print(`skill  ${show(link.directory)}: ${link.detail}`);
		}
	}
	if (next.clients.length === 0) {
		print(`No MCP client is registered yet. Register one with: opencua config --register ${CLIENT_NAMES.join("|")}`);
	}
	if (changes.some((item) => item.action === "added" || item.action === "updated" || item.action === "removed")) {
		print("Restart your MCP clients so they pick up the change.");
	}
	return failures.length === 0 ? 0 : 1;
}

// --- permissions ---------------------------------------------------------------------------------------------------

const GRANT_WAIT_MS = 10 * 60_000;
const GRANT_POLL_MS = 1_500;

/**
 * True when what was typed during a permission wait asks to skip it: a line that is just "s" or "skip". A bare Enter
 * does not, because one is often already waiting in the terminal (an extra Enter after setup's questions, or a Return
 * meant for macOS's dialog) and would skip the permission the moment its pane opens.
 */
export function asksToSkip(typed: string): boolean {
	return typed.split(/\r\n|\r|\n/).some((line) => /^\s*s(?:kip)?\s*$/i.test(line));
}

const WATCH_WAIT_MS = 5 * 60_000;
const WATCH_NOTE_MS = 30_000;

/**
 * Re-checks until `granted` holds or five minutes pass, with no terminal to read from (an agent running setup or
 * doctor --fix). A line every 30 seconds keeps the agent's log moving.
 */
async function watchUntilGranted(granted: () => boolean, say: Say): Promise<boolean> {
	const started = Date.now();
	let note = started + WATCH_NOTE_MS;
	while (Date.now() - started < WATCH_WAIT_MS) {
		if (granted()) {
			return true;
		}
		if (Date.now() >= note) {
			const left = Math.max(0, Math.round((WATCH_WAIT_MS - (Date.now() - started)) / 1000));
			say(`  still watching (${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} left)...`);
			note += WATCH_NOTE_MS;
		}
		await sleep(GRANT_POLL_MS);
	}
	return granted();
}

/**
 * Who the permission guide can reach: a person at the terminal, a person at the Mac with no terminal (an agent ran the
 * command), or nobody (CI, a locked screen, or --no-wait).
 */
async function grantMode(wait: boolean, terminalAllowed: boolean): Promise<GrantMode> {
	if (terminalAllowed && isInteractive()) {
		return "terminal";
	}
	const ci = process.env["CI"];
	if (!wait || (ci !== undefined && ci !== "" && ci !== "false")) {
		return "report";
	}
	const { probeHostCapabilities } = await import("@opencua/core");
	return probeHostCapabilities().session.screenLocked ? "report" : "watch";
}

/** Re-checks until `granted` holds, the person types s and Enter, or ten minutes pass. */
async function waitUntilGranted(granted: () => boolean): Promise<boolean> {
	const terminal = openTerminal();
	let skipped = false;
	let typed = "";
	const skip = (chunk: Buffer | string) => {
		typed += String(chunk);
		skipped = asksToSkip(typed);
	};
	terminal?.input.on("data", skip);
	// A stream paused by an earlier wait stays paused when a listener is added, so Enter would never arrive.
	terminal?.input.resume();
	try {
		const deadline = Date.now() + GRANT_WAIT_MS;
		while (Date.now() < deadline && !skipped) {
			if (granted()) {
				return true;
			}
			await sleep(GRANT_POLL_MS);
		}
		return granted();
	} finally {
		terminal?.input.off("data", skip);
		terminal?.input.pause();
		terminal?.close();
	}
}

const AUTOMATION_STATUSES: readonly AutomationStatus[] = [
	"granted",
	"denied",
	"not-determined",
	"not-running",
	"unknown",
];

function automationAnswer(value: unknown): Record<string, AutomationStatus> | undefined {
	if (typeof value !== "object" || value === null) {
		return undefined;
	}
	return Object.fromEntries(
		Object.entries(value).flatMap(([bundleId, status]) => {
			const known = AUTOMATION_STATUSES.find((candidate) => candidate === status);
			return known === undefined ? [] : [[bundleId, known]];
		}),
	);
}

function grantDependencies(layout: Layout, say: Say, open: boolean, mode: GrantMode): GrantDependencies {
	return {
		read: () => {
			const result = runSelfCheck(layout);
			return result.ok ? { ...result.report.permissions, automation: result.report.automation } : undefined;
		},
		request: (kinds): PermissionRequestAnswer | undefined => {
			const answer = requestHelperPermissions(layout, kinds);
			if (answer === undefined) {
				return undefined;
			}
			const accessibility = answer["accessibility"];
			const screenRecording = answer["screenRecording"];
			const inputMonitoring = answer["inputMonitoring"];
			const automation = automationAnswer(answer["automation"]);
			return {
				...(typeof accessibility === "boolean" ? { accessibility } : {}),
				...(typeof screenRecording === "boolean" ? { screenRecording } : {}),
				...(typeof inputMonitoring === "boolean" ? { inputMonitoring } : {}),
				...(automation === undefined ? {} : { automation }),
			};
		},
		openUrl: async (url) => open && (await openPrivacyPane(url)),
		resetDecision: (service) => {
			// Only this helper's own decision, and the guide calls it only while the permission is off.
			const bundleId = findAppBundleId(layout.helperApp, layout.home);
			if (bundleId !== undefined) {
				spawnSync("/usr/bin/tccutil", ["reset", service, bundleId], { stdio: "ignore" });
			}
		},
		waitFor: mode === "terminal" ? waitUntilGranted : (granted) => watchUntilGranted(granted, say),
		print: say,
	};
}

const SETTINGS_QUIT_WAIT_MS = 5_000;
const OPEN_ATTEMPTS = 4;

/**
 * Opens a System Settings pane. A running System Settings keeps showing the app list it read when it opened, so an
 * entry macOS added a moment ago would not be there to switch on: it is quit first, and the pane opens fresh.
 */
async function openPrivacyPane(url: string): Promise<boolean> {
	const running = () => spawnSync("/usr/bin/pgrep", ["-x", "System Settings"], { stdio: "ignore" }).status === 0;
	if (running()) {
		spawnSync("/usr/bin/osascript", ["-e", 'quit app "System Settings"'], { stdio: "ignore" });
		const deadline = Date.now() + SETTINGS_QUIT_WAIT_MS;
		while (running() && Date.now() < deadline) {
			await sleep(200);
		}
	}
	// Right after a quit, LaunchServices can still refuse to start System Settings for a moment.
	for (let attempt = 0; attempt < OPEN_ATTEMPTS; attempt += 1) {
		if (spawnSync("/usr/bin/open", [url], { stdio: "ignore" }).status === 0) {
			return true;
		}
		await sleep(500);
	}
	return false;
}

/** The approved apps the server reads a page address from with Apple Events (browsers). */
function approvedBrowsers(layout: Layout): string[] {
	try {
		return loadSettings(layout.configPath).settings.allowedApps.filter((bundleId) => isBrowserBundle(bundleId));
	} catch {
		return [];
	}
}

function runGrant(layout: Layout, say: Say, open: boolean, mode: GrantMode): Promise<GrantOutcome> {
	return grantPermissions(
		{
			mode,
			openPanes: open,
			helperApp: layout.helperApp,
			extraAutomationTargets: approvedBrowsers(layout),
			inputMonitoring: existsSync(historyLaunchAgentPath(layout.home)),
		},
		grantDependencies(layout, say, open, mode),
	);
}

async function runPermissionsGrantCommand(
	options: { readonly open: boolean; readonly wait: boolean },
	json: boolean,
): Promise<number> {
	const layout = resolveLayout();
	const outcome = await runGrant(layout, json ? quiet : print, options.open, await grantMode(options.wait, !json));
	if (json) {
		print(JSON.stringify(outcome));
	} else if (outcome.missing.length === 0) {
		print(`\nAll set: "opencua-mcp" holds every permission it needs.`);
	}
	return outcome.missing.length === 0 ? 0 : 1;
}

// --- doctor --------------------------------------------------------------------------------------------------------

function reapplyRegistrations(layout: Layout, say: Say): boolean {
	let settings: Settings;
	try {
		settings = loadSettings(layout.configPath).settings;
	} catch (error) {
		say(indent(errorMessage(error)));
		return false;
	}
	const show = (path: string) => displayPath(path, layout.home);
	let desired: DesiredRegistration;
	try {
		desired = prepareRegistration(layout, settings, false).desired;
	} catch (error) {
		say(indent(errorMessage(error)));
		return false;
	}
	const outcome = applyToClients(
		settings.clients.filter((client) => client !== "json"),
		desired,
		clientContext(layout),
	);
	for (const change of outcome.changes) {
		say(indent(describeChange(change, show)));
	}
	for (const failure of outcome.failures) {
		say(indent(`${failure.client.padEnd(7)}failed: ${failure.error}`));
	}
	for (const link of syncSkillLinks(settings.clients, layout.bundleDir, clientContext(layout))) {
		if (link.action !== "unchanged") {
			say(indent(`skill  ${show(link.directory)}: ${link.detail}`));
		}
	}
	return outcome.failures.length === 0;
}

interface DoctorCommandOptions {
	readonly fix?: boolean;
	readonly rebuildHelper?: boolean;
	readonly open: boolean;
	readonly wait: boolean;
}

async function runDoctorCommand(
	options: DoctorCommandOptions,
	json: boolean,
	platform: NodeJS.Platform = process.platform,
): Promise<number> {
	const layout = resolveLayout(process.env, undefined, platform);
	if (platform !== "darwin") {
		if (options.fix === true) reapplyRegistrations(layout, json ? quiet : print);
		const report = portableDoctor(layout, platform);
		print(json ? JSON.stringify(report) : formatDoctorReport(report));
		return report.ready ? 0 : 1;
	}
	if (options.fix !== true) {
		const report = evaluateDoctor(gatherDoctorFacts(layout));
		print(json ? JSON.stringify(report) : formatDoctorReport(report));
		return report.ready ? 0 : 1;
	}
	const say = json ? quiet : print;
	const stdio = json ? "ignore" : "inherit";
	const mode = await grantMode(options.wait, !json);
	const outcome = await runDoctorFix(
		{
			rebuildHelper: options.rebuildHelper === true,
			openPanes: options.open,
			interactive: !json && isInteractive(),
			guidePermissions: mode !== "report",
		},
		{
			gather: () => gatherDoctorFacts(layout),
			rebuildNative: () => spawnSync("/bin/bash", [join(layout.nativeDir, "build.sh")], { stdio }).status === 0,
			rebuildHelper: () =>
				spawnSync("/bin/bash", [layout.setupScript, "--yes", "--rebuild-helper", "--no-doctor"], { stdio })
					.status === 0,
			reapplyRegistrations: () => reapplyRegistrations(layout, say),
			resume: () => {
				new StopSwitch().resume();
			},
			openUrl: (url) => spawnSync("/usr/bin/open", [url], { stdio: "ignore" }).status === 0,
			grantPermissions: () => runGrant(layout, say, options.open, mode),
			ask: confirm,
			print: say,
		},
	);
	if (json) {
		print(
			JSON.stringify({
				fixed: outcome.fixed,
				skipped: outcome.skipped,
				failed: outcome.failed,
				report: outcome.report,
			}),
		);
	}
	return outcome.report.ready ? 0 : 1;
}

// --- update and uninstall ------------------------------------------------------------------------------------------

function runUpdateCommand(): number {
	const layout = resolveLayout();
	return runUpdate(layout, {
		git: gitIn(layout.checkout, process.env),
		marker: readInstallMarker(layout.installMarkerPath),
		runSetup: () => runPlatformSetup(layout),
		helperDigest: () => {
			const result = spawnSync("/bin/bash", [layout.helperBuildScript, "--inputs-digest"], { encoding: "utf8" });
			return result.status === 0 ? result.stdout.trim() || undefined : undefined;
		},
		stableSigning: ["opencua", "apple-cua"].some((name) =>
			existsSync(join(layout.checkout, `.signing/${name}-signing.keychain-db`)),
		),
		print,
	});
}

interface UninstallCommandOptions {
	readonly yes?: boolean;
	readonly purge?: boolean;
	readonly dryRun?: boolean;
}

async function runUninstallCommand(options: UninstallCommandOptions): Promise<number> {
	const layout = resolveLayout();
	const show = (path: string) => displayPath(path, layout.home);
	const plan = planUninstall(gatherUninstallFacts(layout, process.env), { purge: options.purge === true });
	print(formatPlan(plan));
	if (options.dryRun === true) {
		print("\n--dry-run: nothing was changed.");
		return 0;
	}
	if (options.yes !== true) {
		if (!isInteractive()) {
			print("\nNothing was changed. Run opencua uninstall --yes to uninstall without being asked.");
			return 1;
		}
		if (!(await confirm("\nUninstall opencua"))) {
			print("Nothing was changed.");
			return 1;
		}
	}
	print("\nUninstalling:");
	const outcome = await executeUninstall(plan, {
		context: clientContext(layout),
		stopHistory: async (historyOptions) => {
			await uninstallHistoryService(historyOptions);
		},
		signal: (pid, signal) => {
			process.kill(pid, signal);
		},
		isAlive: (pid) => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		},
		wait: async (milliseconds) => {
			await sleep(milliseconds);
		},
		launchServices: launchServicesWithLsregister,
		resetPermission: resetPermissionWithTccutil,
		print,
	});
	print("");
	if (outcome.backups.length > 0) {
		print("Backups of the files opencua edited (kept):");
		for (const backup of outcome.backups) {
			print(`  ${show(backup)}`);
		}
	}
	if (outcome.failures.length > 0) {
		print(`opencua is partly uninstalled: ${outcome.failures.length} step(s) failed, listed above.`);
		return 1;
	}
	print(
		plan.removeCheckout
			? "opencua is uninstalled."
			: `opencua is uninstalled. The developer checkout ${show(layout.checkout)} stays; delete it yourself, or uninstall with --purge.`,
	);
	return 0;
}

// --- commands ------------------------------------------------------------------------------------------------------

export function registerLifecycleCommands(program: Command, options: LifecycleCommandOptions): void {
	program
		.command("setup")
		.description("Install dependencies, build TypeScript and configure this checkout for the current platform")
		.action(() => {
			const platform = options.platform ?? process.platform;
			process.exitCode = runPlatformSetup(resolveLayout(process.env, undefined, platform), platform);
		});
	const dev = program
		.command("dev")
		.description(
			"Run the MCP server from a developer checkout through the installed, permission-granted helper; with `pnpm dev` running there, every saved edit reloads the server without a reinstall or a reconnect",
		);
	dev.command("link [checkout]")
		.description("point every registered MCP client at <checkout>'s server (default: the current directory)")
		.action((checkout: string | undefined) => {
			const layout = resolveLayout();
			const outcome = linkDevCheckout(layout, checkout ?? process.cwd());
			if (!outcome.ok) {
				print(`dev link refused: ${outcome.error}`);
				process.exitCode = 1;
				return;
			}
			const linked = resolveLayout();
			print(`MCP clients now run ${linked.server} through ${layout.helperExecutable}.`);
			const applied = reapplyRegistrations(linked, print);
			print(
				`Reconnect each client once (e.g. /mcp reconnect opencua). Then keep \`pnpm -C "${outcome.checkout}" dev\` running: each rebuild restarts the server behind the same connection. opencua dev unlink returns to ${layout.checkout}.`,
			);
			process.exitCode = applied ? 0 : 1;
		});
	dev.command("unlink")
		.description("point the registered MCP clients back at the installed checkout's server")
		.action(() => {
			const layout = resolveLayout();
			if (!unlinkDevCheckout(layout)) {
				print(`Not linked: MCP clients run ${layout.server}.`);
				return;
			}
			const installed = resolveLayout();
			print(`MCP clients run ${installed.server} again; reconnect each client once.`);
			process.exitCode = reapplyRegistrations(installed, print) ? 0 : 1;
		});
	dev.command("status")
		.description("show which checkout's server the registered MCP clients run")
		.action(() => {
			const layout = resolveLayout();
			print(
				layout.devCheckout === undefined
					? `Not linked: MCP clients run ${layout.server}.`
					: `Linked to ${layout.devCheckout}: MCP clients run ${layout.server} through ${layout.helperExecutable}.`,
			);
		});
	program
		.command("config")
		.description(
			"Choose the apps agents may use and the MCP clients opencua is registered with; asks when run in a terminal without flags. Settings live in ~/.opencua/config.json and apply to every registered client",
		)
		.option(
			"--allow <apps>",
			"restrict to apps by name or bundle id, comma-separated and repeatable (e.g. TextEdit,com.apple.finder)",
			collect,
		)
		.option("--disallow <apps>", 'remove apps from the restriction; "all" clears the restriction', collect)
		.option("--delivery <mode>", "background (default) or attended", parseDelivery)
		.option("--toolset <profile>", "full (default) or lean", parseToolset)
		.option("--iphone", "register the iPhone Mirroring tools")
		.option("--no-iphone", "do not register the iPhone Mirroring tools")
		.option(
			"--cursor-motion <style|off|json>",
			"Cua Cursor Motion style, off, or a JSON object",
			parseCursorMotionFlag,
		)
		.option(
			"--cursor-motion-timing <timing>",
			"native, fitts or fixed (needs an enabled motion)",
			parseCursorMotionTimingFlag,
		)
		.option(
			"--cursor-motion-duration <ms>",
			"glide duration, 0 to 5000 (needs an enabled motion)",
			parseCursorMotionDurationFlag,
		)
		.option(
			"--register <clients>",
			`register with ${CLIENT_NAMES.join(", ")} (comma-separated, repeatable)`,
			collectClients,
		)
		.option("--unregister <clients>", "remove the opencua registration from these clients", collectClients)
		.option("--apply", "write the saved settings into every registered client again")
		.option("--show", "print the settings and where each client is registered")
		.option(
			"--detect",
			"list the agent clients installed on this Mac; in a terminal, offer to register the ones that are not yet",
		)
		.action(async (commandOptions: ConfigCommandOptions) => {
			process.exitCode = await runConfig(commandOptions, options.isJsonOutput());
		});

	const permissions =
		program.commands.find((command) => command.name() === "permissions") ??
		program.command("permissions").description("Manage macOS permissions");
	permissions
		.command("grant")
		.description(
			'Walk through granting "opencua-mcp" Accessibility, Screen Recording and Automation: shows macOS\'s dialogs, opens System Settings and moves on as soon as each is on (also without a terminal, as when an agent runs it); exits 0 when everything is granted',
		)
		.option("--no-open", "print how to open System Settings instead of opening it")
		.option(
			"--no-wait",
			"without a terminal: only list what is missing instead of opening each pane and watching for the switch",
		)
		.action(async (commandOptions: { readonly open: boolean; readonly wait: boolean }) => {
			process.exitCode = await runPermissionsGrantCommand(commandOptions, options.isJsonOutput());
		});

	program
		.command("doctor")
		.description(
			'Check this Mac, the native binaries, the signed helper, the permissions of "opencua-mcp" and the MCP client registrations without raising a permission prompt; exits 0 when ready, 1 otherwise',
		)
		.option("--fix", "repair what is safe to repair, ask before what is not, and report what is left")
		.option(
			"--rebuild-helper",
			"with --fix: consent to rebuilding the helper app (macOS then asks for both permissions again)",
		)
		.option(
			"--no-open",
			"with --fix: print how to open System Settings for a missing permission instead of opening it",
		)
		.option(
			"--no-wait",
			"with --fix and no terminal: open a missing permission's pane without watching for the switch",
		)
		.action(async (commandOptions: DoctorCommandOptions) => {
			process.exitCode = await runDoctorCommand(
				commandOptions,
				options.isJsonOutput(),
				options.platform ?? process.platform,
			);
		});

	program
		.command("update")
		.description(
			"Fast-forward this checkout to its upstream (refused when it has local changes), rerun setup, re-apply the MCP client registrations and run the doctor",
		)
		.action(() => {
			process.exitCode = runUpdateCommand();
		});

	program
		.command("uninstall")
		.description(
			"Remove opencua: its MCP client registrations (backed up), running servers, the helper app and its permissions, the opencua command and its PATH line, ~/.opencua, and the checkout install.sh created",
		)
		.option("-y, --yes", "do not ask for confirmation")
		.option("--purge", "also delete this checkout when it is a developer checkout")
		.option("--dry-run", "print what would be removed and change nothing")
		.action(async (commandOptions: UninstallCommandOptions) => {
			process.exitCode = await runUninstallCommand(commandOptions);
		});
}
