import { describe, expect, it } from "bun:test";
import { MK, WM, clickMessages, dragMessages, pointLParam, wheelMessages } from "./messages.js";

const SEED = Number(process.env["MESSAGES_SEED"] ?? 20261107);
const CASES = 500;

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

// GET_X_LPARAM / GET_Y_LPARAM as windowsx.h defines them: the signed low and high words.
const signed16 = (word: number) => (word >= 0x8000 ? word - 0x10000 : word);
const getX = (lParam: number) => signed16(lParam % 0x10000);
const getY = (lParam: number) => signed16(Math.floor(lParam / 0x10000) % 0x10000);

describe("#given client points #when packed into lParam #then windowsx.h reads the same point back", () => {
	it(`round-trips ${CASES} seeded points including negative and edge coordinates (seed ${SEED})`, () => {
		const next = random(SEED);
		const edges = [-32768, -1, 0, 1, 32767];
		const failures: string[] = [];
		for (let index = 0; index < CASES; index += 1) {
			const pick = () =>
				next() < 0.3 ? (edges[Math.floor(next() * edges.length)] ?? 0) : Math.floor(next() * 65536) - 32768;
			const point = { x: pick(), y: pick() };
			const lParam = pointLParam(point);
			if (lParam < 0 || lParam > 0xffffffff || getX(lParam) !== point.x || getY(lParam) !== point.y) {
				failures.push(`${JSON.stringify(point)} -> ${lParam}`);
			}
		}
		expect(failures).toEqual([]);
	});

	it("matches documented values and rejects points outside 16 bits", () => {
		expect(pointLParam({ x: -1, y: 2 })).toBe(0x0002ffff);
		expect(pointLParam({ x: 300, y: -2 })).toBe(0xfffe012c);
		for (const point of [
			{ x: 32768, y: 0 },
			{ x: 0, y: -32769 },
		]) {
			expect(() => pointLParam(point)).toThrow(RangeError);
		}
	});
});

describe("#given pointer actions #when turned into window messages #then the button state follows the Win32 contract", () => {
	it("holds MK_LBUTTON through every drag move and releases at the last point", () => {
		const next = random(SEED + 1);
		for (let index = 0; index < 100; index += 1) {
			const path = Array.from({ length: 2 + Math.floor(next() * 8) }, () => ({
				x: Math.floor(next() * 800),
				y: Math.floor(next() * 600),
			}));
			const messages = dragMessages(path, index % 2 === 0 ? ["shift"] : []);
			const shift = index % 2 === 0 ? MK.SHIFT : 0;
			expect(messages.map((item) => item.message)).toEqual([
				WM.MOUSEMOVE,
				WM.LBUTTONDOWN,
				...path.slice(1).map(() => WM.MOUSEMOVE),
				WM.LBUTTONUP,
			]);
			expect(messages.slice(1, -1).every((item) => item.wParam === (MK.LBUTTON | shift))).toBe(true);
			const last = messages.at(-1);
			expect(last?.wParam).toBe(shift);
			const end = path.at(-1);
			expect(last === undefined || end === undefined ? undefined : [getX(last.lParam), getY(last.lParam)]).toEqual(
				end === undefined ? undefined : [end.x, end.y],
			);
		}
		expect(() => dragMessages([{ x: 1, y: 1 }])).toThrow(RangeError);
	});

	it("sends the right button pair per click kind and a double click as press, release, dblclk, release", () => {
		const point = { x: 5, y: 6 };
		expect(clickMessages("right", point).map((item) => item.message)).toEqual([
			WM.MOUSEMOVE,
			WM.RBUTTONDOWN,
			WM.RBUTTONUP,
		]);
		expect(clickMessages("middle", point, ["ctrl"])[1]).toEqual({
			message: WM.MBUTTONDOWN,
			wParam: MK.MBUTTON | MK.CONTROL,
			lParam: pointLParam(point),
		});
		expect(clickMessages("double", point).map((item) => item.message)).toEqual([
			WM.MOUSEMOVE,
			WM.LBUTTONDOWN,
			WM.LBUTTONUP,
			WM.LBUTTONDBLCLK,
			WM.LBUTTONUP,
		]);
	});

	it("puts the signed wheel delta in the high word of wParam", () => {
		const [down] = wheelMessages({ x: 10, y: 20 }, -2, ["ctrl"]);
		expect(down && signed16(Math.floor(down.wParam / 0x10000))).toBe(-240);
		expect(down && down.wParam % 0x10000).toBe(MK.CONTROL);
		for (const notches of [0, 1.5, 274]) expect(() => wheelMessages({ x: 0, y: 0 }, notches)).toThrow(RangeError);
	});
});
