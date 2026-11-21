import { windowMinimizedForPid } from "./macos-ffi/accessibility.js";
import { managedDisplaySpaces, spacesForWindows } from "./macos-ffi/sls-spaces.js";

export type WindowPlacement = { readonly onShownSpace: boolean };

function placementFromWindowServer(windowId: number): WindowPlacement | undefined {
	const spaces = spacesForWindows([windowId]).get(windowId);
	if (spaces === undefined || spaces.length === 0) return undefined;
	const shown = new Set(managedDisplaySpaces().map((display) => display.currentSpaceId));
	return { onShownSpace: spaces.some((space) => shown.has(space)) };
}

const askAccessibility = (pid: number, windowId: number): boolean | undefined => windowMinimizedForPid(pid, windowId);
let placementSource: (windowId: number) => WindowPlacement | undefined = placementFromWindowServer;
let minimizedSource: (pid: number, windowId: number) => boolean | undefined = askAccessibility;

export function setWindowPlacementSourcesForTesting(
	sources: {
		readonly placement?: (windowId: number) => WindowPlacement | undefined;
		readonly minimized?: (pid: number, windowId: number) => boolean | undefined;
	} = {},
): void {
	placementSource = sources.placement ?? placementFromWindowServer;
	minimizedSource = sources.minimized ?? askAccessibility;
}

/**
 * Whether a window is minimized, as far as can be known. Accessibility answers when it can see the window. macOS hides
 * every window of an inactive app parked on another Space from accessibility, so then the WindowServer decides: a
 * window placed on a Space no display shows is a live window there (a minimized window keeps its Space too, so this
 * cannot tell the two apart; input to a minimized window is ignored by its app). Undefined means unknown.
 */
export function windowMinimizedState(pid: number, windowId: number): boolean | undefined {
	const answered = minimizedSource(pid, windowId);
	if (answered !== undefined) return answered;
	const placement = placementSource(windowId);
	return placement !== undefined && !placement.onShownSpace ? false : undefined;
}

export function windowOnHiddenSpace(windowId: number): boolean | undefined {
	const placement = placementSource(windowId);
	return placement === undefined ? undefined : !placement.onShownSpace;
}
