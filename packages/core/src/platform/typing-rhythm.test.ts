import { describe, expect, it } from "bun:test";
import { HUMAN_BASE_MILLISECONDS, humanBaseMilliseconds, humanCharacterDelay, typingRhythm } from "./typing-rhythm.js";

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

describe("#given the OPENCUA_TYPE_RHYTHM setting #when it is read #then only an exact human value selects the human rhythm", () => {
	it("selects constant when the setting is unset or unrecognized", () => {
		expect(typingRhythm({})).toBe("constant");
		expect(typingRhythm({ OPENCUA_TYPE_RHYTHM: "garbage" })).toBe("constant");
		expect(typingRhythm({ OPENCUA_TYPE_RHYTHM: "humanlike" })).toBe("constant");
	});

	it("selects human for human, ignoring surrounding space and letter case", () => {
		expect(typingRhythm({ OPENCUA_TYPE_RHYTHM: "human" })).toBe("human");
		expect(typingRhythm({ OPENCUA_TYPE_RHYTHM: " HUMAN " })).toBe("human");
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

describe("#given the default 4 ms pacing #when the human base is chosen #then a typist's interval is used and slower pacing is kept", () => {
	it("raises fast pacing to the typist base and keeps slower pacing", () => {
		expect(humanBaseMilliseconds(4)).toBe(HUMAN_BASE_MILLISECONDS);
		expect(humanBaseMilliseconds(0)).toBe(HUMAN_BASE_MILLISECONDS);
		expect(humanBaseMilliseconds(90)).toBe(90);
	});

	it("separates a word-boundary pause from a mid-word keystroke at the default pacing", () => {
		const base = humanBaseMilliseconds(4);
		expect(humanCharacterDelay(" ", "n", base, () => 0.5)).toBeGreaterThan(
			humanCharacterDelay("e", "n", base, () => 0.5),
		);
	});
});

describe("#given the typist base above the configured pacing #when fast transitions are drawn #then they run below the base but never below the pacing", () => {
	it("lets a repeated key and a same-hand pair run faster than the base while staying at or above the floor", () => {
		const base = humanBaseMilliseconds(4);
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
