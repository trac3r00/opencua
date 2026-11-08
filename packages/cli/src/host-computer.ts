import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { MacOSHostComputer } from "@opencua/core";
import { AppApprovalStore } from "@opencua/core/light";
import { resolveLayout } from "./layout.js";
import { resolveCursorMotion } from "./lifecycle-commands.js";
import { type GlobalOptions, type HostOptions, parsePositiveInteger } from "./read-commands.js";

const execFileAsync = promisify(execFile);

export type HostComputerSpec = {
	readonly cursorRequested: boolean;
	readonly appApproval: AppApprovalStore;
	readonly hostOptions: HostOptions;
};

/** The app allowlist from OPENCUA_ALLOWED_BUNDLE_IDS; unset allows any explicitly targeted app. */
export function approvalFromEnv(env: NodeJS.ProcessEnv): AppApprovalStore {
	return new AppApprovalStore(
		env["OPENCUA_ALLOWED_BUNDLE_IDS"]
			?.split(",")
			.map((bundleId) => bundleId.trim())
			.filter((bundleId) => bundleId.length > 0),
	);
}

export async function createHostComputer(spec: HostComputerSpec): Promise<MacOSHostComputer> {
	// When the cursor is hidden, inject the no-op overlay so no helper spawns.
	const { MacOSHostComputer, NOOP_POINTER_OVERLAY, agentCursorEnabled } = await import("@opencua/core");
	const showCursor = spec.cursorRequested && agentCursorEnabled();
	return new MacOSHostComputer({
		appApproval: spec.appApproval,
		// The person's desktop takes background delivery only; attended delivery is refused there.
		delivery: "background",
		...(showCursor ? { cursorMotion: resolveCursorMotion(resolveLayout().configPath) } : {}),
		...spec.hostOptions,
		...(showCursor ? {} : { overlay: NOOP_POINTER_OVERLAY }),
	});
}

export async function resolveTargetPid(options: GlobalOptions): Promise<number | undefined> {
	if (options.targetPid !== undefined && options.targetBundleId !== undefined) {
		throw new Error("Use only one of --target-pid or --target-bundle-id");
	}
	if (options.targetPid !== undefined) {
		return options.targetPid;
	}
	if (options.targetBundleId !== undefined) {
		return resolvePidForBundleId(options.targetBundleId);
	}
	return undefined;
}

async function resolvePidForBundleId(bundleId: string): Promise<number> {
	const script = `tell application "System Events" to get unix id of first process whose bundle identifier is ${toAppleScriptString(bundleId)}`;
	const { stdout } = await execFileAsync("osascript", ["-e", script], { encoding: "utf8" });
	return parsePositiveInteger(stdout.trim());
}

function toAppleScriptString(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
