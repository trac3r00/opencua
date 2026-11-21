import { spawn } from "node:child_process";

import { onInputTarget } from "../computer/input-scope.js";
import { ForegroundKeeper } from "./foreground-keeper.js";
import { readSecondsSinceHidEvent } from "./macos-ffi/event-flags.js";
import { listWindows } from "./macos-ffi/window-list.js";
import { getRunningApplications } from "./macos-ffi/workspace.js";

const ANY_INPUT_EVENT = 0xffffffff;

/**
 * Activation requested by a background process is ignored once another app holds the front, so the person's app
 * is brought back through LaunchServices, which delivers a reopen event. An app without an on-screen window would
 * answer that by opening one, so it is left alone.
 */
async function restoreThroughLaunchServices(pid: number): Promise<boolean> {
	const application = getRunningApplications().find((candidate) => candidate.pid === pid);
	const hasWindow = listWindows({ onScreenOnly: true })?.some(
		(window) => window.ownerPid === pid && window.layer === 0,
	);
	if (application === undefined || application.bundleId.length === 0 || hasWindow !== true) {
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
		frontmostPid: () => getRunningApplications().find((application) => application.isActive)?.pid,
		secondsSinceHumanInput: () => readSecondsSinceHidEvent(ANY_INPUT_EVENT),
		restore: restoreThroughLaunchServices,
		now: () => Date.now(),
	});
	onInputTarget((pid) => keeper.noteTouched(pid));
	return keeper;
}
