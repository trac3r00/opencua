#!/usr/bin/env node
import { execFile, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
	ComputerInterface,
	KeyOptions,
	MacOSHostComputer,
	MacOSHostComputerOptions,
	PointerMode,
	ScrollOptions,
} from "@opencua/core";
import { AppApprovalStore, StopSwitch, resolveStateDir } from "@opencua/core/light";
import { Command } from "commander";
import { registerBrowserCommands } from "./browser-commands.js";
import { registerBuddyCommands } from "./buddy-commands.js";
import { registerDaemonCommands } from "./daemon-commands.js";
import { forwardToDaemon } from "./daemon.js";
import { IN_HELPER_ENV, needsHelperPermissions } from "./helper-route.js";
import { registerHistoryCommands } from "./history-commands.js";
import { deliveryFromEnv } from "./host-computer.js";
import { registerHudCommands } from "./hud-commands.js";
import { registerIosCommands } from "./ios.js";
import { resolveLayout } from "./layout.js";
import { registerLifecycleCommands, resolveCursorMotion } from "./lifecycle-commands.js";
import {
	type ReadCommandHost,
	registerAppsListCommand,
	registerAppsStateCommand,
	registerCursorCommand,
	registerScreenCommand,
	registerScreenshotCommand,
	registerWindowsListCommand,
} from "./read-commands.js";
import { registerSkillsCommands } from "./skills-command.js";
import { commandPathOf, isInputCommand, stopRefusalFor } from "./stop-gate.js";
import { registerUtmCommands } from "./utm.js";

// Every CLI run is a fresh process that compiles @opencua/core again; Node's on-disk compile cache keeps that
// compiled code between runs. Runtimes without it (older Node, Bun under test) simply compile as before; the
// installed type definitions predate it, hence the reflective lookup.
const enableCompileCache: unknown = Reflect.get(nodeModule, "enableCompileCache");
if (typeof enableCompileCache === "function") {
	Reflect.apply(enableCompileCache, nodeModule, []);
}

type PackageJson = {
	version: string;
};

type GlobalOptions = {
	json?: boolean;
	targetPid?: number;
	targetBundleId?: string;
	cursor?: boolean;
	background?: boolean;
};

type MouseButton = "left" | "right" | "middle";
type PermissionKind = "screen" | "accessibility" | "input-monitoring" | "apple-events";
type PermissionStatus = "authorized" | "denied" | "not-determined" | "restricted" | "unknown";
type KeyModifier = NonNullable<KeyOptions["modifiers"]>[number];
type Constructor = new () => unknown;

type PermissionController = {
	check(kind: PermissionKind): PermissionStatus | Promise<PermissionStatus>;
	request(kind: PermissionKind): undefined | Promise<undefined>;
};

type PointCommandOptions = {
	x?: number;
	y?: number;
};

type ClickCommandOptions = PointCommandOptions & {
	button: MouseButton;
};

type DragCommandOptions = {
	fromX?: number;
	fromY?: number;
	toX?: number;
	toY?: number;
	duration: number;
};

type ScrollCommandOptions = {
	direction: ScrollOptions["direction"];
	amount: number;
};

type KeyCommandOptions = {
	modifiers?: string;
};

export interface CursorOverlayAckOptions {
	requestedMode?: string;
	timeoutMs?: number;
	pollMs?: number;
	now?: () => number;
	sleep?: (milliseconds: number) => Promise<void>;
}

type CursorOverlayWithState = {
	setMode(mode: PointerMode): void;
	state?(options?: { readonly deadlineMs?: number }): Promise<{
		readonly shown: boolean;
		readonly mode?: string;
	} | null>;
};

