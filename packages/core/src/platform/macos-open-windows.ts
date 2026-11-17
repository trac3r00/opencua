import { openWindows } from "get-windows";
import { isSystemCallHost } from "./macos-call-helpers.js";
import { onlineDisplayBounds } from "./macos-ffi/display-list.js";
import type { ListedWindow } from "./macos-ffi/window-list.js";
import { listWindows } from "./macos-ffi/window-list.js";
import { findRunningApplication } from "./macos-ffi/workspace.js";
import type { MacOSWindowInfo } from "./macos-window-target.js";
import { isOwnedSurfacePid } from "./owned-surfaces.js";

const OPEN_WINDOWS_ATTEMPTS = 3;
const OPEN_WINDOWS_RETRY_DELAY_MILLISECONDS = 30;
/** The helper binary gets a deadline because it can hang, not only fail, when macOS refuses it. */
const BINARY_LISTING_TIMEOUT_MILLISECONDS = 5_000;
/** App windows live at layer 0; menu bar items, Control Centre and drag helpers sit above them. */
const NORMAL_WINDOW_LAYER = 0;
/** opencua-owned surfaces sit one level below normal windows so agent input never raises them over the person's work. */
const OWNED_SURFACE_LAYER = -1;

export interface OpenWindowsSources {
	/** The in-process WindowServer listing; undefined means this build cannot read it. */
	readonly listNative: () => readonly MacOSWindowInfo[] | undefined;
	/** All-Spaces in-process listing; undefined means unsupported or unreadable. */
	readonly listNativeAllSpaces?: () => readonly MacOSWindowInfo[] | undefined;
	/** The helper-binary listing, kept for builds where the in-process binding cannot load. */
	readonly listBinary: () => Promise<readonly MacOSWindowInfo[]>;
}

/**
 * Normal app windows plus Apple's call-banner helpers at notification layer 21.
 * Bundle identity and system path prove the helper, never its localized owner label.
 * Approval and observation guards still apply to the helper's own pid and bundle ID.
 */
export function targetableWindows(
	listed: readonly ListedWindow[],
	applicationForPid: (
		pid: number,
	) => { readonly bundleId: string; readonly path: string } | undefined = findRunningApplication,
): readonly MacOSWindowInfo[] {
	const windows: MacOSWindowInfo[] = [];
	for (const window of listed) {
		if (window.layer !== NORMAL_WINDOW_LAYER) {
			const ownedSurface = window.layer === OWNED_SURFACE_LAYER && isOwnedSurfacePid(window.ownerPid);
			if (window.layer !== 21 && !ownedSurface) {
				continue;
			}
			if (ownedSurface) {
				windows.push({
					id: window.id,
					bounds: window.bounds,
					owner: { processId: window.ownerPid, name: window.ownerName },
					title: window.title,
					layer: window.layer,
				});
				continue;
			}
			const application = applicationForPid(window.ownerPid);
			if (application === undefined || !isSystemCallHost(application.bundleId, application.path)) {
				continue;
			}
		}
		windows.push({
			id: window.id,
			bounds: window.bounds,
			owner: { processId: window.ownerPid, name: window.ownerName },
			title: window.title,
			layer: window.layer,
		});
	}
	return windows;
}

let nativeSourceOverride: (() => readonly MacOSWindowInfo[] | undefined) | undefined;
let nativeAllSpacesSourceOverride: (() => readonly MacOSWindowInfo[] | undefined) | undefined;

/**
 * Test seam in the shape of setOnscreenWindowIdsSourceForTesting: production reads the real
 * WindowServer listing, while a test pins which source answers so its fixtures stay authoritative
 * instead of the machine's actual windows.
 */
export function setOpenWindowsSourceForTesting(
	source: (() => readonly MacOSWindowInfo[] | undefined) | undefined,
	allSpacesSource?: (() => readonly MacOSWindowInfo[] | undefined) | undefined,
): void {
	nativeSourceOverride = source;
	nativeAllSpacesSourceOverride = allSpacesSource;
}

/** The full WindowServer listing for read-only validation of an explicitly observed window. */
export function observedWindowForPid(pid: number, windowId: number): MacOSWindowInfo | undefined {
	const source = nativeAllSpacesSourceOverride ?? nativeSourceOverride ?? listNativeAllSpacesWindows;
	const listed = source();
	return listed?.find((window) => window.id === windowId && window.owner?.processId === pid);
}

