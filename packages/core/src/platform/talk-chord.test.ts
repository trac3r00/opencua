import { describe, expect, it } from "bun:test";
import { StopChordDetector, TALK_CHORD_FORBIDDEN_MASK, TALK_CHORD_MASK } from "./stop-chord.js";

const CONTROL = 0x00040000;
const ALTERNATE = 0x00080000;
const COMMAND = 0x00100000;
const SHIFT = 0x00020000;
const TALK = CONTROL | ALTERNATE;

function talkDetector(sequence: readonly number[]) {
	let index = 0;
	const events: string[] = [];
	const detector = new StopChordDetector({
		readFlags: () => sequence[index++] ?? 0,
		mask: TALK_CHORD_MASK,
		forbiddenMask: TALK_CHORD_FORBIDDEN_MASK,
		onChord: () => events.push("press"),
		onRelease: () => events.push("release"),
	});
	for (let sample = 0; sample < sequence.length; sample += 1) detector.sample();
	return events;
}

describe("talk chord #given Control+Option push-to-talk readings", () => {
	it("#when held for 3 samples then let go #then it presses once and releases once", () => {
		expect(talkDetector([TALK, TALK, TALK, TALK, TALK, 0, 0])).toEqual(["press", "release"]);
	});

	it("#when Command or Shift is held too #then it never fires, so the stop chord and shortcuts stay distinct", () => {
		expect(talkDetector([TALK | COMMAND, TALK | COMMAND, TALK | COMMAND, 0])).toEqual([]);
		expect(talkDetector([TALK | SHIFT, TALK | SHIFT, TALK | SHIFT, 0])).toEqual([]);
	});

	it("#when a tap is shorter than the hold threshold #then it neither presses nor releases", () => {
		expect(talkDetector([TALK, TALK, 0, TALK, 0])).toEqual([]);
	});

	it("#when pressed twice #then each press gets its own release", () => {
		expect(talkDetector([TALK, TALK, TALK, 0, TALK, TALK, TALK, 0])).toEqual([
			"press",
			"release",
			"press",
			"release",
		]);
	});
});

describe("talk chord early start #given the press is sampled", () => {
	function events(sequence: readonly number[]): string[] {
		const seen: string[] = [];
		let index = 0;
		const detector = new StopChordDetector({
			readFlags: () => sequence[index++] ?? 0,
			mask: TALK_CHORD_MASK,
			requiredSamples: 3,
			onEngage: () => seen.push("engage"),
			onAbandon: () => seen.push("abandon"),
			onChord: () => seen.push("chord"),
			onRelease: () => seen.push("release"),
		});
		for (let sample = 0; sample < sequence.length; sample += 1) detector.sample();
		return seen;
	}
	it("#when the keys go down #then work starts on the first sample, before the press is confirmed", () => {
		expect(events([TALK, TALK, TALK, TALK, 0])).toEqual(["engage", "chord", "release"]);
	});

	it("#when they are let go before the press is confirmed #then the early start is abandoned, never released", () => {
		expect(events([TALK, TALK, 0, TALK, 0, 0])).toEqual(["engage", "abandon", "engage", "abandon"]);
	});

	it("#when nothing is held #then nothing fires", () => {
		expect(events([0, 0, 0])).toEqual([]);
	});
});
