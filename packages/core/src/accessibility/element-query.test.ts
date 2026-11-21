import { describe, expect, it } from "bun:test";

import { describeQuery, matchElements, suggestNearMisses } from "./element-query.js";
import type { AXTreeElement } from "./types.js";

function el(partial: Partial<AXTreeElement> & { id: number; role: string }): AXTreeElement {
	return {
		label: null,
		value: null,
		frame: { x: 0, y: 0, width: 10, height: 10 },
		actions: [],
		children: [],
		...partial,
	};
}

describe("#given a pressable control and decoys sharing its label #when queried #then the pressable control outranks them", () => {
	it("ranks the AXPress button above the static text with the same label", () => {
		const elements = [
			el({ id: 1, role: "AXStaticText", label: "Save", frame: { x: 0, y: 30, width: 40, height: 12 } }),
			el({
				id: 2,
				role: "AXButton",
				label: "Save",
				actions: ["AXPress"],
				frame: { x: 0, y: 60, width: 60, height: 24 },
			}),
		];

		const matches = matchElements(elements, { label: "Save" });

		expect(matches.map((match) => match.element.id)).toEqual([2, 1]);
		expect(matches[0]?.matchedBy).toContain("label");
		expect(matches[0]?.matchedBy).toContain("pressable");
		expect(matches[0]?.score).toBeGreaterThan(matches[1]?.score ?? 0);
	});
});

describe("#given role aliases and case differences #when querying by role #then matching ignores the AX prefix and letter case", () => {
	it("matches button to AXButton, axbutton to AXButton, and is case-insensitive", () => {
		const elements = [
			el({ id: 1, role: "AXButton", label: "Open", actions: ["AXPress"] }),
			el({ id: 2, role: "AXTextField", label: "Note", actions: ["AXSetValue"] }),
			el({ id: 3, role: "AXStaticText", value: "Ready" }),
		];

		expect(matchElements(elements, { role: "button" }).map((match) => match.element.id)).toEqual([1]);
		expect(matchElements(elements, { role: "axbutton" }).map((match) => match.element.id)).toEqual([1]);
		expect(matchElements(elements, { role: "TEXTFIELD" }).map((match) => match.element.id)).toEqual([2]);
	});
});

describe("#given whitespace noise in labels #when querying by substring #then matching is normalized", () => {
	it("collapses whitespace and ignores case on both sides", () => {
		const elements = [
			el({ id: 1, role: "AXButton", label: "  Save   As… ", actions: ["AXPress"] }),
			el({ id: 2, role: "AXButton", label: "Open", actions: ["AXPress"] }),
		];

		expect(matchElements(elements, { labelContains: "save as" }).map((match) => match.element.id)).toEqual([1]);
	});
});

describe("#given text that only lives in the value #when querying #then value matches are found and rank below label matches", () => {
	it("finds value text, and prefers the same text when it is the label", () => {
		const elements = [
			el({ id: 5, role: "AXStaticText", value: "Ready" }),
			el({ id: 6, role: "AXStaticText", label: "Ready" }),
		];

		expect(matchElements(elements, { text: "ready" }).map((match) => match.element.id)).toEqual([6, 5]);
		expect(matchElements(elements, { valueContains: "ready" }).map((match) => match.element.id)).toEqual([5]);
	});
});

describe("#given equally scored matches #when ranked #then reading order decides and repeated calls agree", () => {
	it("orders by score, then y, then x, then id", () => {
		const elements = [
			el({
				id: 7,
				role: "AXButton",
				label: "Next",
				actions: ["AXPress"],
				frame: { x: 0, y: 100, width: 20, height: 20 },
			}),
			el({
				id: 8,
				role: "AXButton",
				label: "Next",
				actions: ["AXPress"],
				frame: { x: 50, y: 20, width: 20, height: 20 },
			}),
			el({
				id: 9,
				role: "AXButton",
				label: "Next",
				actions: ["AXPress"],
				frame: { x: 10, y: 20, width: 20, height: 20 },
			}),
		];

		const first = matchElements(elements, { label: "Next" }).map((match) => match.element.id);
		const second = matchElements([...elements].reverse(), { label: "Next" }).map((match) => match.element.id);

		expect(first).toEqual([9, 8, 7]);
		expect(second).toEqual(first);
	});
});

describe("#given nothing matches #when the query misses #then the result is empty and near misses teach the caller what is there", () => {
	const elements = [
		el({
			id: 1,
			role: "AXButton",
			label: "Save As…",
			actions: ["AXPress"],
			frame: { x: 0, y: 10, width: 40, height: 20 },
		}),
		el({
			id: 2,
			role: "AXButton",
			label: "Open",
			actions: ["AXPress"],
			frame: { x: 0, y: 40, width: 40, height: 20 },
		}),
		el({
			id: 3,
			role: "AXButton",
			label: "Close",
			actions: ["AXPress"],
			frame: { x: 0, y: 70, width: 40, height: 20 },
		}),
	];

	it("returns no matches for a label that shares no word or synonym with any element", () => {
		expect(matchElements(elements, { label: "Zebra" })).toEqual([]);
	});

	it("suggests the candidates that share words with the query", () => {
		const misses = suggestNearMisses(elements, { label: "Save Document" }, 3);

		expect(misses.map((element) => element.id)).toEqual([1]);
	});

	it("falls back to the role's own controls in reading order when no words overlap", () => {
		const misses = suggestNearMisses(elements, { role: "button", label: "Zebra" }, 2);

		expect(misses.map((element) => element.id)).toEqual([1, 2]);
	});

	it("returns nothing when there is neither word overlap nor a role to narrow the field", () => {
		expect(suggestNearMisses(elements, { label: "Zebra" }, 3)).toEqual([]);
	});
});

