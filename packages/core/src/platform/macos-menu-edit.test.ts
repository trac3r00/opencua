import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { vi } from "@opencua/test-support";
import type { MenuKeyEquivalent } from "./macos-menu.js";

const selectText = vi.hoisted(() => ({
	selectAllInFocusedTextElement: vi.fn<(pid: number) => boolean>(() => true),
	selectedTextOfFocusedElement: vi.fn<(pid: number) => string | undefined>(() => "chosen words"),
	replaceSelectionInFocusedTextElement: vi.fn<(pid: number, text: string) => boolean>(() => true),
	selectTextByIndex: vi.fn(),
}));
const pasteboard = vi.hoisted(() => ({
	writeClipboard: vi.fn(),
	readClipboard: vi.fn(() => ({ types: ["public.utf8-plain-text"], text: "from clipboard", fileUrls: [] })),
}));
const menu = vi.hoisted(() => ({
	invokeMenu: vi.fn(async (_pid: number, path: readonly string[]) => ({ resolvedPath: path, action: "AXPress" })),
	normalizeMenuPath: (path: readonly string[]) => path.map((segment) => segment.trim()),
	commandChordMask: vi.fn<() => number | undefined>(() => undefined),
	findMenuKeyEquivalent: vi.fn<() => MenuKeyEquivalent | undefined>(() => undefined),
	applicationIsFrontmost: () => true,
	planBackgroundKeyEquivalent: () => ({ kind: "keys" }),
	pressMenuItem: vi.fn(),
}));
const accessibility = vi.hoisted(() => ({
	extractAccessibilityTree: vi.fn(),
	focusedWindowIdForPid: vi.fn(() => undefined),
	focusedWindowIsModal: vi.fn(() => false),
	focusedWindowShowsFilePanel: vi.fn(() => false),
	focusedElementFrame: vi.fn(() => undefined),
	typeIntoFocusedAXElement: vi.fn(() => true),
	performActionByIndex: vi.fn(),
	setValueByIndex: vi.fn(),
	releaseAccessibilitySnapshot: vi.fn(),
}));
const keyboardFence = vi.hoisted(() => ({
	awaitKeyboardFence: vi.fn(async (_lastInput: number | undefined) => ({ waited: false, events: 0, elapsedMs: 0 })),
	awaitAccessibilityWriteSettled: async () => ({ waited: false, events: 0, elapsedMs: 0 }),
}));

vi.mock("./macos-ffi/select-text.js", () => selectText);
vi.mock("./macos-ffi/pasteboard.js", () => pasteboard);
vi.mock("./macos-menu.js", () => menu);
vi.mock("./macos-ffi/accessibility.js", () => accessibility);
vi.mock("./macos-ffi/ax-observer.js", () => ({
	createAxEventWaiter: () => null,
	waitForAxQuiet: () => ({ quiet: true, events: 0, elapsedMs: 0 }),
}));
vi.mock("./keyboard-fence.js", () => keyboardFence);
vi.mock("./macos-ffi/lock-screen.js", () => ({ isScreenLocked: () => false }));

const { MacOSInputController } = await import("./macos-input.js");
const { MacOSHostComputer } = await import("./macos.js");

const PID = 4242;

afterEach(() => {
	vi.restoreAllMocks();
	menu.commandChordMask.mockReturnValue(undefined);
	menu.findMenuKeyEquivalent.mockReturnValue(undefined);
	accessibility.focusedWindowShowsFilePanel.mockReturnValue(false);
});

