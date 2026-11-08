import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import type { Command } from "commander";
import { executeReadCommand, warmHostComputers } from "./daemon-executor.js";
import { daemonPaths, daemonStatus, runDaemon, stopDaemon } from "./daemon.js";

type DaemonCommandContext = {
	readonly entryScript: string;
	readonly stateDir: string;
};

const START_TIMEOUT_MS = 10_000;
const START_POLL_MS = 50;

export function registerDaemonCommands(program: Command, context: DaemonCommandContext): void {
	const daemon = program
		.command("daemon")
		.description(
			"Keep one warm opencua process so screenshot, cursor, screen, windows list and apps list/state skip start-up (input never goes through it)",
		);

	daemon
		.command("start")
		.description("Start the daemon in the background and wait until it answers")
		.action(async () => {
			const running = await daemonStatus(context.stateDir);
			if (running !== undefined) {
				process.stdout.write(`opencua daemon already running (pid ${running.pid})\n`);
				return;
			}
			const child = spawn(process.execPath, [context.entryScript, "daemon", "run"], {
				detached: true,
				stdio: "ignore",
				env: process.env,
			});
			child.unref();
			const deadline = Date.now() + START_TIMEOUT_MS;
			while (Date.now() < deadline) {
				const status = await daemonStatus(context.stateDir);
				if (status !== undefined) {
					process.stdout.write(`opencua daemon started (pid ${status.pid})\n`);
					return;
				}
				await sleep(START_POLL_MS);
			}
			throw new Error(`the opencua daemon did not answer within ${START_TIMEOUT_MS / 1000} s`);
		});

	daemon
		.command("run")
		.description("Serve in the foreground (what `daemon start` runs)")
		.action(async () => {
			const computers = warmHostComputers();
			const served = await runDaemon(context.stateDir, (request) => executeReadCommand(request, computers));
			for (const signal of ["SIGINT", "SIGTERM"] as const) {
				process.once(signal, served.stop);
			}
			await served.closed;
			process.exit(0);
		});

	daemon
		.command("stop")
		.description("Stop the daemon")
		.action(async () => {
			const stopped = await stopDaemon(context.stateDir);
			process.stdout.write(stopped ? "opencua daemon stopped\n" : "opencua daemon is not running\n");
		});

	daemon
		.command("status")
		.description("Report whether the daemon is running")
		.action(async () => {
			const status = await daemonStatus(context.stateDir);
			if (status === undefined) {
				const stale = existsSync(daemonPaths(context.stateDir).socket) ? " (a stale socket remains)" : "";
				process.stdout.write(`opencua daemon is not running${stale}\n`);
				return;
			}
			process.stdout.write(`opencua daemon running (pid ${status.pid}, since ${status.startedAt})\n`);
		});
}
