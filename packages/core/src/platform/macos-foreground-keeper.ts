import { spawn } from "node:child_process";

import { onInputTarget } from "../computer/input-scope.js";
import { ForegroundKeeper } from "./foreground-keeper.js";
import { frontProcessPid, setFrontProcessOfWindowNoWindows } from "./macos-ffi/skylight.js";
import { listWindows } from "./macos-ffi/window-list.js";
import { getRunningApplications } from "./macos-ffi/workspace.js";
import { hidPhysicalInputProbe } from "./macos-physical-intent.js";

const FAST_RESTORE_ATTEMPTS = 24;
const FAST_RESTORE_POLL_MILLISECONDS = 25;

/** The WindowServer's front process: a launching app holds the front before AppKit reports any app active. */
function frontmostPid(): number | undefined {
	return frontProcessPid() ?? getRunningApplications().find((application) => application.isActive)?.pid;
}

/**
 * The person's app is handed the front straight through the WindowServer (no windows raised), which takes effect in
 * tens of milliseconds; when that does not hold, it is brought back through LaunchServices, which delivers a reopen
 * event and took over a second when measured. An app without an on-screen window would answer the reopen by opening
 * one, so it is left alone.
 */
async function restorePersonApp(pid: number): Promise<boolean> {
	const window = listWindows({ onScreenOnly: true })?.find(
		(candidate) => candidate.ownerPid === pid && candidate.layer === 0,
	);
	if (window === undefined) {
		return false;
	}
	// An app still finishing its launch takes the front again and again (Chrome held it 0.8 s against three slower
	// tries), so the front is handed back on every short poll until it stays.
	for (let attempt = 0; attempt < FAST_RESTORE_ATTEMPTS && setFrontProcessOfWindowNoWindows(window.id); attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, FAST_RESTORE_POLL_MILLISECONDS));
		if (frontmostPid() === pid) {
			return true;
		}
	}
	const application = getRunningApplications().find((candidate) => candidate.pid === pid);
	if (application === undefined || application.bundleId.length === 0) {
		return false;
	}
	return await new Promise<boolean>((resolve) => {
		const child = spawn("open", ["-b", application.bundleId], { stdio: "ignore" });
		child.once("error", () => resolve(false));
		child.once("close", (code) => resolve(code === 0));
	});
}

/** A keeper for the native host, told about every scoped input OpenCUA sends. */
export function startNativeForegroundKeeper(): ForegroundKeeper {
	const keeper = new ForegroundKeeper({
		frontmostPid,
		secondsSinceMouseDown: hidPhysicalInputProbe.secondsSinceMouseDown,
		commandHeld: hidPhysicalInputProbe.commandHeld,
		restore: restorePersonApp,
		now: () => Date.now(),
	});
	onInputTarget((pid) => keeper.noteTouched(pid));
	return keeper;
}