describe("#given a background Save panel #when its shortcut overlaps the app menu #then the panel receives it", () => {
	it("routes Go to Folder through native keyboard delivery instead of Find Previous", async () => {
		menu.commandChordMask.mockReturnValue(1);
		menu.findMenuKeyEquivalent.mockReturnValue({ path: ["Edit", "Find", "Find Previous"], enabled: false });
		accessibility.focusedWindowShowsFilePanel.mockReturnValue(true);
		const prepare = vi.spyOn(MacOSInputController.prototype, "prepareKeyboardTarget").mockResolvedValue();
		const press = vi.spyOn(MacOSInputController.prototype, "pressKey").mockResolvedValue();
		const computer = new MacOSHostComputer({ defaultTargetPid: PID, delivery: "background" });

		await computer.key("g", { modifiers: ["command", "shift"] });

		expect(prepare).toHaveBeenCalledOnce();
		expect(menu.findMenuKeyEquivalent).not.toHaveBeenCalled();
		expect(press).toHaveBeenCalledWith("g", { modifiers: ["command", "shift"] });
		await computer.close();
	});
});

describe("#given Edit menu commands that AppKit validates only while its menu is shown", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		selectText.selectedTextOfFocusedElement.mockReturnValue("chosen words");
	});

	it("#when a menu command precedes focused typing #then its completion arms the keyboard readiness fence", async () => {
		const clock = vi.spyOn(performance, "now").mockReturnValue(123);
		const computer = new MacOSHostComputer({ delivery: "background" });
		try {
			await computer.invokeMenu(PID, ["File", "New Folder"]);
			await computer.typeIntoFocused(PID, "bench-folder");

			expect(keyboardFence.awaitKeyboardFence).toHaveBeenCalledWith(123, expect.any(Function), expect.any(Object));
		} finally {
			await computer.close();
			clock.mockRestore();
		}
	});

	it("#when Edit > Copy is invoked #then the focused field's selection goes to the clipboard without opening the menu", async () => {
		const computer = new MacOSHostComputer({ delivery: "background" });

		const result = await computer.invokeMenu(PID, ["Edit", "Copy"]);

		expect(result).toEqual({ resolvedPath: ["Edit", "Copy"], action: "accessibility" });
		expect(pasteboard.writeClipboard).toHaveBeenCalledWith({ type: "text", text: "chosen words" });
		expect(menu.invokeMenu).not.toHaveBeenCalled();
		await computer.close();
	});

	it("#when Edit > Cut is invoked #then the selection is copied and then removed from the field", async () => {
		const computer = new MacOSHostComputer({ delivery: "background" });

		await computer.invokeMenu(PID, ["Edit", "Cut"]);

		expect(pasteboard.writeClipboard).toHaveBeenCalledWith({ type: "text", text: "chosen words" });
		expect(selectText.replaceSelectionInFocusedTextElement).toHaveBeenCalledWith(PID, "");
		await computer.close();
	});

	it("#when Edit > Select All and Paste are invoked #then the field itself is selected and typed into", async () => {
		const computer = new MacOSHostComputer({ delivery: "background" });

		await computer.invokeMenu(PID, ["Edit", "Select All"]);
		await computer.invokeMenu(PID, ["Edit", "Paste"]);

		expect(selectText.selectAllInFocusedTextElement).toHaveBeenCalledWith(PID);
		expect(accessibility.typeIntoFocusedAXElement).toHaveBeenCalledWith(PID, "from clipboard");
		expect(menu.invokeMenu).not.toHaveBeenCalled();
		await computer.close();
	});

	it("#when nothing is selected in a native field #then Copy is handed to the menu, which decides", async () => {
		selectText.selectedTextOfFocusedElement.mockReturnValue(undefined);
		const computer = new MacOSHostComputer({ delivery: "background" });

		await computer.invokeMenu(PID, ["Edit", "Copy"]);

		expect(pasteboard.writeClipboard).not.toHaveBeenCalled();
		expect(menu.invokeMenu).toHaveBeenCalledWith(PID, ["Edit", "Copy"]);
		await computer.close();
	});

	it("#when any other path is invoked #then it is pressed as a menu item", async () => {
		const computer = new MacOSHostComputer({ delivery: "background" });

		const result = await computer.invokeMenu(PID, ["Format", "Font", "Bold"]);

		expect(result.action).toBe("AXPress");
		expect(menu.invokeMenu).toHaveBeenCalledWith(PID, ["Format", "Font", "Bold"]);
		await computer.close();
	});
});
