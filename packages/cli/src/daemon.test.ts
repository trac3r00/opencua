import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeReadCommand } from "./daemon-executor.js";
import {
	type DaemonRequest,
	daemonPaths,
	daemonRouteOf,
	daemonStatus,
	forwardToDaemon,
	runDaemon,
	stopDaemon,
} from "./daemon.js";

let stateDir: string;

beforeEach(() => {
	// Short root: a Unix socket path must stay under 104 bytes on macOS.
	stateDir = mkdtempSync(join(tmpdir().length < 40 ? tmpdir() : "/tmp", "ocd-"));
});

afterEach(() => {
	rmSync(stateDir, { recursive: true, force: true });
});

const context = () => ({ stateDir, cwd: stateDir, env: {} });

describe("#given CLI argv #when routing to the daemon #then only the read commands go there", () => {
	it.each([
		[["screenshot", "-o", "a.png"], "screenshot"],
		[["--json", "apps", "state", "com.apple.calculator", "--screenshot"], "apps state"],
		[["--target-pid", "42", "apps", "list"], "apps list"],
		[["windows", "list"], "windows list"],
		[["cursor"], "cursor"],
		[["screen"], "screen"],
	])("routes %j to %s", (argv, route) => {
		expect(daemonRouteOf(argv)).toBe(route);
	});

	it.each([
		[["click", "10", "20"]],
		[["--target-pid", "42", "type", "hello"]],
		[["key", "return"]],
		[["apps", "set-value", "Notes", "3", "x"]],
		[["apps", "perform-action", "Notes", "3", "AXPress"]],
		[["windows", "active"]],
		[["screenshot", "--help"]],
		[["daemon", "start"]],
		[[]],
	])("keeps %j in-process", (argv) => {
		expect(daemonRouteOf(argv)).toBeUndefined();
	});
});

describe("#given no daemon #when a read command is forwarded #then the caller runs it in-process", () => {
	it("returns undefined without a socket", async () => {
		expect(await forwardToDaemon(["apps", "list"], context())).toBeUndefined();
	});

	it("returns undefined for a stale socket file nobody listens on", async () => {
		const paths = daemonPaths(stateDir);
		writeFileSync(paths.socket, "");
		writeFileSync(paths.token, "token\n");
		expect(await forwardToDaemon(["apps", "list"], context())).toBeUndefined();
	});
});

describe("#given a running daemon #when requests arrive #then it answers routed reads and nothing else", () => {
	it("round-trips a read with the caller's cwd and OPENCUA_* settings, then stops and removes its files", async () => {
		const seen: DaemonRequest[] = [];
		const served = await runDaemon(stateDir, async (request) => {
			seen.push(request);
			return { stdout: "ok\n", stderr: "", exitCode: 0 };
		});
		const paths = daemonPaths(stateDir);
		expect(statSync(paths.token).mode & 0o777).toBe(0o600);
		expect(statSync(paths.socket).mode & 0o077).toBe(0);

		const response = await forwardToDaemon(["--json", "apps", "list"], {
			stateDir,
			cwd: "/somewhere",
			env: { OPENCUA_ALLOWED_BUNDLE_IDS: "com.apple.calculator", HOME: "/Users/someone" },
		});

		expect(response).toEqual({ stdout: "ok\n", stderr: "", exitCode: 0 });
		expect(seen).toEqual([
			{
				argv: ["--json", "apps", "list"],
				cwd: "/somewhere",
				env: { OPENCUA_ALLOWED_BUNDLE_IDS: "com.apple.calculator" },
			},
		]);
		expect(await stopDaemon(stateDir)).toBe(true);
		await served.closed;
		expect(() => statSync(paths.socket)).toThrow();
		expect(() => statSync(paths.token)).toThrow();
	});

	it("refuses a request carrying the wrong token before running anything", async () => {
		let ran = false;
		const served = await runDaemon(stateDir, async () => {
			ran = true;
			return { stdout: "", stderr: "", exitCode: 0 };
		});
		const paths = daemonPaths(stateDir);
		const realToken = readFileSync(paths.token, "utf8");
		writeFileSync(paths.token, "not-the-token\n");

		expect(await forwardToDaemon(["apps", "list"], context())).toBeUndefined();
		expect(ran).toBe(false);

		writeFileSync(paths.token, realToken);
		served.stop();
		await served.closed;
	});

	it("refuses a second daemon on the same state directory", async () => {
		const served = await runDaemon(stateDir, async () => ({ stdout: "", stderr: "", exitCode: 0 }));
		expect(await daemonStatus(stateDir)).toMatchObject({ pid: process.pid });
		await expect(runDaemon(stateDir, async () => ({ stdout: "", stderr: "", exitCode: 0 }))).rejects.toThrow(
			/already running/,
		);
		served.stop();
		await served.closed;
	});
});

describe("#given the daemon executor #when a read command runs #then it prints what the CLI prints", () => {
	const fakeComputer = {
		listApps: async () => [{ pid: 7, bundleId: "com.apple.calculator", name: "Calculator" }],
		getScreenSize: async () => ({ width: 1512, height: 982 }),
		getCursorPosition: async () => ({ x: 3, y: 4 }),
	};
	const source = async () => fakeComputer as never;

	it("answers apps list as JSON and as text", async () => {
		const json = await executeReadCommand({ argv: ["--json", "apps", "list"], cwd: stateDir, env: {} }, source);
		expect(json).toEqual({
			stdout: `${JSON.stringify([{ pid: 7, bundleId: "com.apple.calculator", name: "Calculator" }])}\n`,
			stderr: "",
			exitCode: 0,
		});
		const text = await executeReadCommand({ argv: ["apps", "list"], cwd: stateDir, env: {} }, source);
		expect(text.stdout).toBe("7\tcom.apple.calculator\tCalculator\n");
	});

	it("reports a command error with exit code 1 instead of throwing", async () => {
		const failing = async () => {
			throw new Error("Screen Recording permission is required");
		};
		const result = await executeReadCommand({ argv: ["screen"], cwd: stateDir, env: {} }, failing);
		expect(result).toEqual({ stdout: "", stderr: "Screen Recording permission is required\n", exitCode: 1 });
	});

	it("warns once on stderr and exits 3 when apps state lacks Accessibility permission", async () => {
		const untrusted = async () =>
			({
				...fakeComputer,
				getAppState: async () => ({
					app: "Calculator",
					bundleId: "com.apple.calculator",
					pid: 7,
					frontmost: false,
					axAvailable: false,
					axUnavailable: "accessibility-permission",
					elements: [],
					screenshotBase64: "",
					screenshotWidth: 0,
					screenshotHeight: 0,
					display: { width: 1512, height: 982, scaleFactor: 2 },
				}),
			}) as never;

		const result = await executeReadCommand(
			{ argv: ["--json", "apps", "state", "com.apple.calculator"], cwd: stateDir, env: {} },
			untrusted,
		);

		expect(result.exitCode).toBe(3);
		expect(result.stderr.trimEnd().split("\n")).toHaveLength(1);
		expect(JSON.parse(result.stdout)).toMatchObject({
			axAvailable: false,
			axUnavailable: "accessibility-permission",
		});
	});
});
