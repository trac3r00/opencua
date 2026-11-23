import { beforeEach, describe, expect, it } from "bun:test";
import { vi } from "@opencua/test-support";

const koffiMock = vi.hoisted(() => {
	const sourceReference = { type: "source" };
	const keyboardEvent = { type: "keyboard" };
	const mouseEvent = { type: "mouse" };
	const cursorEvent = { type: "cursor" };

	const coreFoundationFunctions = {
		CFGetTypeID: vi.fn(),
		CFRetain: vi.fn(),
		CFStringCreateWithCString: vi.fn(),
		CFStringGetLength: vi.fn(),
		CFStringGetMaximumSizeForEncoding: vi.fn(),
		CFStringGetCString: vi.fn(),
		CFArrayCreate: vi.fn(),
		CFArrayGetCount: vi.fn(),
		CFArrayGetValueAtIndex: vi.fn(),
		CFStringGetTypeID: vi.fn(),
		CFNumberGetTypeID: vi.fn(),
		CFNumberGetValue: vi.fn(),
		CFBooleanGetTypeID: vi.fn(),
		CFBooleanGetValue: vi.fn(),
		CFArrayGetTypeID: vi.fn(() => 6),
		CFNullGetTypeID: vi.fn(() => 7),
		CFRelease: vi.fn(),
	};

	const coreGraphicsFunctions = {
		CGEventSourceCreate: vi.fn(() => sourceReference),
		CGEventCreate: vi.fn(() => cursorEvent),
		CGEventCreateMouseEvent: vi.fn(() => mouseEvent),
		CGEventCreateKeyboardEvent: vi.fn(() => keyboardEvent),
		CGEventCreateScrollWheelEvent: vi.fn(() => ({ type: "scroll" })),
		CGEventKeyboardSetUnicodeString: vi.fn(),
		CGEventSetFlags: vi.fn(),
		CGEventSetType: vi.fn(),
		CGEventSetIntegerValueField: vi.fn(),
		CGEventSetTimestamp: vi.fn(),
		CGEventSetLocation: vi.fn(),
		CGEventGetLocation: vi.fn(() => ({ x: 10.4, y: 20.6 })),
		CGEventPost: vi.fn(),
		CGEventPostToPid: vi.fn(),
		CGWarpMouseCursorPosition: vi.fn(() => 0),
	};

	const systemFunctions = {
		clock_gettime_nsec_np: vi.fn(() => 123n),
	};

	function libraryFor(path: string | null) {
		if (path === "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics") {
			return coreGraphicsFunctions;
		}
		if (path === "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation") {
			return coreFoundationFunctions;
		}
		if (path === null) {
			return systemFunctions;
		}
		throw new Error(`Unexpected library: ${String(path)}`);
	}

	return {
		coreFoundationFunctions,
		coreGraphicsFunctions,
		keyboardEvent,
		mouseEvent,
		sourceReference,
		module: {
			load: vi.fn((path: string | null) => ({
				func: vi.fn((name: string | number) => {
					const nativeFunctions = libraryFor(path);
					const nativeFunction = nativeFunctions[String(name) as keyof typeof nativeFunctions];
					if (nativeFunction === undefined) {
						throw new Error(`Unexpected native function: ${String(name)}`);
					}
					return nativeFunction;
				}),
			})),
			opaque: vi.fn(() => ({ type: "opaque" })),
			pointer: vi.fn((name: unknown) => ({ type: "pointer", name })),
			struct: vi.fn((_name: string, members: object) => ({ type: "struct", members })),
		},
	};
});

const skyLightMock = vi.hoisted(() => ({
	postBackgroundEventRecordToWindowOwner: vi.fn(() => true),
	postCoreGraphicsEventToWindowOwner: vi.fn(),
	postAuthenticatedSkyLightEventToPid: vi.fn(() => true),
	postSkyLightEventToPid: vi.fn(),
	setSkyLightIntegerField: vi.fn(),
	setSkyLightWindowLocation: vi.fn(),
}));

vi.mock("koffi", () => koffiMock.module);
vi.mock("./appkit.js", () => ({
	createNSEventBackedMouseEvent: vi.fn(() => koffiMock.mouseEvent),
}));
vi.mock("./skylight.js", () => ({
	postBackgroundEventRecordToWindowOwner: skyLightMock.postBackgroundEventRecordToWindowOwner,
	postCoreGraphicsEventToWindowOwner: skyLightMock.postCoreGraphicsEventToWindowOwner,
	postAuthenticatedSkyLightEventToPid: skyLightMock.postAuthenticatedSkyLightEventToPid,
	postSkyLightEventToPid: skyLightMock.postSkyLightEventToPid,
	setSkyLightIntegerField: skyLightMock.setSkyLightIntegerField,
	setSkyLightWindowLocation: skyLightMock.setSkyLightWindowLocation,
}));

