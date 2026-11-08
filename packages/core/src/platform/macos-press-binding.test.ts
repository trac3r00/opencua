import { beforeEach, describe, expect, it } from "bun:test";
import { vi } from "@opencua/test-support";

const accessibilityMock = vi.hoisted(() => ({
	pressElementAtScreenPoint: vi.fn((_pid: number, _x: number, _y: number, _windowId?: number) => false),
}));

vi.mock("./macos-ffi/accessibility.js", () => accessibilityMock);
vi.mock("./macos-ffi/lock-screen.js", () => ({ isScreenLocked: () => false }));

const { runInInputScope } = await import("../computer/input-scope.js");
const { NOOP_POINTER_OVERLAY } = await import("./macos-ffi/cursor-overlay.js");
const { MacOSHostComputer } = await import("./macos.js");

beforeEach(() => accessibilityMock.pressElementAtScreenPoint.mockClear());

describe("#given an accessibility press at a screen point #when it runs inside a dispatch #then it is held to that dispatch's window", () => {
	it("#given a different default app #when pressing an explicit pid #then the press goes to that pid", async () => {
		const set = vi.fn();
		const computer = new MacOSHostComputer({
			defaultTargetPid: 5678,
			overlay: { ...NOOP_POINTER_OVERLAY, set },
			delivery: "background",
		});
		try {
			await computer.pressAtPosition(1234, { x: 5, y: 6 });
			expect(accessibilityMock.pressElementAtScreenPoint.mock.calls).toEqual([[1234, 5, 6, undefined]]);
		} finally {
			await computer.close();
		}
	});

	it("#when the dispatch is bound to an observed window of the app #then only an element of that window may be pressed", async () => {
		// given
		const computer = new MacOSHostComputer({ overlay: NOOP_POINTER_OVERLAY, delivery: "background" });

		try {
			// when
			await runInInputScope({ target: { pid: 1234, windowId: 12 } }, () =>
				computer.pressAtPosition(1234, { x: 5, y: 6 }),
			);
			await computer.pressAtPosition(1234, { x: 7, y: 8 });
			await runInInputScope({ target: { pid: 5678, windowId: 99 } }, () =>
				computer.pressAtPosition(1234, { x: 9, y: 10 }),
			);

			// then: the bound window rides along for its own app only
			expect(accessibilityMock.pressElementAtScreenPoint.mock.calls).toEqual([
				[1234, 5, 6, 12],
				[1234, 7, 8, undefined],
				[1234, 9, 10, undefined],
			]);
		} finally {
			await computer.close();
		}
	});
});