export async function waitForCursorOverlayAck(
	overlay: CursorOverlayWithState,
	{
		requestedMode,
		timeoutMs = 1_000,
		pollMs = 100,
		now = Date.now,
		sleep: pause = sleep,
	}: CursorOverlayAckOptions = {},
): Promise<boolean> {
	const deadline = now() + timeoutMs;
	do {
		const remaining = deadline - now();
		if (remaining <= 0) return false;
		const state = overlay.state === undefined ? null : await overlay.state({ deadlineMs: remaining });
		if (now() >= deadline) return false;
		// A requested mode is answered by the mode the daemon reports; "shown" only says whether the cursor is drawn,
		// which is false whenever the overlay is idle or hidden and says nothing about whether the mode was applied.
		// Without requestedMode, any shown state is accepted for compatibility.
		if (requestedMode === undefined ? state?.shown === true : state?.mode === requestedMode) return true;
		await pause(Math.min(pollMs, deadline - now()));
	} while (now() < deadline);
	return false;
}

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const packageJson: PackageJson = readPackageJson();
const program = new Command();

program
	.name("opencua")
	.description("Native macOS computer-use control with Codex-style app-targeted tools.")
	.version(packageJson.version)
	.option("--json", "print machine-readable JSON output")
	.option(
		"--target-pid <pid>",
		"deliver input to a target process id using the cached app window session from get_app_state",
		parsePositiveInteger,
	)
	.option("--target-bundle-id <id>", "deliver input to the running app with this bundle identifier")
	.option("--no-cursor", "hide the synthetic white+blue cursor overlay (shown by default to mark where input lands)")
	.option(
		"--background",
		"deliver input without changing the frontmost app or moving the cursor (the default; kept for scripts that pass it)",
	);

// The read commands are defined once (read-commands.ts) and shared with the daemon, so both print the same output.
const inProcessReads: ReadCommandHost = {
	cwd: process.cwd(),
	json: isJsonOutput,
	withComputer: async (action, hostOptions) => await withComputer(action, hostOptions),
	emit: (result) => {
		process.stdout.write(result.stdout);
		process.stderr.write(result.stderr ?? "");
		if (result.exitCode !== 0) {
			process.exitCode = result.exitCode;
		}
	},
};

registerScreenshotCommand(program, inProcessReads);

program
	.command("click")
	.description("Click. With --target-pid, routes through the cached app window session.")
	.argument("[x]", "x coordinate")
	.argument("[y]", "y coordinate")
	.option("-x, --x <x>", "x coordinate", parseXCoordinate)
	.option("-y, --y <y>", "y coordinate", parseYCoordinate)
	.option("-b, --button <button>", "mouse button: left, right, or middle", parseMouseButton, "left")
	.action(async (x: string | undefined, y: string | undefined, options: ClickCommandOptions) => {
		const position = parsePointArguments(x, y, options);
		await withComputer((computer) => clickWithButton(computer, position, options.button));
		writeActionOutput(
			"click",
			{ ...position, button: options.button },
			`Clicked ${options.button} at ${position.x},${position.y}`,
		);
	});

program
	.command("right-click")
	.description("Right-click. With --target-pid, routes through the cached app window session.")
	.argument("[x]", "x coordinate")
	.argument("[y]", "y coordinate")
	.option("-x, --x <x>", "x coordinate", parseXCoordinate)
	.option("-y, --y <y>", "y coordinate", parseYCoordinate)
	.action(async (x: string | undefined, y: string | undefined, options: PointCommandOptions) => {
		const position = parsePointArguments(x, y, options);
		await withComputer((computer) => computer.rightClick(position));
		writeActionOutput("right-click", position, `Right-clicked at ${position.x},${position.y}`);
	});

program
	.command("middle-click")
	.description("Middle-click. With --target-pid, routes through the cached app window session.")
	.argument("[x]", "x coordinate")
	.argument("[y]", "y coordinate")
	.option("-x, --x <x>", "x coordinate", parseXCoordinate)
	.option("-y, --y <y>", "y coordinate", parseYCoordinate)
	.action(async (x: string | undefined, y: string | undefined, options: PointCommandOptions) => {
		const position = parsePointArguments(x, y, options);
		await withComputer((computer) => computer.middleClick(position));
		writeActionOutput("middle-click", position, `Middle-clicked at ${position.x},${position.y}`);
	});

