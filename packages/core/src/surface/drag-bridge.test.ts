import { describe, expect, it } from "bun:test";
import { dropInCall, readDragPayload } from "./drag-bridge.js";

describe("#given what a source page returned #when read as a drag payload #then only string items with MIME types are carried", () => {
	it("keeps text, URI and custom types and drops everything a destination could misread", () => {
		expect(
			readDragPayload(
				JSON.stringify({
					items: {
						"text/plain": "card-42",
						"application/x-card": '{"id":42}',
						Files: "",
						"bad type": "x",
						"text/html": 5,
					},
				}),
			),
		).toEqual({ items: { "text/plain": "card-42", "application/x-card": '{"id":42}' } });
		for (const bad of [
			undefined,
			"{",
			JSON.stringify({}),
			JSON.stringify({ items: [] }),
			JSON.stringify({ items: null }),
		]) {
			expect(() => readDragPayload(bad)).toThrow();
		}
	});

	it("quotes the payload so text with quotes and script cannot escape the page call", () => {
		const call = dropInCall(1, 2, { items: { "text/plain": `"); alert(1); ("` } });
		const argument = call.slice(call.indexOf(", ", call.indexOf(", ") + 2) + 2, -1);
		expect(JSON.parse(JSON.parse(argument))).toEqual({ items: { "text/plain": `"); alert(1); ("` } });
	});
});
