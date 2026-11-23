import { describe, expect, it } from "bun:test";

import { ForegroundKeeper, LAUNCH_WATCH_MILLISECONDS } from "./foreground-keeper.js";

const PERSON = 100;
const CHROME = 200;
const OTHER = 300;

function harness(): {
	readonly keeper: ForegroundKeeper;
	readonly state: {
		front: number;
		now: number;
		mouseDownSeconds: number;
		command: boolean;
		pointerPid: number | undefined;
	};
	readonly restored: number[];
} {
	const state: {
		front: number;
		now: number;
		mouseDownSeconds: number;
		command: boolean;
		pointerPid: number | undefined;
	} = { front: PERSON, now: 1_000, mouseDownSeconds: 60, command: false, pointerPid: undefined };
	const restored: number[] = [];
	const keeper = new ForegroundKeeper(
		{
			frontmostPid: () => state.front,
			secondsSinceMouseDown: () => state.mouseDownSeconds,
			commandHeld: () => state.command,
			pidUnderPointer: () => state.pointerPid,
			restore: async (pid) => {
				restored.push(pid);
				state.front = pid;
				return true;
			},
			now: () => state.now,
		},
		{ watchMs: 8_000, poll: false },
	);
	return { keeper, state, restored };
}

/** Time passes with the keeper polling, as its timer would, while the person's app stays in front. */
async function idle(keeper: ForegroundKeeper, state: { now: number }, milliseconds: number, step = 50): Promise<void> {
	for (let elapsed = 0; elapsed < milliseconds; elapsed += step) {
		state.now += step;
		await keeper.check();
	}
}

describe("#given input sent to a background app #when that app takes the front #then the person's app is restored", () => {
	it("restores the app that was in front before the input", async () => {
		const { keeper, state, restored } = harness();
		keeper.noteTouched(CHROME);
		await idle(keeper, state, 2_000);
		state.front = CHROME;

		const result = await keeper.check();

		expect(result).toEqual({ thief: CHROME, restored: PERSON, ok: true });
		expect(restored).toEqual([PERSON]);
	});

	it("keeps the person's app across several inputs to the thief", async () => {
		const { keeper, state, restored } = harness();
		keeper.noteTouched(CHROME);
		state.front = CHROME;
		state.now += 50;
		keeper.noteTouched(CHROME);
		state.now += 50;

		await keeper.check();

		expect(restored).toEqual([PERSON]);
	});

	it("#when the person kept typing in their own app meanwhile #then it is still restored", async () => {
		const { keeper, state, restored } = harness();
		keeper.noteTouched(CHROME);
		await idle(keeper, state, 3_000);
		state.front = CHROME;

		await keeper.check();

		expect(restored).toEqual([PERSON]);
	});

	it("#when the person clicked inside their own app seconds before the steal #then it is still restored", async () => {
		const { keeper, state, restored } = harness();
		keeper.noteTouched(CHROME);
		await idle(keeper, state, 3_000);
		state.mouseDownSeconds = 2;
		state.front = CHROME;

		await keeper.check();

		expect(restored).toEqual([PERSON]);
	});

	it("#when the person clicked inside their own app just as the touched app stole the front #then it is still restored", async () => {
		const { keeper, state, restored } = harness();
		keeper.noteTouched(CHROME);
		await idle(keeper, state, 3_000);
		state.now += 50;
		state.mouseDownSeconds = 0.08;
		state.pointerPid = PERSON;
		state.front = CHROME;

		const result = await keeper.check();

		expect(result).toEqual({ thief: CHROME, restored: PERSON, ok: true });
		expect(restored).toEqual([PERSON]);
	});

	it("#when a launched app takes the front 20 s later #then the launch watch still restores", async () => {
		const { keeper, state, restored } = harness();
		keeper.noteTouched(CHROME, PERSON, LAUNCH_WATCH_MILLISECONDS);
		await idle(keeper, state, 20_000, 250);
		state.front = CHROME;

		await keeper.check();

		expect(restored).toEqual([PERSON]);
	});
});

describe("#given the person switched apps themselves #when the touched app is in front #then nothing is restored", () => {
	it("treats a mouse press just before the switch as the person's click on it", async () => {
		const { keeper, state, restored } = harness();
		keeper.noteTouched(CHROME);
		await idle(keeper, state, 3_000);
		state.now += 50;
		state.mouseDownSeconds = 0.08;
		state.pointerPid = CHROME;
		state.front = CHROME;

		expect(await keeper.check()).toBeUndefined();
		expect(restored).toEqual([]);
	});

	it("treats Command seen just before the switch as Command-Tab", async () => {
		const { keeper, state, restored } = harness();
		keeper.noteTouched(CHROME);
		await idle(keeper, state, 3_000);
		state.command = true;
		await keeper.check();
		state.command = false;
		state.now += 50;
		state.front = CHROME;

		expect(await keeper.check()).toBeUndefined();
		expect(restored).toEqual([]);
	});

	it("leaves a third app the person brought forward alone", async () => {
		const { keeper, state, restored } = harness();
		keeper.noteTouched(CHROME);
		state.now += 500;
		state.front = OTHER;

		expect(await keeper.check()).toBeUndefined();
		expect(restored).toEqual([]);
	});

	it("stops watching after the watch window", async () => {
		const { keeper, state, restored } = harness();
		keeper.noteTouched(CHROME);
		state.now += 9_000;
		state.front = CHROME;

		expect(await keeper.check()).toBeUndefined();
		expect(restored).toEqual([]);
	});

	it("uses the app in front before a launch the launched app already replaced", async () => {
		const { keeper, state, restored } = harness();
		state.front = CHROME;
		keeper.noteTouched(CHROME, PERSON);
		state.now += 500;

		await keeper.check();

		expect(restored).toEqual([PERSON]);
	});

	it("never restores when the touched app was already in front", async () => {
		const { keeper, state, restored } = harness();
		state.front = CHROME;
		keeper.noteTouched(CHROME);
		state.now += 1_000;

		expect(await keeper.check()).toBeUndefined();
		expect(restored).toEqual([]);
	});
});
