import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "@opencua/test-support";

const browser = vi.hoisted(() => ({
	doctorBrowserService: vi.fn(),
	installBrowserService: vi.fn(),
	uninstallBrowserService: vi.fn(),
	readConnection: vi.fn(),
}));

vi.mock("@opencua/browser", () => ({
	doctorBrowserService: browser.doctorBrowserService,
	installBrowserService: browser.installBrowserService,
	uninstallBrowserService: browser.uninstallBrowserService,
	readConnection: browser.readConnection,
}));
vi.mock("node:child_process", () => ({
	execFile: vi.fn((_command: string, _args: readonly string[], callback?: (error: Error | null) => void) => {
		callback?.(null);
		return { stdin: { end: vi.fn() } };
	}),
}));

const { browserSetupInstructions, detectChromiumBrowsers, setupBrowser } = await import("./browser-commands.js");

const paths = {
	launchAgent: "/tmp/agent.plist",
	nativeHostManifest: "/tmp/host.json",
	nativeHostProgram: "/tmp/native-host.js",
	nativeHostLauncher: "/tmp/launcher",
	stateDirectory: "/tmp/state",
	cliProgram: "/tmp/cli.js",
	logDirectory: "/tmp/logs",
	stdoutLog: "/tmp/stdout",
	stderrLog: "/tmp/stderr",
};

beforeEach(() => {
	browser.doctorBrowserService.mockResolvedValue({
		installed: true,
		running: true,
		connectionReady: true,
		launchAgent: paths.launchAgent,
		nativeHostManifest: paths.nativeHostManifest,
	});
	browser.installBrowserService.mockResolvedValue(paths);
	browser.readConnection.mockResolvedValue({ port: 47953, token: "a".repeat(64) });
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({
			ok: true,
			json: async () => ({ connected: false, stopped: false, spaces: [] }),
		})),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

describe("#given an installed but unpaired browser service #when setup runs #then it prints the one human step without restarting the daemon", () => {
	it("does not reinstall a healthy daemon and returns the Load unpacked instructions", async () => {
		const lines: string[] = [];

		const result = await setupBrowser({ wait: false, open: false }, (line) => lines.push(line));

		expect(browser.installBrowserService).not.toHaveBeenCalled();
		expect(result.status.connected).toBe(false);
		expect(result.clipboard).toBe(true);
		expect(result.instructions).toContain("Load unpacked");
		expect(lines.join("\n")).toContain("Load unpacked");
	});
});

describe("#given a missing browser service #when setup runs #then it installs once and reports the remaining connection", () => {
	it("installs, copies the extension path, and does not wait without a terminal", async () => {
		browser.doctorBrowserService.mockResolvedValue({
			installed: false,
			running: false,
			connectionReady: false,
			launchAgent: paths.launchAgent,
			nativeHostManifest: paths.nativeHostManifest,
		});

		const result = await setupBrowser({ wait: false, open: false });

		expect(browser.installBrowserService).toHaveBeenCalledTimes(1);
		expect(result.status.connected).toBe(false);
		expect(result.extensionPath).toContain("packages/browser/extension");
	});
});

describe("#given a running daemon registered only in Brave #when setup runs for Google Chrome #then it reinstalls to register Chrome", () => {
	it("installs once because doctor reports the Chrome manifest missing", async () => {
		browser.doctorBrowserService.mockResolvedValue({
			installed: false,
			running: true,
			connectionReady: true,
			launchAgent: paths.launchAgent,
			nativeHostManifest: "/tmp/Brave/NativeMessagingHosts/com.browser_skill_omo.bridge.json",
			missingNativeHostManifests: ["/tmp/Google/Chrome/NativeMessagingHosts/com.browser_skill_omo.bridge.json"],
		});

		await setupBrowser({ wait: false, open: false, browser: "Google Chrome" });

		expect(browser.installBrowserService).toHaveBeenCalledTimes(1);
	});
});

describe("#given Aside in the user's Applications folder #when browsers are detected #then Aside is offered with its extensions page", () => {
	it("lists Aside with chrome://extensions", async () => {
		const home = await mkdtemp(join(tmpdir(), "cli-aside-"));
		try {
			await mkdir(join(home, "Applications", "Aside.app"), { recursive: true });

			const aside = detectChromiumBrowsers(home).find((candidate) => candidate.name === "Aside");

			expect(aside?.extensionsUrl).toBe("chrome://extensions");
			expect(aside?.appPath.endsWith("Aside.app")).toBe(true);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});

describe("#given a browser setup page #when instructions are rendered #then the human step names the browser, URL, and exact folder", () => {
	it("keeps the manual step to Developer mode and Load unpacked", () => {
		const instructions = browserSetupInstructions(
			{ name: "Brave", appPath: "/Applications/Brave Browser.app", extensionsUrl: "brave://extensions" },
			"/checkout/packages/browser/extension",
		);

		expect(instructions).toContain("brave://extensions");
		expect(instructions).toContain("Developer mode");
		expect(instructions).toContain("Load unpacked");
		expect(instructions).toContain("/checkout/packages/browser/extension");
	});
});