program
	.command("double-click")
	.description("Double-click. With --target-pid, routes through the cached app window session.")
	.argument("[x]", "x coordinate")
	.argument("[y]", "y coordinate")
	.option("-x, --x <x>", "x coordinate", parseXCoordinate)
	.option("-y, --y <y>", "y coordinate", parseYCoordinate)
	.action(async (x: string | undefined, y: string | undefined, options: PointCommandOptions) => {
		const position = parsePointArguments(x, y, options);
		await withComputer((computer) => computer.doubleClick(position));
		writeActionOutput("double-click", position, `Double-clicked at ${position.x},${position.y}`);
	});

program
	.command("move")
	.description("Move cursor globally, or send mouseMoved to --target-pid without moving the real cursor.")
	.argument("[x]", "x coordinate")
	.argument("[y]", "y coordinate")
	.option("-x, --x <x>", "x coordinate", parseXCoordinate)
	.option("-y, --y <y>", "y coordinate", parseYCoordinate)
	.action(async (x: string | undefined, y: string | undefined, options: PointCommandOptions) => {
		const position = parsePointArguments(x, y, options);
		await withComputer((computer) => computer.move(position));
		writeActionOutput("move", position, `Moved cursor to ${position.x},${position.y}`);
	});

program
	.command("drag")
	.description("Drag. With --target-pid, routes through the cached app window session.")
	.argument("[fromX]", "start x coordinate")
	.argument("[fromY]", "start y coordinate")
	.argument("[toX]", "end x coordinate")
	.argument("[toY]", "end y coordinate")
	.option("--from-x <x>", "start x coordinate", parseXCoordinate)
	.option("--from-y <y>", "start y coordinate", parseYCoordinate)
	.option("--to-x <x>", "end x coordinate", parseXCoordinate)
	.option("--to-y <y>", "end y coordinate", parseYCoordinate)
	.option("-d, --duration <ms>", "duration in milliseconds", parseNonNegativeInteger, 500)
	.action(
		async (
			fromX: string | undefined,
			fromY: string | undefined,
			toX: string | undefined,
			toY: string | undefined,
			options: DragCommandOptions,
		) => {
			const args = parseDragArguments(fromX, fromY, toX, toY, options);
			await withComputer((computer) =>
				computer.drag({
					from: { x: args.fromX, y: args.fromY },
					to: { x: args.toX, y: args.toY },
					duration: args.duration,
				}),
			);
			writeActionOutput("drag", args, `Dragged from ${args.fromX},${args.fromY} to ${args.toX},${args.toY}`);
		},
	);

program
	.command("scroll")
	.description("Scroll globally with a wheel event, or scroll --target-pid through the cached app window session.")
	.requiredOption("-d, --direction <direction>", "direction: up, down, left, or right", parseScrollDirection)
	.option("-a, --amount <n>", "scroll amount", parsePositiveInteger, 3)
	.action(async (options: ScrollCommandOptions) => {
		await withComputer((computer) => computer.scroll({ direction: options.direction, amount: options.amount }));
		writeActionOutput("scroll", options, `Scrolled ${options.direction} by ${options.amount}`);
	});

program
	.command("cursor-mode")
	.description("Set the cursor overlay mode: pointer (acting), scroll, or thinking")
	.argument("<mode>", "pointer | scroll | thinking")
	.action(async (mode: string) => {
		const normalized: PointerMode = mode === "scroll" || mode === "thinking" ? mode : "pointer";
		const { NOOP_POINTER_OVERLAY, agentCursorEnabled, createCursorOverlay } = await import("@opencua/core");
		// Drive the shared overlay daemon directly (it persists across commands).
		// setMode writes to the daemon socket asynchronously; await briefly so the
		// command actually lands before this short-lived process exits (otherwise
		// the mode change is dropped and the cursor stays the plain pointer).
		const overlay = (
			program.opts<GlobalOptions>().cursor === false || !agentCursorEnabled()
				? NOOP_POINTER_OVERLAY
				: createCursorOverlay(undefined, resolveCursorMotion(resolveLayout().configPath))
		) as CursorOverlayWithState;
		overlay.setMode(normalized);
		const acknowledged = await waitForCursorOverlayAck(overlay, { requestedMode: normalized });
		// The flag reports what the overlay actually confirmed, so a script can tell an applied mode from a bare send.
		writeActionOutput("cursor-mode", { mode: normalized, acknowledged }, `Cursor mode: ${normalized}`);
	});

