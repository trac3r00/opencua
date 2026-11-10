import { describe, expect, it } from "bun:test";
import type { AXTreeElement, AppState } from "@opencua/core";
import { copyForMatch } from "@opencua/test-support";
import { observedActionResult, observedRunStepsResult, observedSetFieldsResult, stateResult } from "./tool-result.js";

const state: AppState = {
	app: "Fixture",
	bundleId: "test.fixture",
	pid: 1234,
	frontmost: true,
	axAvailable: true,
	elements: [],
	screenshotBase64: "",
	screenshotWidth: 100,
	screenshotHeight: 100,
	display: { width: 100, height: 100, scaleFactor: 1 },
};

describe("#given image and accessibility coordinates #when observed #then their grounding is explicit", () => {
	it("keeps image-space element frames and exposes the offset scaled screen mapping", () => {
		const elements = elementRange(1);
		const payload = payloadOf(
			stateResult({
				...state,
				elements,
				screenshotBase64: "aW1hZ2U=",
				windowBounds: { x: -300, y: 150, width: 200, height: 400 },
			}),
		);

		expect(payload["elements"]).toEqual(elements);
		expect(payload["visual_context"]).toEqual({
			image_available: true,
			element_frame_space: "window-screenshot-pixels",
			ocr_frame_space: "screen-logical-points",
			tree_coverage: "full",
			image_to_screen: { origin: { x: -300, y: 150 }, scale: { x: 2, y: 4 } },
		});
	});

	it.each([
		{ flags: { treeSkipped: true }, coverage: "capture-only" },
		{ flags: { treeOmitted: true }, coverage: "diff-only" },
		{ flags: { elementsTruncated: true }, coverage: "partial" },
	])("reports $coverage without manufacturing element targets", ({ flags, coverage }) => {
		const payload = payloadOf(stateResult({ ...state, ...flags }));

		expect(payload["visual_context"]).toMatchObject({
			image_available: false,
			element_frame_space: "screen-logical-points",
			tree_coverage: coverage,
		});
		expect(payload["visual_context"]).not.toHaveProperty("image_to_screen");
	});

	it("does not offer image mapping when capture was omitted or denied", () => {
		const payload = payloadOf(
			stateResult({ ...state, windowBounds: { x: 300, y: 150, width: 200, height: 400 } }, "token", "table"),
		);

		expect(payload["visual_context"]).toMatchObject({
			image_available: false,
			element_frame_space: "window-screenshot-pixels",
		});
		expect(payload["visual_context"]).not.toHaveProperty("image_to_screen");
		expect(payload).not.toHaveProperty("elements");
	});
});

describe("#given observed action state #when formatted #then observation is not inferred action success", () => {
	it.each([
		{ summary: undefined, expected: "unavailable" },
		{ summary: { added: 0, removed: 0, changed: 0 }, expected: "unchanged" },
		{ summary: { added: 1, removed: 0, changed: 0 }, expected: "changed" },
		{ summary: { added: 0, removed: 1, changed: 0 }, expected: "changed" },
		{ summary: { added: 0, removed: 0, changed: 1 }, expected: "changed" },
	])("reports $expected without inventing an outcome", ({ summary, expected }) => {
		const result = observedActionResult(
			{
				...state,
				...(summary === undefined ? {} : { axChangeSummary: summary }),
			},
			true,
		);
		const text = result.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");
		const payload: unknown = JSON.parse(text.slice(text.indexOf("{")));
		expect(payload).toHaveProperty("observationStatus", expected);
		expect(payload).not.toHaveProperty("actionSucceeded");
	});
});

