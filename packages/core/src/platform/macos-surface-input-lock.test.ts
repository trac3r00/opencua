import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { vi } from "@opencua/test-support";

const SURFACE_PID = 42;
const actualOwnedSurfaces = { ...(await import("./owned-surfaces.js")) };
vi.mock("./owned-surfaces.js", () => ({
	...actualOwnedSurfaces,
	isOwnedSurfacePid: (pid: number) => pid === SURFACE_PID,
}));
vi.mock("./macos-ffi/lock-screen.js", () => ({ isScreenLocked: () => false }));

const { runInInputScope } = await import("../computer/input-scope.js");
const { NOOP_POINTER_OVERLAY } = await import("./macos-ffi/cursor-overlay.js");
const { InputLock } = await import("./input-lock.js");
const { MacOSInputController } = await import("./macos-input.js");
const { MacOSHostComputer } = await import("./macos.js");

describe("#given an opencua-owned surface #when agents send pointer input to it #then no burst waits on the machine-wide input lock", () => {
	let computer: InstanceType<typeof MacOSHostComputer>;
	beforeEach(() => {
		vi.spyOn(InputLock.prototype, "run");
		vi.spyOn(MacOSInputController.prototype, "drag").mockResolvedValue(undefined);
		vi.spyOn(MacOSInputController.prototype, "click").mockResolvedValue(undefined);
		vi.spyOn(MacOSInputController.prototype, "move").mockResolvedValue(undefined);
		vi.spyOn(MacOSInputController.prototype, "scroll").mockResolvedValue(undefined);
		computer = new MacOSHostComputer({ delivery: "background", overlay: NOOP_POINTER_OVERLAY });
	});
	afterEach(async () => {
		await computer.close();
		vi.restoreAllMocks();
	});

	it("delivers drag, click and move to the surface without taking the lock", async () => {
		await runInInputScope({ target: { pid: SURFACE_PID } }, async () => {
			await computer.drag({ from: { x: 10, y: 10 }, to: { x: 40, y: 40 } });
			await computer.click({ x: 12, y: 12 });
			await computer.move({ x: 20, y: 20 });
		});
		expect(MacOSInputController.prototype.drag).toHaveBeenCalledTimes(1);
		expect(MacOSInputController.prototype.click).toHaveBeenCalledTimes(1);
		expect(MacOSInputController.prototype.move).toHaveBeenCalledTimes(1);
		expect(InputLock.prototype.run).not.toHaveBeenCalled();
	});

	it("still takes the lock for scroll, which has no surface channel", async () => {
		await runInInputScope({ target: { pid: SURFACE_PID } }, () =>
			computer.scroll({ direction: "down", amount: 1, position: { x: 12, y: 12 } }),
		);
		expect(InputLock.prototype.run).toHaveBeenCalledTimes(1);
		expect(MacOSInputController.prototype.scroll).toHaveBeenCalledTimes(1);
	});
});