program
	.command("type")
	.description("Type text")
	.argument("<text...>", "text to type")
	.action(async (textParts: string[]) => {
		const text = textParts.join(" ");
		await withComputer((computer) => computer.type(text));
		writeActionOutput("type", { text }, `Typed: ${text}`);
	});

program
	.command("key")
	.description("Press key with optional modifiers")
	.argument("<key>", "key to press")
	.option("-m, --modifiers <csv>", "modifiers (comma-separated: cmd,alt,ctrl,shift)")
	.action(async (key: string, options: KeyCommandOptions) => {
		const modifiers = options.modifiers === undefined ? [] : parseModifiersCsv(options.modifiers);
		await withComputer((computer) => computer.key(key, { modifiers }));
		writeActionOutput("key", { key, modifiers }, `Pressed: ${formatKeyChord(key, modifiers)}`);
	});

program
	.command("keypress")
	.description("Press a key chord")
	.argument("<keys...>", "key chord, for example: cmd shift t")
	.action(async (keys: string[]) => {
		if (keys.length === 0) {
			throw new Error("keypress requires at least one key");
		}
		const key = keys[keys.length - 1];
		if (key === undefined) {
			throw new Error("keypress requires a key");
		}
		const modifiers = keys.slice(0, -1).map(parseModifier);
		await withComputer((computer) => computer.key(key, { modifiers }));
		writeActionOutput("keypress", { keys, key, modifiers }, `Pressed: ${formatKeyChord(key, modifiers)}`);
	});

program
	.command("wait")
	.description("Sleep for N milliseconds")
	.argument("<ms>", "milliseconds to wait")
	.action(async (milliseconds: string) => {
		const duration = parseNonNegativeInteger(milliseconds);
		await sleep(duration);
		writeActionOutput("wait", { milliseconds: duration }, `Waited ${duration}ms`);
	});

registerCursorCommand(program, inProcessReads);
registerScreenCommand(program, inProcessReads);

const permissionsCommand = program.command("permissions").description("Manage macOS permissions");

permissionsCommand
	.command("check")
	.description("Check a macOS permission status")
	.argument("<kind>", "permission kind: screen, accessibility, input-monitoring, or apple-events", parsePermissionKind)
	.action(async (kind: PermissionKind) => {
		const permissions = await loadPermissions();
		const status = permissions === null ? "unknown" : await permissions.check(kind);
		writeOutput(status, status);
	});

permissionsCommand
	.command("request")
	.description("Trigger a macOS permission dialog")
	.argument("<kind>", "permission kind: screen, accessibility, input-monitoring, or apple-events", parsePermissionKind)
	.action(async (kind: PermissionKind) => {
		const permissions = await loadPermissions();
		if (permissions === null) {
			throw new Error("MacOSPermissions is not available in @opencua/core yet");
		}
		await permissions.request(kind);
		writeOutput({ ok: true, kind }, `Requested ${kind} permission`);
	});

const windowsCommand = program.command("windows").description("Inspect macOS windows");

windowsCommand
	.command("active")
	.description("Print active window")
	.action(async () => {
		const windows = await loadWindows();
		const activeWindow = await callFirstMethod(windows, ["active", "getActiveWindow", "activeWindow"]);
		writeOutput(activeWindow, formatUnknown(activeWindow));
	});

registerWindowsListCommand(windowsCommand, inProcessReads);

const appsCommand = program.command("apps").description("Inspect running apps and their accessibility state");

registerAppsListCommand(appsCommand, inProcessReads);
registerAppsStateCommand(appsCommand, inProcessReads);

