import { describe, expect, it } from "bun:test";
import { profileDefaults } from "./observation-profile.js";

describe("#given an observation profile #when resolving defaults #then the fast path avoids pixels and the visual path avoids a tree walk", () => {
	it("returns the semantic fast defaults", () => {
		expect(profileDefaults("fast")).toEqual({
			includeScreenshot: false,
			settleMs: 0,
			maxElements: 250,
			elementFormat: "table",
		});
	});

	it("returns the image-only defaults", () => {
		expect(profileDefaults("visual")).toEqual({
			includeScreenshot: true,
			includeAccessibilityTree: false,
		});
	});

	it("keeps an observation without a profile compact: a table and no image", () => {
		expect(profileDefaults(undefined)).toEqual({ includeScreenshot: false, elementFormat: "table" });
	});

	it("leaves options untouched for the full profile", () => {
		expect(profileDefaults("full")).toEqual({});
	});
});
