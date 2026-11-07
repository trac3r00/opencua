import type { Point } from "../types/index.js";
import { dragProfile, lognormalProgress, smoothstepProgress } from "./drag-profile.js";

const DEFAULT_DRAG_FRAME_MILLISECONDS = 16;
/** Matches the public drag contract; bounds both held-button time and event count. */
const MAX_DRAG_DURATION_MILLISECONDS = 30_000;

/** Distance-based travel time in milliseconds, bounded so large displays do not create long gestures. */
export function pointerTravelDuration(from: Point, to: Point): number {
	const distance = Math.hypot(to.x - from.x, to.y - from.y);
	return distance === 0 ? 0 : Math.min(600, Math.max(120, distance * 0.6));
}

export function dragSteps(duration: number): number {
	if (!Number.isFinite(duration) || duration < 0 || duration > MAX_DRAG_DURATION_MILLISECONDS) {
		throw new RangeError(`drag duration must be finite and between 0 and ${MAX_DRAG_DURATION_MILLISECONDS} ms`);
	}
	if (duration <= 0) {
		return 1;
	}
	return Math.max(1, Math.ceil(duration / DEFAULT_DRAG_FRAME_MILLISECONDS));
}

function interpolatePoint(from: Point, to: Point, progress: number): Point {
	return {
		x: Math.round(from.x + (to.x - from.x) * progress),
		y: Math.round(from.y + (to.y - from.y) * progress),
	};
}

/**
 * Velocity profile of a hand: still at the start, fastest in the middle, still again at the end.
 * Smoothstep, so the pointer accelerates out of the press instead of leaving at full speed and
 * stopping dead on arrival — which is what reads as "robotic" to a human watching the cursor.
 */
export function easedProgress(progress: number): number {
	return smoothstepProgress(progress);
}

/** {@link interpolatePoint} along the eased profile, for pointer moves. */
export function interpolatePointEased(from: Point, to: Point, progress: number): Point {
	return interpolatePoint(from, to, smoothstepProgress(progress));
}

/** {@link interpolatePoint} for a held-button drag or swipe: OPENCUA_DRAG_PROFILE=lognormal, otherwise the eased profile. */
export function interpolatePointDrag(from: Point, to: Point, progress: number): Point {
	const profile = dragProfile() === "lognormal" ? lognormalProgress : smoothstepProgress;
	return interpolatePoint(from, to, profile(progress));
}

/** Exact wheel displacement with eased ends; large scrolls trade smaller deltas for a bounded event rate. */
export function scrollEventPlan(units: number): number[] {
	if (!Number.isFinite(units)) {
		throw new RangeError("scroll units must be finite");
	}
	if (Math.abs(units) <= 4) {
		return [units];
	}
	const magnitude = Math.abs(units);
	const steps = Math.min(40, Math.ceil(magnitude / 8));
	const deltas: number[] = [];
	let delivered = 0;
	for (let step = 1; step <= steps; step += 1) {
		const cumulative =
			step === steps
				? units
				: Math.sign(units) * Math.min(magnitude, Math.round(magnitude * easedProgress(step / steps)));
		deltas.push(cumulative - delivered);
		delivered = cumulative;
	}
	return deltas;
}
