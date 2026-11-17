import { describe, expect, it } from "bun:test";
import { StaleElementRef, resolveSnapshotRefs, withSnapshotRefs } from "./snapshot-refs.js";
import { textResult } from "./tool-result.js";

describe("snapshot refs", () => {
	it("#given a matching token #when resolving nested targets #then only element indices are translated", () => {
		const input = {
			observation_token: "snapshot-a",
			updates: [{ element_index: "@snapshot-a:e9", value: "@snapshot-b:e1" }],
			steps: [{ element_index: "20" }],
		};
		expect(resolveSnapshotRefs(input)).toEqual({
			observation_token: "snapshot-a",
			updates: [{ element_index: "9", value: "@snapshot-b:e1" }],
			steps: [{ element_index: "20" }],
		});
		expect(input.updates[0]?.element_index).toBe("@snapshot-a:e9");
	});

	it.each(["@old:e9", "@snapshot-a:e-1", "@snapshot-a:e9:extra", "@snapshot-a:e", "@:e9"])(
		"#given malformed or stale ref %s #when resolving #then dispatch is rejected",
		(element_index) => {
			expect(() => resolveSnapshotRefs({ observation_token: "snapshot-a", element_index })).toThrow(StaleElementRef);
		},
	);

	it("#given a ref without a token #when resolving #then the ref cannot authorize itself", () => {
		expect(() => resolveSnapshotRefs({ element_index: "@snapshot-a:e9" })).toThrow(StaleElementRef);
	});

	it("#given JSON elements and compact rows #when projecting refs #then ids bind to the returned snapshot", () => {
		const result = withSnapshotRefs(
			textResult(
				JSON.stringify({
					observation_token: "snapshot-a",
					elements: [{ id: 9, role: "AXButton" }],
					element_rows: ["20\tTextField\tName"],
					matches: [{ element_index: 21 }],
				}),
			),
		);
		const text = result.content[0];
		expect(text?.type === "text" && JSON.parse(text.text)).toEqual({
			observation_token: "snapshot-a",
			elements: [{ id: 9, role: "AXButton" }],
			element_rows: ["20\tTextField\tName"],
			matches: [{ element_index: 21 }],
			element_ref_format: "@snapshot-a:e{id}",
		});
	});

	it("#given capture-only output #when projecting refs #then no actionable refs are invented", () => {
		const result = textResult('{"treeSkipped":true}');
		expect(withSnapshotRefs(result)).toEqual(result);
	});

	it("#given a compact diff #when projecting refs #then the template names the current observation", () => {
		const result = withSnapshotRefs(
			textResult(
				JSON.stringify({
					observation_token: "snapshot-b",
					axChanges: {
						added: ["9\tButton\tNew"],
						removed: [{ id: 8 }],
						changed: [{ before: { id: 7 }, after: { id: 6 } }],
					},
					matches: [{ element_index: "20" }],
				}),
			),
		);
		const text = result.content[0];
		expect(text?.type === "text" && JSON.parse(text.text).element_ref_format).toBe("@snapshot-b:e{id}");
	});
});
