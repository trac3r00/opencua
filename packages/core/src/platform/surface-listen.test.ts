import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { surfaceAudioStatePath } from "./owned-surfaces.js";
import { type ProcessIdentity, listenToSurface } from "./surface-listen.js";

const SURFACE_STARTED = 1_794_036_000_000;
const GPU =
	"/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.GPU.xpc/Contents/MacOS/com.apple.WebKit.GPU";

let stateDir: string;
let identity: ProcessIdentity | undefined;
const measured: { pid: number; durationMs: number }[] = [];
const dependencies = {
	owned: (pid: number, options: { readonly stateDir?: string }) => pid === 4242 && options.stateDir === stateDir,
	measure: async (pid: number, durationMs: number) => {
		measured.push({ pid, durationMs });
		return { rms: 0.001, peak: 0.01, samples: 96_000 };
	},
	identity: (pid: number) => (pid === 777 ? identity : undefined),
	surfaceStartedAt: (pid: number) => (pid === 4242 ? SURFACE_STARTED : undefined),
};

beforeEach(() => {
	stateDir = realpathSync(mkdtempSync(join(tmpdir(), "opencua-surface-listen-")));
	measured.length = 0;
	identity = { command: GPU, startedAt: SURFACE_STARTED + 1_000 };
});

afterEach(() => {
	rmSync(stateDir, { recursive: true, force: true });
});

const report = (state: Record<string, unknown>) =>
	writeFileSync(surfaceAudioStatePath(4242, { stateDir }), JSON.stringify(state));

describe("#given an owned surface that reported its audio process #when an agent listens #then that process is tapped", () => {
	it("#given its live WebKit GPU process #when listening for a second #then it taps that pid and answers in dB", async () => {
		report({ playing: true, changedAt: 1, gpuPid: 777 });
		const heard = await listenToSurface(4242, 1_000, { stateDir }, dependencies);
		expect(measured).toEqual([{ pid: 777, durationMs: 1_000 }]);
		expect(heard.rmsDb).toBeCloseTo(-60, 6);
		expect(heard.peakDb).toBeCloseTo(-40, 6);
		expect(heard.samples).toBe(96_000);
	});
});

describe("#given something that cannot be listened to #when an agent listens #then nothing is tapped", () => {
	it("#given a pid that is not an owned surface #when listening #then it is refused", async () => {
		report({ playing: true, changedAt: 1, gpuPid: 777 });
		await expect(listenToSurface(1, 1_000, { stateDir }, dependencies)).rejects.toThrow(/not an open owned surface/);
		expect(measured).toEqual([]);
	});

	it("#given a surface that has not reported its audio process #when listening #then it is refused", async () => {
		report({ playing: false, changedAt: 1 });
		await expect(listenToSurface(4242, 1_000, { stateDir }, dependencies)).rejects.toThrow(
			/has not reported an audio process/,
		);
		expect(measured).toEqual([]);
	});

	it("#given the reported pid now belongs to another program or predates the surface #when listening #then it is refused", async () => {
		report({ playing: true, changedAt: 1, gpuPid: 777 });
		for (const reused of [
			{ command: "/Applications/Music.app/Contents/MacOS/Music", startedAt: SURFACE_STARTED + 1_000 },
			{ command: GPU, startedAt: SURFACE_STARTED - 60_000 },
			undefined,
		]) {
			identity = reused;
			await expect(listenToSurface(4242, 1_000, { stateDir }, dependencies)).rejects.toThrow(
				/is gone or is not its WebKit GPU process/,
			);
		}
		expect(measured).toEqual([]);
	});

	it("#given a duration outside 50..10000 ms #when listening #then it is refused", async () => {
		report({ playing: true, changedAt: 1, gpuPid: 777 });
		for (const duration of [49, 10_001, 1.5]) {
			await expect(listenToSurface(4242, duration, { stateDir }, dependencies)).rejects.toThrow(/duration_ms/);
		}
		expect(measured).toEqual([]);
	});
});
