export type TypingRhythm = "constant" | "human";

/**
 * Text is typed the way a person types unless OPENCUA_TYPE_RHYTHM=constant (trimmed, case-insensitive) asks for the
 * fixed dropped-keystroke guard alone.
 */
export function typingRhythm(environment: NodeJS.ProcessEnv = process.env): TypingRhythm {
	const value = environment["OPENCUA_TYPE_RHYTHM"]?.trim().toLowerCase();
	return value === "constant" ? "constant" : "human";
}

/**
 * About how long one human-paced text may take. A short entry is typed at a typist's pace; a long one speeds up so a
 * paragraph still lands within a script's time budget instead of taking a minute.
 */
export const HUMAN_TEXT_BUDGET_MILLISECONDS = 6_000;
/** Average transition factor (word boundaries, same-hand runs), so the budget covers the whole text. */
const AVERAGE_TRANSITION_FACTOR = 1.3;

/** The human base interval for a text of `length` characters: a typist's pace, faster for long text, never under the guard. */
export function humanBaseForText(length: number, pacing: number): number {
	const budgeted = Math.floor(HUMAN_TEXT_BUDGET_MILLISECONDS / (Math.max(1, length) * AVERAGE_TRANSITION_FACTOR));
	return Math.max(pacing, Math.min(HUMAN_BASE_MILLISECONDS, budgeted));
}

const HUMAN_INTERVAL_CEILING_MILLISECONDS = 300;

/**
 * A typist's base keystroke interval (about 200 words a minute before the transition factors and jitter). The constant
 * 4 ms default is a dropped-keystroke guard, not a rhythm: under it every factor except newline is clamped away.
 */
export const HUMAN_BASE_MILLISECONDS = 60;

const JITTER_LOW = 0.75;
const JITTER_SPAN = 0.5;

const NEWLINE_FACTOR = 4;
const WORD_BOUNDARY_FACTOR = 2.5;
const REPEAT_FACTOR = 0.7;
const SAME_HAND_FACTOR = 0.85;
const CROSS_HAND_FACTOR = 1;

const LEFT_HAND_KEYS = "qwertasdfgzxcvb12345";
const RIGHT_HAND_KEYS = "yuiophjklnm67890";
const WORD_BOUNDARY = /^[\s\p{P}]$/u;

function handOf(character: string): "left" | "right" | undefined {
	const key = character.toLowerCase();
	if (LEFT_HAND_KEYS.includes(key)) {
		return "left";
	}
	if (RIGHT_HAND_KEYS.includes(key)) {
		return "right";
	}
	return undefined;
}

function transitionFactor(previous: string | undefined, next: string): number {
	if (next === "\n") {
		return NEWLINE_FACTOR;
	}
	if (previous === undefined) {
		return CROSS_HAND_FACTOR;
	}
	if (WORD_BOUNDARY.test(previous)) {
		return WORD_BOUNDARY_FACTOR;
	}
	if (previous === next) {
		return REPEAT_FACTOR;
	}
	const hand = handOf(previous);
	if (hand !== undefined && hand === handOf(next)) {
		return SAME_HAND_FACTOR;
	}
	return CROSS_HAND_FACTOR;
}

/**
 * Human inter-character delay in whole milliseconds: the base scaled by the transition from the previous character to
 * the next (newline 4x, pause after a space or punctuation 2.5x, repeated key 0.7x, same hand 0.85x, otherwise 1x),
 * then by jitter in [0.75, 1.25) from random(). The result is never below `floor` (the configured pacing, which keeps
 * the keystroke-drop protection of the constant delay), so repeats and same-hand pairs can run faster than the base,
 * and never above 300 ms unless the floor is larger. A base of 0 stays 0.
 */
export function humanCharacterDelay(
	previous: string | undefined,
	next: string,
	base: number,
	random: () => number,
	floor: number = base,
): number {
	if (base === 0) {
		return 0;
	}
	const jitter = JITTER_LOW + JITTER_SPAN * random();
	const nominal = base * transitionFactor(previous, next) * jitter;
	return Math.max(floor, Math.round(Math.min(HUMAN_INTERVAL_CEILING_MILLISECONDS, nominal)));
}
