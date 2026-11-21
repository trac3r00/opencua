import { afterEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { StopSource } from "./stop-switch.js";
import {
	type SpaceHelperProcess,
	type SpaceStopSwitch,
	TAKEOVER_REASON,
	VirtualSpace,
} from "./virtual-space-controller.js";
import { parseSpaceRecord, sendSpaceCommand, spaceControlPath, spaceRecordPath } from "./virtual-space.js";

class FakeHelper extends EventEmitter implements SpaceHelperProcess {
	readonly pid = 4242;
	readonly stdout = new PassThrough();
	readonly received: string[] = [];
	readonly stdin = {
		write: (chunk: string) => this.received.push(chunk),
		// Like the real helper: stdin closing releases the display and the process exits.
		end: () => queueMicrotask(() => this.emit("exit", 0)),
	};

	say(message: object): void {
		this.stdout.write(`${JSON.stringify(message)}\n`);
	}
}

class FakeStopSwitch implements SpaceStopSwitch {
	readonly calls: (readonly [string, ...unknown[]])[] = [];
	private waiter: (() => void) | undefined;

	stop(reason: string, source: StopSource): void {
		this.calls.push(["stop", reason, source]);
		this.waiter?.();
	}

	resume(): boolean {
		this.calls.push(["resume"]);
		this.waiter?.();
		return true;
	}

	/** Resolves on the next stop or resume; subscribe before triggering it. */
	next(): Promise<void> {
		return new Promise((resolve) => {
			this.waiter = resolve;
		});
	}
}

const CREATED = { displayId: 7, width: 1920, height: 1080, x: 3008, y: 0 };
const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function startSpace(): Promise<{
	readonly space: VirtualSpace;
	readonly helper: FakeHelper;
	readonly stopSwitch: FakeStopSwitch;
	readonly stateDir: string;
}> {
	const stateDir = mkdtempSync(join(tmpdir(), "opencua-vs-"));
	directories.push(stateDir);
	const helper = new FakeHelper();
	const stopSwitch = new FakeStopSwitch();
	const starting = VirtualSpace.start({ stateDir, spawnHelper: () => helper, stopSwitch });
	helper.say(CREATED);
	return { space: await starting, helper, stopSwitch, stateDir };
}

function recordOnDisk(stateDir: string, id: string) {
	return parseSpaceRecord(JSON.parse(readFileSync(spaceRecordPath(stateDir, id), "utf8")));
}

describe("#given a helper that reports its display #when the space starts #then the space is recorded", () => {
	it("writes the state file with the display, bounds and helper pid", async () => {
		const { space, stateDir } = await startSpace();

		expect(recordOnDisk(stateDir, space.id)).toEqual({
			id: space.id,
			displayId: 7,
			bounds: { x: 3008, y: 0, width: 1920, height: 1080 },
			pid: 4242,
			createdAt: space.record.createdAt,
			takenOver: false,
		});
		space.stop();
		await space.exited;
	});

	it("rejects with the helper's reason when the display cannot be created", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "opencua-vs-"));
		directories.push(stateDir);
		const helper = new FakeHelper();
		const starting = VirtualSpace.start({ stateDir, spawnHelper: () => helper, stopSwitch: new FakeStopSwitch() });
		helper.say({ error: "unsupported", message: "no CGVirtualDisplay" });

		await expect(starting).rejects.toThrow("unsupported");
	});

	it("rejects when the helper exits before its display is ready", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "opencua-vs-"));
		directories.push(stateDir);
		const helper = new FakeHelper();
		const starting = VirtualSpace.start({ stateDir, spawnHelper: () => helper, stopSwitch: new FakeStopSwitch() });
		helper.emit("exit", 1);

		await expect(starting).rejects.toThrow("exited with code 1");
	});
});

describe("#given a running space #when the person takes over and hands back in the PiP #then the stop switch follows", () => {
	it("stops every agent on takeover and resumes on resume", async () => {
		const { space, helper, stopSwitch, stateDir } = await startSpace();

		const stopped = stopSwitch.next();
		helper.say({ event: "takeover" });
		await stopped;
		expect(stopSwitch.calls).toEqual([["stop", TAKEOVER_REASON, "menu"]]);
		expect(recordOnDisk(stateDir, space.id)?.takenOver).toBe(true);

		const resumed = stopSwitch.next();
		helper.say({ event: "resume" });
		await resumed;
		expect(stopSwitch.calls.at(-1)).toEqual(["resume"]);
		expect(recordOnDisk(stateDir, space.id)?.takenOver).toBe(false);
		space.stop();
		await space.exited;
	});

	it("leaves a stop it did not engage alone when resume arrives without a takeover", async () => {
		const { space, stopSwitch } = await startSpace();

		expect(space.resume("control")).toBe(false);
		expect(stopSwitch.calls).toEqual([]);
		space.stop();
		await space.exited;
	});
});

describe("#given a running space #when commands arrive on its control socket #then the space obeys them", () => {
	it("takes over and resumes from the CLI and mirrors it in the PiP", async () => {
		const { space, helper, stopSwitch, stateDir } = await startSpace();

		await sendSpaceCommand(stateDir, space.id, "takeover");
		expect(stopSwitch.calls).toEqual([["stop", TAKEOVER_REASON, "cli"]]);
		expect(recordOnDisk(stateDir, space.id)?.takenOver).toBe(true);

		await sendSpaceCommand(stateDir, space.id, "resume");
		expect(stopSwitch.calls.at(-1)).toEqual(["resume"]);
		expect(helper.received).toEqual(["takeover\n", "resume\n"]);
		space.stop();
		await space.exited;
	});

	it("stops the helper and removes the state file and socket when it exits", async () => {
		const { space, stateDir } = await startSpace();

		await sendSpaceCommand(stateDir, space.id, "stop");
		await space.exited;

		expect(existsSync(spaceRecordPath(stateDir, space.id))).toBe(false);
		expect(existsSync(spaceControlPath(stateDir, space.id))).toBe(false);
	});

	it("keeps the takeover stop when the helper exits while the person has control", async () => {
		const { space, helper, stopSwitch } = await startSpace();
		const stopped = stopSwitch.next();
		helper.say({ event: "takeover" });
		await stopped;

		helper.emit("exit", 0);
		await space.exited;

		expect(stopSwitch.calls).toEqual([["stop", TAKEOVER_REASON, "menu"]]);
	});
});
