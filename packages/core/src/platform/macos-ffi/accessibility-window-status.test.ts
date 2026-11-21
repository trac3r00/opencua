import { beforeEach, describe, expect, it } from "bun:test";
import { vi } from "@opencua/test-support";

const koffiMock = vi.hoisted(() => {
	type Reference = {
		readonly type: string;
		value?: string;
		readonly children?: Reference[];
	};

	const minimizedValue: Reference = { type: "boolean", value: "true" };
	const windowElement: Reference = { type: "ax" };
	const applicationElement: Reference = { type: "ax" };
	const coreFoundationFunctions = {
		CFGetTypeID: vi.fn((reference: Reference) =>
			reference.type === "boolean" ? 3 : reference.type === "array" ? 6 : 4,
		),
		CFRetain: vi.fn((reference: Reference) => reference),
		CFStringCreateWithCString: vi.fn((_allocator: null, value: string) => ({ type: "string", value })),
		CFStringGetLength: vi.fn((reference: Reference) => reference.value?.length ?? 0),
		CFStringGetMaximumSizeForEncoding: vi.fn((length: number) => length * 4),
		CFStringGetCString: vi.fn((reference: Reference, buffer: Buffer) => {
			buffer.write(reference.value ?? "", "utf8");
			return true;
		}),
		CFArrayCreate: vi.fn((_allocator: null, values: readonly Reference[] | null) => ({
			type: "array",
			children: values ?? [],
		})),
		CFStringGetTypeID: vi.fn(() => 1),
		CFNumberGetTypeID: vi.fn(() => 2),
		CFNumberGetValue: vi.fn(),
		CFBooleanGetTypeID: vi.fn(() => 3),
		CFBooleanGetValue: vi.fn((reference: Reference) => reference.value === "true"),
		CFArrayGetTypeID: vi.fn(() => 6),
		CFNullGetTypeID: vi.fn(() => 7),
		CFArrayGetCount: vi.fn((reference: Reference) => reference.children?.length ?? 0),
		CFArrayGetValueAtIndex: vi.fn((reference: Reference, index: number) => reference.children?.[index] ?? null),
		CFRelease: vi.fn(),
	};
	function copyAttributeValue(element: Reference, attribute: Reference, outValue: Array<Reference | null>): number {
		if (attribute.value === "AXWindows") {
			outValue[0] = { type: "array", children: element === applicationElement ? [windowElement] : [] };
			return 0;
		}
		if (attribute.value === "AXMinimized") {
			outValue[0] = minimizedValue;
			return 0;
		}
		return -25205;
	}
	const accessibilityFunctions = {
		AXIsProcessTrusted: vi.fn(() => true),
		AXUIElementCreateApplication: vi.fn(() => applicationElement),
		AXUIElementSetMessagingTimeout: vi.fn(() => 0),
		AXUIElementGetTypeID: vi.fn(() => 4),
		AXValueGetTypeID: vi.fn(() => 5),
		AXValueGetType: vi.fn(),
		AXValueGetValue: vi.fn(),
		AXUIElementCreateSystemWide: vi.fn(() => ({ type: "ax" })),
		AXUIElementCopyElementAtPosition: vi.fn(),
		AXUIElementGetPid: vi.fn(),
		AXUIElementPerformAction: vi.fn(),
		AXUIElementSetAttributeValue: vi.fn(() => 0),
		AXValueCreate: vi.fn(() => ({ type: "axvalue" })),
		AXUIElementCopyActionNames: vi.fn(),
		AXUIElementCopyMultipleAttributeValues: vi.fn(),
		AXUIElementCopyAttributeValue: vi.fn(copyAttributeValue),
		_AXUIElementGetWindow: vi.fn((element: Reference, outWindowId: Uint32Array) => {
			if (element !== windowElement) return -25205;
			outWindowId[0] = 42;
			return 0;
		}),
	};

	return {
		accessibilityFunctions,
		copyAttributeValue,
		applicationElement,
		coreFoundationFunctions,
		minimizedValue,
		windowElement,
		module: {
			load: vi.fn((path: string) => ({
				func: vi.fn((name: string | number) => {
					const source = String(name);
					const match = source.match(/(?:\s|^)([A-Za-z_][A-Za-z0-9_]*)\(/);
					const functions = path.includes("ApplicationServices.framework")
						? accessibilityFunctions
						: coreFoundationFunctions;
					const nativeFunction = functions[(match?.[1] ?? source) as keyof typeof functions];
					if (nativeFunction === undefined) throw new Error(`Unexpected native function: ${source}`);
					return nativeFunction;
				}),
			})),
			opaque: vi.fn(() => ({ type: "opaque" })),
			pointer: vi.fn((name: unknown) => ({ type: "pointer", name })),
		},
	};
});

vi.mock("koffi", () => koffiMock.module);
const openWindows = vi.hoisted(() => ({ listing: [] as readonly unknown[] }));
vi.mock("../macos-open-windows.js", () => ({ openWindowsForTargeting: async () => openWindows.listing }));

beforeEach(() => {
	vi.clearAllMocks();
	koffiMock.minimizedValue.value = "true";
	koffiMock.accessibilityFunctions.AXUIElementCopyAttributeValue.mockImplementation(koffiMock.copyAttributeValue);
});

describe("#given mocked accessibility windows", () => {
	it("#when an off-Space window is exposed only as AXFocusedWindow #then its minimized state is still verified", async () => {
		const { windowMinimizedForPid } = await import("./accessibility.js");
		koffiMock.minimizedValue.value = "false";
		koffiMock.accessibilityFunctions.AXUIElementCopyAttributeValue.mockImplementation(
			(element, attribute, outValue) => {
				if (attribute.value === "AXWindows") {
					outValue[0] = { type: "array", children: [] };
					return 0;
				}
				if (element === koffiMock.applicationElement && attribute.value === "AXFocusedWindow") {
					outValue[0] = koffiMock.windowElement;
					return 0;
				}
				return koffiMock.copyAttributeValue(element, attribute, outValue);
			},
		);

		expect(windowMinimizedForPid(process.pid, 42)).toBe(false);
		expect(windowMinimizedForPid(process.pid, 99)).toBeUndefined();
		expect(koffiMock.coreFoundationFunctions.CFRelease).toHaveBeenCalledWith(koffiMock.windowElement);
	});
	it("#when an inactive app's off-Space window is exposed only as AXFocusedWindow #then set_window_frame resizes it", async () => {
		const { setWindowFrame } = await import("../macos-window-frame.js");
		const requested = { x: 10, y: 20, width: 800, height: 600 };
		openWindows.listing = [{ id: 42, owner: { processId: process.pid }, bounds: requested }];
		koffiMock.accessibilityFunctions.AXUIElementCopyAttributeValue.mockImplementation(
			(element, attribute, outValue) => {
				if (attribute.value === "AXWindows") {
					outValue[0] = { type: "array", children: [] };
					return 0;
				}
				if (element === koffiMock.applicationElement && attribute.value === "AXFocusedWindow") {
					outValue[0] = koffiMock.windowElement;
					return 0;
				}
				return koffiMock.copyAttributeValue(element, attribute, outValue);
			},
		);

		const result = await setWindowFrame(process.pid, 42, requested);

		expect(result.verified).toBe(true);
		expect(koffiMock.accessibilityFunctions.AXUIElementSetAttributeValue).toHaveBeenCalledWith(
			koffiMock.windowElement,
			expect.anything(),
			expect.anything(),
		);
	});

	it("#when the window is minimized #then returns true and releases copied references", async () => {
		const { windowMinimizedForPid } = await import("./accessibility.js");
		koffiMock.coreFoundationFunctions.CFRelease.mockClear();

		expect(windowMinimizedForPid(process.pid, 42)).toBe(true);
		expect(koffiMock.coreFoundationFunctions.CFRelease).toHaveBeenCalledWith(koffiMock.minimizedValue);
		expect(koffiMock.coreFoundationFunctions.CFRelease).toHaveBeenCalledWith(koffiMock.windowElement);
		expect(koffiMock.coreFoundationFunctions.CFRelease).toHaveBeenCalledWith(koffiMock.applicationElement);
	});

	it("#when the window is not minimized #then returns false", async () => {
		koffiMock.minimizedValue.value = "false";
		const { windowMinimizedForPid } = await import("./accessibility.js");

		expect(windowMinimizedForPid(process.pid, 42)).toBe(false);
	});

	it("#when the attribute or matching window is missing #then returns undefined", async () => {
		const { windowMinimizedForPid } = await import("./accessibility.js");
		koffiMock.accessibilityFunctions.AXUIElementCopyAttributeValue.mockImplementation(
			(element, attribute, outValue) => {
				if (attribute.value === "AXWindows") {
					outValue[0] = {
						type: "array",
						children: element === koffiMock.applicationElement ? [koffiMock.windowElement] : [],
					};
					return 0;
				}
				return -25205;
			},
		);

		expect(windowMinimizedForPid(process.pid, 42)).toBeUndefined();
		expect(windowMinimizedForPid(process.pid, 99)).toBeUndefined();
	});

	it("#when the attribute is not a CFBoolean #then returns undefined", async () => {
		const { windowMinimizedForPid } = await import("./accessibility.js");
		koffiMock.accessibilityFunctions.AXUIElementCopyAttributeValue.mockImplementation(
			(element, attribute, outValue) => {
				if (attribute.value === "AXWindows") {
					outValue[0] = {
						type: "array",
						children: element === koffiMock.applicationElement ? [koffiMock.windowElement] : [],
					};
					return 0;
				}
				outValue[0] = { type: "string", value: "true" };
				return 0;
			},
		);

		expect(windowMinimizedForPid(process.pid, 42)).toBeUndefined();
	});
});
