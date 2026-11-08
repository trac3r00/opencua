import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { overlayBinaryPath } from "./macos-ffi/cursor-overlay.js";
import { resolveStateDir } from "./stop-switch.js";

export interface StopMenuProcess {
	on(event: "error", listener: (error: Error) => void): unknown;
	kill(): boolean;
}

export type SpawnStopMenu = (
	command: string,
	args: readonly string[],
	options: { readonly stdio: "ignore" },
) => StopMenuProcess;

export interface StopMenu {
	stop(): void;
}

/**
 * Show the user's menu bar Stop/Resume control for as long as this process lives. It draws no
 * cursor and sends no input: it only flips the machine-wide StopSwitch file that every agent
 * reads before acting. The helper also exits on its own once this process is gone.
 */
export function startStopMenu(
	spawnProcess: SpawnStopMenu,
	binaryPath: string | null = overlayBinaryPath() ?? null,
	parentPid: number = process.pid,
	parentsDir: string = join(resolveStateDir(), "stop-menu-parents"),
): StopMenu | undefined {
	if (binaryPath === null) return undefined;
	const child = spawnProcess(binaryPath, ["--status-only", "--parent", String(parentPid)], { stdio: "ignore" });
	child.on("error", (error: Error) => {
		process.stderr.write(`opencua: menu bar stop control unavailable: ${error.message}\n`);
	});
	return {
		stop(): void {
			child.kill();
			// The helper records each server as <pid>-<start>; a stopped server must not keep a later helper's menu alive.
			let names: string[] = [];
			try {
				names = readdirSync(parentsDir);
			} catch {
				return;
			}
			for (const name of names) {
				if (name.startsWith(`${parentPid}-`)) rmSync(join(parentsDir, name), { force: true });
			}
		},
	};
}
