import { AsyncLocalStorage } from "node:async_hooks";
import type { Point, Rect } from "../types/index.js";

/**
 * The part of a shared window one worker may touch, in global screen points. Set by the coordinator around a confined
 * worker's dispatch and read by the lowest input layer, so a pointer event or keystroke outside it is refused right
 * before it would be posted, whatever moved in between.
 */
const regions = new AsyncLocalStorage<Readonly<Rect>>();

/** Raised when input would land outside the confined worker's region; nothing of that event was posted. */
export class InputOutsideRegion extends Error {
	readonly code = "INPUT_OUTSIDE_WORKER_REGION";

	constructor(detail: string) {
		super(`${detail}, outside the worker's region; nothing was posted for it`);
		this.name = "InputOutsideRegion";
	}
}

/** Run `action` with `region` (global screen points) confining every pointer event and keystroke it posts. */
export function withInputRegion<T>(region: Rect, action: () => T): T {
	return regions.run(Object.freeze({ ...region }), action);
}

export function currentInputRegion(): Readonly<Rect> | undefined {
	return regions.getStore();
}

/** Half-open: the right and bottom edges belong to the next region. */
function contains(region: Readonly<Rect>, point: Point): boolean {
	return (
		point.x >= region.x &&
		point.x < region.x + region.width &&
		point.y >= region.y &&
		point.y < region.y + region.height
	);
}

/**
 * The start of a pointer path for a confined flow: a point outside the region is moved to the nearest point inside it,
 * so the animated travel toward an in-region target never sweeps through other workers' parts of the window.
 */
export function clampToInputRegion(point: Point): Point {
	const region = currentInputRegion();
	if (region === undefined || contains(region, point)) return point;
	return {
		x: Math.max(region.x, Math.min(region.x + Math.max(0, region.width - 1), point.x)),
		y: Math.max(region.y, Math.min(region.y + Math.max(0, region.height - 1), point.y)),
	};
}

/** Refuses a pointer event outside the current region; no-op when the flow is not confined. */
export function assertPointInInputRegion(point: Point, what: string): void {
	const region = currentInputRegion();
	if (region === undefined || contains(region, point)) return;
	throw new InputOutsideRegion(`${what} at (${Math.round(point.x)}, ${Math.round(point.y)})`);
}

/**
 * Refuses a keystroke whose focused element is not inside the current region: keys go wherever focus is, so another
 * worker's click elsewhere in the window would otherwise send this worker's typing into that worker's area. A focus
 * that cannot be read is refused too. No-op when the flow is not confined.
 */
export function assertFocusInInputRegion(readFocusedFrame: () => Rect | undefined): void {
	assertElementInInputRegion(readFocusedFrame, "keyboard input to the focused element");
}

/**
 * Refuses an accessibility change (a value, a selection, an action, a scroll) to an element whose centre is not inside
 * the current region, or whose frame cannot be read. The frame is read only when the flow is confined.
 */
export function assertElementInInputRegion(readFrame: () => Rect | undefined, what: string): void {
	const region = currentInputRegion();
	if (region === undefined) return;
	const frame = readFrame();
	if (frame === undefined || !(frame.width > 0 && frame.height > 0)) {
		throw new InputOutsideRegion(`${what} with no readable frame`);
	}
	const center = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
	if (!contains(region, center)) {
		throw new InputOutsideRegion(`${what} centred at (${Math.round(center.x)}, ${Math.round(center.y)})`);
	}
}
