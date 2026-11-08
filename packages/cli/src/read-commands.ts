import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ComputerInterface, MacOSHostComputerOptions, ScreenshotOptions } from "@opencua/core";
import type { Command } from "commander";

export type CommandResult = { readonly stdout: string; readonly exitCode: number };

export type GlobalOptions = {
	json?: boolean;
	targetPid?: number;
	targetBundleId?: string;
	cursor?: boolean;
	background?: boolean;
};

export type HostOptions = Pick<MacOSHostComputerOptions, "display">;

/** Where a read command runs: in the CLI process, or in the daemon on behalf of a client. */
export interface ReadCommandHost {
	/** Directory relative output paths resolve against: the client's cwd. */
	readonly cwd: string;
	json(): boolean;
	withComputer<T>(action: (computer: ComputerInterface) => Promise<T>, hostOptions?: HostOptions): Promise<T>;
	emit(result: CommandResult): void;
}

type ScreenshotCommandOptions = {
	output: string;
	region?: string;
	display?: number;
	format: "png" | "jpeg";
	quality: number;
};

type AppStateCommandOptions = {
	screenshot?: boolean;
	maxElements?: number;
	windowId?: number;
	menuBar?: boolean;
};

type Constructor = new () => unknown;

/** The program-level options; the daemon parses each request with these same definitions. */
export function addGlobalOptions(program: Command): Command {
	return program
		.option("--json", "print machine-readable JSON output")
		.option(
			"--target-pid <pid>",
			"deliver input to a target process id using the cached app window session from get_app_state",
			parsePositiveInteger,
		)
		.option("--target-bundle-id <id>", "deliver input to the running app with this bundle identifier")
		.option(
			"--no-cursor",
			"hide the synthetic white+blue cursor overlay (shown by default to mark where input lands)",
		)
		.option(
			"--background",
			"deliver input without changing the frontmost app or moving the cursor (the default; kept for scripts that pass it)",
		);
}

export function registerScreenshotCommand(program: Command, host: ReadCommandHost): void {
	program
		.command("screenshot")
		.description("Take a screenshot")
		.option("-o, --output <path>", "output file path", "./screenshot.png")
		.option("-r, --region <x,y,w,h>", "screenshot region in global screen points")
		.option("--display <id>", "capture this display id instead of the main display", parsePositiveInteger)
		.option("-f, --format <format>", "image format: png or jpeg", parseScreenshotFormat, "png")
		.option("-q, --quality <n>", "JPEG quality from 1 to 100", parseQuality, 95)
		.action(async (options: ScreenshotCommandOptions) => host.emit(await screenshotCommand(host, options)));
}

export function registerCursorCommand(program: Command, host: ReadCommandHost): void {
	program
		.command("cursor")
		.description("Get cursor position")
		.action(async () => {
			const position = await host.withComputer((computer) => computer.getCursorPosition());
			host.emit(output(host, position, `${position.x},${position.y}`));
		});
}

export function registerScreenCommand(program: Command, host: ReadCommandHost): void {
	program
		.command("screen")
		.description("Get screen size")
		.action(async () => {
			const size = await host.withComputer((computer) => computer.getScreenSize());
			host.emit(output(host, size, `${size.width}x${size.height}`));
		});
}

export function registerWindowsListCommand(windows: Command, host: ReadCommandHost): void {
	windows
		.command("list")
		.description("Print all windows")
		.action(async () => {
			const windowList = await callFirstMethod(await loadWindows(), ["list", "listWindows", "all"]);
			host.emit(output(host, windowList, formatUnknown(windowList)));
		});
}

export function registerAppsListCommand(apps: Command, host: ReadCommandHost): void {
	apps
		.command("list")
		.description("Print running apps (name, bundleId, pid)")
		.action(async () => {
			const list = await host.withComputer((computer) => computer.listApps());
			host.emit(output(host, list, list.map((app) => `${app.pid}\t${app.bundleId}\t${app.name}`).join("\n")));
		});
}

export function registerAppsStateCommand(apps: Command, host: ReadCommandHost): void {
	apps
		.command("state <app>")
		.description("Print an app's accessibility (AX) element tree")
		.option("--screenshot", "Include the base64 screenshot payload (large; omitted by default)")
		.option("--max-elements <count>", "Cap the accessibility elements walked", (value) => Number.parseInt(value, 10))
		.option("--window-id <id>", "Observe this WindowServer window id instead of the focused window", (value) =>
			Number.parseInt(value, 10),
		)
		.option("--menu-bar", "Include the application menu bar")
		.action(async (app: string, options: AppStateCommandOptions) =>
			host.emit(await appsStateCommand(host, app, options)),
		);
}

export function registerReadCommands(program: Command, host: ReadCommandHost): void {
	registerScreenshotCommand(program, host);
	registerCursorCommand(program, host);
	registerScreenCommand(program, host);
	registerWindowsListCommand(program.command("windows").description("Inspect macOS windows"), host);
	const apps = program.command("apps").description("Inspect running apps and their accessibility state");
	registerAppsListCommand(apps, host);
	registerAppsStateCommand(apps, host);
}

