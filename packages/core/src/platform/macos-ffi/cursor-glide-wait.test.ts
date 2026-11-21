import { describe, expect, it } from "bun:test";
import { GLIDE_WAIT_CAP_MILLISECONDS, glideWaitMilliseconds } from "./cursor-overlay.js";

const MOTION = { style: "adaptive" } as const;

describe("glideWaitMilliseconds #given the planned cursor motion #when an action waits for the cursor", () => {
	it("#when the cursor is already there #then nothing waits", () => {
		expect(glideWaitMilliseconds(MOTION, { x: 10, y: 10 }, { x: 11, y: 10 })).toBe(0);
	});

	it("#when the cursor travels #then it waits longer for a longer move, never past the cap", () => {
		const near = glideWaitMilliseconds(MOTION, { x: 0, y: 0 }, { x: 80, y: 0 });
		const far = glideWaitMilliseconds(MOTION, { x: 0, y: 0 }, { x: 2_000, y: 900 });
		expect(near).toBeGreaterThan(0);
		expect(far).toBeGreaterThan(near);
		expect(far).toBeLessThanOrEqual(GLIDE_WAIT_CAP_MILLISECONDS);
	});
});
