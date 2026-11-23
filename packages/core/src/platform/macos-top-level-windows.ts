import { windowTitlesForPid } from "./macos-ffi/accessibility.js";
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
	/** A browser's private (incognito) window; set only for apps listed in privacyFor. */
	readonly private?: true;
}

/**
 * Browsers name a private window only in the title they give accessibility ("Page - Brave (Private)", "(Incognito)",
 * "InPrivate", "Private Browsing"); the WindowServer title is the page title alone.
 */
export function isPrivateBrowserTitle(title: string): boolean {
	return /(\((private|incognito)\)|inprivate|private browsing)\s*$/i.test(title.trim());
}

/** Mark the private windows of the apps asked, asking each app's accessibility titles once. */
export function markPrivateWindows(
	windows: readonly TopLevelWindow[],
	privacyFor: readonly number[],
	titlesOfApp: (pid: number) => ReadonlyMap<number, string>,
): readonly TopLevelWindow[] {
	const wanted = new Set(privacyFor);
	const answers = new Map<number, ReadonlyMap<number, string>>();
	return windows.map((window) => {
		if (!wanted.has(window.ownerPid)) {
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
		return isPrivateBrowserTitle(titles.get(window.id) ?? window.title) ? { ...window, private: true } : window;
	});
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
	/** Apps (by pid) whose private browser windows are marked; one accessibility request per app. */
	readonly privacyFor?: readonly number[];
}

/** A source of on-screen top-level windows, as the MCP session consumes it. */
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
	const filled =
		options.titlesFor === undefined ? summaries : fillWindowTitles(summaries, options.titlesFor, windowTitlesForPid);
	const titled =
		options.privacyFor === undefined ? filled : markPrivateWindows(filled, options.privacyFor, windowTitlesForPid);
	return options.withSpaces === true
		? placeOnSpaces(titled, spacesForWindows(titled.map((window) => window.id)), managedDisplaySpaces())
		: titled;
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