appsCommand
	.command("set-value <app> <elementIndex> <value>")
	.description("Set the value of a settable accessibility element (e.g. a text field)")
	.action(async (app: string, elementIndex: string, value: string) => {
		await withComputer(async (computer) => {
			const pid = await resolveAppPidForCli(computer, app);
			await computer.setValue(pid, parseElementIndexForCli(elementIndex), value);
			writeOutput({ ok: true, app, pid, elementIndex: Number(elementIndex) }, "ok");
		});
	});

appsCommand
	.command("perform-action <app> <elementIndex> <action>")
	.description("Perform an AX action on an element (e.g. AXPress, AXRaise)")
	.action(async (app: string, elementIndex: string, action: string) => {
		await withComputer(async (computer) => {
			const pid = await resolveAppPidForCli(computer, app);
			await computer.performAction(pid, parseElementIndexForCli(elementIndex), action);
			writeOutput({ ok: true, app, pid, elementIndex: Number(elementIndex), action }, "ok");
		});
	});

appsCommand
	.command("select-text <app> <elementIndex>")
	.description("Select text in an element, or place the caret before/after a match")
	.option("--text <text>", "Text to select")
	.option("--prefix <prefix>", "Disambiguate a repeated match by preceding text")
	.option("--suffix <suffix>", "Disambiguate a repeated match by following text")
	.option("--selection <selection>", "Selection mode (default: text)")
	.action(
		async (
			app: string,
			elementIndex: string,
			options: { text?: string; prefix?: string; suffix?: string; selection?: string },
		) => {
			await withComputer(async (computer) => {
				const pid = await resolveAppPidForCli(computer, app);
				await computer.selectText(pid, parseElementIndexForCli(elementIndex), {
					selection: parseSelectionForCli(options.selection),
					...(options.text !== undefined ? { text: options.text } : {}),
					...(options.prefix !== undefined ? { prefix: options.prefix } : {}),
					...(options.suffix !== undefined ? { suffix: options.suffix } : {}),
				});
				writeOutput({ ok: true, app, pid, elementIndex: Number(elementIndex) }, "ok");
			});
		},
	);

program
	.command("stop")
	.description(
		"Stop computer use for every opencua agent on this Mac; only `opencua resume` lifts it (keyboard chord: Control+Option+Command)",
	)
	.option("--reason <text>", "why computer use is being stopped", "stopped by user")
	.action((options: { reason: string }) => {
		const status = new StopSwitch().stop(options.reason, "cli");
		writeOutput(status, `computer use stopped (${status.reason}); resume with \`opencua resume\``);
	});

program
	.command("resume")
	.description("Lift the stop so opencua agents may use the computer again")
	.action(() => {
		const wasStopped = new StopSwitch().resume();
		writeOutput({ stopped: false, wasStopped }, wasStopped ? "computer use resumed" : "computer use was not stopped");
	});

program
	.command("stop-status")
	.description("Show whether computer use is stopped")
	.action(() => {
		const status = new StopSwitch().status();
		writeOutput(
			status,
			status.stopped
				? `stopped (${status.source} at ${status.stoppedAt}): ${status.reason}`
				: "computer use is not stopped",
		);
	});

registerIosCommands(program, { isJsonOutput });
registerBrowserCommands(program, { isJsonOutput });
registerHistoryCommands(program, { isJsonOutput });
registerLifecycleCommands(program, { isJsonOutput });
registerUtmCommands(program, { isJsonOutput });
registerHudCommands(program, { isJsonOutput });
registerSkillsCommands(program);
registerBuddyCommands(program, {
	isJsonOutput,
	stateDir: resolveStateDir(),
	entryScript: fileURLToPath(import.meta.url),
	withComputer: async (action) => await withComputer(action),
	overlay: async () => {
		const { NOOP_POINTER_OVERLAY, agentCursorEnabled, createCursorOverlay } = await import("@opencua/core");
		return program.opts<GlobalOptions>().cursor === false || !agentCursorEnabled()
			? NOOP_POINTER_OVERLAY
			: createCursorOverlay(undefined, resolveCursorMotion(resolveLayout().configPath));
	},
});

