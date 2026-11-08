import { describe, expect, it } from "bun:test";
import { type MotionSample, RETARGET_LOOK_AHEAD_SECONDS, closedLoopCorrection, retargetSamples } from "./retarget.js";

const SEED = Number(process.env["RETARGET_SEED"] ?? 20261107);

function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

function curve(next: () => number, count: number): MotionSample[] {
	const [x0, y0, x1, y1] = [next() * 800, next() * 600, next() * 800, next() * 600];
	const bow = (next() - 0.5) * 200;
	return Array.from({ length: count }, (_, index) => {
		const u = index / (count - 1);
		const ease = u * u * (3 - 2 * u);
		return {
			t: u * 0.4,
			x: x0 + (x1 - x0) * ease + bow * Math.sin(Math.PI * u),
			y: y0 + (y1 - y0) * ease,
			heading: 0,
		};
	});
}

describe("#given planned moves whose target shifts mid-flight #when the rest is bent #then the cursor lands on the new target without a jolt", () => {
	it("holds on 300 generated moves (seed SEED)", () => {
		const next = random(SEED);
		const failures: string[] = [];
		for (let index = 0; index < 300; index += 1) {
			const samples = curve(next, 20 + Math.floor(next() * 60));
			const last = samples.at(-1);
			if (last === undefined) continue;
			const from = last.t * (0.3 + next() * 0.6);
			const target = { x: last.x + (next() - 0.5) * 60, y: last.y + (next() - 0.5) * 60 };
			const bent = retargetSamples(samples, from, target);
			const end = bent.at(-1);
			const played = samples.filter((sample) => sample.t <= from);
			const offset = Math.hypot(target.x - last.x, target.y - last.y);
			const firstMoved = bent.findIndex((sample) => sample.t > from);
			const before = samples[firstMoved];
			const after = bent[firstMoved];
			const step = before && after ? Math.hypot(after.x - before.x, after.y - before.y) : 0;
			const stepSpan = before ? (before.t - from) / (last.t - from) : 1;
			const problems = [
				end?.x === target.x && end?.y === target.y ? "" : "misses target",
				JSON.stringify(bent.slice(0, played.length)) === JSON.stringify(played) ? "" : "rewrote played samples",
				bent.every(
					(sample, at) =>
						Math.hypot(sample.x - (samples[at]?.x ?? 0), sample.y - (samples[at]?.y ?? 0)) <= offset + 1e-9,
				)
					? ""
					: "overshoots the offset",
				step <= offset * 3 * stepSpan * stepSpan + 1e-9 ? "" : "jolts at the junction",
			].filter(Boolean);
			if (problems.length > 0) failures.push(`move ${index}: ${problems.join(", ")}`);
		}
		expect(failures).toEqual([]);
	});

	it("leaves a move alone when the target held still or vanished, and corrects one that moved", () => {
		const samples = curve(random(SEED + 1), 30);
		const last = samples.at(-1);
		if (last === undefined) throw new Error("empty curve");
		expect(retargetSamples(samples, 0.1, { x: last.x, y: last.y })).toEqual(samples);
		expect(closedLoopCorrection(samples, last, { x: last.x + 0.5, y: last.y })).toBeUndefined();
		expect(closedLoopCorrection(samples, last, undefined)).toBeUndefined();
		const corrected = closedLoopCorrection(samples, last, { x: last.x + 12, y: last.y - 5 });
		expect(corrected?.from).toBeCloseTo(last.t - RETARGET_LOOK_AHEAD_SECONDS, 9);
		expect(corrected?.samples.at(-1)).toMatchObject({ x: last.x + 12, y: last.y - 5 });
		expect(retargetSamples([], 0, { x: 1, y: 1 })).toEqual([]);
	});
});
