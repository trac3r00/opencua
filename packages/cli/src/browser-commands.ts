import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type { Command } from "commander";
import { z } from "zod";
import { resolveLayout } from "./layout.js";

const execFileAsync = promisify(execFile);

/** The browser service pulls in its own dependency tree, so it loads only when a browser command runs. */
const browserService = (): Promise<typeof import("@opencua/browser")> => import("@opencua/browser");

export type BrowserInstall = {
	readonly name: string;
	readonly appPath: string;
	readonly extensionsUrl: string;
};

export type BrowserStatus = {
	readonly connected: boolean;
	readonly stopped: boolean;
	readonly spaces: readonly unknown[];
	readonly daemonRunning: boolean;
};

type BrowserSetupOptions = {
	readonly wait: boolean;
	readonly open: boolean;
	readonly browser?: string;
	readonly extension?: string;
	readonly timeoutMs?: number;
};

type BrowserCommandOptions = {
	readonly isJsonOutput: () => boolean;
};

const CANDIDATES: readonly BrowserInstall[] = [
	{
		name: "Brave",
		appPath: "/Applications/Brave Browser.app",
		extensionsUrl: "brave://extensions",
	},
	{
		name: "Google Chrome",
		appPath: "/Applications/Google Chrome.app",
		extensionsUrl: "chrome://extensions",
	},
	{
		name: "Microsoft Edge",
		appPath: "/Applications/Microsoft Edge.app",
		extensionsUrl: "edge://extensions",
	},
	{
		name: "Arc",
		appPath: "/Applications/Arc.app",
		extensionsUrl: "arc://extensions",
	},
	{
		name: "Vivaldi",
		appPath: "/Applications/Vivaldi.app",
		extensionsUrl: "vivaldi://extensions",
	},
	{
		name: "Chromium",
		appPath: "/Applications/Chromium.app",
		extensionsUrl: "chrome://extensions",
	},
	{
		name: "Aside",
		appPath: "/Applications/Aside.app",
		extensionsUrl: "chrome://extensions",
	},
];

export function detectChromiumBrowsers(home = homedir()): readonly BrowserInstall[] {
	return CANDIDATES.filter(
		(candidate) => existsSync(candidate.appPath) || existsSync(join(home, "Applications", `${candidate.name}.app`)),
	).map((candidate) => {
		const local = join(home, "Applications", `${candidate.name}.app`);
		return existsSync(candidate.appPath) ? candidate : { ...candidate, appPath: local };
	});
}

export function browserSetupInstructions(browser: BrowserInstall | undefined, extensionPath: string): string {
	const lines = [
		"One-time human step (the extension stays local; no store install needed):",
		browser === undefined
			? "  1. Open your Chromium browser's extensions page."
			: `  1. Open ${browser.extensionsUrl} in ${browser.name}.`,
		"  2. Turn on Developer mode.",
		"  3. Choose Load unpacked and select the folder below. Its path is on the clipboard.",
		`     ${extensionPath}`,
		"  4. Return here. Browser pages will stay in a minimized background window.",
	];
	return lines.join("\n");
}

async function copyToClipboard(value: string): Promise<boolean> {
	return await new Promise<boolean>((resolveCopy) => {
		const child = execFile("pbcopy", [], (error) => resolveCopy(error === null));
		child.stdin?.end(value);
	});
}

async function openInBackground(browser: BrowserInstall): Promise<boolean> {
	try {
		await execFileAsync("open", ["-g", "-a", browser.appPath, browser.extensionsUrl], { timeout: 5000 });
		return true;
	} catch {
		return false;
	}
}

async function readStatus(): Promise<BrowserStatus> {
	const doctor = await (await browserService()).doctorBrowserService();
	let connected = false;
	let stopped = false;
	let spaces: readonly unknown[] = [];
	try {
		const connection = await (await browserService()).readConnection();
		const response = await fetch(`http://127.0.0.1:${connection.port}/rpc`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${connection.token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ action: "status" }),
			signal: AbortSignal.timeout(1500),
		});
		if (response.ok) {
			const parsed = z
				.object({ connected: z.boolean(), stopped: z.boolean(), spaces: z.array(z.unknown()) })
				.safeParse(await response.json());
			if (parsed.success) {
				connected = parsed.data.connected;
				stopped = parsed.data.stopped;
				spaces = parsed.data.spaces;
			}
		}
	} catch {
		connected = false;
	}
	return { connected, stopped, spaces, daemonRunning: doctor.running };
}

async function waitForConnection(timeoutMs: number, onProgress: (elapsedMs: number) => void): Promise<BrowserStatus> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const status = await readStatus();
		if (status.connected) return status;
		onProgress(timeoutMs - (deadline - Date.now()));
		await sleep(1000);
	}
	return await readStatus();
}

