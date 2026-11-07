import { describe, expect, it } from "bun:test";
import { currentInputRegion } from "@opencua/core";
import { GuardedSession } from "./guarded-session.js";
import { FakeGuardedComputer } from "./protocol-test-harness.js";
import type { RunStep } from "./tool-schemas.js";
import { workerManagementRequestSchema } from "./tool-schemas.js";
import { WorkerCoordinator, WorkerRegionRefusal } from "./worker-coordinator.js";

// The fake window screenshot is 500x400 px over screen bounds {x: 300, y: 150, width: 1000, height: 800}.
const LEFT = { x: 0, y: 0, width: 250, height: 400 };
const RIGHT = { x: 250, y: 0, width: 250, height: 400 };
const FINDER_PID = 1234;

function setup(): { readonly computer: FakeGuardedComputer; readonly coordinator: WorkerCoordinator } {
	const computer = new FakeGuardedComputer();
	const coordinator = new WorkerCoordinator(
		new GuardedSession(computer),
		computer,
		undefined,
		(pid) => pid === FINDER_PID,
	);
	return { computer, coordinator };
}

async function assignLeftPainter(coordinator: WorkerCoordinator): Promise<string> {
	const [painter] = await coordinator.assign([{ worker_id: "left", task: "paint left", app: "Finder", region: LEFT }]);
	if (painter?.observation_token === undefined) throw new Error("the painter needs an observation token");
	return painter.observation_token;
}

describe("#given a shared owned surface #when workers are assigned regions #then the regions must be disjoint", () => {
	it("#given disjoint regions on one shared app #when assigned #then both succeed and echo their region", async () => {
		const { coordinator } = setup();
		try {
			const assigned = await coordinator.assign([
				{ worker_id: "left", task: "paint left", app: "Finder", region: LEFT },
				{ worker_id: "right", task: "paint right", app: "Finder", region: RIGHT },
			]);
			expect(assigned.map(({ worker_id, region }) => ({ worker_id, region }))).toEqual([
				{ worker_id: "left", region: LEFT },
				{ worker_id: "right", region: RIGHT },
			]);
		} finally {
			await coordinator.close();
		}
	});

	it("#given an overlapping region in the same batch #when assigned #then it is refused naming both workers", async () => {
		const { coordinator } = setup();
		try {
			await expect(
				coordinator.assign([
					{ worker_id: "left", task: "paint left", app: "Finder", region: LEFT },
					{
						worker_id: "middle",
						task: "paint middle",
						app: "Finder",
						region: { x: 200, y: 0, width: 100, height: 50 },
					},
				]),
			).rejects.toThrow(/worker "middle" region .* overlaps worker "left" region/);
			expect(coordinator.status()).toEqual([]);
		} finally {
			await coordinator.close();
		}
	});

	it("#given a region already assigned #when an overlapping one is assigned later #then it is refused naming both workers", async () => {
		const { coordinator } = setup();
		try {
			await assignLeftPainter(coordinator);
			await expect(
				coordinator.assign([
					{ worker_id: "late", task: "paint", app: "Finder", region: { x: 100, y: 100, width: 10, height: 10 } },
				]),
			).rejects.toThrow(/worker "late" region .* overlaps worker "left" region/);
			// Regions that only share an edge do not overlap.
			const [right] = await coordinator.assign([
				{ worker_id: "right", task: "paint", app: "Finder", region: RIGHT },
			]);
			expect(right?.region).toEqual(RIGHT);
		} finally {
			await coordinator.close();
		}
	});

	it("#given an app that is not a shared surface #when a region is given #then the assignment is refused", async () => {
		const { coordinator } = setup();
		try {
			await expect(
				coordinator.assign([{ worker_id: "reader", task: "read", app: "Other", region: LEFT }]),
			).rejects.toThrow(/worker "reader" gives a region, but app "Other" is not a shared opencua-owned surface/);
		} finally {
			await coordinator.close();
		}
	});

	it("#given a region with zero width or non-finite x #when parsed by manage_workers #then the request is invalid", () => {
		for (const region of [
			{ x: 0, y: 0, width: 0, height: 10 },
			{ x: Number.POSITIVE_INFINITY, y: 0, width: 10, height: 10 },
		]) {
			const parsed = workerManagementRequestSchema.safeParse({
				op: "assign",
				assignments: [{ worker_id: "w", task: "t", app: "Finder", region }],
			});
			expect(parsed.success).toBe(false);
		}
	});
});

