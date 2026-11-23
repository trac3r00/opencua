import {
	type Rect,
	frontProcessPid,
	getRunningApplications,
	setWindowFrame,
	terminateApplication,
} from "@opencua/core";

/**
 * What this server changed on the person's desktop and can put back: apps it launched, and windows whose frame it
 * set (with the frame each had before its first change). A person who opens an app for a task closes it after,
 * and puts windows they moved back where they were; the agent does the same through cleanUp.
 */
export interface CleanupDeps {
	nameOf(pid: number): string;
	frontmostPid(): number | undefined;
	isRunning(pid: number): boolean;
	quit(pid: number): boolean;
	setFrame(pid: number, windowId: number, frame: Rect): Promise<boolean>;
}

export interface CleanupReport {
	readonly restoredFrames: readonly { readonly app: string; readonly windowId: number; readonly ok: boolean }[];
	readonly quit: readonly { readonly app: string; readonly ok: boolean }[];
	readonly kept: readonly { readonly app: string; readonly reason: string }[];
}

interface Launched {
	readonly pid: number;
	readonly name: string;
	readonly bundleId: string;
}

interface MovedWindow {
	readonly pid: number;
	readonly windowId: number;
	readonly original: Rect;
}

export class CleanupLedger {
	private readonly launched = new Map<number, Launched>();
	private readonly moved = new Map<string, MovedWindow>();

	noteLaunched(app: Launched): void {
		this.launched.set(app.pid, app);
	}

	/** Remember a window's frame before this server first changes it; later changes keep the first original. */
	noteFrameChange(window: MovedWindow): void {
		const key = `${window.pid}:${window.windowId}`;
		if (!this.moved.has(key)) {
			this.moved.set(key, window);
		}
	}

	get empty(): boolean {
		return this.launched.size === 0 && this.moved.size === 0;
	}

	/**
	 * Put moved windows back, then quit the launched apps, except those named in `keep` (by name, bundle id or pid)
	 * and the app the person has in front (they are using it). Everything handled is forgotten; kept apps stay
	 * recorded, so a later clean-up can still close them.
	 */
	async cleanUp(deps: CleanupDeps, keep: readonly string[] = []): Promise<CleanupReport> {
		const kept: { app: string; reason: string }[] = [];
		const keeps = (app: { readonly pid: number }, name: string, bundleId?: string): boolean =>
			keep.some((entry) => {
				const wanted = entry.toLowerCase();
				return wanted === name.toLowerCase() || wanted === bundleId?.toLowerCase() || wanted === String(app.pid);
			});
		const restoredFrames: { app: string; windowId: number; ok: boolean }[] = [];
		for (const [key, window] of [...this.moved.entries()]) {
			const launched = this.launched.get(window.pid);
			const app = launched?.name ?? deps.nameOf(window.pid);
			if (keeps(window, app, launched?.bundleId)) {
				continue;
			}
			this.moved.delete(key);
			if (launched !== undefined || !deps.isRunning(window.pid)) {
				// A window of an app about to quit, or already gone, has nothing to restore.
				continue;
			}
			restoredFrames.push({
				app,
				windowId: window.windowId,
				ok: await deps.setFrame(window.pid, window.windowId, window.original).catch(() => false),
			});
		}
		const front = deps.frontmostPid();
		const quit: { app: string; ok: boolean }[] = [];
		for (const app of [...this.launched.values()]) {
			if (!deps.isRunning(app.pid)) {
				this.launched.delete(app.pid);
				continue;
			}
			if (keeps(app, app.name, app.bundleId)) {
				kept.push({ app: app.name, reason: "kept" });
				continue;
			}
			if (app.pid === front) {
				kept.push({ app: app.name, reason: "in use: the person has it in front" });
				continue;
			}
			this.launched.delete(app.pid);
			quit.push({ app: app.name, ok: deps.quit(app.pid) });
		}
		return { restoredFrames, quit, kept };
	}
}

/** One ledger per server process: launches and frame changes from every tool and script land here. */
export const cleanupLedger = new CleanupLedger();

function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** The macOS host: graceful quit, the WindowServer's front process, and verified frame restores. */
export const nativeCleanupDeps: CleanupDeps = {
	nameOf: (pid) => getRunningApplications().find((app) => app.pid === pid)?.name ?? `pid ${pid}`,
	frontmostPid: frontProcessPid,
	isRunning,
	quit: terminateApplication,
	setFrame: async (pid, windowId, frame) => (await setWindowFrame(pid, windowId, frame)).verified,
};