describe("#given CoreGraphics koffi bindings", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		skyLightMock.postAuthenticatedSkyLightEventToPid.mockReset().mockReturnValue(true);
		skyLightMock.postCoreGraphicsEventToWindowOwner.mockReset().mockReturnValue(true);
	});

	describe("#when posting mouse events without a target pid", () => {
		it("#then refuses the global HID event tap and releases the event", async () => {
			const { postMouseEvent } = await import("./coregraphics.js");

			expect(() =>
				postMouseEvent({
					kind: "down",
					position: { x: 100, y: 200 },
					button: "right",
					clickState: 1,
					targetPid: undefined,
				}),
			).toThrow(/global-input cannot operate on the human desktop/);

			expect(koffiMock.coreGraphicsFunctions.CGEventCreateMouseEvent).toHaveBeenCalledWith(
				koffiMock.sourceReference,
				3,
				{ x: 100, y: 200 },
				1,
			);
			expect(koffiMock.coreGraphicsFunctions.CGEventSetIntegerValueField).toHaveBeenCalledWith(
				koffiMock.mouseEvent,
				1,
				1,
			);
			expect(koffiMock.coreGraphicsFunctions.CGEventPost).not.toHaveBeenCalled();
			expect(koffiMock.coreFoundationFunctions.CFRelease).toHaveBeenCalledWith(koffiMock.mouseEvent);
		});
	});

	describe("#when posting mouse events to a known target window", () => {
		it("#then stamps SkyLight window metadata and single-posts through SkyLight", async () => {
			const { postMouseEvent } = await import("./coregraphics.js");

			postMouseEvent({
				kind: "down",
				position: { x: 100, y: 200 },
				button: "left",
				clickState: 1,
				targetPid: 4321,
				targetWindow: { id: 99, bounds: { x: 80, y: 170, width: 400, height: 300 } },
			});

			expect(skyLightMock.setSkyLightWindowLocation).toHaveBeenCalledWith(koffiMock.mouseEvent, { x: 20, y: 30 });
			expect(skyLightMock.setSkyLightIntegerField).toHaveBeenCalledWith(koffiMock.mouseEvent, 40, 4321);
			expect(skyLightMock.postSkyLightEventToPid).toHaveBeenCalledWith(4321, koffiMock.mouseEvent);
			expect(skyLightMock.postCoreGraphicsEventToWindowOwner).not.toHaveBeenCalled();
			expect(koffiMock.coreGraphicsFunctions.CGEventPostToPid).not.toHaveBeenCalled();
		});
	});

	describe("#when posting to a verified notification-layer window", () => {
		it("#then posts one background record without a global or duplicate post", async () => {
			const { postMouseEvent } = await import("./coregraphics.js");

			postMouseEvent({
				kind: "down",
				position: { x: 1858, y: 78 },
				button: "left",
				clickState: 1,
				targetPid: 496,
				targetWindow: { id: 11, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, layer: 21 },
			});

			expect(skyLightMock.postCoreGraphicsEventToWindowOwner).not.toHaveBeenCalled();
			expect(skyLightMock.postAuthenticatedSkyLightEventToPid).not.toHaveBeenCalled();
			expect(skyLightMock.postSkyLightEventToPid).not.toHaveBeenCalled();
			expect(skyLightMock.postBackgroundEventRecordToWindowOwner).toHaveBeenCalledTimes(1);
			expect(skyLightMock.postBackgroundEventRecordToWindowOwner).toHaveBeenCalledWith(
				{ id: 11, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, layer: 21 },
				koffiMock.mouseEvent,
			);
			expect(koffiMock.coreGraphicsFunctions.CGEventSetIntegerValueField).not.toHaveBeenCalledWith(
				koffiMock.mouseEvent,
				7,
				3,
			);
			expect(koffiMock.coreGraphicsFunctions.CGEventPost).not.toHaveBeenCalled();
			expect(koffiMock.coreGraphicsFunctions.CGWarpMouseCursorPosition).not.toHaveBeenCalled();
		});

		it("#then a rejected record stops input without another transport", async () => {
			const { postMouseEvent } = await import("./coregraphics.js");
			skyLightMock.postBackgroundEventRecordToWindowOwner.mockReturnValueOnce(false);
			expect(() =>
				postMouseEvent({
					kind: "down",
					position: { x: 1858, y: 78 },
					button: "left",
					clickState: 1,
					targetPid: 496,
					targetWindow: { id: 11, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, layer: 21 },
				}),
			).toThrow("failed to post notification-window mouse record without foreground activation");
			expect(skyLightMock.postSkyLightEventToPid).not.toHaveBeenCalled();
			expect(skyLightMock.postCoreGraphicsEventToWindowOwner).not.toHaveBeenCalled();
			expect(koffiMock.coreGraphicsFunctions.CGEventPost).not.toHaveBeenCalled();
		});
	});

	describe("#when posting a targeted mouse event", () => {
		it("#then it does not warp the real cursor per event", async () => {
			const { postMouseEvent } = await import("./coregraphics.js");

			postMouseEvent({
				kind: "down",
				position: { x: 100, y: 200 },
				button: "left",
				clickState: 1,
				targetPid: 4321,
				targetWindow: { id: 99, bounds: { x: 80, y: 170, width: 400, height: 300 } },
			});

			expect(koffiMock.coreGraphicsFunctions.CGWarpMouseCursorPosition).not.toHaveBeenCalled();
		});

		it("#then untargeted events are refused and leave the real cursor alone", async () => {
			const { postMouseEvent } = await import("./coregraphics.js");

			expect(() =>
				postMouseEvent({
					kind: "down",
					position: { x: 100, y: 200 },
					button: "left",
					clickState: 1,
					targetPid: undefined,
				}),
			).toThrow(/global-input cannot operate on the human desktop/);

			expect(koffiMock.coreGraphicsFunctions.CGWarpMouseCursorPosition).not.toHaveBeenCalled();
			expect(koffiMock.coreGraphicsFunctions.CGEventPost).not.toHaveBeenCalled();
		});
	});

	describe("#when explicitly warping the cursor position", () => {
		it("#then refuses before any CoreGraphics warp", async () => {
			const { warpCursorPosition } = await import("./coregraphics.js");

			expect(() => warpCursorPosition({ x: 33, y: 44 })).toThrow(
				/physical-pointer cannot operate on the human desktop/,
			);

			expect(koffiMock.coreGraphicsFunctions.CGWarpMouseCursorPosition).not.toHaveBeenCalled();
		});
	});

	describe("#when posting mouse events to a pid without a known window", () => {
		it("#then refuses to fall back to the public pid post", async () => {
			const { postMouseEvent } = await import("./coregraphics.js");

			expect(() =>
				postMouseEvent({
					kind: "down",
					position: { x: 100, y: 200 },
					button: "left",
					clickState: 1,
					targetPid: 4321,
				}),
			).toThrow("targeted mouse input requires a target window");

			expect(koffiMock.coreGraphicsFunctions.CGEventPostToPid).not.toHaveBeenCalled();
			expect(skyLightMock.postSkyLightEventToPid).not.toHaveBeenCalled();
		});
	});

	describe("#when posting scroll events to a pid without a known window", () => {
		it("#then refuses to fall back to the public pid post", async () => {
			const { postScrollEvent } = await import("./coregraphics.js");

			expect(() => postScrollEvent({ deltaX: 0, deltaY: -2, targetPid: 4321 })).toThrow(
				"targeted scroll input requires a target window",
			);

			expect(koffiMock.coreGraphicsFunctions.CGEventPostToPid).not.toHaveBeenCalled();
			expect(skyLightMock.postSkyLightEventToPid).not.toHaveBeenCalled();
		});
	});

	describe("#when posting one targeted scroll event to a window", () => {
		it("#then it is delivered exactly once, through the per-pid SkyLight post only", async () => {
			const { postScrollEvent } = await import("./coregraphics.js");

			postScrollEvent({
				deltaX: 0,
				deltaY: -3,
				targetPid: 4321,
				targetWindow: { id: 99, bounds: { x: 80, y: 170, width: 400, height: 300 } },
				position: { x: 200, y: 300 },
			});

			const scrollEvent = koffiMock.coreGraphicsFunctions.CGEventCreateScrollWheelEvent.mock.results[0]?.value;
			expect(skyLightMock.postSkyLightEventToPid).toHaveBeenCalledTimes(1);
			expect(skyLightMock.postSkyLightEventToPid).toHaveBeenCalledWith(4321, scrollEvent);
			expect(skyLightMock.postCoreGraphicsEventToWindowOwner).not.toHaveBeenCalled();
			expect(skyLightMock.postAuthenticatedSkyLightEventToPid).not.toHaveBeenCalled();
			expect(koffiMock.coreGraphicsFunctions.CGEventPostToPid).not.toHaveBeenCalled();
			expect(koffiMock.coreGraphicsFunctions.CGEventPost).not.toHaveBeenCalled();
			expect(skyLightMock.setSkyLightWindowLocation).toHaveBeenCalledWith(scrollEvent, { x: 120, y: 130 });
		});
	});

	describe("#when posting a targeted mouse event with held modifiers", () => {
		it("#then the flags are in the NSEvent behind it and on the CGEvent", async () => {
			const { createNSEventBackedMouseEvent } = await import("./appkit.js");
			const { K_CG_EVENT_FLAG_MASK_COMMAND, postMouseEvent } = await import("./coregraphics.js");

			postMouseEvent({
				kind: "down",
				position: { x: 100, y: 200 },
				button: "left",
				clickState: 1,
				targetPid: 4321,
				targetWindow: { id: 99, bounds: { x: 80, y: 170, width: 400, height: 300 } },
				flags: K_CG_EVENT_FLAG_MASK_COMMAND,
			});

			expect(createNSEventBackedMouseEvent).toHaveBeenCalledWith(
				1,
				{ x: 100, y: 200 },
				K_CG_EVENT_FLAG_MASK_COMMAND,
				99,
				1,
			);
			expect(koffiMock.coreGraphicsFunctions.CGEventSetFlags).toHaveBeenCalledWith(
				koffiMock.mouseEvent,
				K_CG_EVENT_FLAG_MASK_COMMAND,
			);
		});

		it("#then an event without modifiers leaves the flags alone", async () => {
			const { createNSEventBackedMouseEvent } = await import("./appkit.js");
			const { postMouseEvent } = await import("./coregraphics.js");

			postMouseEvent({
				kind: "down",
				position: { x: 100, y: 200 },
				button: "left",
				clickState: 1,
				targetPid: 4321,
				targetWindow: { id: 99, bounds: { x: 80, y: 170, width: 400, height: 300 } },
			});

			expect(createNSEventBackedMouseEvent).toHaveBeenCalledWith(1, { x: 100, y: 200 }, 0, 99, 1);
			expect(koffiMock.coreGraphicsFunctions.CGEventSetFlags).not.toHaveBeenCalled();
		});
	});

	describe("#when posting a modifier key change", () => {
		it("#then it is a flagsChanged event carrying the new modifier state", async () => {
			const { K_CG_EVENT_FLAG_MASK_SHIFT, postKeyboardEvent } = await import("./coregraphics.js");

			postKeyboardEvent({
				keyCode: 56,
				keyDown: true,
				flags: K_CG_EVENT_FLAG_MASK_SHIFT,
				text: undefined,
				targetPid: 4321,
				targetWindow: { id: 99, bounds: { x: 80, y: 170, width: 400, height: 300 } },
				flagsChanged: true,
			});

			expect(koffiMock.coreGraphicsFunctions.CGEventSetType).toHaveBeenCalledWith(koffiMock.keyboardEvent, 12);
			expect(koffiMock.coreGraphicsFunctions.CGEventSetFlags).toHaveBeenCalledWith(
				koffiMock.keyboardEvent,
				K_CG_EVENT_FLAG_MASK_SHIFT,
			);
		});

		it("#then an ordinary key event keeps its key type", async () => {
			const { postKeyboardEvent } = await import("./coregraphics.js");

			postKeyboardEvent({
				keyCode: 0,
				keyDown: true,
				flags: 0,
				text: undefined,
				targetPid: 4321,
				targetWindow: { id: 99, bounds: { x: 80, y: 170, width: 400, height: 300 } },
			});

			expect(koffiMock.coreGraphicsFunctions.CGEventSetType).not.toHaveBeenCalled();
		});
	});

	describe("#when posting a scroll event with held modifiers at a point", () => {
		it("#then the wheel event carries the flags and location while the untargeted post is refused", async () => {
			const { K_CG_EVENT_FLAG_MASK_ALTERNATE, postScrollEvent } = await import("./coregraphics.js");

			expect(() =>
				postScrollEvent({
					deltaX: 0,
					deltaY: -4,
					targetPid: undefined,
					flags: K_CG_EVENT_FLAG_MASK_ALTERNATE,
					position: { x: 300, y: 400 },
				}),
			).toThrow(/global-input cannot operate on the human desktop/);

			const scrollEvent = koffiMock.coreGraphicsFunctions.CGEventCreateScrollWheelEvent.mock.results[0]?.value;
			expect(koffiMock.coreGraphicsFunctions.CGEventSetFlags).toHaveBeenCalledWith(
				scrollEvent,
				K_CG_EVENT_FLAG_MASK_ALTERNATE,
			);
			expect(koffiMock.coreGraphicsFunctions.CGEventSetLocation).toHaveBeenCalledWith(scrollEvent, {
				x: 300,
				y: 400,
			});
			expect(koffiMock.coreGraphicsFunctions.CGEventPost).not.toHaveBeenCalled();
		});
	});

	describe("#when reading the cursor position", () => {
		it("#then returns the location from a temporary CGEvent", async () => {
			const { getCurrentCursorPosition } = await import("./coregraphics.js");

			const position = getCurrentCursorPosition();

			expect(position).toEqual({ x: 10.4, y: 20.6 });
		});
	});
});
