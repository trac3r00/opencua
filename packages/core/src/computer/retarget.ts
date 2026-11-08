import type { Point } from "../types/index.js";

export interface MotionSample {
	readonly t: number;
	readonly x: number;
	readonly y: number;
	readonly heading: number;
}

/**
 * Bends the rest of a planned move onto a target that moved while the cursor was flying: samples at
 * or before `from` stay as played; later ones get the target's offset blended in by smoothstep, so
 * the cursor keeps its velocity at the junction (the blend starts with zero slope) and lands exactly
 * on the new target. Headings follow the bent path.
 */
export function retargetSamples(samples: readonly MotionSample[], from: number, target: Point): MotionSample[] {
	const last = samples.at(-1);
	if (last === undefined) return [];
	const dx = target.x - last.x;
	const dy = target.y - last.y;
	if (dx === 0 && dy === 0) return [...samples];
	const span = last.t - from;
	const bent = samples.map((sample) => {
		if (sample.t <= from || span <= 0) return sample;
		const u = Math.min(1, (sample.t - from) / span);
		const weight = u * u * (3 - 2 * u);
		return { ...sample, x: sample.x + dx * weight, y: sample.y + dy * weight };
	});
	return bent.map((sample, index) => {
		if (sample.t <= from) return sample;
		const previous = bent[index - 1];
		if (previous === undefined || (previous.x === sample.x && previous.y === sample.y)) return sample;
		return { ...sample, heading: Math.atan2(sample.y - previous.y, sample.x - previous.x) };
	});
}

/** How long before arrival the target is looked at again: late enough to see it settle, early enough to steer. */
export const RETARGET_LOOK_AHEAD_SECONDS = 0.08;

/**
 * The closed-loop check of one move: at RETARGET_LOOK_AHEAD_SECONDS before arrival, `locate` reads the
 * target again (AX frame or a fresh frame); a shift of at least `threshold` points bends the remaining
 * samples onto it. Returns the samples to keep playing, or undefined when the target held still or vanished.
 */
export function closedLoopCorrection(
	samples: readonly MotionSample[],
	planned: Point,
	located: Point | undefined,
	threshold = 1,
): { readonly from: number; readonly samples: MotionSample[] } | undefined {
	const last = samples.at(-1);
	if (last === undefined || located === undefined) return undefined;
	if (Math.hypot(located.x - planned.x, located.y - planned.y) < threshold) return undefined;
	const from = Math.max(samples[0]?.t ?? 0, last.t - RETARGET_LOOK_AHEAD_SECONDS);
	return { from, samples: retargetSamples(samples, from, located) };
}