describe("#given a label that differs in wording but not intent #when queried #then the intended control is found", () => {
	it("finds Done for OK", () => {
		const elements = [el({ id: 1, role: "AXButton", label: "Done", actions: ["AXPress"] })];

		expect(matchElements(elements, { label: "OK" }).map((match) => match.element.id)).toEqual([1]);
	});

	it("finds Send for 보내기", () => {
		const elements = [el({ id: 1, role: "AXButton", label: "Send", actions: ["AXPress"] })];

		expect(matchElements(elements, { label: "보내기" }).map((match) => match.element.id)).toEqual([1]);
	});

	it("finds the × control for close", () => {
		const elements = [el({ id: 1, role: "AXButton", label: "×", actions: ["AXPress"] })];

		expect(matchElements(elements, { label: "close" }).map((match) => match.element.id)).toEqual([1]);
	});
});

describe("#given Save Draft, Save, and unrelated controls #when searching the text save draft #then Save Draft ranks first and Save follows above the rest", () => {
	it("returns Save Draft, then Save, and no unrelated control", () => {
		const elements = [
			el({
				id: 1,
				role: "AXButton",
				label: "Save Draft",
				actions: ["AXPress"],
				frame: { x: 0, y: 10, width: 60, height: 20 },
			}),
			el({
				id: 2,
				role: "AXButton",
				label: "Save",
				actions: ["AXPress"],
				frame: { x: 0, y: 40, width: 40, height: 20 },
			}),
			el({
				id: 3,
				role: "AXButton",
				label: "Cancel",
				actions: ["AXPress"],
				frame: { x: 0, y: 70, width: 40, height: 20 },
			}),
			el({
				id: 4,
				role: "AXButton",
				label: "Open",
				actions: ["AXPress"],
				frame: { x: 0, y: 100, width: 40, height: 20 },
			}),
		];

		expect(matchElements(elements, { text: "save draft" }).map((match) => match.element.id)).toEqual([1, 2]);
	});
});

describe("#given an exact label and a synonym for the same query #when ranked #then the exact label outranks the synonym", () => {
	it("ranks OK above Done for the query OK", () => {
		const elements = [
			el({
				id: 1,
				role: "AXButton",
				label: "Done",
				actions: ["AXPress"],
				frame: { x: 0, y: 10, width: 40, height: 20 },
			}),
			el({
				id: 2,
				role: "AXButton",
				label: "OK",
				actions: ["AXPress"],
				frame: { x: 0, y: 40, width: 40, height: 20 },
			}),
		];

		const matches = matchElements(elements, { label: "OK" });

		expect(matches.map((match) => match.element.id)).toEqual([2, 1]);
		expect(matches[0]?.score).toBeGreaterThan(matches[1]?.score ?? 0);
	});
});

describe("#given Korean labels sharing whole words #when searched by text with those words #then the overlapping control is found and unrelated ones are not", () => {
	it("matches 임시 완료 against 임시 저장 완료 but not 삭제", () => {
		const elements = [
			el({ id: 1, role: "AXButton", label: "임시 저장 완료", actions: ["AXPress"] }),
			el({ id: 2, role: "AXButton", label: "삭제", actions: ["AXPress"] }),
		];

		expect(matchElements(elements, { text: "임시 완료" }).map((match) => match.element.id)).toEqual([1]);
	});
});

describe("#given an exact label that only shares words with a control #when queried #then that control is not a stand-in", () => {
	it("never lands Unmute tab on Mute tab", () => {
		const elements = [el({ id: 1, role: "AXButton", label: "Mute tab", actions: ["AXPress"] })];

		expect(matchElements(elements, { label: "Unmute tab" })).toEqual([]);
	});
});

describe("#given a label that shares no word or synonym with any element #when queried #then nothing is returned", () => {
	it("does not return Open or Close for OK", () => {
		const elements = [
			el({ id: 1, role: "AXButton", label: "Open", actions: ["AXPress"] }),
			el({ id: 2, role: "AXButton", label: "Close", actions: ["AXPress"] }),
		];

		expect(matchElements(elements, { label: "OK" })).toEqual([]);
	});
});

describe("#given a structured query #when described for an answer #then the description names each constraint it carries", () => {
	it("joins the constraints in a fixed order", () => {
		expect(describeQuery({ role: "button", labelContains: "Save" })).toBe('role=button label_contains="Save"');
		expect(describeQuery({ label: "Open", valueContains: "ready" })).toBe('label="Open" value_contains="ready"');
		expect(describeQuery({ text: "hello world" })).toBe('text="hello world"');
	});
});

describe("#given a query with no constraints #when it is matched #then nothing matches and nothing is suggested", () => {
	const elements = [el({ id: 1, role: "AXButton", label: "Open", actions: ["AXPress"] })];

	it("returns no matches for an empty or whitespace-only query", () => {
		expect(matchElements(elements, {})).toEqual([]);
		expect(matchElements(elements, { label: "   " })).toEqual([]);
		expect(suggestNearMisses(elements, {}, 3)).toEqual([]);
	});
});
