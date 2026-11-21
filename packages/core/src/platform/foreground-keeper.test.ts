import { describe, expect, it } from "bun:test";

import { ForegroundKeeper } from "./foreground-keeper.js";

const PERSON = 100;
const CHROME = 200;

function harness(): {
	readonly keeper: ForegroundKeeper;
	readonly state: { front: number; now: number; idleSeconds: number };
	readonly restored: number[];
} {
	const state = { front: PERSON, now: 1_000, idleSeconds: 60 };
	const restored: number[] = [];
	const keeper = new ForegroundKeeper(
		{
			frontmostPid: () => state.front,
			secondsSinceHumanInput: () => state.idleSeconds,
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

describe("#given input sent to a background app #when that app takes the front #then the person's app is restored", () => {
	it("restores the app that was in front before the input", async () => {
		const { keeper, state, restored } = harness();
		keeper.noteTouched(CHROME);
		state.now += 2_000;
		state.front = CHROME;

		const result = await keeper.check();

		expect(result).toEqual({ thief: CHROME, restored: PERSON, ok: true });
		expect(restored).toEqual([PERSON]);
	});

	it("keeps the person's app across several inputs to the thief", async () => {
		const { keeper, state, restored } = harness();
		keeper.noteTouched(CHROME);
		state.front = CHROME;
		state.now += 500;
		keeper.noteTouched(CHROME);
		state.now += 500;

		await keeper.check();

		expect(restored).toEqual([PERSON]);
	});
});

describe("#given the person used the keyboard or mouse #when the app is in front #then nothing is restored", () => {
	it("treats a real input event after the action as the person's own switch", async () => {
		const { keeper, state, restored } = harness();
		keeper.noteTouched(CHROME);
		state.now += 3_000;
		state.idleSeconds = 1;
		state.front = CHROME;

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
