import type { DisplayInventoryEntry } from "../accessibility/types.js";
import type { ManagedDisplaySpaces } from "./macos-ffi/sls-spaces.js";

/** A display a window overlaps, with the overlap in square points. */
export interface DisplayOverlap {
	readonly display: DisplayInventoryEntry;
	readonly area: number;
}

/** A runner-up display within this share of the largest overlap holds about as much of the window. */
const AMBIGUOUS_OVERLAP_SHARE = 0.1;

/** The displays a window overlaps in global points, the one holding most of it first. */
export function displayOverlaps(
	window: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
	displays: readonly DisplayInventoryEntry[] | undefined,
): readonly DisplayOverlap[] {
	if (displays === undefined) {
		return [];
	}
	return displays
		.map((display) => {
			const width = Math.min(window.x + window.width, display.x + display.width) - Math.max(window.x, display.x);
			const height = Math.min(window.y + window.height, display.y + display.height) - Math.max(window.y, display.y);
			return { display, area: Math.max(0, width) * Math.max(0, height) };
		})
		.filter(({ area }) => area > 0)
		.sort((left, right) => right.area - left.area);
}

/** Whether the window straddles its top two displays about evenly, so neither clearly owns it. */
export function overlapIsAmbiguous(overlaps: readonly DisplayOverlap[]): boolean {
	const [first, second] = overlaps;
	return (
		first !== undefined && second !== undefined && first.area - second.area <= first.area * AMBIGUOUS_OVERLAP_SHARE
	);
}

/**
 * The Space each display shows now, by display id. The WindowServer names displays by UUID; with "Displays have
 * separate Spaces" off it lists one entry for all of them, which then answers for every display.
 */
export function activeSpacesByDisplay(
	displayIds: readonly number[],
	uuidOf: (displayId: number) => string | undefined,
	managed: readonly ManagedDisplaySpaces[],
): ReadonlyMap<number, number> {
	const shared = managed.length === 1 ? managed[0] : undefined;
	const active = new Map<number, number>();
	for (const id of displayIds) {
		const uuid = uuidOf(id)?.toUpperCase();
		const entry = managed.find((candidate) => candidate.displayIdentifier.toUpperCase() === uuid) ?? shared;
		if (entry !== undefined) active.set(id, entry.currentSpaceId);
	}
	return active;
}
