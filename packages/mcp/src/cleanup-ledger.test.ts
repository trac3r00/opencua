import { describe, expect, it } from "bun:test";
import type { Rect } from "@opencua/core";
import { type CleanupDeps, CleanupLedger } from "./cleanup-ledger.js";

const NOTES = { pid: 10, name: "Notes", bundleId: "com.apple.Notes" };
const CHROME = { pid: 20, name: "Google Chrome", bundleId: "com.google.Chrome" };
const FINDER_PID = 30;
const ORIGINAL: Rect = { x: 100, y: 100, width: 800, height: 600 };

function host(front?: number): {
	readonly deps: CleanupDeps;
	readonly quit: number[];
	readonly frames: { pid: number; windowId: number; frame: Rect }[];
	readonly running: Set<number>;
} {
	const quit: number[] = [];
	const frames: { pid: number; windowId: number; frame: Rect }[] = [];
	const running = new Set([NOTES.pid, CHROME.pid, FINDER_PID]);
	return {
		quit,
		frames,
		running,
		deps: {
			nameOf: (pid) => (pid === FINDER_PID ? "Finder" : `pid ${pid}`),
			frontmostPid: () => front,
			isRunning: (pid) => running.has(pid),
			quit: (pid) => {
				quit.push(pid);
				return true;
			},
			setFrame: async (pid, windowId, frame) => {
				frames.push({ pid, windowId, frame });
				return true;
			},
		},
	};
}

describe("#given apps OpenCUA launched and windows it moved #when it cleans up #then the desktop is put back", () => {
	it("restores a moved window to its frame before the first move and quits the apps it launched", async () => {
		const ledger = new CleanupLedger();
		const { deps, quit, frames } = host();
		ledger.noteLaunched(NOTES);
		ledger.noteFrameChange({ pid: FINDER_PID, windowId: 7, original: ORIGINAL });
		ledger.noteFrameChange({ pid: FINDER_PID, windowId: 7, original: { x: 0, y: 0, width: 10, height: 10 } });

		const report = await ledger.cleanUp(deps);

		expect(frames).toEqual([{ pid: FINDER_PID, windowId: 7, frame: ORIGINAL }]);
		expect(quit).toEqual([NOTES.pid]);
		expect(report).toEqual({
			restoredFrames: [{ app: "Finder", windowId: 7, ok: true }],
			quit: [{ app: "Notes", ok: true }],
			kept: [],
		});
		expect(ledger.empty).toBe(true);
	});

	it("does not restore windows of an app it is about to quit", async () => {
		const ledger = new CleanupLedger();
		const { deps, frames, quit } = host();
		ledger.noteLaunched(CHROME);
		ledger.noteFrameChange({ pid: CHROME.pid, windowId: 9, original: ORIGINAL });

		await ledger.cleanUp(deps);

		expect(frames).toEqual([]);
		expect(quit).toEqual([CHROME.pid]);
	});

	it("keeps the app the person has in front and any app named in keep, and can close them later", async () => {
		const ledger = new CleanupLedger();
		const { deps, quit } = host(CHROME.pid);
		ledger.noteLaunched(NOTES);
		ledger.noteLaunched(CHROME);

		const first = await ledger.cleanUp(deps, ["notes"]);

		expect(quit).toEqual([]);
		expect(first.kept).toEqual([
			{ app: "Notes", reason: "kept" },
			{ app: "Google Chrome", reason: "in use: the person has it in front" },
		]);
		expect(ledger.empty).toBe(false);

		const later = host();
		await ledger.cleanUp(later.deps);
		expect(later.quit).toEqual([NOTES.pid, CHROME.pid]);
	});

	it("forgets an app that already quit, without asking it to quit", async () => {
		const ledger = new CleanupLedger();
		const { deps, quit, running } = host();
		ledger.noteLaunched(NOTES);
		running.delete(NOTES.pid);

		const report = await ledger.cleanUp(deps);

		expect(quit).toEqual([]);
		expect(report.quit).toEqual([]);
		expect(ledger.empty).toBe(true);
	});
});
