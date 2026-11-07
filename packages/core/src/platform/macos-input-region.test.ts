import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { vi } from "@opencua/test-support";

const coreGraphicsMock = vi.hoisted(() => ({
	getCurrentCursorPosition: vi.fn(() => ({ x: 1, y: 2 })),
	postKeyboardEvent: vi.fn(),
	postMouseEvent: vi.fn(),
	postScrollEvent: vi.fn(),
	postUnicodeText: vi.fn(),
	warpCursorPosition: vi.fn(),
}));

const WINDOW = { id: 99, owner: { processId: 1234 }, bounds: { x: 10, y: 20, width: 300, height: 200 } };

vi.mock("get-windows", () => ({ openWindows: () => Promise.resolve([WINDOW]) }));
// Deterministic accessibility: no live Accessibility state decides how these keyboard and pointer paths route.
vi.mock("./macos-ffi/accessibility.js", () => ({
	focusedElementFrame: () => undefined,
	focusedElementInWebArea: () => false,
	focusedWindowIdForPid: () => 99,
	focusedWindowIsModal: () => false,
	focusedWindowShowsFilePanel: () => false,
	raiseWindowInApp: () => true,
	windowIdsAtScreenPoint: () => undefined,
	windowMinimizedForPid: () => false,
	windowTitlesForPid: () => new Map(),
}));
vi.mock("./macos-ffi/lock-screen.js", () => ({ isScreenLocked: () => false }));
vi.mock("./macos-ffi/skylight.js", () => ({
	focusGuardFor: () => null,
	setProcessAppActive: vi.fn(),
	beginFocusWithoutRaise: vi.fn(() => ({ previousPsn: Buffer.alloc(8, 1), targetPsn: Buffer.alloc(8, 2) })),
	frontProcessSerialNumber: vi.fn(() => Buffer.alloc(8, 2)),
	processSerialNumbersMatch: (left: Buffer, right: Buffer) => left.equals(right),
	restoreFrontProcessNoWindows: vi.fn(() => true),
}));
vi.mock("./macos-ffi/coregraphics.js", () => ({
	K_CG_EVENT_FLAG_MASK_ALTERNATE: 0x00080000,
	K_CG_EVENT_FLAG_MASK_COMMAND: 0x00100000,
	K_CG_EVENT_FLAG_MASK_CONTROL: 0x00040000,
	K_CG_EVENT_FLAG_MASK_SHIFT: 0x00020000,
	getCurrentCursorPosition: coreGraphicsMock.getCurrentCursorPosition,
	postKeyboardEvent: coreGraphicsMock.postKeyboardEvent,
	postMouseEvent: coreGraphicsMock.postMouseEvent,
	postScrollEvent: coreGraphicsMock.postScrollEvent,
	postUnicodeText: coreGraphicsMock.postUnicodeText,
	warpCursorPosition: coreGraphicsMock.warpCursorPosition,
}));

const { InputOutsideRegion, withInputRegion } = await import("../computer/input-region.js");
const { MacOSInputController, setFocusedFrameSourceForTesting, setOnscreenWindowIdsSourceForTesting } = await import(
	"./macos-input.js"
);
const { setOpenWindowsSourceForTesting } = await import("./macos-open-windows.js");
setOpenWindowsSourceForTesting(() => undefined);

// The left half of the window, in screen points.
const LEFT_HALF = { x: 10, y: 20, width: 150, height: 200 };
let focused: { x: number; y: number; width: number; height: number } | undefined;

beforeEach(() => {
	vi.clearAllMocks();
	setOnscreenWindowIdsSourceForTesting(() => [99]);
	focused = { x: 40, y: 60, width: 20, height: 10 };
	setFocusedFrameSourceForTesting(() => focused);
});

afterEach(() => {
	setFocusedFrameSourceForTesting(undefined);
});

function controller() {
	return new MacOSInputController(1234, undefined, undefined, undefined, "attended");
}

