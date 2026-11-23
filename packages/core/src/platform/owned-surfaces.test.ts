import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { type Socket, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { processExecutablePath } from "./macos-ffi/process-info.js";
import {
	boardPageUrl,
	closeOwnedSurface,
	isOwnedSurfacePid,
	nameSurfaceCursor,
	readOwnedSurfaces,
	registerOwnedSurface,
	sendSurfacePointer,
	setSessionCursorName,
	setSurfaceBinaryForTesting,
	setSurfaceCursorIntent,
	setSurfaceCursorRegion,
	speakOnSurface,
	surfaceAudioState,
	surfaceAudioStatePath,
	surfaceBinaryPath,
	surfaceCursorFor,
	surfaceCursorTag,
	surfaceCursorUserData,
	surfaceSocketPath,
	unregisterOwnedSurface,
} from "./owned-surfaces.js";

let stateDir: string;
const starts = new Map<number, string>();
const startTime = (pid: number) => starts.get(pid);
/** The file each fake pid executes; a pid left out is one of the person's own apps. */
const executables = new Map<number, string>();
const executablePath = (pid: number) => executables.get(pid) ?? "/Applications/Safari.app/Contents/MacOS/Safari";
const probes = () => ({ stateDir, startTime, executablePath });
const registryFile = () => join(stateDir, "owned-surfaces.json");
const STARTED = "Wed Nov  4 04:00:00 2026";

/** Pid 4242 is a surface opencua launched: it runs the surface binary and is in the registry. */
function launchSurface(): void {
	starts.set(4242, STARTED);
	executables.set(4242, surfaceBinaryPath());
	registerOwnedSurface({ pid: 4242, title: "canvas", url: "http://127.0.0.1:8765/" }, probes());
}

/** What any process running as the person can do: write a registry that names a process of its choosing. */
function forgeRegistry(pid: number, startedAt: string): void {
	writeFileSync(
		registryFile(),
		`${JSON.stringify({ surfaces: [{ pid, startedAt, title: "canvas", url: "http://127.0.0.1/" }] })}\n`,
		{ mode: 0o600 },
	);
}

beforeEach(() => {
	stateDir = realpathSync(mkdtempSync(join(tmpdir(), "opencua-owned-surfaces-")));
	starts.clear();
	executables.clear();
});

afterEach(() => {
	setSurfaceBinaryForTesting(undefined);
	rmSync(stateDir, { recursive: true, force: true });
});

describe("#given the owned-surface registry #when a pid is checked #then only opencua's own live window counts", () => {
	it("treats a registered, still-running surface as owned and writes the registry privately", () => {
		launchSurface();

		expect(isOwnedSurfacePid(4242, probes(), 0)).toBe(true);
		expect(statSync(registryFile()).mode & 0o777).toBe(0o600);
	});

	it("never treats an unregistered process, such as one of the person's apps, as owned", () => {
		starts.set(777, "Wed Nov  4 03:00:00 2026");

		expect(isOwnedSurfacePid(777, probes(), 0)).toBe(false);
	});

	it("refuses a different process that reused the surface's pid", () => {
		launchSurface();
		starts.set(4242, "Wed Nov  4 05:30:00 2026");

		expect(isOwnedSurfacePid(4242, probes(), 10_000)).toBe(false);
	});

	it("refuses to register a process that is not running and forgets a closed surface", () => {
		expect(() => registerOwnedSurface({ pid: 9, title: "gone", url: "http://127.0.0.1/" }, probes())).toThrow(
			/not running/,
		);
		launchSurface();
		unregisterOwnedSurface(4242, { stateDir });

		expect(readOwnedSurfaces({ stateDir })).toEqual([]);
		expect(isOwnedSurfacePid(4242, probes(), 20_000)).toBe(false);
	});
});

describe("#given a registry any process of the person can write #when it names a process opencua did not launch #then that process gains nothing", () => {
	it("#given an entry with one of the person's apps and its true start time #when the pid is checked #then it is not owned", () => {
		starts.set(777, STARTED);
		forgeRegistry(777, STARTED);

		expect(readOwnedSurfaces({ stateDir }).map((surface) => surface.pid)).toEqual([777]);
		expect(isOwnedSurfacePid(777, probes(), 0)).toBe(false);
	});

	it("#given such an entry #when the surface is closed through opencua #then the app is not killed and the entry stays out of reach", () => {
		starts.set(777, STARTED);
		forgeRegistry(777, STARTED);
		const kill = spyOn(process, "kill").mockImplementation(() => true);
		try {
			expect(closeOwnedSurface(777, probes())).toBe(false);
			expect(kill).not.toHaveBeenCalled();
		} finally {
			kill.mockRestore();
		}
	});

	it("#given an entry naming this very process with its true start time #when checked with the real probes #then it is not owned", () => {
		const own = registerOwnedSurface({ pid: process.pid, title: "canvas", url: "http://127.0.0.1/" }, { stateDir });

		expect(own.startedAt.length).toBeGreaterThan(0);
		expect(processExecutablePath(process.pid)).not.toBe(surfaceBinaryPath());
		expect(isOwnedSurfacePid(process.pid, { stateDir }, 0)).toBe(false);
	});

	it("#given the surface binary is the file this process executes #when checked with the real probes #then it is owned", () => {
		setSurfaceBinaryForTesting(process.execPath);
		registerOwnedSurface({ pid: process.pid, title: "canvas", url: "http://127.0.0.1/" }, { stateDir });

		expect(isOwnedSurfacePid(process.pid, { stateDir }, 0)).toBe(true);
	});

	it("#given a surface reached through a symlinked install path #when its pid is checked #then the resolved binary still matches", () => {
		const link = join(stateDir, "linked-surface");
		symlinkSync(process.execPath, link);
		setSurfaceBinaryForTesting(link);
		registerOwnedSurface({ pid: process.pid, title: "canvas", url: "http://127.0.0.1/" }, { stateDir });

		expect(isOwnedSurfacePid(process.pid, { stateDir }, 0)).toBe(true);
	});
});

describe("#given a registry file this user does not solely control #when it is read #then nothing in it is trusted", () => {
	it("#given a file others may write #when read #then it holds no surfaces, and the next registration replaces it privately", () => {
		launchSurface();
		chmodSync(registryFile(), 0o666);

		expect(readOwnedSurfaces({ stateDir })).toEqual([]);
		expect(isOwnedSurfacePid(4242, probes(), 0)).toBe(false);

		launchSurface();
		expect(statSync(registryFile()).mode & 0o777).toBe(0o600);
		expect(isOwnedSurfacePid(4242, probes(), 30_000)).toBe(true);
	});

	it("#given a symlink in the registry's place #when read #then the file it points at is not followed", () => {
		launchSurface();
		const elsewhere = join(stateDir, "planted.json");
		renameSync(registryFile(), elsewhere);
		symlinkSync(elsewhere, registryFile());

		expect(readOwnedSurfaces({ stateDir })).toEqual([]);
		expect(isOwnedSurfacePid(4242, probes(), 0)).toBe(false);
	});
});

describe("#given a named surface cursor #when its region is set or cleared #then the surface reads it from the names file", () => {
	const names = () => JSON.parse(readFileSync(join(stateDir, "surface-cursors.json"), "utf8"));

	it("keeps the name and color beside the region and drops only the region when cleared", () => {
		nameSurfaceCursor(9_001, "explorer", { stateDir });
		const named = names()["9001"];
		setSurfaceCursorRegion(9_001, { x: 10, y: 20, width: 300, height: 200 }, { stateDir });
		expect(names()["9001"]).toEqual({ ...named, region: { x: 10, y: 20, width: 300, height: 200 } });
		setSurfaceCursorRegion(9_001, undefined, { stateDir });
		expect(names()["9001"]).toEqual(named);
	});

	it("sets and clears an intent badge beside the name and refuses unknown intents", () => {
		nameSurfaceCursor(9_003, "scout", { stateDir });
		setSurfaceCursorIntent(9_003, "listening", { stateDir });
		expect(names()["9003"]).toMatchObject({ name: "scout", badge: "🎧" });
		setSurfaceCursorIntent(9_003, undefined, { stateDir });
		expect(names()["9003"].badge).toBeUndefined();
		const fromWire: Parameters<typeof setSurfaceCursorIntent>[1] = JSON.parse('"__proto__"');
		expect(() => setSurfaceCursorIntent(9_003, fromWire, { stateDir })).toThrow(RangeError);
	});

	it("speaks only to a running surface, leaves no clip behind when there is none, and refuses empty or huge clips", () => {
		expect(speakOnSurface(424242, Buffer.from("RIFF"), { stateDir })).toBe(false);
		expect(readdirSync(stateDir).filter((name) => name.endsWith(".audio"))).toEqual([]);
		expect(() => speakOnSurface(1, Buffer.alloc(0), { stateDir })).toThrow(RangeError);
		expect(() => speakOnSurface(1, Buffer.alloc(16 * 1024 * 1024 + 1), { stateDir })).toThrow(RangeError);
	});

	it("rejects regions the surface would not draw and leaves the file untouched", () => {
		setSurfaceCursorRegion(9_002, { x: 0, y: 0, width: 5, height: 5 }, { stateDir });
		const before = readFileSync(join(stateDir, "surface-cursors.json"), "utf8");
		for (const region of [
			{ x: 0, y: 0, width: 0, height: 5 },
			{ x: 0, y: 0, width: 5, height: -1 },
			{ x: Number.NaN, y: 0, width: 5, height: 5 },
			{ x: 0, y: Number.POSITIVE_INFINITY, width: 5, height: 5 },
		]) {
			expect(() => setSurfaceCursorRegion(9_002, region, { stateDir })).toThrow(RangeError);
		}
		expect(readFileSync(join(stateDir, "surface-cursors.json"), "utf8")).toBe(before);
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

describe("#given input with or without a worker's cursor #when its surface cursor is resolved #then every session has its own", () => {
	it("gives input outside any worker scope this process's own tag and the session's name, never the shared tag 1", () => {
		setSessionCursorName("claude-code 4242");

		const session = surfaceCursorFor(undefined, undefined);

		expect(session.tag).toBe(surfaceCursorTag(`process-${process.pid}`));
		expect(session.tag).not.toBe(1);
		expect(session.name).toBe("claude-code 4242");
	});

	it("keeps a worker's own cursor and name inside its scope", () => {
		setSessionCursorName("claude-code 4242");

		expect(surfaceCursorFor("worker-7", { agentName: "painter 7" })).toEqual({
			tag: surfaceCursorTag("worker-7"),
			name: "painter 7",
		});
		expect(surfaceCursorFor("worker-7", undefined).name).toBe("worker-7");
	});

	it("labels a worker's cursor with its name and purpose", () => {
		expect(surfaceCursorFor("worker-7", { agentName: "painter 7", purpose: "draw row 7" }).name).toBe(
			"painter 7: draw row 7",
		);
	});
});

describe("#given many agent processes starting on one surface #when each names its cursor at once #then no name is lost", () => {
	it("keeps every process's entry in the shared names file", async () => {
		const modulePath = fileURLToPath(new URL("./owned-surfaces.ts", import.meta.url));
		const processes = Array.from({ length: 8 }, (_, index) =>
			Bun.spawn(
				[
					process.execPath,
					"-e",
					`const m = await import(${JSON.stringify(modulePath)}); m.nameSurfaceCursor(${100 + index}, "agent ${index}", { stateDir: ${JSON.stringify(stateDir)} });`,
				],
				{ stdout: "ignore", stderr: "pipe" },
			),
		);
		const codes = await Promise.all(processes.map((child) => child.exited));

		expect(codes).toEqual(Array.from({ length: 8 }, () => 0));
		const names: unknown = JSON.parse(await Bun.file(join(stateDir, "surface-cursors.json")).text());
		expect(Object.keys(names as Record<string, unknown>).sort()).toEqual(
			Array.from({ length: 8 }, (_, index) => String(100 + index)).sort(),
		);
		expect(existsSync(join(stateDir, "surface-cursors.json.lock"))).toBe(false);
	});
});

describe("#given the built-in board #when its url is resolved #then it names the shipped page", () => {
	it("points at an existing file next to the native helpers", () => {
		const url = boardPageUrl();

		expect(url.startsWith("file://")).toBe(true);
		expect(existsSync(fileURLToPath(url))).toBe(true);
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