// Refuse input commands while the stop switch is on, before any command code can send input.
program.hook("preAction", (_program, actionCommand) => {
	const commandPath = commandPathOf(actionCommand);
	const refusal = stopRefusalFor(commandPath, new StopSwitch());
	if (refusal !== undefined) {
		throw new Error(refusal);
	}
	const options = program.opts<GlobalOptions>();
	if (
		isInputCommand(commandPath) &&
		!commandPath.includes(" ") &&
		options.targetPid === undefined &&
		options.targetBundleId === undefined
	) {
		throw new Error("app-target-required: pass --target-pid or --target-bundle-id before sending input");
	}
	if (needsHelperPermissions(commandPath)) {
		relaunchInHelper();
	}
});

registerDaemonCommands(program, { entryScript: fileURLToPath(import.meta.url), stateDir: resolveStateDir() });

// A running daemon answers the read commands without this process starting the core, its capture session or the
// helper relaunch; any failure to reach it falls through to the in-process path below.
if (process.env[IN_HELPER_ENV] !== "1") {
	const forwarded = await forwardToDaemon(process.argv.slice(2), {
		stateDir: resolveStateDir(),
		cwd: process.cwd(),
		env: process.env,
	});
	if (forwarded !== undefined) {
		process.stdout.write(forwarded.stdout);
		process.stderr.write(forwarded.stderr);
		process.exit(forwarded.exitCode);
	}
}

await program.parseAsync().catch(handleError);

/**
 * Runs this command again inside the "opencua-mcp" helper, which holds the macOS permissions the person granted, and
 * exits with its status. A source run (tests, development) or a checkout without a built helper stays in place.
 */
function relaunchInHelper(): void {
	const script = fileURLToPath(import.meta.url);
	if (process.platform !== "darwin" || process.env[IN_HELPER_ENV] === "1" || !script.endsWith(".js")) {
		return;
	}
	const { helperExecutable } = resolveLayout();
	if (!existsSync(helperExecutable)) {
		return;
	}
	const result = spawnSync(helperExecutable, [script, ...process.argv.slice(2)], {
		stdio: "inherit",
		env: { ...process.env, [IN_HELPER_ENV]: "1" },
	});
	process.exit(result.status ?? 1);
}

/** Resolve an app name/bundleId to a pid, reusing the same matching as `apps state`. */
async function resolveAppPidForCli(computer: MacOSHostComputer, app: string): Promise<number> {
	const { getAppStateForApp } = await import("@opencua/core");
	const state = await getAppStateForApp(computer, app);
	return state.pid;
}

/** Element indices address the AX tree from `apps state`; reject junk rather than sending NaN. */
function parseElementIndexForCli(raw: string): number {
	const index = Number(raw);
	if (!Number.isInteger(index) || index < 0) {
		throw new Error(`Invalid element index "${raw}": expected a non-negative integer`);
	}
	return index;
}

/** Selection mode is a closed set in core; validate here so a typo fails loudly. */
function parseSelectionForCli(raw: string | undefined): "text" | "before" | "after" {
	const selection = raw ?? "text";
	if (selection !== "text" && selection !== "before" && selection !== "after") {
		throw new Error(`Invalid --selection "${raw}": expected text, before, or after`);
	}
	return selection;
}

function readPackageJson(): PackageJson {
	const parsed: { version: string } = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf8")) as {
		version: string;
	};
	if (typeof parsed.version !== "string") {
		throw new Error("Invalid package.json: version must be a string");
	}
	return parsed;
}