async function screenshotCommand(host: ReadCommandHost, options: ScreenshotCommandOptions): Promise<CommandResult> {
	const region = options.region === undefined ? undefined : parseRegion(options.region);
	const hostOptions = options.display === undefined ? {} : { display: options.display };
	const screenshotOptions: ScreenshotOptions = {
		format: options.format,
		quality: options.quality,
		...(region === undefined ? {} : { region }),
	};
	const result = await host.withComputer((computer) => computer.screenshot(screenshotOptions), hostOptions);
	writeFileSync(resolve(host.cwd, options.output), result.data);
	return output(
		host,
		{
			ok: true,
			action: "screenshot",
			args: {
				output: options.output,
				format: options.format,
				quality: options.quality,
				...(region === undefined ? {} : { region }),
				...(options.display === undefined ? {} : { display: options.display }),
			},
			output: options.output,
			mimeType: result.mimeType,
			width: result.width,
			height: result.height,
		},
		`Screenshot saved to ${options.output} (${result.mimeType}, ${result.width}x${result.height})`,
	);
}

async function appsStateCommand(
	host: ReadCommandHost,
	app: string,
	options: AppStateCommandOptions,
): Promise<CommandResult> {
	const { getAppStateForApp } = await import("@opencua/core");
	const state = await host.withComputer((computer) =>
		getAppStateForApp(computer, app, {
			...(options.maxElements === undefined ? {} : { maxElements: options.maxElements }),
			...(options.windowId === undefined ? {} : { windowId: options.windowId }),
			...(options.menuBar === true ? { includeMenuBar: true } : {}),
		}),
	);
	// The base64 screenshot dwarfs the AX tree and makes the JSON unusable for
	// programmatic consumers, so it is dropped unless explicitly requested.
	const payload = options.screenshot === true ? state : { ...state, screenshotBase64: "" };
	return output(
		host,
		payload,
		[
			`${state.app} (${state.bundleId}) pid=${state.pid} frontmost=${state.frontmost} axAvailable=${state.axAvailable}${state.windowId === undefined ? "" : ` window=${state.windowId}${state.windowTitle === undefined ? "" : ` (${state.windowTitle})`}`}`,
			...(state.windowCandidates ?? []).map(
				(candidate) =>
					`candidate #${candidate.id}\t${candidate.title}\t` +
					`[${candidate.bounds.x},${candidate.bounds.y},${candidate.bounds.width},${candidate.bounds.height}]`,
			),
			...state.elements.map(
				(element) =>
					`#${element.id}\t${element.role}\t${element.label ?? ""}\t` +
					`[${element.frame.x},${element.frame.y},${element.frame.width},${element.frame.height}]`,
			),
		].join("\n"),
	);
}

function output(host: ReadCommandHost, jsonValue: unknown, humanValue: string): CommandResult {
	return { stdout: host.json() ? `${JSON.stringify(jsonValue)}\n` : `${humanValue}\n`, exitCode: 0 };
}

export async function loadWindows(): Promise<unknown> {
	const coreExports = Object.fromEntries(Object.entries(await import("@opencua/core")));
	const windowsConstructor = coreExports["MacOSWindows"];
	if (!isConstructor(windowsConstructor)) {
		throw new Error("MacOSWindows is not available in @opencua/core yet");
	}
	return new windowsConstructor();
}

function isConstructor(value: unknown): value is Constructor {
	return typeof value === "function";
}

export async function callFirstMethod(instance: unknown, methodNames: string[]): Promise<unknown> {
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

export function formatUnknown(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	return JSON.stringify(value, null, 2);
}

export function parseInteger(value: string, name: string): number {
	const number = Number.parseInt(value, 10);
	if (!Number.isSafeInteger(number)) {
		throw new Error(`${name} must be an integer`);
	}
	return number;
}

export function parsePositiveInteger(value: string): number {
	const number = parseInteger(value, "value");
	if (number <= 0) {
		throw new Error("value must be positive");
	}
	return number;
}

function parseQuality(value: string): number {
	const quality = parsePositiveInteger(value);
	if (quality > 100) {
		throw new Error("quality must be between 1 and 100");
	}
	return quality;
}

function parseRegion(value: string): NonNullable<ScreenshotOptions["region"]> {
	const parts = value.split(",").map((part) => parseInteger(part.trim(), "region value"));
	const [x, y, width, height] = parts;
	if (parts.length !== 4 || x === undefined || y === undefined || width === undefined || height === undefined) {
		throw new Error("region must be x,y,width,height");
	}
	return { x, y, width, height };
}

function parseScreenshotFormat(value: string): ScreenshotOptions["format"] {
	if (value === "png" || value === "jpeg") {
		return value;
	}
	throw new Error("format must be png or jpeg");
}
