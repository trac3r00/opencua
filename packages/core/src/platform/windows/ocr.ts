import type { OcrTextEntry } from "../../accessibility/types.js";
import { WindowsHostError } from "./transport.js";
import * as wire from "./wire.js";

/**
 * The helper's "ocr" reply (word boxes in pixels of an image of the whole window, plus that
 * window's screen bounds) as screen-frame entries: one per nonblank line, its frame the union of
 * its words, scaled from image pixels onto the window bounds. Windows.Media.Ocr reports no
 * confidence, so every entry says 1.
 */
export function readWindowsOcr(response: unknown): OcrTextEntry[] {
	const result = wire.record(response);
	const width = wire.number(result["width"]);
	const height = wire.number(result["height"]);
	const bounds = wire.rect(result["bounds"]);
	if (width <= 0 || height <= 0 || bounds.width <= 0 || bounds.height <= 0) {
		throw new WindowsHostError("PROTOCOL", "OCR image or window has an empty size");
	}
	const scaleX = bounds.width / width;
	const scaleY = bounds.height / height;
	const entries: OcrTextEntry[] = [];
	for (const item of wire.array(result["lines"])) {
		const line = wire.record(item);
		const text = line["text"];
		if (typeof text !== "string") throw new WindowsHostError("PROTOCOL", "OCR line has no text");
		const boxes = wire.array(line["words"]).map((word) => {
			const box = wire.rect(word);
			if (box.width < 0 || box.height < 0) throw new WindowsHostError("PROTOCOL", "OCR word box is negative");
			return box;
		});
		if (text.trim() === "" || boxes.length === 0) continue;
		const left = Math.min(...boxes.map((box) => box.x));
		const top = Math.min(...boxes.map((box) => box.y));
		const right = Math.max(...boxes.map((box) => box.x + box.width));
		const bottom = Math.max(...boxes.map((box) => box.y + box.height));
		entries.push({
			text,
			confidence: 1,
			frame: {
				x: bounds.x + left * scaleX,
				y: bounds.y + top * scaleY,
				width: (right - left) * scaleX,
				height: (bottom - top) * scaleY,
			},
		});
	}
	return entries;
}