async function withComputer<T>(
	action: (computer: MacOSHostComputer) => Promise<T>,
	hostOptions: MacOSHostComputerOptions = {},
): Promise<T> {
	// Commander sets `cursor` to false only when `--no-cursor` is passed; the overlay
	// is shown by default. When hidden, inject the no-op overlay so no helper spawns.
	const { MacOSHostComputer, NOOP_POINTER_OVERLAY, agentCursorEnabled } = await import("@opencua/core");
	const showCursor = program.opts<GlobalOptions>().cursor !== false && agentCursorEnabled();
	const computer = new MacOSHostComputer({
		appApproval: new AppApprovalStore(
			process.env["OPENCUA_ALLOWED_BUNDLE_IDS"]
				?.split(",")
				.map((bundleId) => bundleId.trim())
				.filter((bundleId) => bundleId.length > 0),
		),
		delivery: deliveryFromEnv(process.env),
		...(showCursor ? { cursorMotion: resolveCursorMotion(resolveLayout().configPath) } : {}),
		...hostOptions,
		...(showCursor ? {} : { overlay: NOOP_POINTER_OVERLAY }),
	});
	try {
		const targetPid = await resolveTargetPid();
		computer.setTarget(targetPid);
		return await action(computer);
	} finally {
		await computer.close();
	}
}

async function clickWithButton(
	computer: ComputerInterface,
	position: { x: number; y: number },
	button: MouseButton,
): Promise<void> {
	switch (button) {
		case "left":
			await computer.click(position);
			return;
		case "right":
			await computer.rightClick(position);
			return;
		case "middle":
			await computer.middleClick(position);
			return;
	}
}

async function resolveTargetPid(): Promise<number | undefined> {
	const options = program.opts<GlobalOptions>();
	if (options.targetPid !== undefined && options.targetBundleId !== undefined) {
		throw new Error("Use only one of --target-pid or --target-bundle-id");
	}
	if (options.targetPid !== undefined) {
		return options.targetPid;
	}
	if (options.targetBundleId !== undefined) {
		return resolvePidForBundleId(options.targetBundleId);
	}
	return undefined;
}

async function resolvePidForBundleId(bundleId: string): Promise<number> {
	const script = `tell application "System Events" to get unix id of first process whose bundle identifier is ${toAppleScriptString(bundleId)}`;
	const { stdout } = await execFileAsync("osascript", ["-e", script], { encoding: "utf8" });
	return parsePositiveInteger(stdout.trim());
}

