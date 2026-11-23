import { spawn } from "node:child_process";
import type { AppInfo } from "../accessibility/types.js";
import { findMatchingApp } from "../computer/actions.js";
import { unhideApplication } from "./macos-ffi/workspace.js";

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
	/**
	 * Make an app this background launch started visible without activating it. open -j launches hidden so nothing
	 * flashes over the person, but a hidden app never loads or draws its content (a hidden Safari loads no page).
	 */
	reveal?(pid: number): boolean;
	/** Whether the app has a window on screen. A background open of a running app with none reopens it. */
	hasWindows?(pid: number): boolean;
	/**
	 * Ask a running app for a window the way a Dock click does (a reopen event), without activating it. Background
	 * opens use this only for an app with no window: a windowless app has nothing to observe or act on.
	 */
	reopen?(target: string): Promise<void>;
	/** Told the pid of an app this background open launched or reopened, and of the app in front before it. */
	opened?(pid: number, frontBefore: number | undefined): void;
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
	/** True when a running app with no window was reopened in the background to give it one. */
	readonly reopened?: boolean;
	/** True when a background launch made the launched app visible behind the person's app. */
	readonly revealed?: boolean;
	/**
	 * Whether the launched app showed a window before the call returned. False means it is still starting (or opens
	 * no window by itself, as a browser restoring no session may not): observing it now finds nothing to act on.
	 */
	readonly windowReady?: boolean;
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

const CHROMIUM_BROWSERS = new Set([
	"google chrome",
	"com.google.chrome",
	"brave browser",
	"com.brave.browser",
	"microsoft edge",
	"com.microsoft.edgemac",
	"chromium",
	"org.chromium.chromium",
	"vivaldi",
	"com.vivaldi.vivaldi",
]);

/**
 * A Chromium browser stops rendering a window another app covers, so a page behind the person's apps would be
 * blank and unreadable. These switches keep covered windows rendered; they apply only to a fresh launch.
 */
const CHROMIUM_BACKGROUND_SWITCHES = [
	"--disable-backgrounding-occluded-windows",
	"--disable-renderer-backgrounding",
	"--disable-features=CalculateNativeWinOcclusion",
];

/**
 * A bundle id goes to open -b, an app name to open -a. In the background, -g launches the app
 * without bringing it forward and -j keeps its initial windows hidden.
 */
export function openArguments(target: string, background = true): readonly string[] {
	const switches =
		background && CHROMIUM_BROWSERS.has(target.toLowerCase()) ? ["--args", ...CHROMIUM_BACKGROUND_SWITCHES] : [];
	return [
		...(background ? ["-g", "-j"] : []),
		...(BUNDLE_ID_SHAPE.test(target) ? ["-b", target] : ["-a", target]),
		...switches,
	];
}

/**
 * Host activation is refused (host-focus), so no default restoreFrontmost exists: an app that takes the front
 * despite open -g keeps it, and the result carries no frontmostRestored.
 */
export function spawnOpenLauncher(
	options: {
		readonly background?: boolean;
		readonly restoreFrontmost?: (pid: number) => boolean;
		readonly reveal?: (pid: number) => boolean;
		readonly hasWindows?: (pid: number) => boolean;
		readonly opened?: (pid: number, frontBefore: number | undefined) => void;
	} = {},
): AppOpenLauncher {
	const background = options.background !== false;
	const restoreFrontmost = options.restoreFrontmost;
	const reveal = options.reveal;
	const hasWindows = options.hasWindows;
	const opened = options.opened;
	const run = (args: readonly string[]): Promise<void> =>
		new Promise<void>((resolve, reject) => {
			const child = spawn("open", [...args], { stdio: ["ignore", "ignore", "pipe"] });
			let stderr = "";
			child.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString("utf8");
			});
			child.once("error", reject);
			child.once("close", (code) => {
				if (code === 0) {
					resolve();
					return;
				}
				reject(new Error(stderr.trim().length > 0 ? stderr.trim() : `open exited with code ${String(code)}`));
			});
		});
	return {
		background,
		...(background && restoreFrontmost !== undefined ? { restoreFrontmost } : {}),
		...(background && reveal !== undefined ? { reveal } : {}),
		...(background && opened !== undefined ? { opened } : {}),
		...(background && hasWindows !== undefined
			? {
					hasWindows,
					// -g without -j: the reopen event makes the app show a window, and nothing comes forward.
					reopen: (target: string) => run(["-g", ...openArguments(target, false)]),
				}
			: {}),
		async launch(target: string): Promise<void> {
			await run(openArguments(target, background));
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
	const launcher = options.launcher ?? spawnOpenLauncher({ reveal: unhideApplication });
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
		// Except a windowless one: with no window there is nothing to observe, so it is reopened for one.
		const reopen =
			launcher.background === true && launcher.reopen !== undefined && launcher.hasWindows?.(running.pid) === false
				? launcher.reopen
				: undefined;
		if (reopen !== undefined) {
			launcher.opened?.(running.pid, frontBefore);
			await reopen(running.bundleId);
		}
		const restored = reopen === undefined ? undefined : await restoreIfStolen(running.pid);
		// Otherwise nothing was opened in the background, so a front app seen now is the person's own choice.
		return {
			name: running.name,
			bundleId: running.bundleId,
			pid: running.pid,
			launched: false,
			activated: launcher.background !== true,
			...(reopen === undefined ? {} : { reopened: true }),
			...(restored === undefined ? {} : { frontmostRestored: restored }),
		};
	}
	await launcher.launch(name);
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const appeared = findMatchingApp(await listApps(), name);
		if (appeared !== undefined) {
			if (launcher.background === true) {
				launcher.opened?.(appeared.pid, frontBefore);
			}
			const restored = await restoreIfStolen(appeared.pid);
			// Only an app this call launched is revealed: one the person hid themselves stays hidden.
			const revealed = launcher.background === true ? launcher.reveal?.(appeared.pid) : undefined;
			// A process appears well before its first window (Chrome took seconds on a busy Mac), and an observation in
			// between fails, so the launch waits for a window within the same deadline.
			let windowReady = launcher.hasWindows?.(appeared.pid);
			while (windowReady === false && Date.now() < deadline) {
				await delayMilliseconds(pollIntervalMs);
				windowReady = launcher.hasWindows?.(appeared.pid);
			}
			return {
				name: appeared.name,
				bundleId: appeared.bundleId,
				pid: appeared.pid,
				launched: true,
				activated: false,
				...(restored === undefined ? {} : { frontmostRestored: restored }),
				...(revealed === undefined ? {} : { revealed }),
				...(windowReady === undefined ? {} : { windowReady }),
			};
		}
		if (Date.now() >= deadline) {
			throw new Error(`"${name}" did not appear as a running app within ${timeoutMs} ms of being opened`);
		}
		await delayMilliseconds(pollIntervalMs);
	}
}
