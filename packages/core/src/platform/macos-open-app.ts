import type { AppInfo } from "../accessibility/types.js";
import { findMatchingApp } from "../computer/actions.js";
import { denyHostInteraction } from "../computer/host-interaction-policy.js";
import { activateApplication } from "./macos-ffi/workspace.js";

/** Launches or activates an application by name or bundle id. */
export interface AppOpenLauncher {
	launch(target: string): Promise<void>;
	/** True when launching leaves the app in the background instead of bringing it forward. */
	readonly background?: boolean;
	/**
	 * Bring the app the person had in front back, after a background launch took the foreground anyway (some apps
	 * activate themselves on launch despite open -g). Answers whether the app is in front again.
	 */
	restoreFrontmost?(pid: number): boolean;
}

export interface AppLister {
	listApps(): Promise<AppInfo[]>;
	listAppIdentities?(): Promise<AppInfo[]>;
}

export interface OpenApplicationOptions {
	/** How long to wait for a launched app to become observable. */
	readonly timeoutMs?: number;
	readonly pollIntervalMs?: number;
	readonly launcher?: AppOpenLauncher;
}

export interface OpenApplicationResult {
	readonly name: string;
	readonly bundleId: string;
	readonly pid: number;
	/** True when the app had to be launched; false when it was already running. */
	readonly launched: boolean;
	/** True when an already running app was brought forward instead of launched. */
	readonly activated: boolean;
	/** True when the opened app took the foreground during a background open and the person's app was put back. */
	readonly frontmostRestored?: boolean;
}

const DEFAULT_TIMEOUT_MILLISECONDS = 10_000;
const DEFAULT_POLL_INTERVAL_MILLISECONDS = 200;
const BUNDLE_ID_SHAPE = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

/**
 * A bundle id goes to open -b, an app name to open -a. In the background, -g launches the app
 * without bringing it forward and -j keeps its initial windows hidden.
 */
export function openArguments(target: string, background = true): readonly string[] {
	return [...(background ? ["-g", "-j"] : []), ...(BUNDLE_ID_SHAPE.test(target) ? ["-b", target] : ["-a", target])];
}

export function spawnOpenLauncher(
	options: { readonly background?: boolean; readonly restoreFrontmost?: (pid: number) => boolean } = {},
): AppOpenLauncher {
	const background = options.background !== false;
	return {
		background,
		...(background ? { restoreFrontmost: options.restoreFrontmost ?? activateApplication } : {}),
		async launch(_target: string): Promise<void> {
			denyHostInteraction("host-window");
		},
	};
}

function delayMilliseconds(milliseconds: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, milliseconds);
	});
}

/**
 * Open an app without taking focus: if it is running, keep it in the background; if it is not,
 * launch it and wait until it is actually observable, so the caller's next observation sees a
 * real window instead of racing the launch. The answer always names what open did and which
 * process the caller can now observe.
 */
export async function openApplication(
	lister: AppLister,
	name: string,
	options: OpenApplicationOptions = {},
): Promise<OpenApplicationResult> {
	const launcher = options.launcher ?? spawnOpenLauncher();
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MILLISECONDS;
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MILLISECONDS;
	const listApps = lister.listAppIdentities?.bind(lister) ?? lister.listApps.bind(lister);
	const before = await listApps();
	const running = findMatchingApp(before, name);
	const frontBefore = before.find((app) => app.isFrontmost === true)?.pid;
	// Background opens never leave the opened app in front of the person: if it took the foreground anyway, the app
	// that was in front before is brought back, once, as soon as the theft is seen.
	const restoreIfStolen = async (openedPid: number): Promise<boolean | undefined> => {
		if (launcher.background !== true || launcher.restoreFrontmost === undefined || frontBefore === undefined) {
			return undefined;
		}
		if (frontBefore === openedPid) {
			return undefined;
		}
		const frontNow = (await listApps()).find((app) => app.isFrontmost === true)?.pid;
		return frontNow === openedPid ? launcher.restoreFrontmost(frontBefore) : undefined;
	};
	if (running !== undefined) {
		// Reopening a running app can create or unminimize windows even with open -g.
		// Only an explicitly foreground launcher may request that side effect.
		if (launcher.background !== true) {
			await launcher.launch(running.bundleId);
		}
		const restored = await restoreIfStolen(running.pid);
		return {
			name: running.name,
			bundleId: running.bundleId,
			pid: running.pid,
			launched: false,
			activated: launcher.background !== true,
			...(restored === undefined ? {} : { frontmostRestored: restored }),
		};
	}
	await launcher.launch(name);
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const appeared = findMatchingApp(await listApps(), name);
		if (appeared !== undefined) {
			const restored = await restoreIfStolen(appeared.pid);
			return {
				name: appeared.name,
				bundleId: appeared.bundleId,
				pid: appeared.pid,
				launched: true,
				activated: false,
				...(restored === undefined ? {} : { frontmostRestored: restored }),
			};
		}
		if (Date.now() >= deadline) {
			throw new Error(`"${name}" did not appear as a running app within ${timeoutMs} ms of being opened`);
		}
		await delayMilliseconds(pollIntervalMs);
	}
}