describe("#given a worker confined to a region #when run_worker aims the pointer #then only in-region targets are sent", () => {
	it("#given a click outside the region #when run #then the whole run is refused before any input", async () => {
		const { computer, coordinator } = setup();
		try {
			const token = await assignLeftPainter(coordinator);
			const steps: RunStep[] = [
				{ type: "click", x: 100, y: 100 },
				{ type: "click", x: 300, y: 100 },
			];
			const refused = coordinator.run("left", token, steps, undefined);
			await expect(refused).rejects.toBeInstanceOf(WorkerRegionRefusal);
			await expect(refused).rejects.toThrow(
				/step 1 clicks at \(300, 100\), outside its region \{x: 0, y: 0, width: 250, height: 400\}/,
			);
			expect(computer.targetedInputs).toEqual([]);
			expect(computer.effects).toEqual([]);
			// The token was never consumed, so the corrected run goes through.
			const retried = await coordinator.run("left", token, [{ type: "click", x: 100, y: 100 }], undefined);
			expect(retried.result.isError).not.toBe(true);
		} finally {
			await coordinator.close();
		}
	});

	it("#given a click inside the region #when run #then it is delivered to the shared window", async () => {
		const { computer, coordinator } = setup();
		try {
			const token = await assignLeftPainter(coordinator);
			const ran = await coordinator.run("left", token, [{ type: "click", x: 100, y: 100 }], undefined);
			expect(ran.result.isError).not.toBe(true);
			expect(computer.targetedInputs.map(({ effect, pid }) => ({ kind: effect.kind, pid }))).toEqual([
				{ kind: "click", pid: FINDER_PID },
			]);
		} finally {
			await coordinator.close();
		}
	});

	it("#given a drag whose end leaves the region #when run #then it is refused with zero input", async () => {
		const { computer, coordinator } = setup();
		try {
			const token = await assignLeftPainter(coordinator);
			const drag: RunStep = { type: "drag", from_x: 10, from_y: 10, to_x: 400, to_y: 10 };
			await expect(coordinator.run("left", token, [drag], undefined)).rejects.toThrow(
				/step 0 ends its drag at \(400, 10\), outside its region/,
			);
			const waypoint: RunStep = {
				type: "drag",
				from_x: 10,
				from_y: 10,
				to_x: 20,
				to_y: 20,
				waypoints: [{ x: 260, y: 15 }],
			};
			await expect(coordinator.run("left", token, [waypoint], undefined)).rejects.toThrow(
				/step 0 drags through waypoint 0 at \(260, 15\)/,
			);
			expect(computer.targetedInputs).toEqual([]);
		} finally {
			await coordinator.close();
		}
	});

	it("#given an element id whose centre lies outside the region #when clicked #then it is refused with zero input", async () => {
		const { computer, coordinator } = setup();
		try {
			const token = await assignLeftPainter(coordinator);
			// Screen centre (900, 350) maps to screenshot-local (300, 100).
			computer.elementFrames.set(9, { x: 890, y: 340, width: 20, height: 20 });
			await expect(
				coordinator.run("left", token, [{ type: "click", element_index: "9" }], undefined),
			).rejects.toThrow(/step 0 clicks element 9 at \(300, 100\), outside its region/);
			expect(computer.effects).toEqual([]);
		} finally {
			await coordinator.close();
		}
	});

	it("#given an element id outside the region #when its value is set #then it is refused with zero input", async () => {
		const { computer, coordinator } = setup();
		try {
			const token = await assignLeftPainter(coordinator);
			computer.elementFrames.set(9, { x: 890, y: 340, width: 20, height: 20 });
			await expect(
				coordinator.run("left", token, [{ type: "set_value", element_index: "9", value: "x" }], undefined),
			).rejects.toThrow(/step 0 runs set_value on element 9 at \(300, 100\), outside its region/);
			expect(computer.effects).toEqual([]);
		} finally {
			await coordinator.close();
		}
	});

	it("#given a described target that resolves outside the region after a sent keystroke #when run #then the refusal says the earlier step was sent", async () => {
		const { computer, coordinator } = setup();
		try {
			const token = await assignLeftPainter(coordinator);
			computer.elementFrames.set(9, { x: 890, y: 340, width: 20, height: 20 });
			const ran = await coordinator.run(
				"left",
				token,
				[
					{ type: "press_keys", keys: ["a"] },
					{ type: "click", target: { label: "Open" } },
				],
				undefined,
			);
			const text = ran.result.content.find((content) => content.type === "text")?.text ?? "";
			expect(text).toMatch(
				/step 1 clicks element 9 .*outside its region .*earlier steps of this run were: observe again/,
			);
			expect(computer.effects).toEqual([{ kind: "key", key: "a" }]);
		} finally {
			await coordinator.close();
		}
	});

	it("#given a reveal of a visible control before an out-of-region click #when run #then the refusal says nothing was sent", async () => {
		const { computer, coordinator } = setup();
		try {
			const token = await assignLeftPainter(coordinator);
			computer.elementFrames.set(9, { x: 890, y: 340, width: 20, height: 20 });
			const ran = await coordinator.run(
				"left",
				token,
				[
					{ type: "reveal", target: { label: "Open" } },
					{ type: "click", target: { label: "Open" } },
				],
				undefined,
			);
			const text = ran.result.content.find((content) => content.type === "text")?.text ?? "";
			expect(text).toMatch(/step 1 clicks element 9 .*outside its region .*nothing was sent/);
			expect(computer.effects).toEqual([]);
		} finally {
			await coordinator.close();
		}
	});

	it("#given a confined worker #when its click is dispatched #then the input layer sees its region in screen points", async () => {
		const { computer, coordinator } = setup();
		try {
			const token = await assignLeftPainter(coordinator);
			const seen: unknown[] = [];
			const click = computer.click.bind(computer);
			computer.click = async (...args: Parameters<typeof click>) => {
				seen.push(currentInputRegion());
				await click(...args);
			};
			await coordinator.run("left", token, [{ type: "click", x: 100, y: 100 }], undefined);
			// The 500x400 screenshot covers screen {x: 300, y: 150, width: 1000, height: 800}: twice the pixels.
			expect(seen).toEqual([{ x: 300, y: 150, width: 500, height: 800 }]);
		} finally {
			await coordinator.close();
		}
	});

	it("#given a list inside the worker's region #when a click searches below the fold #then it pages that list and clicks the row", async () => {
		const { computer, coordinator } = setup();
		computer.scrollList = {
			rows: Array.from({ length: 40 }, (_, index) => `row-${index}`),
			visibleRows: 5,
			virtualized: true,
		};
		try {
			// The fake list spans the window's left 300 px, so this worker's region holds all of it.
			const [lister] = await coordinator.assign([
				{ worker_id: "lister", task: "pick a row", app: "Finder", region: { x: 0, y: 0, width: 320, height: 400 } },
			]);
			if (lister?.observation_token === undefined) throw new Error("the lister needs an observation token");
			await coordinator.run(
				"lister",
				lister.observation_token,
				[{ type: "click", target: { text: "row-23" }, find: { vision: "off", max_pages: 10 } }],
				undefined,
			);
			expect(computer.effects.filter((effect) => effect.kind === "performAction")).toHaveLength(4);
			expect(computer.effects.filter((effect) => effect.kind === "click")).toHaveLength(1);
		} finally {
			await coordinator.close();
		}
	});

	it("#given a list outside the worker's region #when a click searches below the fold #then nothing is scrolled or clicked", async () => {
		const { computer, coordinator } = setup();
		computer.scrollList = {
			rows: Array.from({ length: 40 }, (_, index) => `row-${index}`),
			visibleRows: 5,
			virtualized: true,
		};
		try {
			const [right] = await coordinator.assign([
				{ worker_id: "right", task: "paint right", app: "Finder", region: RIGHT },
			]);
			if (right?.observation_token === undefined) throw new Error("the right worker needs an observation token");
			await expect(
				coordinator.run(
					"right",
					right.observation_token,
					[{ type: "click", target: { text: "row-23" }, find: { vision: "off", max_pages: 10 } }],
					undefined,
				),
			).rejects.toThrow(/searching would scroll the area at .*outside the worker's region/);
			expect(computer.effects).toEqual([]);
		} finally {
			await coordinator.close();
		}
	});

	it("#given keyboard-only steps #when run by a confined worker #then they are not checked against the region", async () => {
		const { coordinator } = setup();
		try {
			const token = await assignLeftPainter(coordinator);
			const ran = await coordinator.run("left", token, [{ type: "press_keys", keys: ["a"] }], undefined);
			expect(ran.result.isError).not.toBe(true);
		} finally {
			await coordinator.close();
		}
	});
});

describe("#given one shared surface #when whole-window and confined workers are mixed #then the assignment is refused", () => {
	it("#given a confined worker #when a whole-window worker joins in the same batch #then it is refused naming the confined one", async () => {
		const { coordinator } = setup();
		try {
			await expect(
				coordinator.assign([
					{ worker_id: "left", task: "paint left", app: "Finder", region: LEFT },
					{ worker_id: "roamer", task: "paint anywhere", app: "Finder" },
				]),
			).rejects.toThrow(/worker "roamer" gives no region, but worker "left" is confined/);
		} finally {
			await coordinator.close();
		}
	});

	it("#given a whole-window worker #when a confined worker joins later #then it is refused naming the whole-window one", async () => {
		const { coordinator } = setup();
		try {
			await coordinator.assign([{ worker_id: "roamer", task: "paint anywhere", app: "Finder" }]);
			await expect(
				coordinator.assign([{ worker_id: "left", task: "paint left", app: "Finder", region: LEFT }]),
			).rejects.toThrow(/worker "left" gives a region, but worker "roamer" already owns the whole window/);
		} finally {
			await coordinator.close();
		}
	});
});
