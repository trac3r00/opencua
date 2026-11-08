import { beforeEach, describe, expect, it } from "bun:test";
import { vi } from "@opencua/test-support";

const accessibilityMock = vi.hoisted(() => ({
	extractAccessibilityTree: vi.fn(),
	focusedWindowIdForPid: vi.fn(() => undefined),
	performActionByIndex: vi.fn(),
	setValueByIndex: vi.fn(),
}));

const inputControllerMock = vi.hoisted(() => {
	class MockMacOSInputController {
		readonly setTarget = vi.fn();
		readonly click = vi.fn<(position: { x: number; y: number }) => Promise<void>>().mockResolvedValue(undefined);
		readonly pressKey = vi
			.fn<
				(key: string, options?: { modifiers?: Array<"command" | "option" | "control" | "shift"> }) => Promise<void>
			>()
			.mockResolvedValue(undefined);
		readonly typeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
		readonly showKeyboard = vi.fn();
		readonly close = vi.fn();
	}

	const instances: MockMacOSInputController[] = [];
	return {
		instances,
		MacOSInputController: class extends MockMacOSInputController {
			constructor() {
				super();
				instances.push(this);
			}
		},
	};
});

vi.mock("./macos-ffi/accessibility.js", () => accessibilityMock);
vi.mock("./macos-input.js", () => ({
	MacOSInputController: inputControllerMock.MacOSInputController,
}));

const { MacOSHostComputer } = await import("./macos.js");

beforeEach(() => {
	accessibilityMock.extractAccessibilityTree.mockReset();
	accessibilityMock.performActionByIndex.mockReset();
	accessibilityMock.setValueByIndex.mockReset();
	inputControllerMock.instances.length = 0;
});

function firstInputController(): (typeof inputControllerMock.instances)[number] {
	const controller = inputControllerMock.instances[0];
	if (controller === undefined) {
		throw new Error("expected MacOSInputController instance");
	}
	return controller;
}

const HOST_REFUSAL = /host-window cannot operate on the human desktop/;

describe("#given MacOSHostComputer.setValue on the human desktop #when called #then it is refused before any write or input", () => {
	it("refuses before the accessibility write and keyboard feedback", async () => {
		// given
		const computer = new MacOSHostComputer();

		// when
		await expect(computer.setValue(1234, 7, "updated")).rejects.toThrow(HOST_REFUSAL);

		// then
		expect(accessibilityMock.setValueByIndex).not.toHaveBeenCalled();
		expect(firstInputController().showKeyboard).not.toHaveBeenCalled();
	});

	it("never falls back to synthetic keyboard input that would hijack the user", async () => {
		// given
		const computer = new MacOSHostComputer();

		// when
		await expect(computer.setValue(1234, 7, "updated")).rejects.toThrow(HOST_REFUSAL);

		// then
		const input = firstInputController();
		expect(input.click).not.toHaveBeenCalled();
		expect(input.pressKey).not.toHaveBeenCalled();
		expect(input.typeText).not.toHaveBeenCalled();
		expect(input.setTarget).not.toHaveBeenCalled();
	});
});

describe("#given background delivery #when AXRaise is requested #then no window is raised", () => {
	it("refuses before accessibility dispatch or keyboard feedback", async () => {
		const computer = new MacOSHostComputer();
		try {
			// On the shared host every action is refused first; either refusal keeps the window where it is.
			await expect(computer.performAction(1234, 7, "AXRaise")).rejects.toThrow(/foreground|human desktop/);
			expect(accessibilityMock.performActionByIndex).not.toHaveBeenCalled();
			expect(firstInputController().showKeyboard).not.toHaveBeenCalled();
		} finally {
			await computer.close();
		}
	});
});