function listNativeWindows(): readonly MacOSWindowInfo[] | undefined {
	const listed = listWindows();
	return listed === undefined ? undefined : targetableWindows(listed);
}

async function listBinaryWindows(): Promise<readonly MacOSWindowInfo[]> {
	return await withTimeout(
		openWindowsWithRetry(),
		BINARY_LISTING_TIMEOUT_MILLISECONDS,
		`the get-windows helper did not answer within ${BINARY_LISTING_TIMEOUT_MILLISECONDS} ms; it is a separate process macOS can refuse or kill, so grant Screen Recording to the app that runs this server, or run a build whose in-process window listing loads`,
	);
}

/**
 * On-screen windows for targeting. The in-process WindowServer listing comes first because it
 * asks from this process: under an app bundle it carries that bundle's own grants, while the
 * get-windows helper is a separate identity macOS can refuse — which is how a healthy
 * observation turns into a bare "Command failed" from the helper binary. The binary stays as the
 * fallback for builds where the in-process binding cannot load at all, and an unreadable listing
 * is reported as an error rather than as "nothing is on screen".
 */
export async function openWindowsForTargeting(
	sources: OpenWindowsSources = {
		listNative: nativeSourceOverride ?? listNativeWindows,
		listNativeAllSpaces: nativeAllSpacesSourceOverride ?? listNativeAllSpacesWindows,
		listBinary: listBinaryWindows,
	},
	options: { readonly includeOffscreen?: boolean } = {},
): Promise<readonly MacOSWindowInfo[]> {
	if (options.includeOffscreen === true) {
		if (sources.listNativeAllSpaces === undefined) {
			throw new Error("all-Spaces window listing is unavailable; the helper binary only lists on-screen windows");
		}
		const allSpaces = sources.listNativeAllSpaces();
		if (allSpaces === undefined) {
			throw new Error(
				"all-Spaces WindowServer listing could not be read; the helper binary only lists on-screen windows",
			);
		}
		return allSpaces;
	}
	const native = sources.listNative();
	if (native !== undefined) {
		return native;
	}
	return await sources.listBinary();
}

function listNativeAllSpacesWindows(): readonly MacOSWindowInfo[] | undefined {
	const listed = listWindows({ onScreenOnly: false });
	return listed === undefined
		? undefined
		: targetableWindows(withoutMenuBarStrips(listed, onlineDisplayBounds() ?? []));
}

/** The tallest strip treated as a display's menu bar backing; a real window is taller. */
const MENU_BAR_STRIP_MAX_HEIGHT = 44;

/**
 * macOS keeps a few undrawn, untitled windows per app that span each display's menu bar. The all-Spaces listing
 * reports them as ordinary layer-0 windows, so without this an app showed up with eight phantom targets beside its
 * real window. A window counts as such a strip only while it is off screen and exactly covers a display's top edge.
 */
export function withoutMenuBarStrips(
	listed: readonly ListedWindow[],
	displays: readonly { readonly x: number; readonly y: number; readonly width: number }[],
): readonly ListedWindow[] {
	return listed.filter(
		(window) =>
			window.onScreen !== false ||
			window.title !== "" ||
			window.bounds.height > MENU_BAR_STRIP_MAX_HEIGHT ||
			!displays.some(
				(display) =>
					window.bounds.x === display.x && window.bounds.y === display.y && window.bounds.width === display.width,
			),
	);
}

async function openWindowsWithRetry(): Promise<readonly MacOSWindowInfo[]> {
	let lastError: Error | undefined;
	for (let attempt = 1; attempt <= OPEN_WINDOWS_ATTEMPTS; attempt += 1) {
		try {
			return await openWindows();
		} catch (error) {
			if (!(error instanceof Error)) {
				throw error;
			}
			lastError = error;
			if (attempt < OPEN_WINDOWS_ATTEMPTS) {
				await delayMilliseconds(OPEN_WINDOWS_RETRY_DELAY_MILLISECONDS);
			}
		}
	}
	throw lastError ?? new Error("openWindows was not attempted");
}

async function withTimeout<TValue>(operation: Promise<TValue>, milliseconds: number, message: string): Promise<TValue> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(message)), milliseconds);
			}),
		]);
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	}
}

function delayMilliseconds(milliseconds: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, milliseconds);
	});
}
