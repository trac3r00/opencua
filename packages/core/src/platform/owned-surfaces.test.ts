import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { type Socket, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	isOwnedSurfacePid,
	readOwnedSurfaces,
	registerOwnedSurface,
	sendSurfacePointer,
	surfaceAudioState,
	surfaceAudioStatePath,
	surfaceCursorTag,
	surfaceCursorUserData,
	surfaceSocketPath,
	unregisterOwnedSurface,
} from "./owned-surfaces.js";

let stateDir: string;
const starts = new Map<number, string>();
const startTime = (pid: number) => starts.get(pid);

beforeEach(() => {
	stateDir = realpathSync(mkdtempSync(join(tmpdir(), "opencua-owned-surfaces-")));
	starts.clear();
});

afterEach(() => {
	rmSync(stateDir, { recursive: true, force: true });
});

describe("#given the owned-surface registry #when a pid is checked #then only opencua's own live window counts", () => {
	it("treats a registered, still-running surface as owned and writes the registry privately", () => {
		starts.set(4242, "Wed Nov  4 04:00:00 2026");
		registerOwnedSurface({ pid: 4242, title: "canvas", url: "http://127.0.0.1:8765/" }, { stateDir, startTime });

		expect(isOwnedSurfacePid(4242, { stateDir, startTime }, 0)).toBe(true);
		expect(statSync(join(stateDir, "owned-surfaces.json")).mode & 0o777).toBe(0o600);
	});

	it("never treats an unregistered process, such as one of the person's apps, as owned", () => {
		starts.set(777, "Wed Nov  4 03:00:00 2026");

		expect(isOwnedSurfacePid(777, { stateDir, startTime }, 0)).toBe(false);
	});

	it("refuses a different process that reused the surface's pid", () => {
		starts.set(4242, "Wed Nov  4 04:00:00 2026");
		registerOwnedSurface({ pid: 4242, title: "canvas", url: "http://127.0.0.1:8765/" }, { stateDir, startTime });
		starts.set(4242, "Wed Nov  4 05:30:00 2026");

		expect(isOwnedSurfacePid(4242, { stateDir, startTime }, 10_000)).toBe(false);
	});

	it("refuses to register a process that is not running and forgets a closed surface", () => {
		expect(() =>
			registerOwnedSurface({ pid: 9, title: "gone", url: "http://127.0.0.1/" }, { stateDir, startTime }),
		).toThrow(/not running/);
		starts.set(4242, "Wed Nov  4 04:00:00 2026");
		registerOwnedSurface({ pid: 4242, title: "canvas", url: "http://127.0.0.1:8765/" }, { stateDir, startTime });
		unregisterOwnedSurface(4242, { stateDir });

		expect(readOwnedSurfaces({ stateDir })).toEqual([]);
		expect(isOwnedSurfacePid(4242, { stateDir, startTime }, 20_000)).toBe(false);
	});
});

describe("#given cursor identities #when tagged #then each gets a stable nonzero 31-bit tag", () => {
	it("keeps tags stable per identity and distinct for different ones", () => {
		const tags = Array.from({ length: 16 }, (_, index) => surfaceCursorTag(`painter-${index + 1}`));

		expect(surfaceCursorTag("painter-1")).toBe(tags[0] ?? -1);
		expect(new Set(tags).size).toBe(16);
		for (const tag of tags) expect(tag > 0 && tag <= 0x7fffffff).toBe(true);
	});

	it("keeps the tag in the low 32 bits and marks a context click in bit 32", () => {
		const tag = surfaceCursorTag("painter-1");

		expect(surfaceCursorUserData(tag, false)).toBe(tag);
		const marked = surfaceCursorUserData(tag, true);
		expect(marked % 2 ** 32).toBe(tag);
		expect(Math.floor(marked / 2 ** 32)).toBe(1);
	});
});

