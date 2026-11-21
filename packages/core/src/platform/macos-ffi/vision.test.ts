import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	type OcrTextObservation,
	clampRecognitionRegion,
	filterByMinimumConfidence,
	offsetObservations,
	readImagePixelSize,
	recognizeTextInFile,
	recognizeTextInImage,
} from "./vision.js";

// Hosted GitHub macOS runners are VMs with no Neural Engine and no real GPU. Their Vision answers differently:
// arm64 runners quantize confidence to 0.5 and box a cropped read loosely, and the macOS 15 Intel runner crashes
// inside the recognizer. The live reads below therefore run on real Macs only, which includes every local run.
const realMac = process.platform === "darwin" && process.env["GITHUB_ACTIONS"] !== "true";

const fixture = (name: string): string => fileURLToPath(new URL(`../../../test/fixtures/${name}`, import.meta.url));

const oneByOne = fixture("ocr-sample-1x.png");
const twoByOne = fixture("ocr-sample-2x.png");

function find(observations: readonly OcrTextObservation[], text: string): OcrTextObservation {
	const hit = observations.find((observation) => observation.text === text);
	if (hit === undefined) {
		throw new Error(`${text} was not recognised; saw ${JSON.stringify(observations.map((o) => o.text))}`);
	}
	return hit;
}

function center(box: OcrTextObservation["box"]): { readonly x: number; readonly y: number } {
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

describe.if(realMac)(
	"#given a fixture rendered with known text at known anchors #when Vision OCR reads it #then the strings come back with tap-ready pixel boxes",
	() => {
		it("recognises every line the generator drew, in image pixel space with a top-left origin", () => {
			const observations = recognizeTextInFile(oneByOne);

			const first = find(observations, "ZQX-4471");
			const second = find(observations, "Settings");
			const third = find(observations, "Wi-Fi");

			expect(first.confidence).toBeGreaterThan(0.5);
			// The generator drew ZQX-4471 with its baseline 110px from the top of an 800x400 image.
			// A bottom-left origin (Vision's own convention) would land it near y=290 instead.
			const firstCenter = center(first.box);
			expect(firstCenter.x).toBeGreaterThan(60);
			expect(firstCenter.x).toBeLessThan(280);
			expect(firstCenter.y).toBeGreaterThan(60);
			expect(firstCenter.y).toBeLessThan(130);
			expect(first.box.width).toBeGreaterThan(100);

			// Top-to-bottom reading order is what the top-left conversion has to preserve.
			expect(center(second.box).y).toBeGreaterThan(firstCenter.y);
			expect(center(third.box).y).toBeGreaterThan(center(second.box).y);
		});

		it("reports pixel coordinates, so the same layout at backing scale 2 doubles every box", () => {
			const first = find(recognizeTextInFile(oneByOne), "ZQX-4471");
			const firstAt2x = find(recognizeTextInFile(twoByOne), "ZQX-4471");

			expect(firstAt2x.box.width / first.box.width).toBeGreaterThan(1.9);
			expect(firstAt2x.box.width / first.box.width).toBeLessThan(2.1);
			const ratio = center(firstAt2x.box).y / center(first.box).y;
			expect(ratio).toBeGreaterThan(1.9);
			expect(ratio).toBeLessThan(2.1);
		});

		it("reports the decoded pixel size, which is the scale a box has to be divided by", () => {
			expect(readImagePixelSize(readFileSync(oneByOne))).toEqual({ width: 800, height: 400 });
			expect(readImagePixelSize(readFileSync(twoByOne))).toEqual({ width: 1600, height: 800 });
		});

		it("reads the same fixture from raw bytes as it does from a path", () => {
			const fromPath = recognizeTextInFile(oneByOne)
				.map((observation) => observation.text)
				.sort();
			const fromBytes = recognizeTextInImage(readFileSync(oneByOne))
				.map((observation) => observation.text)
				.sort();

			expect(fromBytes).toEqual(fromPath);
		});
	},
);

function intersectionOverUnion(
	left: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
	right: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
): number {
	const width = Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x);
	const height = Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y);
	const shared = Math.max(0, width) * Math.max(0, height);
	return shared / (left.width * left.height + right.width * right.height - shared);
}

