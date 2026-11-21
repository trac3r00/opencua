import { describe, expect, it } from "bun:test";

import { settleWebFocus } from "./web-focus-settle.js";

function clock(): {
	readonly now: () => number;
	readonly sleep: (milliseconds: number) => Promise<void>;
	slept: number[];
} {
	let time = 0;
	const slept: number[] = [];
	return {
		slept,
		now: () => time,
		sleep: async (milliseconds) => {
			slept.push(milliseconds);
			time += milliseconds;
		},
	};
}

describe("#given a page focus change the browser applies late #when a click waits for it #then it waits only until focus lands", () => {
	it("returns as soon as focus is inside the page", async () => {
		const fake = clock();
		const answers = [false, false, true];
		const landed = await settleWebFocus(() => answers.shift() ?? true, { limitMs: 400, pollMs: 15, ...fake });

		expect(landed).toBe(true);
		expect(fake.slept).toEqual([15, 15]);
	});

	it("does not wait when focus is already there", async () => {
		const fake = clock();

		expect(await settleWebFocus(() => true, { limitMs: 400, pollMs: 15, ...fake })).toBe(true);
		expect(fake.slept).toEqual([]);
	});

	it("gives up at the limit so a page that never takes focus cannot stall the click", async () => {
		const fake = clock();

		expect(await settleWebFocus(() => false, { limitMs: 400, pollMs: 15, ...fake })).toBe(false);
		expect(fake.slept.reduce((sum, milliseconds) => sum + milliseconds, 0)).toBeGreaterThanOrEqual(400);
		expect(fake.slept.length).toBe(Math.ceil(400 / 15));
	});
});
