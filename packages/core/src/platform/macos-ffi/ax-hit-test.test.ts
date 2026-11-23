import { beforeEach, describe, expect, it, mock } from "bun:test";

interface FakeElement {
	readonly role: string;
	readonly title?: string;
	readonly parent?: FakeElement;
}

const window: FakeElement = { role: "AXWindow" };
const content: FakeElement = { role: "AXGroup", parent: window };
const button: FakeElement = { role: "AXButton", title: "Save", parent: content };
const buttonLabel: FakeElement = { role: "AXStaticText", parent: button };
const sheet: FakeElement = { role: "AXSheet", parent: window };
const sheetButton: FakeElement = { role: "AXButton", title: "Cancel", parent: sheet };
const app = { role: "AXApplication" };

const native = { hit: null as FakeElement | null, status: 0, target: button };

mock.module("./koffi.js", () => ({
	koffi: {
		load: () => ({
			func: (signature: string) =>
				signature.includes("AXUIElementCopyElementAtPosition")
					? (_app: unknown, _x: number, _y: number, out: Array<FakeElement | null>) => {
							out[0] = native.hit;
							return native.status;
						}
					: (left: unknown, right: unknown) => left === right,
		}),
	},
}));
mock.module("./corefoundation.js", () => ({
	cfRetain: (reference: unknown) => reference,
	cfRelease: () => undefined,
	isCFString: (reference: unknown) => typeof reference === "string",
	fromCFString: (reference: string) => reference,
}));
mock.module("./accessibility.js", () => ({
	createApplicationElement: () => app,
	refetchElement: () => native.target,
	releaseAXElement: () => undefined,
	copyOptionalAttributeValue: (element: FakeElement, attribute: string) =>
		attribute === "AXParent"
			? (element.parent ?? null)
			: attribute === "AXRole"
				? element.role
				: attribute === "AXTitle"
					? (element.title ?? null)
					: null,
}));

const { elementHitAtPoint } = await import("./ax-hit-test.js");
const point = { x: 100, y: 200 };

describe("#given an observed button #when the app hit-tests the click point", () => {
	beforeEach(() => {
		native.status = 0;
		native.target = button;
	});

	it("#when the hit is the button itself #then it is the target", () => {
		native.hit = button;
		expect(elementHitAtPoint(1, 9, point)).toEqual({ hit: "target" });
	});

	it("#when the hit is the button's own static text #then it still is the target", () => {
		native.hit = buttonLabel;
		expect(elementHitAtPoint(1, 9, point)).toEqual({ hit: "target" });
	});

	it("#when the hit is the button's own container #then it is not refused", () => {
		native.hit = content;
		expect(elementHitAtPoint(1, 9, point)).toEqual({ hit: "target" });
	});

	it("#when a sheet's button is at the point #then the button is covered, named with the sheet", () => {
		native.hit = sheetButton;
		expect(elementHitAtPoint(1, 9, point)).toEqual({
			hit: "covered",
			role: "AXButton",
			label: "Cancel",
			within: "AXSheet",
		});
	});

	it("#when accessibility cannot answer at the point #then the answer is unknown", () => {
		native.hit = null;
		native.status = -25204;
		expect(elementHitAtPoint(1, 9, point)).toEqual({ hit: "unknown" });
	});
});
