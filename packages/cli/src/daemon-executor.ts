import type { ComputerInterface, MacOSHostComputer } from "@opencua/core";
import { Command, CommanderError } from "commander";
import type { DaemonRequest, DaemonResponse } from "./daemon.js";
import { approvalFromEnv, createHostComputer, resolveTargetPid } from "./host-computer.js";
import {
	type GlobalOptions,
	type HostOptions,
	type ReadCommandHost,
	addGlobalOptions,
	registerReadCommands,
} from "./read-commands.js";

export type ComputerSource = (spec: {
	readonly env: Readonly<Record<string, string>>;
	readonly hostOptions: HostOptions;
	readonly targetPid: number | undefined;
}) => Promise<ComputerInterface>;

/**
 * Runs one routed read command with the same command definitions the CLI registers, so the daemon's output is the
 * in-process output byte for byte.
 */
export async function executeReadCommand(request: DaemonRequest, computerFor: ComputerSource): Promise<DaemonResponse> {
	let stdout = "";
	let stderr = "";
	let exitCode = 0;
	const program = addGlobalOptions(new Command().name("opencua"))
		.exitOverride()
		.configureOutput({
			writeOut: (text) => {
				stdout += text;
			},
			writeErr: (text) => {
				stderr += text;
			},
		});
	const host: ReadCommandHost = {
		cwd: request.cwd,
		json: () => program.opts<GlobalOptions>().json === true,
		withComputer: async (action, hostOptions) =>
			await action(
				await computerFor({
					env: request.env,
					hostOptions: hostOptions ?? {},
					targetPid: await resolveTargetPid(program.opts<GlobalOptions>()),
				}),
			),
		emit: (result) => {
			stdout += result.stdout;
			stderr += result.stderr ?? "";
			exitCode = result.exitCode;
		},
	};
	registerReadCommands(program, host);
	try {
		await program.parseAsync(["node", "opencua", ...request.argv]);
		return { stdout, stderr, exitCode };
	} catch (error: unknown) {
		if (error instanceof CommanderError) {
			return { stdout, stderr, exitCode: error.exitCode };
		}
		return { stdout, stderr: `${stderr}${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 };
	}
}

/**
 * The daemon's computers: one warm MacOSHostComputer per allowlist and display, so ScreenCaptureKit and the
 * accessibility caches stay hot across requests. Reads never move a cursor, so no overlay is created.
 */
export function warmHostComputers(): ComputerSource {
	const computers = new Map<string, Promise<MacOSHostComputer>>();
	return async ({ env, hostOptions, targetPid }) => {
		const key = JSON.stringify([env["OPENCUA_ALLOWED_BUNDLE_IDS"] ?? null, hostOptions.display ?? null]);
		let computer = computers.get(key);
		if (computer === undefined) {
			computer = createHostComputer({ cursorRequested: false, appApproval: approvalFromEnv(env), hostOptions });
			computers.set(key, computer);
			computer.catch(() => computers.delete(key));
		}
		const ready = await computer;
		ready.setTarget(targetPid);
		return ready;
	};
}
