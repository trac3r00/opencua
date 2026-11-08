import { describe, expect, it } from "bun:test";
import { exportReplayHtml, scriptJson } from "./replay.js";

function embedded(html: string): unknown {
	const start = html.indexOf("const REPLAY=") + "const REPLAY=".length;
	const end = html.indexOf(";\n(() => {", start);
	return JSON.parse(html.slice(start, end));
}

describe("#given recorded text #when embedded in the replay script #then nothing in it can close or comment out the script", () => {
	it("escapes <, >, & and line separators yet parses back to the same value", () => {
		const value = { text: "</script><!-- a & b \u2028 \u2029 -->" };
		const json = scriptJson(value);
		expect(json).not.toMatch(/[<>&\u2028\u2029]/);
		expect(JSON.parse(json)).toEqual(value);
	});
});

describe("#given a run's events #when exported #then the file holds valid events in time order and counts the rest", () => {
	it("sorts by time, drops invalid events and colors, and keeps the decision text exact", () => {
		const html = exportReplayHtml(
			[
				{ t: 2, type: "cursor", cursor: "a", x: 1, y: 2, down: true },
				{ t: 1, type: "decision", cursor: "a", text: "</script>" },
				{ t: 1.5, type: "cursor", cursor: "b", x: Number.NaN, y: 1, down: false },
				{ t: -1, type: "audio", cursor: "b", peak: 0.5 },
				{ t: 3, type: "audio", cursor: "b", peak: 1.5 },
				{ t: 3, type: "ax", cursor: "b", added: 1, removed: 0, changed: -1 },
			],
			{ title: "t", width: 100, height: 100, colors: { a: "#00ff00", b: "red;}x{" } },
		);
		expect(html.match(/<\/script>/g)).toHaveLength(1);
		expect(embedded(html)).toMatchObject({
			dropped: 4,
			colors: { a: "#00ff00" },
			events: [
				{ t: 1, type: "decision", text: "</script>" },
				{ t: 2, type: "cursor", x: 1, y: 2 },
			],
		});
	});
});