describe.if(realMac)(
	"#given a region of the image #when Vision OCR reads it #then only that region is read and boxes stay in whole-image pixels",
	() => {
		it("returns the text inside the region at the same pixels as an uncropped read, and nothing outside it", () => {
			const bytes = readFileSync(twoByOne);
			const whole = find(recognizeTextInImage(bytes), "ZQX-4471");
			// Vision clips a line's box to a crop's edge and pads it by context, so the margin is a third of the line
			// height and the boxes are compared by overlap: a cut-out box left in crop pixels lands about 100 px away.
			const margin = Math.round(whole.box.height / 3);
			const region = {
				x: whole.box.x - margin,
				y: whole.box.y - margin,
				width: whole.box.width + 2 * margin,
				height: whole.box.height + 2 * margin,
			};

			const cropped = recognizeTextInImage(bytes, { region });

			const hit = find(cropped, "ZQX-4471");
			expect(intersectionOverUnion(hit.box, whole.box)).toBeGreaterThan(0.6);
			expect(cropped.map((observation) => observation.text)).not.toContain("Wi-Fi");
			for (const observation of cropped) {
				expect(observation.box.y).toBeGreaterThanOrEqual(region.y - 2);
				expect(observation.box.y + observation.box.height).toBeLessThanOrEqual(region.y + region.height + 2);
			}
		});

		it("reads nothing from a region that holds no text", () => {
			const blank = recognizeTextInImage(readFileSync(oneByOne), {
				region: { x: 700, y: 300, width: 90, height: 90 },
			});

			expect(blank).toEqual([]);
		});

		it("refuses a region that does not overlap the image instead of reading the whole image", () => {
			expect(() =>
				recognizeTextInImage(readFileSync(oneByOne), { region: { x: 5000, y: 5000, width: 10, height: 10 } }),
			).toThrow(/does not overlap/i);
		});
	},
);

describe("#given a recognition region #when it is clamped and boxes are moved back #then the pixel grid is exact", () => {
	it("clamps to the image and rounds outward to whole pixels", () => {
		expect(clampRecognitionRegion({ x: -5, y: 2.5, width: 20.2, height: 10 }, 100, 100)).toEqual({
			x: 0,
			y: 2,
			width: 16,
			height: 11,
		});
		expect(clampRecognitionRegion({ x: 90, y: 90, width: 50, height: 50 }, 100, 100)).toEqual({
			x: 90,
			y: 90,
			width: 10,
			height: 10,
		});
	});

	it("is undefined when nothing of the region is inside the image", () => {
		expect(clampRecognitionRegion({ x: 100, y: 0, width: 10, height: 10 }, 100, 100)).toBeUndefined();
		expect(clampRecognitionRegion({ x: -20, y: 0, width: 20, height: 10 }, 100, 100)).toBeUndefined();
	});

	it("adds the region origin to every box and leaves an uncropped read untouched", () => {
		const read: readonly OcrTextObservation[] = [
			{ text: "a", confidence: 1, box: { x: 1, y: 2, width: 3, height: 4 } },
		];

		expect(offsetObservations(read, { x: 10, y: 20, width: 50, height: 50 })[0]?.box).toEqual({
			x: 11,
			y: 22,
			width: 3,
			height: 4,
		});
		expect(offsetObservations(read, undefined)).toBe(read);
	});
});

describe("#given observations of mixed confidence #when the minimum-confidence filter runs #then only the confident ones survive", () => {
	const observations: readonly OcrTextObservation[] = [
		{ text: "blurry", confidence: 0.2, box: { x: 0, y: 0, width: 10, height: 10 } },
		{ text: "sharp", confidence: 0.8, box: { x: 20, y: 0, width: 10, height: 10 } },
	];

	it("drops observations below the minimum and keeps the boundary value", () => {
		expect(filterByMinimumConfidence(observations, 0.5).map((observation) => observation.text)).toEqual(["sharp"]);
		expect(filterByMinimumConfidence(observations, 0.2)).toHaveLength(2);
		expect(filterByMinimumConfidence(observations, 0.9)).toHaveLength(0);
	});

	it("returns the observations untouched when no minimum is asked for", () => {
		expect(filterByMinimumConfidence(observations, undefined)).toBe(observations);
	});
});

describe.if(process.platform === "darwin")(
	"#given bytes that are not an image #when Vision OCR is asked to read them #then it refuses instead of reporting an empty screen",
	() => {
		it("throws a decode error naming the input", () => {
			expect(() => recognizeTextInImage(Buffer.from("this is not a png"))).toThrow(/decode/i);
		});
	},
);
