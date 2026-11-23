export type ObservationProfile = "fast" | "full" | "visual";

export type ObservationDefaults = {
	readonly includeScreenshot?: boolean;
	readonly includeAccessibilityTree?: boolean;
	readonly settleMs?: number;
	readonly maxElements?: number;
	readonly elementFormat?: "json" | "table";
};

const FAST_MAX_ELEMENTS = 250;

export function profileDefaults(profile: ObservationProfile | undefined): ObservationDefaults {
	switch (profile) {
		case "fast":
			return { includeScreenshot: false, settleMs: 0, maxElements: FAST_MAX_ELEMENTS, elementFormat: "table" };
		case "visual":
			return { includeScreenshot: true, includeAccessibilityTree: false };
		case undefined:
			// An untuned read of a web page was over 350 KB (a screenshot plus every element as JSON): agent hosts cut
			// it off, and a few such calls fill an agent's context. The same read as a table with no image is a seventh.
			return { includeScreenshot: false, elementFormat: "table" };
		case "full":
			return {};
	}
}