export async function setupBrowser(
	options: BrowserSetupOptions,
	report: (line: string) => void = () => undefined,
): Promise<{
	readonly extensionPath: string;
	readonly browser: BrowserInstall | undefined;
	readonly opened: boolean;
	readonly clipboard: boolean;
	readonly status: BrowserStatus;
	readonly instructions: string;
}> {
	const layout = resolveLayout();
	const browserCli = join(layout.checkout, "packages/browser/dist/cli.js");
	if (!existsSync(browserCli)) {
		throw new Error(
			`The browser package is not built (${browserCli} is missing). Run: pnpm --filter @opencua/browser build`,
		);
	}
	const extensionPath = options.extension ?? join(layout.checkout, "packages/browser/extension");
	if (!existsSync(join(extensionPath, "manifest.json"))) {
		throw new Error(`No browser extension manifest at ${extensionPath}`);
	}
	let status = await readStatus();
	if (!status.connected) {
		const doctor = await (await browserService()).doctorBrowserService();
		if (!doctor.installed || !doctor.running) await (await browserService()).installBrowserService();
		status = await readStatus();
	}
	if (status.connected) {
		return {
			extensionPath,
			browser: undefined,
			opened: false,
			clipboard: false,
			status,
			instructions: "The browser extension is already connected.",
		};
	}
	const browsers = detectChromiumBrowsers(layout.home);
	const selected =
		browsers.find((candidate) => candidate.name.toLowerCase() === options.browser?.toLowerCase()) ?? browsers[0];
	const clipboard = await copyToClipboard(extensionPath);
	const opened = options.open && selected !== undefined ? await openInBackground(selected) : false;
	const instructions = browserSetupInstructions(selected, extensionPath);
	report(instructions);
	if (selected === undefined) {
		report("No supported Chromium browser was found. Install Brave, Chrome, Edge, Arc, Vivaldi, Chromium, or Aside.");
	} else if (!opened) {
		report(`Open ${selected.extensionsUrl} manually in ${selected.name}.`);
	}
	if (options.wait && (process.stdout.isTTY || process.env["OPENCUA_BROWSER_WAIT"] === "1")) {
		report("Waiting for the extension to connect (up to 120 seconds)...");
		status = await waitForConnection(options.timeoutMs ?? 120_000, (elapsed) => {
			if (elapsed > 0 && elapsed % 15_000 < 1000) report(`Still waiting: ${Math.round(elapsed / 1000)}s`);
		});
	}
	return { extensionPath, browser: selected, opened, clipboard, status, instructions };
}

export function registerBrowserCommands(program: Command, options: BrowserCommandOptions): void {
	const browser = program
		.command("browser")
		.description("Set up and inspect the background browser bridge used by the browser skill");

	browser
		.command("setup")
		.description("Build, install, and pair the background Chromium extension; prints the one human step")
		.option("--no-wait", "print the setup step and exit instead of waiting for the extension to connect")
		.option("--no-open", "do not open the browser's extensions page in the background")
		.option("--browser <name>", "Brave, Google Chrome, Microsoft Edge, Arc, Vivaldi, Chromium, or Aside")
		.option("--extension <path>", "use this unpacked extension directory")
		.action(async (flags: { wait: boolean; open: boolean; browser?: string; extension?: string }) => {
			const report = options.isJsonOutput()
				? (line: string) => process.stderr.write(`${line}\n`)
				: (line: string) => process.stdout.write(`${line}\n`);
			const value = await setupBrowser(flags, report);
			const output = {
				ok: true,
				extensionPath: value.extensionPath,
				browser: value.browser?.name,
				opened: value.opened,
				clipboard: value.clipboard,
				connected: value.status.connected,
				daemonRunning: value.status.daemonRunning,
				instructions: value.instructions,
			};
			if (options.isJsonOutput()) process.stdout.write(`${JSON.stringify(output)}\n`);
			else if (!value.status.connected)
				process.stdout.write("\nAfter loading the extension, check with: opencua browser status\n");
		});

	browser
		.command("status")
		.description("Read the daemon and extension connection state")
		.action(async () => {
			const doctor = await (await browserService()).doctorBrowserService();
			const status = await readStatus();
			if (options.isJsonOutput()) {
				process.stdout.write(`${JSON.stringify({ ...doctor, ...status })}\n`);
				return;
			}
			const lines = [
				`daemon:     ${status.daemonRunning ? "running" : "stopped"}`,
				`extension:  ${status.connected ? "connected" : "not connected"}`,
				`actions:    ${status.stopped ? "stopped by the user" : "available"}`,
				`spaces:     ${status.spaces.length}`,
				status.connected ? "" : "next: opencua browser setup",
			].filter((line) => line !== "");
			process.stdout.write(`${lines.join("\n")}\n`);
		});

	browser
		.command("uninstall")
		.description("Remove the browser daemon and native-host registration")
		.action(async () => {
			const paths = await (await browserService()).uninstallBrowserService();
			const output = { ok: true, launchAgent: paths.launchAgent, nativeHost: paths.nativeHostManifest };
			if (options.isJsonOutput()) process.stdout.write(`${JSON.stringify(output)}\n`);
			else process.stdout.write(`Removed the browser service.\nLaunchAgent: ${paths.launchAgent}\n`);
		});
}
