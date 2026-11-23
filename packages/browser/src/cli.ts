#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { connectionToken, readConnection, writeConnection } from "./connection.js";
import { readBuildId, watchBuild } from "./reload.js";
import { doctorBrowserService, installBrowserService, uninstallBrowserService } from "./service.js";

/** Matches the RPC client timeout, so a request a client still waits on is never cut by a reload. */
const RELOAD_DRAIN_MS = 20_000;

const usage = "Usage: cua-browser <install|doctor|uninstall|serve|call <json>|status>";

function reportError(error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`cua-browser: ${message}\n`);
	process.exitCode = 1;
}

async function serve(): Promise<void> {
	const [{ StopSwitch }, { BrowserBridge }, { BrowserController }] = await Promise.all([
		import("@opencua/core/stop"),
		import("./bridge.js"),
		import("./controller.js"),
	]);
	const distDirectory = dirname(fileURLToPath(import.meta.url));
	// The extension's files count too: the daemon restarts on a change, and tells the extension, which reloads.
	const buildDirectories = [
		distDirectory,
		resolve(distDirectory, "../../core/dist"),
		resolve(distDirectory, "../extension"),
	].filter(existsSync);
	const buildId = await readBuildId(buildDirectories);
	const token = await connectionToken();
	const bridge = new BrowserBridge(new StopSwitch(), 15000, token);
	bridge.buildId = buildId;
	const controller = new BrowserController(bridge, buildId);
	bridge.setRpcHandler((input, signal) => controller.dispatch(input, signal));
	const configuredPort = process.env["OPENCUA_BROWSER_PORT"];
	const port = z.coerce
		.number()
		.int()
		.min(1)
		.max(65535)
		.parse(configuredPort ?? 47953);
	const actualPort = await bridge.listen(port);
	try {
		await writeConnection({ port: actualPort, token });
	} catch (error: unknown) {
		await bridge.close();
		throw error;
	}
	process.stderr.write(
		`Browser pairing token: ${token}\nBrowser RPC listening on 127.0.0.1:${actualPort} (build ${buildId})\n`,
	);

	const stopWatching = watchBuild({
		directories: buildDirectories,
		initialId: buildId,
		onChange: (next) => {
			stopWatching();
			process.removeListener("SIGINT", onSigint);
			process.removeListener("SIGTERM", onSigterm);
			process.stderr.write(
				`Browser build changed (${buildId} -> ${next}); draining and exiting so launchd restarts it.\n`,
			);
			void bridge.drain(RELOAD_DRAIN_MS).then(
				() => process.exit(0),
				(error: unknown) => {
					reportError(error);
					process.exit(1);
				},
			);
		},
	});
	const close = async (): Promise<void> => {
		stopWatching();
		process.removeListener("SIGINT", onSigint);
		process.removeListener("SIGTERM", onSigterm);
		await bridge.close();
	};
	const onSigint = (): void => {
		void close().catch(reportError);
	};
	const onSigterm = (): void => {
		void close().catch(reportError);
	};
	process.once("SIGINT", onSigint);
	process.once("SIGTERM", onSigterm);
}

async function call(input: unknown): Promise<void> {
	const connection = await readConnection();
	const response = await fetch(`http://127.0.0.1:${connection.port}/rpc`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${connection.token}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(input),
		signal: AbortSignal.timeout(20000),
	});
	const result: unknown = await response.json();
	if (!response.ok) {
		const failure = z.object({ error: z.string(), message: z.string() }).safeParse(result);
		throw new Error(
			failure.success
				? `${failure.data.error}: ${failure.data.message}`
				: `Browser RPC returned HTTP ${response.status}`,
		);
	}
	process.stdout.write(`${JSON.stringify(result)}\n`);
}

export async function cliMain(args: readonly string[]): Promise<void> {
	const [command, ...rest] = args;
	try {
		switch (command) {
			case "install": {
				if (rest.length !== 0) throw new Error(usage);
				const paths = await installBrowserService();
				process.stdout.write(
					`Installed Browser-Skill-OmO service.\nLaunchAgent: ${paths.launchAgent}\nNative host: ${paths.nativeHostManifest}\n`,
				);
				return;
			}
			case "doctor": {
				if (rest.length !== 0) throw new Error(usage);
				process.stdout.write(`${JSON.stringify(await doctorBrowserService())}\n`);
				return;
			}
			case "uninstall": {
				if (rest.length !== 0) throw new Error(usage);
				const paths = await uninstallBrowserService();
				process.stdout.write(
					`Removed Browser-Skill-OmO service registration.\nLaunchAgent: ${paths.launchAgent}\nNative host: ${paths.nativeHostManifest}\n`,
				);
				return;
			}
			case "serve":
				if (rest.length !== 0) throw new Error(usage);
				await serve();
				return;
			case "call": {
				if (rest.length !== 1) throw new Error(usage);
				let input: unknown;
				try {
					const json = rest[0];
					if (json === undefined) throw new Error("Missing JSON input");
					input = JSON.parse(json);
				} catch {
					throw new Error("call expects one valid JSON string");
				}
				await call(input);
				return;
			}
			case "status":
				if (rest.length !== 0) throw new Error(usage);
				await call({ action: "status" });
				return;
			default:
				throw new Error(usage);
		}
	} catch (error) {
		reportError(error);
	}
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await cliMain(process.argv.slice(2));
}