function toAppleScriptString(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function parseInteger(value: string, name: string): number {
	const number = Number.parseInt(value, 10);
	if (!Number.isSafeInteger(number)) {
		throw new Error(`${name} must be an integer`);
	}
	return number;
}

function parseXCoordinate(value: string): number {
	return parseInteger(value, "x");
}

function parseYCoordinate(value: string): number {
	return parseInteger(value, "y");
}

function parsePointArguments(
	xArgument: string | undefined,
	yArgument: string | undefined,
	options: PointCommandOptions,
): { x: number; y: number } {
	const x = options.x ?? (xArgument === undefined ? undefined : parseInteger(xArgument, "x"));
	const y = options.y ?? (yArgument === undefined ? undefined : parseInteger(yArgument, "y"));
	if (x === undefined || y === undefined) {
		throw new Error("x and y are required (pass positional coordinates or --x/--y)");
	}
	return { x, y };
}

function parseDragArguments(
	fromXArgument: string | undefined,
	fromYArgument: string | undefined,
	toXArgument: string | undefined,
	toYArgument: string | undefined,
	options: DragCommandOptions,
): { fromX: number; fromY: number; toX: number; toY: number; duration: number } {
	const fromX = options.fromX ?? (fromXArgument === undefined ? undefined : parseInteger(fromXArgument, "fromX"));
	const fromY = options.fromY ?? (fromYArgument === undefined ? undefined : parseInteger(fromYArgument, "fromY"));
	const toX = options.toX ?? (toXArgument === undefined ? undefined : parseInteger(toXArgument, "toX"));
	const toY = options.toY ?? (toYArgument === undefined ? undefined : parseInteger(toYArgument, "toY"));
	if (fromX === undefined || fromY === undefined || toX === undefined || toY === undefined) {
		throw new Error(
			"fromX, fromY, toX, and toY are required (pass positional coordinates or --from-x/--from-y/--to-x/--to-y)",
		);
	}
	return { fromX, fromY, toX, toY, duration: options.duration };
}

function parseNonNegativeInteger(value: string): number {
	const number = parseInteger(value, "value");
	if (number < 0) {
		throw new Error("value must be non-negative");
	}
	return number;
}

function parsePositiveInteger(value: string): number {
	const number = parseInteger(value, "value");
	if (number <= 0) {
		throw new Error("value must be positive");
	}
	return number;
}

function parseMouseButton(value: string): MouseButton {
	if (value === "left" || value === "right" || value === "middle") {
		return value;
	}
	throw new Error("button must be left, right, or middle");
}

function parseScrollDirection(value: string): ScrollOptions["direction"] {
	if (value === "up" || value === "down" || value === "left" || value === "right") {
		return value;
	}
	throw new Error("direction must be up, down, left, or right");
}

function parsePermissionKind(value: string): PermissionKind {
	if (value === "screen" || value === "accessibility" || value === "input-monitoring" || value === "apple-events") {
		return value;
	}
	throw new Error("permission kind must be screen, accessibility, input-monitoring, or apple-events");
}

function parseModifiersCsv(value: string): KeyModifier[] {
	if (value.trim() === "") {
		return [];
	}
	return value.split(",").map((modifier) => parseModifier(modifier.trim()));
}

function parseModifier(value: string): KeyModifier {
	switch (value) {
		case "cmd":
		case "command":
			return "command";
		case "alt":
		case "option":
			return "option";
		case "ctrl":
		case "control":
			return "control";
		case "shift":
			return "shift";
		default:
			throw new Error(`unsupported modifier: ${value}`);
	}
}

function formatKeyChord(key: string, modifiers: KeyModifier[]): string {
	return modifiers.length === 0 ? key : `${modifiers.join("+")}+${key}`;
}

function isJsonOutput(): boolean {
	return program.opts<GlobalOptions>().json === true;
}

function writeOutput(jsonValue: unknown, humanValue: string): void {
	if (isJsonOutput()) {
		process.stdout.write(`${JSON.stringify(jsonValue)}\n`);
		return;
	}
	process.stdout.write(`${humanValue}\n`);
}

function writeActionOutput(action: string, args: Record<string, unknown>, humanValue: string): void {
	writeOutput({ ok: true, action, args }, humanValue);
}

async function loadPermissions(): Promise<PermissionController | null> {
	const permissionsConstructor = await loadOptionalConstructor("MacOSPermissions");
	if (permissionsConstructor === null) {
		return null;
	}
	const permissions = new permissionsConstructor();
	if (!hasPermissionController(permissions)) {
		throw new Error("MacOSPermissions does not implement check/request");
	}
	return permissions;
}

async function loadWindows(): Promise<unknown> {
	const windowsConstructor = await loadOptionalConstructor("MacOSWindows");
	if (windowsConstructor === null) {
		throw new Error("MacOSWindows is not available in @opencua/core yet");
	}
	return new windowsConstructor();
}

async function loadOptionalConstructor(exportName: string): Promise<Constructor | null> {
	const coreExports = Object.fromEntries(Object.entries(await import("@opencua/core")));
	const exportedValue = coreExports[exportName];
	return isConstructor(exportedValue) ? exportedValue : null;
}

function isConstructor(value: unknown): value is Constructor {
	return typeof value === "function";
}

function hasPermissionController(value: unknown): value is PermissionController {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const candidate = value as { check?: unknown; request?: unknown };
	return typeof candidate.check === "function" && typeof candidate.request === "function";
}

async function callFirstMethod(instance: unknown, methodNames: string[]): Promise<unknown> {
	if (typeof instance !== "object" || instance === null) {
		throw new Error("window controller is not an object");
	}
	const methods = instance as Record<string, unknown>;
	for (const methodName of methodNames) {
		const method = methods[methodName];
		if (typeof method === "function") {
			return await method.call(instance);
		}
	}
	throw new Error(`window controller is missing one of: ${methodNames.join(", ")}`);
}

function formatUnknown(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	return JSON.stringify(value, null, 2);
}

function handleError(error: unknown): never {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`${message}\n`);
	process.exit(1);
}
