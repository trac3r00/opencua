import { describe, expect, it } from "bun:test";
import {
	agentMasterName,
	freeDisplayNumber,
	ownedDisplayPlan,
	readXinputMasters,
	startOwnedLinuxSession,
} from "./owned-session.js";

const SEED = Number(process.env["SESSION_SEED"] ?? 20261107);

function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

const XINPUT = `⎡ Virtual core pointer                    \tid=2\t[master pointer  (3)]
⎜   ↳ Virtual core XTEST pointer              \tid=4\t[slave  pointer  (2)]
⎣ Virtual core keyboard                   \tid=3\t[master keyboard (2)]
    ↳ Virtual core XTEST keyboard             \tid=5\t[slave  keyboard (3)]
⎡ opencua-explorer pointer                \tid=9\t[master pointer  (10)]
⎜   ↳ opencua-explorer XTEST pointer          \tid=11\t[slave  pointer  (9)]
⎣ opencua-explorer keyboard               \tid=10\t[master keyboard (9)]
    ↳ opencua-explorer XTEST keyboard         \tid=12\t[slave  keyboard (10)]`;

describe("#given X sockets in use #when a display number is picked #then it is the lowest free one from 90", () => {
	it("matches a brute-force search on 300 generated socket sets", () => {
		const next = random(SEED);
		for (let index = 0; index < 300; index += 1) {
			const used = new Set(Array.from({ length: Math.floor(next() * 20) }, () => 85 + Math.floor(next() * 15)));
			const names = [...used].map((number) => `X${number}`).concat(["X0", "Xjunk", "X", "lock"]);
			let want = 90;
			while (used.has(want)) want += 1;
			expect(freeDisplayNumber(names)).toBe(want);
		}
	});
});

describe("#given xinput list output #when masters are read #then only paired master pointer and keyboard come back", () => {
	it("reads the core and agent masters from real-format output and ignores slaves", () => {
		expect(readXinputMasters(XINPUT)).toEqual([
			{ name: "Virtual core", pointerId: 2, keyboardId: 3 },
			{ name: "opencua-explorer", pointerId: 9, keyboardId: 10 },
		]);
		expect(readXinputMasters(XINPUT.replace("[master keyboard (9)]", "[master keyboard (2)]"))).toHaveLength(1);
		expect(readXinputMasters("")).toEqual([]);
	});
});

describe("#given agent names #when turned into master names #then they are safe xinput names", () => {
	it("keeps letters, digits and dashes, and refuses names with none", () => {
		expect(agentMasterName("Explorer #2 (beta)")).toMatch(/^opencua-explorer-2-beta-[0-9a-f]{8}$/);
		expect(agentMasterName("검색 agent")).toMatch(/^opencua-agent-[0-9a-f]{8}$/);
		// Names that reduce to the same slug still get different masters.
		expect(agentMasterName("a b")).not.toBe(agentMasterName("a-b"));
		expect(agentMasterName("Scout")).toBe(agentMasterName("Scout"));
		expect(() => agentMasterName("검색 ")).toThrow(RangeError);
		expect(() => agentMasterName("--")).toThrow(RangeError);
	});
});

describe("#given an owned display plan #when built #then it never listens on TCP and keeps sizes in range", () => {
	it("plans Xvfb and Xephyr on the given display with Composite and XInput", () => {
		const xvfb = ownedDisplayPlan("xvfb", 91, { width: 1280, height: 800 });
		expect(xvfb).toMatchObject({ display: ":91", command: "Xvfb" });
		expect(xvfb.args).toEqual(
			expect.arrayContaining(["-nolisten", "tcp", "Composite", "XInputExtension", "1280x800x24"]),
		);
		expect(ownedDisplayPlan("xephyr", 92, { width: 1280, height: 800 }).command).toBe("Xephyr");
		expect(() => ownedDisplayPlan("xvfb", 0, { width: 1280, height: 800 })).toThrow(RangeError);
		expect(() => ownedDisplayPlan("xvfb", 91, { width: 100, height: 800 })).toThrow(RangeError);
	});
});

describe("#given an owned session #when an agent pointer is added #then xinput runs only on the owned display", () => {
	it("creates the master once and reuses it, with DISPLAY set to the owned display", async () => {
		const calls: Array<{ args: readonly string[]; display: string | undefined }> = [];
		let created = false;
		let stopped = false;
		const session = await startOwnedLinuxSession({
			sockets: () => ["X0", "X90"],
			start: () => ({
				ready: Promise.resolve(),
				stop: () => {
					stopped = true;
				},
			}),
			run: async (_command, args, env) => {
				calls.push({ args, display: env["DISPLAY"] });
				if (args[0] === "create-master") created = true;
				return created ? XINPUT.split("opencua-explorer").join(agentMasterName("Scout")) : XINPUT;
			},
		});
		expect(session.display).toBe(":91");
		const name = agentMasterName("Scout");
		expect(await session.addAgentPointer("Scout")).toEqual({ name, pointerId: 9, keyboardId: 10 });
		expect(await session.addAgentPointer("Scout")).toEqual({ name, pointerId: 9, keyboardId: 10 });
		expect(calls.filter((call) => call.args[0] === "create-master")).toHaveLength(1);
		expect(calls.every((call) => call.display === ":91")).toBe(true);
		await session.close();
		expect(stopped).toBe(true);
	});
});
