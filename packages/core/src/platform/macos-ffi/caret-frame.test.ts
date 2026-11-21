import { describe, expect, it } from "bun:test";
import { caretFrameFrom } from "./accessibility.js";

describe("caretFrameFrom #given the bounds an app reports around its insertion point", () => {
	it("#when the caret ends a line #then it sits on that line at the end of the last character", () => {
		// Notes: the empty range at the end of a line reports the right x on the line above.
		const atCaret = { x: 1751.7, y: 1096, width: 0, height: 16 };
		const before = { x: 1740.5, y: 1112, width: 11.2, height: 16 };

		expect(caretFrameFrom(atCaret, before)).toEqual({ x: 1751.7, y: 1112, width: 1, height: 16 });
	});

	it("#when the caret starts a new line #then the insertion point's own box is kept", () => {
		const atCaret = { x: 500, y: 140, width: 0, height: 16 };
		const newlineOnLineAbove = { x: 900, y: 120, width: 6, height: 16 };

		expect(caretFrameFrom(atCaret, newlineOnLineAbove)).toEqual({ x: 500, y: 140, width: 1, height: 16 });
	});

	it("#when only one box or none answers #then it uses what there is", () => {
		expect(caretFrameFrom(undefined, { x: 10, y: 20, width: 5, height: 14 })).toEqual({
			x: 15,
			y: 20,
			width: 1,
			height: 14,
		});
		expect(caretFrameFrom({ x: 3, y: 4, width: 0, height: 12 }, undefined)).toEqual({
			x: 3,
			y: 4,
			width: 1,
			height: 12,
		});
		expect(caretFrameFrom(undefined, undefined)).toBeUndefined();
		expect(caretFrameFrom({ x: 3, y: 4, width: 0, height: 0 }, undefined)).toBeUndefined();
	});
});
