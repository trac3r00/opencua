import { describe, expect, it } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { StatusHud, type StatusUpdate, agentsDetail, statusLine } from "./buddy-status.js";

interface FakeHud {
	readonly args: readonly string[];
	readonly lines: StatusUpdate[];
	readonly child: ChildProcess;
	exit(): void;
}

function fakeSpawner(): {
	readonly spawned: FakeHud[];
	readonly spawn: (binary: string, args: readonly string[]) => ChildProcess;
} {
	const spawned: FakeHud[] = [];
	return {
		spawned,
		spawn: (_binary, args) => {
			const stdin = new PassThrough();
			const lines: StatusUpdate[] = [];
			stdin.on("data", (chunk: Buffer) => {
				for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) lines.push(JSON.parse(line));
			});
			const emitter = new EventEmitter();
			const child = Object.assign(emitter, { stdin, exitCode: null as number | null, signalCode: null }) as unknown;
			const fake: FakeHud = {
				args,
				lines,
				child: child as ChildProcess,
				exit: () => {
					(child as { exitCode: number | null }).exitCode = 0;
					emitter.emit("exit", 0);
				},
			};
			spawned.push(fake);
			return fake.child;
		},
	};
}

describe("statusLine #given a status update", () => {
	it("#when it has long text and a ttl #then it is one JSON line with the text flattened and clipped", () => {
		const line = statusLine({ state: "thinking", text: `where\n  is ${"x".repeat(300)}`, ttl: 3 });
		expect(line.endsWith("\n")).toBe(true);
		const parsed = JSON.parse(line) as { state: string; text: string; ttl: number };
		expect(parsed.state).toBe("thinking");
		expect(parsed.text.startsWith("where is x")).toBe(true);
		expect(parsed.text.length).toBe(160);
		expect(parsed.ttl).toBe(3);
	});

	it("#when it is idle with no text #then only the state is sent", () => {
		expect(statusLine({ state: "idle", text: "" })).toBe('{"state":"idle"}\n');
	});
});

describe("agentsDetail #given a count of running agents", () => {
	it("#when none, one or several run #then it says so or says nothing", () => {
		expect(agentsDetail(0)).toBeUndefined();
		expect(agentsDetail(1)).toBe("1 agent working in the background");
		expect(agentsDetail(3)).toBe("3 agents working in the background");
	});
});

describe("StatusHud #given a HUD binary", () => {
	it("#when updates arrive #then one --status process gets each as a line", async () => {
		const fake = fakeSpawner();
		const hud = new StatusHud("/bin/buddy-hud", fake.spawn, {});
		hud.set({ state: "listening", text: "Listening" });
		hud.set({ state: "thinking", text: "where is export" });
		await Bun.sleep(0);
		expect(fake.spawned).toHaveLength(1);
		expect(fake.spawned[0]?.args).toEqual(["--status"]);
		expect(fake.spawned[0]?.lines.map((line) => line.state)).toEqual(["listening", "thinking"]);
	});

	it("#when background agents run while buddy is idle #then the pill keeps showing them", async () => {
		const fake = fakeSpawner();
		const hud = new StatusHud("/bin/buddy-hud", fake.spawn, {});
		hud.set({ state: "thinking", text: "question" });
		hud.setAgents(2);
		hud.set({ state: "idle" });
		hud.setAgents(0);
		await Bun.sleep(0);
		expect(fake.spawned[0]?.lines).toEqual([
			{ state: "thinking", text: "question" },
			{ state: "thinking", text: "question", detail: "2 agents working in the background" },
			{ state: "working", text: "2 agents working in the background" },
			{ state: "idle" },
		]);
	});

	it("#when the HUD process died #then the next update starts a new one", async () => {
		const fake = fakeSpawner();
		const hud = new StatusHud("/bin/buddy-hud", fake.spawn, {});
		hud.set({ state: "listening" });
		fake.spawned[0]?.exit();
		hud.set({ state: "thinking" });
		await Bun.sleep(0);
		expect(fake.spawned).toHaveLength(2);
		expect(fake.spawned[1]?.lines.map((line) => line.state)).toEqual(["thinking"]);
	});

	it("#when OPENCUA_BUDDY_HUD=off or no binary #then nothing is started", () => {
		const fake = fakeSpawner();
		new StatusHud("/bin/buddy-hud", fake.spawn, { OPENCUA_BUDDY_HUD: "off" }).set({ state: "thinking" });
		new StatusHud(undefined, fake.spawn, {}).set({ state: "thinking" });
		expect(fake.spawned).toHaveLength(0);
	});
});