describe("#given a post-action state #when the tree was omitted #then the payload stays compact and honest", () => {
	it("reports a new window without claiming an accessibility-tree change", () => {
		const payload = payloadOf(
			observedActionResult(
				{ ...state, axChangeSummary: { added: 0, removed: 0, changed: 0 } },
				true,
				"token-window",
				[{ id: 2, ownerPid: 1234, ownerName: "Fixture", title: "New Window" }],
			),
		);

		expect(payload).toMatchObject({
			observationStatus: "unchanged",
			effect: "observed_change",
			evidence: [{ kind: "window_change" }],
			observation_token: "token-window",
			paused: false,
			needsExplicitObservation: false,
		});
		expect(payload["escalation"]).toBeUndefined();
	});

	it("reports a window-only change after a completed run_steps action", () => {
		const payload = payloadOf(
			observedRunStepsResult(
				{ ...state, axChangeSummary: { added: 0, removed: 0, changed: 0 } },
				{
					requested: 1,
					completed: 1,
					stoppedEarly: false,
					steps: [{ step: 1, type: "press_keys", input_dispatched: true, status: "dispatched" }],
				},
				undefined,
				true,
				"token-run-window",
				[{ id: 2, ownerPid: 1234, ownerName: "Fixture", title: "New Window" }],
			),
		);

		expect(payload).toMatchObject({
			observationStatus: "unchanged",
			effect: "observed_change",
			evidence: [{ kind: "window_change" }],
			observation_token: "token-run-window",
			paused: false,
			needsExplicitObservation: false,
		});
		expect(payload["escalation"]).toBeUndefined();
	});

	it("omits the tree, keeps what changed, and bounds each diff bucket", () => {
		const result = observedActionResult(
			{
				...state,
				treeOmitted: true,
				axChangeSummary: { added: 60, removed: 0, changed: 3 },
				axChanges: {
					added: elementRange(60),
					removed: [],
					changed: [],
				},
			},
			true,
			"token-1",
		);
		const payload = payloadOf(result);

		expect(payload).not.toHaveProperty("elements");
		expect(payload).toHaveProperty("treeOmitted", true);
		expect(payload).toHaveProperty("observation_token", "token-1");
		expect(payload["note"]).toEqual(expect.stringContaining("full_state=true"));
		const changes = payload["axChanges"];
		expect(copyForMatch(changes)).toMatchObject({ added: expect.any(Array) });
		expect(arrayLength(changes, "added")).toBe(25);
		expect(payload["axChangesOmitted"]).toEqual({ added: 35, removed: 0, changed: 0 });
		expect(firstChange(changes, "added")).toEqual({
			id: 1,
			role: "AXStaticText",
			label: "row 1",
			value: null,
			actions: [],
		});
	});

	it("keeps the full tree when the observation was not compact", () => {
		const payload = payloadOf(
			observedActionResult(
				{
					...state,
					elements: elementRange(3),
					axChangeSummary: { added: 0, removed: 0, changed: 0 },
				},
				true,
			),
		);

		expect(payload["elements"]).toHaveLength(3);
		expect(payload).not.toHaveProperty("note");
	});

	it("separates dispatched input from a verified outcome", () => {
		const payload = payloadOf(
			observedSetFieldsResult(
				{ ...state, treeOmitted: true, axChangeSummary: { added: 1, removed: 0, changed: 1 } },
				{
					requested: 2,
					inputDispatched: 2,
					verified: 1,
					outcomeVerified: false,
					stoppedEarly: true,
					uiChanged: true,
					steps: [
						{
							element_index: 20,
							requested_value: "alpha",
							input_dispatched: true,
							observed_value: "alpha",
							status: "verified",
						},
						{
							element_index: 21,
							requested_value: "beta",
							input_dispatched: true,
							observed_value: "queued",
							status: "unverified",
						},
					],
				},
				true,
				"token-2",
			),
		);

		expect(payload["setFields"]).toMatchObject({
			requested: 2,
			inputDispatched: 2,
			verified: 1,
			outcomeVerified: false,
			stoppedEarly: true,
		});
		expect(payload).toHaveProperty("actionDispatched", true);
		expect(payload).toHaveProperty("observationStatus", "changed");
	});
});

function elementRange(count: number): AXTreeElement[] {
	return Array.from({ length: count }, (_, index) => ({
		id: index + 1,
		role: "AXStaticText",
		label: `row ${index + 1}`,
		value: null,
		frame: { x: 0, y: index, width: 10, height: 10 },
		actions: [],
		children: [],
	}));
}

describe("#given accessibility trust is missing #when the state is reported #then the payload names the reason and the process to grant", () => {
	it("keeps axUnavailable and adds an axNote naming this process", () => {
		const payload = payloadOf(
			stateResult({ ...state, axAvailable: false, axUnavailable: "accessibility-permission" }),
		);

		expect(payload["axUnavailable"]).toBe("accessibility-permission");
		expect(String(payload["axNote"])).toContain(process.execPath);
	});
});

function payloadOf(result: { readonly content: readonly unknown[] }): Record<string, unknown> {
	const text = result.content
		.flatMap((item) =>
			item !== null &&
			typeof item === "object" &&
			"type" in item &&
			item.type === "text" &&
			"text" in item &&
			typeof item.text === "string"
				? [item.text]
				: [],
		)
		.join("\n");
	const parsed: unknown = JSON.parse(text.slice(text.indexOf("{")));
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error("tool result must contain a JSON object");
	}
	return Object.fromEntries(Object.entries(parsed));
}

function firstChange(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null || !(key in value)) {
		throw new Error(`missing ${key}`);
	}
	const entries = (value as Record<string, unknown>)[key];
	if (!Array.isArray(entries)) {
		throw new Error(`${key} must be an array`);
	}
	return entries[0];
}

function arrayLength(value: unknown, key: string): number {
	if (typeof value !== "object" || value === null || !(key in value)) {
		throw new Error(`missing ${key}`);
	}
	const entries = (value as Record<string, unknown>)[key];
	if (!Array.isArray(entries)) {
		throw new Error(`${key} must be an array`);
	}
	return entries.length;
}
