import { describe, expect, it } from "bun:test";
import type { InputObservation } from "@opencua/core";
import { observedPointToScreen, validatePoint } from "./guarded-session.js";

const SEED = Number(process.env["POINT_SEED"] ?? 20261108);
const CASES = 2000;

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

function observation(width: number, height: number, bounds: { x: number; y: number; width: number; height: number }) {
	const value: InputObservation = {
		generation: 1,
		pid: 1,
		bundleId: "test.fixture",
		windowId: 1,
		windowBounds: bounds,
		screenshotViewport: { width, height, bounds },
		observedElementIds: new Set<number>(),
	};
	return value;
}

/** Largest double strictly below `value` (value > 0). */
function below(value: number): number {
	const buffer = new DataView(new ArrayBuffer(8));
	buffer.setFloat64(0, value);
	buffer.setBigUint64(0, buffer.getBigUint64(0) - 1n);
	return buffer.getFloat64(0);
}

function rejects(run: () => unknown): boolean {
	try {
		run();
		return false;
	} catch {
		return true;
	}
}

/** Specification: a point is valid iff it is finite and lies in the half-open viewport [0,w) x [0,h). */
function inViewport(width: number, height: number, x: number, y: number): boolean {
	return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x < width && y < height;
}

/** Independent geometric invariant: an accepted point lands inside the half-open window rectangle. */
function landsInsideWindow(
	bounds: { x: number; y: number; width: number; height: number },
	screen: { x: number; y: number },
) {
	return (
		screen.x >= bounds.x &&
		screen.y >= bounds.y &&
		screen.x < bounds.x + bounds.width &&
		screen.y < bounds.y + bounds.height
	);
}

interface Counts {
	attempted: number;
	executed: number;
	failing: string[];
}

function campaign(
	label: string,
	next: () => number,
	pick: (next: () => number) => { w: number; h: number; x: number; y: number },
) {
	const counts: Counts = { attempted: 0, executed: 0, failing: [] };
	for (let index = 0; index < CASES; index += 1) {
		const { w, h, x, y } = pick(next);
		const bounds = {
			x: Math.round((next() - 0.5) * 6000),
			y: Math.round((next() - 0.5) * 4000),
			width: 1 + next() * 3000,
			height: 1 + next() * 2000,
		};
		const view = observation(w, h, bounds);
		counts.attempted += 1;
		const expected = inViewport(w, h, x, y);
		const accepted = !rejects(() => validatePoint(view, { x, y }));
		counts.executed += 1;
		if (accepted !== expected) {
			counts.failing.push(`${label} validate w=${w} h=${h} x=${x} y=${y} accepted=${accepted}`);
			continue;
		}
		if (expected) {
			const screen = observedPointToScreen(view, { x, y });
			if (!landsInsideWindow(bounds, screen)) {
				counts.failing.push(
					`${label} map w=${w} h=${h} x=${x} y=${y} bounds=${JSON.stringify(bounds)} -> ${screen.x},${screen.y}`,
				);
			}
		} else if (!rejects(() => observedPointToScreen(view, { x, y }))) {
			counts.failing.push(`${label} map accepted an invalid point w=${w} h=${h} x=${x} y=${y}`);
		}
	}
	return counts;
}

const dimension = (next: () => number) => (next() < 0.5 ? 1 + Math.floor(next() * 4000) : 1 + next() * 4000);

describe("#given an observed viewport #when a click point is validated and mapped #then only in-viewport points are accepted and they land inside the window", () => {
	it(`holds for interior points (seed ${SEED})`, () => {
		const next = random(SEED);
		const counts = campaign("interior", next, (n) => {
			const w = dimension(n);
			const h = dimension(n);
			return { w, h, x: n() * below(w), y: n() * below(h) };
		});
		expect(counts.executed).toBe(CASES);
		expect(counts.failing).toEqual([]);
	});

	it(`holds at the half-open upper edge (seed ${SEED})`, () => {
		const next = random(SEED + 1);
		const counts = campaign("edge", next, (n) => {
			const w = dimension(n);
			const h = dimension(n);
			const pick = Math.floor(n() * 4);
			if (pick === 0) return { w, h, x: below(w), y: below(h) };
			if (pick === 1) return { w, h, x: w, y: 0 };
			if (pick === 2) return { w, h, x: 0, y: h };
			return { w, h, x: -Number.EPSILON, y: 0 };
		});
		expect(counts.executed).toBe(CASES);
		expect(counts.failing).toEqual([]);
	});

	it(`rejects non-finite and out-of-range points (seed ${SEED})`, () => {
		const next = random(SEED + 2);
		const bad = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, -0.5, 1e12, -1e12];
		const counts = campaign("invalid", next, (n) => {
			const w = dimension(n);
			const h = dimension(n);
			const value = bad[Math.floor(n() * bad.length)] ?? Number.NaN;
			return n() < 0.5 ? { w, h, x: value, y: n() * below(h) } : { w, h, x: n() * below(w), y: value };
		});
		expect(counts.executed).toBe(CASES);
		expect(counts.failing).toEqual([]);
	});

	it("#given a viewport on a far-right window #when the last representable point is mapped #then it stays below the exclusive edge", () => {
		const bounds = { x: 1000, y: 0, width: 1, height: 1 };
		const point = { x: below(1), y: 0 };
		const screen = observedPointToScreen(observation(1, 1, bounds), point);
		expect(landsInsideWindow(bounds, screen)).toBe(true);
	});

	it("#given the unclamped mapping and an off-by-one validator #when the oracle checks them #then both defects are detected", () => {
		const bounds = { x: 1000, y: 0, width: 1, height: 1 };
		const unclamped = { x: bounds.x + (below(1) / 1) * bounds.width, y: 0 };
		expect(landsInsideWindow(bounds, unclamped)).toBe(false);
		const offByOne = (width: number, x: number) => Number.isFinite(x) && x >= 0 && x <= width;
		expect(offByOne(100, 100)).not.toBe(inViewport(100, 100, 100, 0));
	});
});
