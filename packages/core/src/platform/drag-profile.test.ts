import { describe, expect, it } from "bun:test";
import { dragProfile, lognormalProgress, smoothstepProgress } from "./drag-profile.js";
import { interpolatePointDrag, interpolatePointEased } from "./macos-input-drag.js";

const SAMPLE_COUNT = 1000;
const SAMPLES = Array.from({ length: SAMPLE_COUNT }, (_value, index) => index / (SAMPLE_COUNT - 1));

function velocityPeakIndex(progress: readonly number[]): number {
	let peak = 0;
	let peakVelocity = Number.NEGATIVE_INFINITY;
	for (let index = 0; index + 1 < progress.length; index += 1) {
		const velocity = Math.abs((progress[index + 1] ?? 0) - (progress[index] ?? 0));
		if (velocity > peakVelocity) {
			peakVelocity = velocity;
			peak = index;
		}
	}
	return peak;
}

describe("#given the lognormal drag profile #when it is sampled at its ends #then it is exactly 0 and 1", () => {
	it("#when t is 0 and 1 #then progress is exactly 0 and 1", () => {
		expect(lognormalProgress(0)).toBe(0);
		expect(lognormalProgress(1)).toBe(1);
	});

	it("#when t is outside [0, 1] #then it is clamped to the endpoints", () => {
		expect(lognormalProgress(-5)).toBe(0);
		expect(lognormalProgress(5)).toBe(1);
	});
});

describe("#given the lognormal drag profile #when sampled at 1000 points #then it never travels backwards", () => {
	it("#when consecutive samples are compared #then progress is monotonic non-decreasing", () => {
		const values = SAMPLES.map((t) => lognormalProgress(t));
		for (let index = 1; index < values.length; index += 1) {
			expect(values[index] ?? 0).toBeGreaterThanOrEqual(values[index - 1] ?? 0);
		}
	});
});

describe("#given the lognormal drag profile #when its velocity is sampled at 1000 points #then the peak lands in the first half", () => {
	it("#when the largest per-sample step is located #then its index is below 500", () => {
		const values = SAMPLES.map((t) => lognormalProgress(t));
		expect(velocityPeakIndex(values)).toBeLessThan(500);
	});
});

describe("#given the smoothstep drag profile #when sampled #then it equals the original formula exactly", () => {
	const legacy = (t: number): number => {
		const clamped = Math.min(1, Math.max(0, t));
		return clamped * clamped * (3 - 2 * clamped);
	};

	it.each([0, 0.1, 0.25, 0.5, 0.75, 0.9, 1])(
		"#when t is %s #then smoothstepProgress matches the legacy formula",
		(t) => {
			expect(smoothstepProgress(t)).toBe(legacy(t));
		},
	);
});

describe("#given the OPENCUA_DRAG_PROFILE environment value #when it is parsed #then only exact lognormal opts in", () => {
	it("#when the variable is unset #then the profile is smoothstep", () => {
		expect(dragProfile({})).toBe("smoothstep");
	});

	it("#when the value is lognormal with surrounding space and mixed case #then the profile is lognormal", () => {
		expect(dragProfile({ OPENCUA_DRAG_PROFILE: "  LogNormal " })).toBe("lognormal");
	});

	it("#when the value is smoothstep or an unknown name #then the profile is smoothstep", () => {
		expect(dragProfile({ OPENCUA_DRAG_PROFILE: "smoothstep" })).toBe("smoothstep");
		expect(dragProfile({ OPENCUA_DRAG_PROFILE: "gaussian" })).toBe("smoothstep");
	});
});

describe("#given OPENCUA_DRAG_PROFILE=lognormal #when a drag point is interpolated #then the lognormal curve is used", () => {
	it("#when the process environment selects lognormal #then the midpoint follows lognormalProgress", () => {
		const key = "OPENCUA_DRAG_PROFILE";
		const previous = process.env[key];
		process.env[key] = "lognormal";
		try {
			const point = interpolatePointDrag({ x: 0, y: 0 }, { x: 1000, y: 0 }, 0.25);
			expect(point.x).toBe(Math.round(1000 * lognormalProgress(0.25)));
			// A plain pointer move keeps the eased profile: only held-button drags and swipes change.
			const move = interpolatePointEased({ x: 0, y: 0 }, { x: 1000, y: 0 }, 0.25);
			expect(move.x).toBe(Math.round(1000 * smoothstepProgress(0.25)));
		} finally {
			if (previous === undefined) {
				Reflect.deleteProperty(process.env, key);
			} else {
				process.env[key] = previous;
			}
		}
	});
});
