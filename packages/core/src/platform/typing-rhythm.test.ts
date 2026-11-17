import { describe, expect, it } from "bun:test";
import {
	HUMAN_BASE_MILLISECONDS,
	HUMAN_TEXT_BUDGET_MILLISECONDS,
	humanBaseForText,
	humanCharacterDelay,
	typingRhythm,
} from "./typing-rhythm.js";

function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const SAMPLE_TEXT = "Hello, world!\nThe quick brown fox -- jumps; over 12 lazy dogs.";

function delaysFor(text: string, base: number, random: () => number): number[] {
	const characters = Array.from(text);
	return characters.map((character, index) => humanCharacterDelay(characters[index - 1], character, base, random));
}

describe("#given the OPENCUA_TYPE_RHYTHM setting #when it is read #then text is typed like a person unless constant is asked for", () => {
	it("selects human when the setting is unset or anything but constant", () => {
		expect(typingRhythm({})).toBe("human");
		expect(typingRhythm({ OPENCUA_TYPE_RHYTHM: "garbage" })).toBe("human");
		expect(typingRhythm({ OPENCUA_TYPE_RHYTHM: "human" })).toBe("human");
	});

	it("selects constant for constant, ignoring surrounding space and letter case", () => {
		expect(typingRhythm({ OPENCUA_TYPE_RHYTHM: "constant" })).toBe("constant");
		expect(typingRhythm({ OPENCUA_TYPE_RHYTHM: " CONSTANT " })).toBe("constant");
	});
});

describe("#given the same seed #when the human delay sequence is drawn twice #then both sequences are identical", () => {
	it("produces identical delays for identical seeded randomness", () => {
		const first = delaysFor(SAMPLE_TEXT, 20, seededRandom(7));
		const second = delaysFor(SAMPLE_TEXT, 20, seededRandom(7));
		expect(first).toEqual(second);
	});
});

describe("#given a word boundary and a mid-word pair #when both draw the same random value #then the boundary pause is longer", () => {
	it("pauses longer after a space than between two letters of a word", () => {
		const midWord = humanCharacterDelay("e", "n", 20, () => 0.5);
		const wordBoundary = humanCharacterDelay(" ", "n", 20, () => 0.5);
		expect(wordBoundary).toBeGreaterThan(midWord);
	});

	it("pauses longest before a newline", () => {
		const newline = humanCharacterDelay("e", "\n", 20, () => 0.5);
		const wordBoundary = humanCharacterDelay(" ", "n", 20, () => 0.5);
		expect(newline).toBeGreaterThan(wordBoundary);
	});
});

describe("#given any previous character, next character, base and random value #when the human delay is computed #then it stays within the base and the 300 ms ceiling", () => {
	it("keeps every delay between the base and 300 milliseconds", () => {
		const extremes = [() => 0, () => 0.999999, seededRandom(42)];
		for (const base of [1, 4, 20, 60]) {
			for (const random of extremes) {
				for (const delay of delaysFor(SAMPLE_TEXT, base, random)) {
					expect(delay).toBeGreaterThanOrEqual(base);
					expect(delay).toBeLessThanOrEqual(300);
					expect(Number.isInteger(delay)).toBe(true);
				}
			}
		}
	});
});

describe("#given a text length #when the human base is chosen #then short text gets a typist's pace and long text fits the budget", () => {
	it("types a short entry at the typist base and keeps slower configured pacing", () => {
		expect(humanBaseForText(20, 4)).toBe(HUMAN_BASE_MILLISECONDS);
		expect(humanBaseForText(1, 0)).toBe(HUMAN_BASE_MILLISECONDS);
		expect(humanBaseForText(20, 90)).toBe(90);
	});

	it("speeds up long text so its nominal total stays within the budget, never under the pacing guard", () => {
		// Above the pacing guard; at a few thousand characters the guard is the floor (checked below).
		for (const length of [100, 400, 1_000]) {
			const base = humanBaseForText(length, 4);
			expect(base).toBeLessThan(HUMAN_BASE_MILLISECONDS);
			expect(base * length * 1.3).toBeLessThanOrEqual(HUMAN_TEXT_BUDGET_MILLISECONDS);
		}
		expect(humanBaseForText(100_000, 4)).toBe(4);
	});

	it("separates a word-boundary pause from a mid-word keystroke at the default pacing", () => {
		const base = humanBaseForText(20, 4);
		expect(humanCharacterDelay(" ", "n", base, () => 0.5)).toBeGreaterThan(
			humanCharacterDelay("e", "n", base, () => 0.5),
		);
	});
});

describe("#given the typist base above the configured pacing #when fast transitions are drawn #then they run below the base but never below the pacing", () => {
	it("lets a repeated key and a same-hand pair run faster than the base while staying at or above the floor", () => {
		const base = humanBaseForText(20, 4);
		const repeat = humanCharacterDelay("e", "e", base, () => 0.5, 4);
		const sameHand = humanCharacterDelay("a", "s", base, () => 0.5, 4);
		const crossHand = humanCharacterDelay("a", "k", base, () => 0.5, 4);
		expect(repeat).toBeLessThan(base);
		expect(sameHand).toBeLessThan(crossHand);
		expect(humanCharacterDelay("e", "e", base, () => 0, 50)).toBe(50);
	});
});

describe("#given a base interval of zero #when the human delay is computed #then it is zero for every transition", () => {
	it("returns zero so back-to-back posting is kept", () => {
		expect(humanCharacterDelay("e", "n", 0, () => 0.5)).toBe(0);
		expect(humanCharacterDelay(" ", "\n", 0, seededRandom(1))).toBe(0);
	});
});
