import { describe, expect, it } from "bun:test";
import { parseCursorMotion } from "./cursor-motion-config.js";
import { RETARGET_RADIUS, planCursorMotion } from "./cursor-motion.js";

const motion = parseCursorMotion({ style: "classic" });
const shown = { x: 100, y: 100, shown: true, reducedMotion: false };

function arrival(command: string): number {
	const packet: unknown = JSON.parse(command.slice("trajectory ".length));
	if (typeof packet !== "object" || packet === null || !("arrival" in packet) || typeof packet.arrival !== "number") {
		throw new Error("no arrival");
	}
	return packet.arrival;
}

describe("#given a cursor still flying to a target #when the target moves a little #then the flight bends instead of restarting", () => {
	it("keeps the remaining flight time and ends on the new point; far moves and finished flights plan afresh", () => {
		if (motion === undefined) throw new Error("motion config");
		const first = planCursorMotion({ x: 600, y: 400 }, shown, motion, undefined, 1_000);
		const total = first.move.samples.at(-1)?.t ?? 0;
		expect(total).toBeGreaterThan(0.1);
		const halfway = 1_000 + (total * 1000) / 2;
		const bent = planCursorMotion({ x: 612, y: 395 }, shown, motion, first.move, halfway);
		expect(arrival(bent.command)).toBeCloseTo(total / 2, 2);
		expect(bent.move.samples.at(-1)).toMatchObject({ x: 612, y: 395 });
		// The bent flight starts at t = 0 where the cursor is now, then goes on.
		expect(bent.move.samples[0]?.t).toBe(0);
		expect(bent.move.samples[1]?.t).toBeGreaterThan(0);

		const far = planCursorMotion({ x: 600 + RETARGET_RADIUS + 20, y: 400 }, shown, motion, first.move, halfway);
		expect(far.move.samples[0]?.t).toBe(0);
		const late = planCursorMotion({ x: 612, y: 395 }, shown, motion, first.move, 1_000 + total * 1000 + 5);
		expect(late.move.samples[0]?.t).toBe(0);
		const reduced = planCursorMotion(
			{ x: 612, y: 395 },
			{ ...shown, reducedMotion: true },
			motion,
			first.move,
			halfway,
		);
		expect(reduced.move.startedAt).toBe(halfway);
		expect(reduced.move.samples[0]?.t).toBe(0);
	});
});
