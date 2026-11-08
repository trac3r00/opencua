import { describe, expect, it } from "bun:test";
import { readWindowsOcr } from "./ocr.js";
import { WindowsHostError } from "./transport.js";

const SEED = Number(process.env["OCR_SEED"] ?? 20261107);
const CASES = 300;

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

const TEXTS = ["File", "검색", "e\u0301 café", "😀 ok", "a  b"];

describe("#given generated Windows OCR replies #when read #then each line lands on its screen frame", () => {
	it(`maps ${CASES} seeded replies, with unscaled, uniformly and unevenly scaled images (seed ${SEED})`, () => {
		const next = random(SEED);
		const failures: string[] = [];
		let lines = 0;
		for (let index = 0; index < CASES; index += 1) {
			const bounds = {
				x: Math.floor(next() * 2000) - 500,
				y: Math.floor(next() * 1200),
				width: 200 + Math.floor(next() * 1600),
				height: 150 + Math.floor(next() * 900),
			};
			const scaleX = index % 3 === 0 ? 1 : 0.5 + next() * 1.5;
			const scaleY = index % 3 === 0 ? 1 : index % 3 === 1 ? scaleX : 0.5 + next() * 1.5;
			const image = { width: bounds.width * scaleX, height: bounds.height * scaleY };
			const expected: Array<{ text: string; frame: { x: number; y: number; width: number; height: number } }> = [];
			const replyLines: unknown[] = [];
			for (let line = 0; line < Math.floor(next() * 5); line += 1) {
				const text = TEXTS[Math.floor(next() * TEXTS.length)] ?? "x";
				const words = 1 + Math.floor(next() * 3);
				const screenWords = Array.from({ length: words }, (_, word) => ({
					x: bounds.x + 10 + word * 60,
					y: bounds.y + 10 + line * 30 + Math.floor(next() * 3),
					width: 20 + Math.floor(next() * 30),
					height: 12 + Math.floor(next() * 6),
				}));
				const left = Math.min(...screenWords.map((box) => box.x));
				const top = Math.min(...screenWords.map((box) => box.y));
				const right = Math.max(...screenWords.map((box) => box.x + box.width));
				const bottom = Math.max(...screenWords.map((box) => box.y + box.height));
				expected.push({ text, frame: { x: left, y: top, width: right - left, height: bottom - top } });
				replyLines.push({
					text,
					words: screenWords.map((box) => ({
						x: (box.x - bounds.x) * scaleX,
						y: (box.y - bounds.y) * scaleY,
						width: box.width * scaleX,
						height: box.height * scaleY,
					})),
				});
			}
			replyLines.push({ text: "   ", words: [{ x: 0, y: 0, width: 1, height: 1 }] });
			const got = readWindowsOcr({ ...image, bounds, lines: replyLines });
			lines += expected.length;
			const close = (a: number, b: number) => Math.abs(a - b) < 1e-6;
			const same =
				got.length === expected.length &&
				got.every((entry, at) => {
					const want = expected[at];
					return (
						want !== undefined &&
						entry.text === want.text &&
						entry.confidence === 1 &&
						close(entry.frame.x, want.frame.x) &&
						close(entry.frame.y, want.frame.y) &&
						close(entry.frame.width, want.frame.width) &&
						close(entry.frame.height, want.frame.height)
					);
				});
			if (!same) failures.push(`case ${index}: ${JSON.stringify(got[0])} vs ${JSON.stringify(expected[0])}`);
		}
		expect(failures).toEqual([]);
		expect(lines).toBeGreaterThan(CASES);
	});
});

describe("#given malformed Windows OCR replies #when read #then each is rejected as a protocol error", () => {
	it("rejects empty sizes, textless lines, and negative or non-numeric word boxes", () => {
		const bounds = { x: 0, y: 0, width: 100, height: 100 };
		const word = { x: 1, y: 1, width: 5, height: 5 };
		for (const reply of [
			{ width: 0, height: 100, bounds, lines: [] },
			{ width: 100, height: 100, bounds: { ...bounds, width: 0 }, lines: [] },
			{ width: 100, height: 100, bounds, lines: [{ words: [word] }] },
			{ width: 100, height: 100, bounds, lines: [{ text: "a", words: [{ ...word, width: -1 }] }] },
			{ width: 100, height: 100, bounds, lines: [{ text: "a", words: [{ ...word, x: "1" }] }] },
			{ width: 100, height: 100, lines: [] },
			{ width: 100, height: 100, bounds, lines: "a" },
		]) {
			expect(() => readWindowsOcr(reply)).toThrow(WindowsHostError);
		}
	});
});