describe("#given a confined worker's region #when pointer input is posted #then only points inside it go out", () => {
	it("#given a click outside the region #when posted #then it is refused and no mouse event is sent", async () => {
		const input = controller();
		try {
			await expect(withInputRegion(LEFT_HALF, () => input.click({ x: 250, y: 70 }))).rejects.toBeInstanceOf(
				InputOutsideRegion,
			);
			expect(coreGraphicsMock.postMouseEvent).not.toHaveBeenCalled();
		} finally {
			input.close();
		}
	});

	it("#given a click inside the region #when posted #then the mouse events go out", async () => {
		const input = controller();
		try {
			await withInputRegion(LEFT_HALF, () => input.click({ x: 50, y: 70 }));
			expect(coreGraphicsMock.postMouseEvent).toHaveBeenCalled();
		} finally {
			input.close();
		}
	});

	it("#given a drag whose waypoint leaves the region #when posted #then it is refused before any event", async () => {
		const input = controller();
		try {
			await expect(
				withInputRegion(LEFT_HALF, () =>
					input.drag({ from: { x: 30, y: 40 }, to: { x: 60, y: 90 }, waypoints: [{ x: 250, y: 60 }] }),
				),
			).rejects.toBeInstanceOf(InputOutsideRegion);
			expect(coreGraphicsMock.postMouseEvent).not.toHaveBeenCalled();
		} finally {
			input.close();
		}
	});

	it("#given a scroll with no position #when posted #then it lands at the region's centre, not the window's", async () => {
		const input = controller();
		try {
			await input.click({ x: 50, y: 70 });
			vi.clearAllMocks();
			await withInputRegion(LEFT_HALF, () => input.scroll({ direction: "down", amount: 1 }));
			expect(coreGraphicsMock.postScrollEvent).toHaveBeenCalled();
			expect(JSON.stringify(coreGraphicsMock.postScrollEvent.mock.calls[0])).toContain('"x":85,"y":120');
		} finally {
			input.close();
		}
	});
});

describe("#given a confined worker whose pointer rests outside its region #when it clicks inside #then the travel stays inside", () => {
	it("#given the pointer outside the region #when it moves to a point inside #then every posted point lies in the region", async () => {
		const input = controller();
		try {
			await input.click({ x: 280, y: 200 });
			vi.clearAllMocks();
			await withInputRegion(LEFT_HALF, () => input.move({ x: 50, y: 70 }));
			const points = coreGraphicsMock.postMouseEvent.mock.calls.map(
				([event]) => (event as { readonly position: { readonly x: number; readonly y: number } }).position,
			);
			expect(points.length).toBeGreaterThan(0);
			for (const point of points) {
				expect(point.x).toBeGreaterThanOrEqual(LEFT_HALF.x);
				expect(point.x).toBeLessThan(LEFT_HALF.x + LEFT_HALF.width);
				expect(point.y).toBeGreaterThanOrEqual(LEFT_HALF.y);
				expect(point.y).toBeLessThan(LEFT_HALF.y + LEFT_HALF.height);
			}
		} finally {
			input.close();
		}
	});
});

describe("#given text being typed #when focus moves out of the region part-way #then typing stops before the next character", () => {
	it("#given focus that leaves after the first character #when typing #then only that character goes out", async () => {
		const input = controller();
		try {
			await input.click({ x: 50, y: 70 });
			vi.clearAllMocks();
			let reads = 0;
			setFocusedFrameSourceForTesting(() => {
				reads += 1;
				return reads <= 2 ? { x: 40, y: 60, width: 20, height: 10 } : { x: 240, y: 60, width: 20, height: 10 };
			});
			await expect(withInputRegion(LEFT_HALF, () => input.typeText("abc"))).rejects.toBeInstanceOf(
				InputOutsideRegion,
			);
			expect(coreGraphicsMock.postUnicodeText).toHaveBeenCalledTimes(1);
		} finally {
			input.close();
		}
	});
});

describe("#given a confined worker's region #when keys are posted #then the focused element must sit inside it", () => {
	it("#given focus inside the region #when a key is pressed #then the key goes out", async () => {
		const input = controller();
		try {
			await input.click({ x: 50, y: 70 });
			vi.clearAllMocks();
			await withInputRegion(LEFT_HALF, () => input.pressKey("t"));
			expect(coreGraphicsMock.postKeyboardEvent).toHaveBeenCalled();
		} finally {
			input.close();
		}
	});

	it("#given focus moved into another worker's half #when a key or text is posted #then it is refused and nothing is sent", async () => {
		const input = controller();
		try {
			await input.click({ x: 50, y: 70 });
			vi.clearAllMocks();
			focused = { x: 240, y: 60, width: 20, height: 10 };
			await expect(withInputRegion(LEFT_HALF, () => input.pressKey("t"))).rejects.toBeInstanceOf(InputOutsideRegion);
			await expect(withInputRegion(LEFT_HALF, () => input.typeText("hi"))).rejects.toBeInstanceOf(
				InputOutsideRegion,
			);
			focused = undefined;
			await expect(withInputRegion(LEFT_HALF, () => input.pressKey("t"))).rejects.toBeInstanceOf(InputOutsideRegion);
			expect(coreGraphicsMock.postKeyboardEvent).not.toHaveBeenCalled();
			expect(coreGraphicsMock.postUnicodeText).not.toHaveBeenCalled();
		} finally {
			input.close();
		}
	});

	it("#given no region #when focus is anywhere #then keys are not checked", async () => {
		const input = controller();
		try {
			await input.click({ x: 50, y: 70 });
			focused = { x: 240, y: 60, width: 20, height: 10 };
			await input.pressKey("t");
			expect(coreGraphicsMock.postKeyboardEvent).toHaveBeenCalled();
		} finally {
			input.close();
		}
	});
});