describe("#given an owned surface's pointer socket #when agent pointer events are sent #then they arrive whole and in order", () => {
	it("returns false without writing when the surface has no socket, so the caller posts the event", () => {
		expect(sendSurfacePointer(4242, { tag: 7, context: false, kind: "down", x: 1, y: 2 }, { stateDir })).toBe(false);
	});

	it("writes one line per event with the cursor tag, context flag, kind and window point", async () => {
		const clients: Socket[] = [];
		let received = "";
		const expected = "7 0 D 10 20\n7 0 G 10.5 20.3\n9 1 U 3 4\n";
		const done = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`only received ${JSON.stringify(received)}`)), 2_000);
			const server = createServer((client) => {
				clients.push(client);
				client.on("data", (chunk) => {
					received += chunk.toString();
					if (received.length >= expected.length) {
						clearTimeout(timer);
						for (const open of clients) open.destroy();
						server.close(() => resolve());
					}
				});
			});
			server.listen(surfaceSocketPath(4242, { stateDir }), () => {
				sendSurfacePointer(4242, { tag: 7, context: false, kind: "down", x: 10, y: 20 }, { stateDir });
				sendSurfacePointer(4242, { tag: 7, context: false, kind: "drag", x: 10.46, y: 20.31 }, { stateDir });
				sendSurfacePointer(4242, { tag: 9, context: true, kind: "up", x: 3, y: 4 }, { stateDir });
			});
		});

		await done;

		expect(received).toBe(expected);
	});
});

describe("#given an owned surface's audio state file #when it is read #then only a well-formed state is reported", () => {
	it("#given a playing state written by the surface #when read #then it reports playing and the change time", () => {
		writeFileSync(surfaceAudioStatePath(4242, { stateDir }), '{"playing":true,"changedAt":1794031639000}');
		expect(surfaceAudioState(4242, { stateDir })).toEqual({ playing: true, changedAt: 1794031639000 });
	});

	it("#given the silent state a surface writes at startup #when read #then it reports not playing rather than nothing", () => {
		writeFileSync(surfaceAudioStatePath(4242, { stateDir }), '{"playing":false,"changedAt":1794031639000}');
		expect(surfaceAudioState(4242, { stateDir })).toEqual({ playing: false, changedAt: 1794031639000 });
	});

	it("#given a WebAudio level measured by the page #when read #then the level comes back with its bands", () => {
		const level = {
			rmsDb: -63,
			peakDb: -60,
			bands: [-160, -160, -160, -88, -160, -160, -160, -160],
			at: 1794036018450,
		};
		writeFileSync(
			surfaceAudioStatePath(4242, { stateDir }),
			JSON.stringify({ playing: true, changedAt: 1794036018265, level }),
		);
		expect(surfaceAudioState(4242, { stateDir })).toEqual({ playing: true, changedAt: 1794036018265, level });
	});

	it("#given a malformed level #when read #then the playing state is kept and the level dropped", () => {
		for (const level of [
			{ rmsDb: "x", peakDb: -1, bands: [], at: 1 },
			{ rmsDb: -1, peakDb: -1, bands: [1, 2], at: 1 },
			{ rmsDb: -1, peakDb: -1, bands: [0, 0, 0, 0, 0, 0, 0, "x"], at: 1 },
			null,
		]) {
			writeFileSync(
				surfaceAudioStatePath(4242, { stateDir }),
				JSON.stringify({ playing: true, changedAt: 5, level }),
			);
			expect(surfaceAudioState(4242, { stateDir })).toEqual({ playing: true, changedAt: 5 });
		}
	});

	it("#given no file #when read #then there is no audio state", () => {
		expect(surfaceAudioState(4242, { stateDir })).toBeUndefined();
	});

	it("#given malformed or mistyped files #when read #then there is no audio state", () => {
		for (const text of [
			"",
			"not json",
			"null",
			'{"playing":"yes","changedAt":1}',
			'{"playing":true}',
			'{"playing":false,"changedAt":"1"}',
		]) {
			writeFileSync(surfaceAudioStatePath(4242, { stateDir }), text);
			expect(surfaceAudioState(4242, { stateDir })).toBeUndefined();
		}
	});
});
