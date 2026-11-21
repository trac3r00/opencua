import type { DisplayInventoryEntry } from "../accessibility/types.js";
import { displayOverlaps } from "./display-placement.js";
import { focusedWindowIdForPid, windowTitlesForPid } from "./macos-ffi/accessibility.js";
import { onlineDisplayInfo } from "./macos-ffi/display-list.js";
import { type ManagedDisplaySpaces, managedDisplaySpaces, spacesForWindows } from "./macos-ffi/sls-spaces.js";
import { openWindowsForTargeting } from "./macos-open-windows.js";

export interface TopLevelWindow {
	readonly id: number;
	readonly ownerPid: number;
	readonly ownerName: string;
	readonly title: string;
	readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
	/** Where the window lives among Spaces; absent when the WindowServer places it on none (unknown or on every Space). */
	readonly space?: WindowSpace;
	/** The display holding most of the window, and its backing scale. */
	readonly displayId?: number;
	readonly scaleFactor?: number;
	/** The window its app reports as focused over accessibility. */
	readonly focused?: true;
}

export interface WindowSpace {
	readonly spaceIds: readonly number[];
	/** On the Space its display shows now; false means it is parked on another Space. */
	readonly current: boolean;
	/** The display that owns the Space, by the WindowServer's display identifier. */
	readonly display?: string;
}

export interface TopLevelWindowOptions {
	/** Include windows on other Spaces when the caller is using background delivery. */
	readonly includeOffscreen?: boolean;
	/**
	 * Apps (by pid, or "all") whose untitled windows get their titles from the apps themselves over
	 * accessibility. The WindowServer hides every window title from a process without Screen Recording,
	 * while each app still names its own windows. It costs one accessibility request per app asked, so a
	 * caller that only compares window ids leaves it out.
	 */
	readonly titlesFor?: "all" | readonly number[];
	/** Say which Space and display each window is on, and whether that Space is the one shown now. */
	readonly withSpaces?: boolean;
	/** Say which display each window is mostly on, and its scale factor. */
	readonly withDisplays?: boolean;
	/** Mark each app's focused window, asking each listed app once over accessibility. */
	readonly withFocus?: boolean;
}

/** A source of on-screen top-level windows, front to back as the WindowServer stacks them, as the MCP session consumes it. */
export type WindowProbe = (options?: TopLevelWindowOptions) => Promise<readonly TopLevelWindow[]>;

/** On-screen top-level windows, for detecting side effects an action caused outside the observed window. */
export async function listTopLevelWindows(options: TopLevelWindowOptions = {}): Promise<readonly TopLevelWindow[]> {
	const windows = await openWindowsForTargeting(undefined, { includeOffscreen: options.includeOffscreen === true });
	const summaries: TopLevelWindow[] = [];
	for (const window of windows) {
		const ownerPid = window.owner?.processId;
		if (ownerPid === undefined) {
			continue;
		}
		summaries.push({
			id: window.id,
			ownerPid,
			ownerName: window.owner?.name ?? "",
			title: window.title ?? "",
			bounds: {
				x: Math.round(window.bounds.x),
				y: Math.round(window.bounds.y),
				width: Math.round(window.bounds.width),
				height: Math.round(window.bounds.height),
			},
		});
	}
	const titled =
		options.titlesFor === undefined ? summaries : fillWindowTitles(summaries, options.titlesFor, windowTitlesForPid);
	const spaced =
		options.withSpaces === true
			? placeOnSpaces(titled, spacesForWindows(titled.map((window) => window.id)), managedDisplaySpaces())
			: titled;
	const displayed = options.withDisplays === true ? placeOnDisplays(spaced, onlineDisplayInfo()) : spaced;
	return options.withFocus === true ? markFocusedWindows(displayed, focusedWindowIdForPid) : displayed;
}

/** Give each window the display holding most of it; a window on no known display is left as it was. */
export function placeOnDisplays(
	windows: readonly TopLevelWindow[],
	displays: readonly DisplayInventoryEntry[] | undefined,
): readonly TopLevelWindow[] {
	return windows.map((window) => {
		const display = displayOverlaps(window.bounds, displays)[0]?.display;
		return display === undefined ? window : { ...window, displayId: display.id, scaleFactor: display.scaleFactor };
	});
}

/** Mark the window each app has focused, asking each app once; an app that cannot answer marks nothing. */
export function markFocusedWindows(
	windows: readonly TopLevelWindow[],
	focusedWindowOf: (pid: number) => number | undefined,
): readonly TopLevelWindow[] {
	const focused = new Map<number, number | undefined>();
	for (const { ownerPid } of windows) {
		if (focused.has(ownerPid)) continue;
		try {
			focused.set(ownerPid, focusedWindowOf(ownerPid));
		} catch {
			focused.set(ownerPid, undefined);
		}
	}
	return windows.map((window) => (focused.get(window.ownerPid) === window.id ? { ...window, focused: true } : window));
}

/** Give each window its Spaces, their display, and whether one of them is the Space its display shows now. */
export function placeOnSpaces(
	windows: readonly TopLevelWindow[],
	spacesByWindow: ReadonlyMap<number, readonly number[]>,
	displays: readonly ManagedDisplaySpaces[],
): readonly TopLevelWindow[] {
	const displayOfSpace = new Map<number, string>();
	const shown = new Set<number>();
	for (const display of displays) {
		shown.add(display.currentSpaceId);
		for (const space of display.spaces) displayOfSpace.set(space.id, display.displayIdentifier);
	}
	return windows.map((window) => {
		const spaceIds = spacesByWindow.get(window.id);
		if (spaceIds === undefined || spaceIds.length === 0) return window;
		const display = spaceIds.map((id) => displayOfSpace.get(id)).find((name) => name !== undefined);
		return {
			...window,
			space: {
				spaceIds,
				current: spaceIds.some((id) => shown.has(id)),
				...(display === undefined ? {} : { display }),
			},
		};
	});
}

/**
 * Give each untitled window of the apps asked for the title its app reports for it. Each app is asked
 * at most once; an app that cannot answer leaves its windows as they were.
 */
export function fillWindowTitles(
	windows: readonly TopLevelWindow[],
	titlesFor: "all" | readonly number[],
	titlesOfApp: (pid: number) => ReadonlyMap<number, string>,
): readonly TopLevelWindow[] {
	const wanted = titlesFor === "all" ? undefined : new Set(titlesFor);
	const answers = new Map<number, ReadonlyMap<number, string>>();
	return windows.map((window) => {
		if (window.title !== "" || (wanted !== undefined && !wanted.has(window.ownerPid))) {
			return window;
		}
		let titles = answers.get(window.ownerPid);
		if (titles === undefined) {
			try {
				titles = titlesOfApp(window.ownerPid);
			} catch {
				titles = new Map();
			}
			answers.set(window.ownerPid, titles);
		}
		const title = titles.get(window.id);
		return title === undefined || title === "" ? window : { ...window, title };
	});
}
