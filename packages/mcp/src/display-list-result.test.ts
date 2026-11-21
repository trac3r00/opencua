import { describe, expect, it } from "bun:test";
import { listDisplaysResult } from "./display-list-result.js";

const displays = [
	{ id: 1, isMain: true, x: 0, y: 0, width: 1512, height: 982, scaleFactor: 2 },
	{ id: 2, isMain: false, x: 1512, y: 0, width: 2560, height: 1440, scaleFactor: 1 },
];

describe("listDisplaysResult #given the agent's cursor on one display and the person's pointer on another", () => {
	it("#when the person's pointer is known #then has_cursor marks the display the person is on", async () => {
		const result = await listDisplaysResult({
			displays: () => displays,
			computer: { getCursorPosition: async () => ({ x: 100, y: 100 }), listApps: async () => [] },
			personPointer: () => ({ x: 2000, y: 500 }),
		});
		const first = result.content[0];
		const parsed = JSON.parse(first?.type === "text" ? first.text : "{}") as {
			displays: { id: number; has_cursor: boolean }[];
		};
		expect(parsed.displays.map((display) => [display.id, display.has_cursor])).toEqual([
			[1, false],
			[2, true],
		]);
	});
});
