import { afterEach, describe, expect, it } from "bun:test";
import { setWindowPlacementSourcesForTesting, windowMinimizedState, windowOnHiddenSpace } from "./window-minimized.js";

afterEach(() => setWindowPlacementSourcesForTesting());

describe("windowMinimizedState #given what accessibility and the WindowServer each know about a window", () => {
	it("#when accessibility answers #then its answer stands", () => {
		setWindowPlacementSourcesForTesting({ minimized: () => true, placement: () => ({ onShownSpace: false }) });
		expect(windowMinimizedState(1, 2)).toBe(true);
		setWindowPlacementSourcesForTesting({ minimized: () => false, placement: () => undefined });
		expect(windowMinimizedState(1, 2)).toBe(false);
	});

	it("#when accessibility is blind and the window sits on a Space no display shows #then it is a live window there", () => {
		setWindowPlacementSourcesForTesting({ minimized: () => undefined, placement: () => ({ onShownSpace: false }) });
		expect(windowMinimizedState(1, 2)).toBe(false);
		expect(windowOnHiddenSpace(2)).toBe(true);
	});

	it("#when accessibility is blind and the window is on a shown Space or on none #then it stays unknown", () => {
		// A minimized window keeps its Space (measured on macOS 26), so a shown Space cannot vouch for it.
		setWindowPlacementSourcesForTesting({ minimized: () => undefined, placement: () => ({ onShownSpace: true }) });
		expect(windowMinimizedState(1, 2)).toBeUndefined();
		expect(windowOnHiddenSpace(2)).toBe(false);
		setWindowPlacementSourcesForTesting({ minimized: () => undefined, placement: () => undefined });
		expect(windowMinimizedState(1, 2)).toBeUndefined();
		expect(windowOnHiddenSpace(2)).toBeUndefined();
	});
});
