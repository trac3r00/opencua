import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { vi } from "@opencua/test-support";

const koffiMock = vi.hoisted(() => {
	type Reference = {
		readonly type: string;
		readonly value?: string;
		readonly location?: number;
		readonly length?: number;
		children?: Reference[];
		readonly attributes?: Record<string, string>;
		readonly actions?: readonly string[];
		/** The rows a list shows (AXVisibleRows); absent for elements that do not name them. */
		readonly visibleRows?: Reference[];
		windows?: Reference[];
		parent?: Reference | undefined;
		focusedWindow?: Reference | undefined;
	};

	const observableState: {
		fieldValue: string;
		pressCount: number;
		pressedTitles: string[];
		selection: { location: number; length: number } | null;
	} = {
		fieldValue: "initial",
		pressCount: 0,
		pressedTitles: [],
		selection: null,
	};

	const targetButton: Reference = {
		type: "ax",
		attributes: { AXRole: "AXButton", AXTitle: "Target Button" },
		actions: ["AXPress"],
		children: [],
	};
	const textField: Reference = {
		type: "ax",
		attributes: { AXRole: "AXTextField", AXDescription: "Editable", AXValue: "initial" },
		actions: ["AXConfirm"],
		children: [],
	};
	const windowElement: Reference = {
		type: "ax",
		attributes: { AXRole: "AXWindow", AXTitle: "Fixture", AXWindowId: "42" },
		children: [textField, targetButton],
	};
	const hiddenTextField: Reference = {
		type: "ax",
		attributes: { AXRole: "AXTextField", AXTitle: "Hidden Editable" },
		children: [],
	};
	const hiddenButton: Reference = {
		type: "ax",
		attributes: { AXRole: "AXButton", AXTitle: "Hidden Target Button" },
		actions: ["AXPress"],
		children: [],
	};
	const hiddenWindowElement: Reference = {
		type: "ax",
		attributes: { AXRole: "AXWindow", AXTitle: "Hidden Fixture", AXWindowId: "17182" },
		children: [hiddenTextField, hiddenButton],
	};
	const sheetAncestor: Reference = {
		type: "ax",
		attributes: { AXRole: "AXGroup" },
		children: [],
		parent: windowElement,
	};
	const sheetElement: Reference = {
		type: "ax",
		attributes: { AXRole: "AXSheet", AXTitle: "Save", AXWindowId: "420" },
		children: [],
		parent: sheetAncestor,
	};
	const dialogElement: Reference = {
		type: "ax",
		attributes: { AXRole: "AXDialog", AXTitle: "Alert", AXWindowId: "421" },
		children: [],
		parent: windowElement,
	};
	const menuBarElement: Reference = {
		type: "ax",
		attributes: { AXRole: "AXMenuBar", AXTitle: "Menu Bar" },
		children: [],
	};
	const applicationElement: Reference = {
		type: "ax",
		attributes: { AXRole: "AXApplication", AXTitle: "Fixture" },
		children: [windowElement],
		windows: [windowElement],
	};
	const focus: { window: Reference | null } = { window: null };
	const capabilities = { windowIdentity: true };
	const timeout = { operation: "", count: 0 };
	const listRows: Reference[] = ["row-0", "row-1", "row-2", "row-3"].map((title) => ({
		type: "ax",
		attributes: { AXRole: "AXRow", AXTitle: title },
		actions: ["AXPress"],
		children: [],
	}));
	/** An outline that holds four rows and shows the middle two. */
	const outlineElement: Reference = {
		type: "ax",
		attributes: { AXRole: "AXOutline", AXTitle: "list" },
		children: listRows,
		visibleRows: listRows.slice(1, 3),
	};
	const insertedPrefix: Reference = {
		type: "ax",
		attributes: { AXRole: "AXButton", AXTitle: "Inserted Prefix" },
		actions: ["AXPress"],
		children: [],
	};

	const coreFoundationFunctions = {
		CFGetTypeID: vi.fn((reference: Reference) =>
			reference.type === "ax" ? 4 : reference.type === "string" ? 1 : reference.type === "null" ? 7 : 6,
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
		CFArrayGetCount: vi.fn((reference: Reference) => reference.children?.length ?? 0),
		CFArrayGetValueAtIndex: vi.fn((reference: Reference, index: number) => reference.children?.[index] ?? null),
		CFStringGetTypeID: vi.fn(() => 1),
		CFNumberGetTypeID: vi.fn(() => 2),
		CFNumberGetValue: vi.fn(),
		CFBooleanGetTypeID: vi.fn(() => 3),
		CFBooleanGetValue: vi.fn(),
		CFArrayGetTypeID: vi.fn(() => 6),
		CFNullGetTypeID: vi.fn(() => 7),
		CFRelease: vi.fn(),
	};

	const accessibilityFunctions = {
		AXIsProcessTrusted: vi.fn(() => true),
		AXUIElementCreateApplication: vi.fn(() => applicationElement),
		AXUIElementCreateSystemWide: vi.fn(),
		AXUIElementSetMessagingTimeout: vi.fn(() => 0),
		AXUIElementCopyElementAtPosition: vi.fn(),
		AXUIElementGetPid: vi.fn(),
		AXUIElementGetTypeID: vi.fn(() => 4),
		AXValueGetTypeID: vi.fn(() => 5),
		AXValueGetType: vi.fn(),
		AXValueGetValue: vi.fn(),
		AXValueCreate: vi.fn((_type: number, buffer: Buffer) => ({
			type: "range",
			location: Number(buffer.readBigInt64LE(0)),
			length: Number(buffer.readBigInt64LE(8)),
		})),
		AXUIElementPerformAction: vi.fn((element: Reference, action: Reference) => {
			if (action.value === undefined || !element.actions?.includes(action.value)) return -25206;
			if (element === targetButton && action.value === "AXPress") observableState.pressCount += 1;
			if (action.value === "AXPress") observableState.pressedTitles.push(element.attributes?.["AXTitle"] ?? "");
			return 0;
		}),
		AXUIElementSetAttributeValue: vi.fn((element: Reference, attribute: Reference, value: Reference) => {
			if (element !== textField) return -25205;
			if (attribute.value === "AXValue" && value.value !== undefined) {
				observableState.fieldValue = value.value;
				if (textField.attributes !== undefined) textField.attributes["AXValue"] = value.value;
				return 0;
			}
			if (attribute.value === "AXSelectedTextRange" && value.location !== undefined && value.length !== undefined) {
				observableState.selection = { location: value.location, length: value.length };
				return 0;
			}
			return -25205;
		}),
		AXUIElementCopyAttributeValue: vi.fn(
			(element: Reference, attribute: Reference, outValue: Array<Reference | null>) => {
				if (
					(timeout.operation === "scope" && attribute.value === "AXWindows") ||
					(timeout.operation === "single" && element === textField) ||
					(timeout.operation === "visible" && attribute.value === "AXVisibleRows")
				) {
					timeout.count += 1;
					return -25204;
				}
				if (attribute.value === "AXFocusedWindow" && element.focusedWindow !== undefined) {
					outValue[0] = element.focusedWindow;
					return 0;
				}
				if (element === applicationElement && attribute.value === "AXFocusedWindow") {
					outValue[0] = focus.window;
					return focus.window === null ? -25205 : 0;
				}
				if (attribute.value === "AXParent") {
					outValue[0] = element.parent ?? null;
					return element.parent === undefined ? -25205 : 0;
				}
				if (attribute.value === "AXChildren") {
					outValue[0] = { type: "array", children: element.children ?? [] };
					return 0;
				}
				if (attribute.value === "AXWindows" && element.windows !== undefined) {
					outValue[0] = { type: "array", children: element.windows };
					return 0;
				}
				if (attribute.value === "AXVisibleRows" && element.visibleRows !== undefined) {
					outValue[0] = { type: "array", children: element.visibleRows };
					return 0;
				}
				const value = attribute.value === undefined ? undefined : element.attributes?.[attribute.value];
				if (value === undefined) return -25205;
				outValue[0] = { type: "string", value };
				return 0;
			},
		),
		AXUIElementCopyActionNames: vi.fn((element: Reference, outActions: Array<Reference | null>) => {
			if (timeout.operation === "actions" && element === textField) {
				timeout.count += 1;
				return -25204;
			}
			outActions[0] = {
				type: "array",
				children: element.actions?.map((value) => ({ type: "string", value })) ?? [],
			};
			return 0;
		}),
		AXUIElementCopyMultipleAttributeValues: vi.fn(
			(element: Reference, attributes: Reference, _options: number, outValues: Array<Reference | null>) => {
				if (element === textField) {
					if (timeout.operation === "batch") {
						timeout.count += 1;
						return -25204;
					}
					if (timeout.operation === "single") return -25205;
				}
				const requested = attributes.children ?? [];
				outValues[0] = {
					type: "array",
					children: requested.map((attribute) => valueForAttribute(element, attribute.value)),
				};
				return 0;
			},
		),
		_AXUIElementGetWindow: vi.fn((element: Reference, outWindowId: Uint32Array) => {
			const windowId = element.attributes?.["AXWindowId"];
			if (windowId === undefined) return -25205;
			outWindowId[0] = Number(windowId);
			return 0;
		}),
	};

	function valueForAttribute(element: Reference, attribute: string | undefined): Reference {
		if (attribute === "AXChildren") {
			return { type: "array", children: element.children ?? [] };
		}
		const value = attribute === undefined ? undefined : element.attributes?.[attribute];
		return value === undefined ? { type: "null" } : { type: "string", value };
	}

	function libraryFor(path: string) {
		if (path.includes("ApplicationServices.framework")) return accessibilityFunctions;
		if (path.includes("CoreFoundation.framework")) return coreFoundationFunctions;
		throw new Error(`Unexpected library: ${path}`);
	}

	return {
		accessibilityFunctions,
		applicationElement,
		coreFoundationFunctions,
		focus,
		insertedPrefix,
		menuBarElement,
		outlineElement,
		observableState,
		targetButton,
		textField,
		windowElement,
		hiddenWindowElement,
		capabilities,
		timeout,
		sheetAncestor,
		sheetElement,
		dialogElement,
		module: {
			load: vi.fn((path: string) => ({
				func: vi.fn((name: string | number) => {
					const source = String(name);
					const prototypeMatch = source.match(/\s([A-Za-z_][A-Za-z0-9_]*)\(/);
					const functionName = prototypeMatch?.[1] ?? source;
					if (functionName === "_AXUIElementGetWindow" && !capabilities.windowIdentity) {
						throw new Error("window identity SPI unavailable");
					}
					const library = libraryFor(path);
					const nativeFunction = library[functionName as keyof typeof library];
					if (nativeFunction === undefined) throw new Error(`Unexpected native function: ${functionName}`);
					return nativeFunction;
				}),
			})),
			opaque: vi.fn(() => ({ type: "opaque" })),
			pointer: vi.fn((name: unknown) => ({ type: "pointer", name })),
			out: vi.fn((type: unknown) => ({ type: "out", inner: type })),
		},
	};
});

vi.mock("koffi", () => koffiMock.module);

beforeEach(() => {
	koffiMock.timeout.operation = "";
	koffiMock.timeout.count = 0;
	koffiMock.focus.window = null;
	koffiMock.applicationElement.children = [koffiMock.windowElement];
	koffiMock.applicationElement.windows = [koffiMock.windowElement];
	koffiMock.applicationElement.focusedWindow = undefined;
	koffiMock.windowElement.children = [koffiMock.textField, koffiMock.targetButton];
	koffiMock.textField.children = [];
	koffiMock.windowElement.parent = undefined;
	koffiMock.sheetAncestor.parent = koffiMock.windowElement;
	koffiMock.sheetElement.parent = koffiMock.sheetAncestor;
	koffiMock.observableState.fieldValue = "initial";
	koffiMock.observableState.pressCount = 0;
	koffiMock.observableState.pressedTitles.length = 0;
	koffiMock.observableState.selection = null;
	if (koffiMock.textField.attributes !== undefined) koffiMock.textField.attributes["AXValue"] = "initial";
	if (koffiMock.targetButton.attributes !== undefined) {
		koffiMock.targetButton.attributes["AXRole"] = "AXButton";
		koffiMock.targetButton.attributes["AXTitle"] = "Target Button";
	}
	koffiMock.accessibilityFunctions.AXIsProcessTrusted.mockReturnValue(true);
	koffiMock.accessibilityFunctions.AXUIElementPerformAction.mockClear();
	koffiMock.coreFoundationFunctions.CFRelease.mockClear();
	koffiMock.coreFoundationFunctions.CFRetain.mockClear();
});

afterEach(async () => {
	const { releaseAccessibilitySnapshot } = await import("./accessibility.js");
	releaseAccessibilitySnapshot(process.pid);
});

describe("#given an app that stops answering after its root probe", () => {
	it.each(["batch", "single", "scope", "actions", "visible"])(
		"#when a %s read times out #then the walk fails on the first timeout and releases its references",
		async (operation) => {
			const { extractAccessibilityTree } = await import("./accessibility.js");
			koffiMock.timeout.operation = operation;
			// Action enumeration happens after these children have already been retained.
			koffiMock.textField.children = operation === "visible" ? [koffiMock.outlineElement] : [koffiMock.targetButton];

			expect(() => extractAccessibilityTree(process.pid, { windowId: 42, visibleOnly: true })).toThrow(
				/messaging timeout/,
			);
			expect(koffiMock.timeout.count).toBe(1);
			for (const element of [
				koffiMock.windowElement,
				koffiMock.textField,
				koffiMock.targetButton,
				koffiMock.outlineElement,
				...(koffiMock.outlineElement.children ?? []),
			]) {
				const retained = koffiMock.coreFoundationFunctions.CFRetain.mock.calls.filter(
					([reference]) => reference === element,
				).length;
				const released = koffiMock.coreFoundationFunctions.CFRelease.mock.calls.filter(
					([reference]) => reference === element,
				).length;
				expect(released).toBe(retained);
			}
		},
	);
});

describe("#given an app with a focused window", () => {
	it("#when focus is a sheet with an AXWindow ancestor #then observation resolves to its owner", async () => {
		const { focusedWindowIdsForObservationPid } = await import("./accessibility.js");
		koffiMock.applicationElement.focusedWindow = koffiMock.sheetElement;

		const focused = focusedWindowIdsForObservationPid(process.pid);

		expect(focused).toEqual({ focusedWindowId: 420, sheetOwnerWindowId: 42 });
		expect(koffiMock.coreFoundationFunctions.CFRelease).toHaveBeenCalledWith(koffiMock.sheetElement);
		expect(koffiMock.coreFoundationFunctions.CFRelease).toHaveBeenCalledWith(koffiMock.sheetAncestor);
		expect(koffiMock.coreFoundationFunctions.CFRelease).toHaveBeenCalledWith(koffiMock.windowElement);
	});

	it("#when the sheet has no AXWindow ancestor #then its focused id remains available", async () => {
		const { focusedWindowIdsForObservationPid } = await import("./accessibility.js");
		koffiMock.applicationElement.focusedWindow = koffiMock.sheetElement;
		koffiMock.sheetElement.parent = undefined;

		const focused = focusedWindowIdsForObservationPid(process.pid);

		expect(focused).toEqual({ focusedWindowId: 420, sheetOwnerWindowId: undefined });
		expect(koffiMock.coreFoundationFunctions.CFRelease).toHaveBeenCalledWith(koffiMock.sheetElement);
	});

	it("#when the legacy focused-window lookup sees a sheet #then it keeps returning the sheet id", async () => {
		const { focusedWindowIdForPid } = await import("./accessibility.js");
		koffiMock.applicationElement.focusedWindow = koffiMock.sheetElement;

		const focusedWindowId = focusedWindowIdForPid(process.pid);

		expect(focusedWindowId).toBe(420);
		expect(koffiMock.coreFoundationFunctions.CFRelease).toHaveBeenCalledWith(koffiMock.sheetElement);
		expect(koffiMock.coreFoundationFunctions.CFRelease).not.toHaveBeenCalledWith(koffiMock.windowElement);
	});

	it("#when focus is a dialog #then observation keeps the focused dialog", async () => {
		const { focusedWindowIdsForObservationPid } = await import("./accessibility.js");
		koffiMock.applicationElement.focusedWindow = koffiMock.dialogElement;

		const focused = focusedWindowIdsForObservationPid(process.pid);

		expect(focused).toEqual({ focusedWindowId: 421, sheetOwnerWindowId: undefined });
		expect(koffiMock.coreFoundationFunctions.CFRelease).toHaveBeenCalledWith(koffiMock.dialogElement);
		expect(koffiMock.coreFoundationFunctions.CFRelease).not.toHaveBeenCalledWith(koffiMock.windowElement);
	});
});

describe("#given a window-scoped accessibility walk", () => {
	it("#when an off-Space window is exposed only as AXFocusedWindow #then its controls remain observed and actionable", async () => {
		const { extractAccessibilityTree, performActionByIndex } = await import("./accessibility.js");
		koffiMock.applicationElement.children = [];
		koffiMock.applicationElement.windows = [];
		koffiMock.focus.window = koffiMock.windowElement;

		const state = extractAccessibilityTree(process.pid, { windowId: 42 });
		const button = state.elements.find((element) => element.label === "Target Button");
		expect(state.axAvailable).toBe(true);
		expect(state.windowTitle).toBe("Fixture");
		expect(state.elements.map((element) => element.role)).toEqual(["AXWindow", "AXTextField", "AXButton"]);
		if (button === undefined) throw new Error("focused window button was not observed");
		performActionByIndex(process.pid, button.id, "AXPress");
		expect(koffiMock.observableState.pressCount).toBe(1);
	});

	it("#when the focused off-Space window has a different id #then it is not attributed to the requested window", async () => {
		const { extractAccessibilityTree } = await import("./accessibility.js");
		koffiMock.applicationElement.children = [];
		koffiMock.focus.window = koffiMock.windowElement;

		const state = extractAccessibilityTree(process.pid, { windowId: 999 });
		expect(state.elements).toEqual([]);
		expect(state.axAvailable).toBe(false);
		expect(state.axUnavailable).toBe("app-not-accessible");
		expect(state.windowTitle).toBeUndefined();
	});
	it.each([42, 999])(
		"#when a popup menu is a top-level child and window id is %s #then its items remain observed without the menu bar",
		async (windowId) => {
			const { extractAccessibilityTree, performActionByIndex } = await import("./accessibility.js");
			const menuItem = {
				type: "ax",
				attributes: { AXRole: "AXMenuItem", AXTitle: "Choose" },
				actions: ["AXPress"],
				children: [],
			};
			const menu = {
				type: "ax",
				attributes: { AXRole: "AXMenu", AXTitle: "Context" },
				children: [menuItem],
			};
			koffiMock.applicationElement.children = [koffiMock.windowElement, koffiMock.menuBarElement, menu];

			const scoped = extractAccessibilityTree(process.pid, { windowId });
			const item = scoped.elements.find((element) => element.label === "Choose");

			expect(scoped.elements.map((element) => element.role)).toContain("AXMenu");
			expect(scoped.elements.map((element) => element.role)).not.toContain("AXMenuBar");
			expect(item).toMatchObject({ role: "AXMenuItem", actions: ["AXPress"] });
			if (item === undefined) throw new Error("menu item was not observed");
			performActionByIndex(process.pid, item.id, "AXPress");
			expect(koffiMock.observableState.pressedTitles).toEqual(["Choose"]);
		},
	);

	it("#when the requested window matches #then its observed title is returned with the tree", async () => {
		const { extractAccessibilityTree } = await import("./accessibility.js");

		const scoped = extractAccessibilityTree(process.pid, { windowId: 42 });

		expect(scoped).toHaveProperty("windowTitle", "Fixture");
	});

	it("#when the requested window is absent #then the app's other window is not walked", async () => {
		const { extractAccessibilityTree } = await import("./accessibility.js");
		koffiMock.applicationElement.children = [koffiMock.windowElement, koffiMock.menuBarElement];

		const unavailable = extractAccessibilityTree(process.pid, { windowId: 999 });

		expect(unavailable.elements).toEqual([]);
		expect(unavailable.axAvailable).toBe(false);
		expect(unavailable).not.toHaveProperty("windowTitle");
	});

	it("#when AXWindows supplies a hidden root #then its exact window and controls are walked", async () => {
		const { extractAccessibilityTree, performActionByIndex } = await import("./accessibility.js");
		koffiMock.applicationElement.children = [koffiMock.windowElement];
		koffiMock.applicationElement.windows = [koffiMock.windowElement, koffiMock.hiddenWindowElement];

		const scoped = extractAccessibilityTree(process.pid, { windowId: 17182 });

		expect(scoped.elements.map((element) => element.role)).toEqual(["AXWindow", "AXTextField", "AXButton"]);
		expect(scoped).toHaveProperty("windowTitle", "Hidden Fixture");
		expect(scoped.elements.map((element) => element.label)).toEqual([
			"Hidden Fixture",
			"Hidden Editable",
			"Hidden Target Button",
		]);
		const button = scoped.elements.find((element) => element.label === "Hidden Target Button");
		if (button === undefined) throw new Error("hidden window button was not observed");
		performActionByIndex(process.pid, button.id, "AXPress");
		expect(koffiMock.observableState.pressedTitles).toEqual(["Hidden Target Button"]);
		expect(koffiMock.observableState.pressCount).toBe(0);
	});

	it("#when the window identity SPI is absent #then exact scope stays empty while an explicit unscoped walk works", async () => {
		vi.resetModules();
		koffiMock.capabilities.windowIdentity = false;
		try {
			const { extractAccessibilityTree, releaseAccessibilitySnapshot } = await import("./accessibility.js");
			const scoped = extractAccessibilityTree(process.pid, { windowId: 42 });
			expect(scoped.elements).toEqual([]);
			expect(scoped.axAvailable).toBe(false);
			expect(scoped.windowTitle).toBeUndefined();

			const unscoped = extractAccessibilityTree(process.pid);
			expect(unscoped.elements.some((element) => element.label === "Target Button")).toBe(true);
			releaseAccessibilitySnapshot(process.pid);
		} finally {
			koffiMock.capabilities.windowIdentity = true;
			vi.resetModules();
		}
	});

	it("#when AXWindows misses the requested ID #then no different window is chosen", async () => {
		const { extractAccessibilityTree } = await import("./accessibility.js");
		koffiMock.applicationElement.children = [koffiMock.menuBarElement];
		koffiMock.applicationElement.windows = [koffiMock.hiddenWindowElement];

		const unavailable = extractAccessibilityTree(process.pid, { windowId: 999 });

		expect(unavailable.elements).toEqual([]);
		expect(unavailable.axAvailable).toBe(false);
		expect(unavailable).not.toHaveProperty("windowTitle");
	});

	it("#when AXWindows supplies a hidden root #then its retained reference is released with the snapshot", async () => {
		const { extractAccessibilityTree, releaseAccessibilitySnapshot } = await import("./accessibility.js");
		koffiMock.applicationElement.children = [koffiMock.menuBarElement];
		koffiMock.applicationElement.windows = [koffiMock.hiddenWindowElement];
		const { CFRetain, CFRelease } = koffiMock.coreFoundationFunctions;
		const balance = (element: unknown): number =>
			CFRetain.mock.calls.filter(([reference]) => reference === element).length -
			CFRelease.mock.calls.filter(([reference]) => reference === element).length;

		extractAccessibilityTree(process.pid, { windowId: 17182 });
		releaseAccessibilitySnapshot(process.pid);

		expect(balance(koffiMock.hiddenWindowElement)).toBe(0);
	});

	it("#when the window id matches #then the walk covers that window without the app element or the menu bar", async () => {
		const { extractAccessibilityTree } = await import("./accessibility.js");
		koffiMock.applicationElement.children = [koffiMock.windowElement, koffiMock.menuBarElement];
		koffiMock.windowElement.children = [koffiMock.textField, koffiMock.targetButton];

		const scoped = extractAccessibilityTree(process.pid, { windowId: 42 });

		expect(scoped.elements.map((element) => element.role)).toEqual(["AXWindow", "AXTextField", "AXButton"]);
		expect(scoped.elements.some((element) => element.role === "AXApplication")).toBe(false);
		expect(scoped.elements.some((element) => element.role === "AXMenuBar")).toBe(false);
	});

	it("#when the window id does not match #then the walk is unavailable", async () => {
		const { extractAccessibilityTree } = await import("./accessibility.js");
		koffiMock.applicationElement.children = [koffiMock.windowElement, koffiMock.menuBarElement];

		const unavailable = extractAccessibilityTree(process.pid, { windowId: 999 });

		expect(unavailable.elements).toEqual([]);
		expect(unavailable.axAvailable).toBe(false);
	});

	it("#when the window id does not match and the menu bar is requested #then the walk remains unavailable", async () => {
		const { extractAccessibilityTree } = await import("./accessibility.js");
		koffiMock.applicationElement.children = [koffiMock.windowElement, koffiMock.menuBarElement];

		const unavailable = extractAccessibilityTree(process.pid, { windowId: 999, includeMenuBar: true });

		expect(unavailable.elements).toEqual([]);
		expect(unavailable.axAvailable).toBe(false);
	});

	it.each([
		["matches", 42],
		["does not match", 999],
	])(
		"#when the window id %s #then every top-level child is released exactly as often as it was retained",
		async (_case, windowId) => {
			const { extractAccessibilityTree, releaseAccessibilitySnapshot } = await import("./accessibility.js");
			koffiMock.applicationElement.children = [koffiMock.windowElement, koffiMock.menuBarElement];
			const { CFRetain, CFRelease } = koffiMock.coreFoundationFunctions;
			const balance = (element: unknown): number =>
				CFRetain.mock.calls.filter(([reference]) => reference === element).length -
				CFRelease.mock.calls.filter(([reference]) => reference === element).length;

			extractAccessibilityTree(process.pid, { windowId });
			releaseAccessibilitySnapshot(process.pid);

			expect(balance(koffiMock.windowElement)).toBe(0);
			expect(balance(koffiMock.menuBarElement)).toBe(0);
		},
	);

	it("#when the menu bar is requested #then the scoped walk keeps it", async () => {
		const { extractAccessibilityTree } = await import("./accessibility.js");
		koffiMock.applicationElement.children = [koffiMock.windowElement, koffiMock.menuBarElement];

		const scoped = extractAccessibilityTree(process.pid, { windowId: 42, includeMenuBar: true });

		expect(scoped.elements.map((element) => element.role)).toContain("AXMenuBar");
	});
});

describe("#given a subtree observation #when an element index from the previous walk is drilled into #then only that branch is returned", () => {
	it("#given an observed web control #when its live ancestors are read #then it is distinguished from native chrome", async () => {
		const { extractAccessibilityTree, isWebElementByIndex } = await import("./accessibility.js");
		const webArea = {
			type: "ax",
			attributes: { AXRole: "AXWebArea", AXTitle: "Owned Page" },
			children: [],
		};
		const webButton = {
			type: "ax",
			attributes: { AXRole: "AXButton", AXTitle: "Web Button" },
			actions: ["AXPress"],
			children: [],
			parent: webArea,
		};
		koffiMock.windowElement.children = [webButton, koffiMock.targetButton];
		const state = extractAccessibilityTree(process.pid, { windowId: 42 });
		const web = state.elements.find((element) => element.label === "Web Button");
		const native = state.elements.find((element) => element.label === "Target Button");
		if (web === undefined || native === undefined) throw new Error("fixture controls were not observed");
		expect(isWebElementByIndex(process.pid, web.id)).toBe(true);
		expect(isWebElementByIndex(process.pid, native.id)).toBe(false);
		expect(() => isWebElementByIndex(process.pid, 999)).toThrow();
	});

	it("#given browser layout wrappers #when observed at the default depth #then the nested toolbar remains actionable", async () => {
		const { extractAccessibilityTree, performActionByIndex } = await import("./accessibility.js");
		const button = {
			type: "ax",
			attributes: { AXRole: "AXButton", AXTitle: "Nested Toolbar Action" },
			actions: ["AXPress"],
			children: [],
		};
		let branch: typeof koffiMock.windowElement = button;
		for (let level = 0; level < 14; level += 1) {
			branch = {
				type: "ax",
				attributes: { AXRole: "AXGroup", AXTitle: `Layout ${level}` },
				children: [branch],
			};
		}
		koffiMock.windowElement.children = [branch];
		const state = extractAccessibilityTree(process.pid, { windowId: 42 });
		const target = state.elements.find((element) => element.label === "Nested Toolbar Action");
		expect(state.truncated).toBe(false);
		if (target === undefined) throw new Error("nested toolbar control was omitted");
		performActionByIndex(process.pid, target.id, "AXPress");
		expect(koffiMock.observableState.pressedTitles).toEqual(["Nested Toolbar Action"]);
	});

	it("marks omitted descendants as truncated and reveals deeper controls in a subtree", async () => {
		const { extractAccessibilityTree, performActionByIndex } = await import("./accessibility.js");
		const deepButton = {
			type: "ax",
			attributes: { AXRole: "AXButton", AXTitle: "Deep Button" },
			actions: ["AXPress"],
			children: [],
		};
		const middle = {
			type: "ax",
			attributes: { AXRole: "AXGroup", AXTitle: "Middle" },
			children: [deepButton],
		};
		koffiMock.windowElement.children = [middle];

		const capped = extractAccessibilityTree(process.pid, { windowId: 42, maxDepth: 1 });
		expect(capped.truncated).toBe(true);
		expect(capped.elements.map((element) => element.label)).toEqual(["Fixture", "Middle"]);

		const subtree = extractAccessibilityTree(process.pid, { windowId: 42, subtreeOf: 1 });
		expect(subtree.truncated).toBe(false);
		expect(subtree.elements.map((element) => element.label)).toEqual(["Middle", "Deep Button"]);
		const button = subtree.elements.find((element) => element.label === "Deep Button");
		if (button === undefined) throw new Error("deep button was not observed");
		performActionByIndex(process.pid, button.id, "AXPress");
		expect(koffiMock.observableState.pressedTitles).toEqual(["Deep Button"]);
	});

	it("does not mark a boundary leaf truncated when it has no children", async () => {
		const { extractAccessibilityTree } = await import("./accessibility.js");
		koffiMock.windowElement.children = [koffiMock.targetButton];

		const observed = extractAccessibilityTree(process.pid, { windowId: 42, maxDepth: 1 });

		expect(observed.truncated).toBe(false);
	});

	it("returns the subtree with ids restarting at zero", async () => {
		const { extractAccessibilityTree } = await import("./accessibility.js");
		const scoped = extractAccessibilityTree(process.pid, { windowId: 42 });
		expect(scoped.elements.map((element) => element.role)).toEqual(["AXWindow", "AXTextField", "AXButton"]);

		const subtree = extractAccessibilityTree(process.pid, { windowId: 42, subtreeOf: 2 });

		expect(subtree.elements.map((element) => element.role)).toEqual(["AXButton"]);
		expect(subtree.elements[0]?.id).toBe(0);
		expect(subtree.elements[0]?.label).toBe("Target Button");
		expect(subtree.walkKey).not.toBe(scoped.walkKey);
	});

	it("keeps the rooted element itself as id zero", async () => {
		const { extractAccessibilityTree } = await import("./accessibility.js");
		extractAccessibilityTree(process.pid, { windowId: 42 });

		const subtree = extractAccessibilityTree(process.pid, { windowId: 42, subtreeOf: 0 });

		expect(subtree.elements.map((element) => element.role)).toEqual(["AXWindow", "AXTextField", "AXButton"]);
	});

	it("re-anchors element ids so a later action resolves inside the subtree", async () => {
		const { extractAccessibilityTree, performActionByIndex } = await import("./accessibility.js");
		extractAccessibilityTree(process.pid, { windowId: 42 });
		extractAccessibilityTree(process.pid, { windowId: 42, subtreeOf: 2 });

		performActionByIndex(process.pid, 0, "AXPress");

		expect(koffiMock.observableState.pressCount).toBe(1);
	});
});

describe("#given a subtree request #when the index is not part of the observation #then it refuses and keeps the snapshot", () => {
	it("rejects an index outside the last walk", async () => {
		const { extractAccessibilityTree, performActionByIndex } = await import("./accessibility.js");
		extractAccessibilityTree(process.pid, { windowId: 42 });

		expect(() => extractAccessibilityTree(process.pid, { windowId: 42, subtreeOf: 99 })).toThrow(
			/not part of the current observation/,
		);

		performActionByIndex(process.pid, 2, "AXPress");
		expect(koffiMock.observableState.pressCount).toBe(1);
	});

	it("rejects a negative index", async () => {
		const { extractAccessibilityTree } = await import("./accessibility.js");
		extractAccessibilityTree(process.pid, { windowId: 42 });

		expect(() => extractAccessibilityTree(process.pid, { windowId: 42, subtreeOf: -1 })).toThrow(/non-negative/);
	});

	it("rejects a subtree request before anything was observed", async () => {
		const { extractAccessibilityTree } = await import("./accessibility.js");

		expect(() => extractAccessibilityTree(process.pid, { subtreeOf: 0 })).toThrow(
			/not part of the current observation/,
		);
	});
});

describe("#given a settle poll #when it runs with a smaller budget #then the observation index space survives", () => {
	it("releases every temporary tree reference without releasing the observation", async () => {
		const { extractAccessibilityTree, releaseAccessibilitySnapshot } = await import("./accessibility.js");
		const { CFRetain, CFRelease } = koffiMock.coreFoundationFunctions;
		extractAccessibilityTree(process.pid, { windowId: 42 });

		extractAccessibilityTree(process.pid, { windowId: 42, signatureOnly: true });
		releaseAccessibilitySnapshot(process.pid);

		for (const element of [koffiMock.windowElement, koffiMock.textField, koffiMock.targetButton]) {
			const retained = CFRetain.mock.calls.filter(([reference]) => reference === element).length;
			const released = CFRelease.mock.calls.filter(([reference]) => reference === element).length;
			expect(retained - released).toBe(0);
		}
	});

	it("keeps element ids and the subtree anchor resolvable", async () => {
		const { extractAccessibilityTree, performActionByIndex } = await import("./accessibility.js");
		const observed = extractAccessibilityTree(process.pid, { windowId: 42 });
		expect(observed.elements).toHaveLength(3);

		const poll = extractAccessibilityTree(process.pid, { windowId: 42, maxElements: 1, signatureOnly: true });
		expect(poll.elements).toHaveLength(1);

		const subtree = extractAccessibilityTree(process.pid, { windowId: 42, subtreeOf: 2 });
		expect(subtree.elements.map((element) => element.role)).toEqual(["AXButton"]);

		performActionByIndex(process.pid, 0, "AXPress");
		expect(koffiMock.observableState.pressCount).toBe(1);
	});
});

describe("#given a snapshot whose control was recycled #when the observed id is acted on #then it is refused instead of acting", () => {
	it("refuses a retained element that now reads as a different control", async () => {
		const { extractAccessibilityTree, performActionByIndex } = await import("./accessibility.js");
		const snapshot = extractAccessibilityTree(process.pid);
		const button = snapshot.elements.find((element) => element.label === "Target Button");
		expect(button).toBeDefined();

		if (koffiMock.targetButton.attributes !== undefined) {
			koffiMock.targetButton.attributes["AXRole"] = "AXStaticText";
			koffiMock.targetButton.attributes["AXTitle"] = "Recycled Row";
		}

		expect(() => performActionByIndex(process.pid, button?.id ?? -1, "AXPress")).toThrow(/not the observed control/);
		expect(koffiMock.observableState.pressCount).toBe(0);
	});

	it("still dispatches when the control is unchanged", async () => {
		const { extractAccessibilityTree, performActionByIndex } = await import("./accessibility.js");
		const snapshot = extractAccessibilityTree(process.pid);
		const button = snapshot.elements.find((element) => element.label === "Target Button");
		expect(button).toBeDefined();

		performActionByIndex(process.pid, button?.id ?? -1, "AXPress");

		expect(koffiMock.observableState.pressCount).toBe(1);
	});
});

describe("#given an observation key #when walks and polls run #then the key tracks the backing snapshot", () => {
	it("changes on a new walk, survives a signature poll, and disappears on release", async () => {
		const { currentObservationKey, extractAccessibilityTree, releaseAccessibilitySnapshot } = await import(
			"./accessibility.js"
		);

		releaseAccessibilitySnapshot(process.pid);
		expect(currentObservationKey(process.pid)).toBeUndefined();

		extractAccessibilityTree(process.pid, { windowId: 42 });
		const first = currentObservationKey(process.pid);
		expect(first).toBeDefined();

		extractAccessibilityTree(process.pid, { windowId: 42, maxElements: 1, signatureOnly: true });
		expect(currentObservationKey(process.pid)).toBe(first);

		extractAccessibilityTree(process.pid, { windowId: 42 });
		expect(currentObservationKey(process.pid)).not.toBe(first);

		releaseAccessibilitySnapshot(process.pid);
		expect(currentObservationKey(process.pid)).toBeUndefined();
	});
});

describe("#given an AX element index from an accessibility snapshot", () => {
	it("#when the live hierarchy shifts #then the action still targets the snapshotted element", async () => {
		const { extractAccessibilityTree, performActionByIndex } = await import("./accessibility.js");
		const snapshot = extractAccessibilityTree(process.pid);
		const button = snapshot.elements.find((element) => element.label === "Target Button");
		expect(button).toBeDefined();

		koffiMock.windowElement.children = [koffiMock.insertedPrefix, koffiMock.textField, koffiMock.targetButton];
		performActionByIndex(process.pid, button?.id ?? -1, "AXPress");

		expect(koffiMock.observableState.pressCount).toBe(1);
	});

	it("#when a live node appears past the snapshot #then an unobserved id is rejected without acting", async () => {
		const { extractAccessibilityTree, performActionByIndex } = await import("./accessibility.js");
		const snapshot = extractAccessibilityTree(process.pid);
		expect(snapshot.elements).toHaveLength(4);

		koffiMock.windowElement.children = [koffiMock.insertedPrefix, koffiMock.textField, koffiMock.targetButton];

		expect(() => performActionByIndex(process.pid, 4, "AXPress")).toThrow("element 4 not found in snapshot");
		expect(koffiMock.accessibilityFunctions.AXUIElementPerformAction).not.toHaveBeenCalled();
	});

	it("#when a cached value target shifts #then the observed field value changes", async () => {
		const { extractAccessibilityTree, setValueByIndex } = await import("./accessibility.js");
		const snapshot = extractAccessibilityTree(process.pid);
		const field = snapshot.elements.find((element) => element.label === "Editable");
		expect(field).toBeDefined();

		koffiMock.windowElement.children = [koffiMock.insertedPrefix, koffiMock.textField, koffiMock.targetButton];
		setValueByIndex(process.pid, field?.id ?? -1, "updated");

		expect(koffiMock.observableState.fieldValue).toBe("updated");
		expect(koffiMock.observableState.pressCount).toBe(0);
	});

	it("#when a cached selection target shifts #then selection applies to the observed field", async () => {
		const { extractAccessibilityTree } = await import("./accessibility.js");
		const { selectTextByIndex } = await import("./select-text.js");
		const snapshot = extractAccessibilityTree(process.pid);
		const field = snapshot.elements.find((element) => element.label === "Editable");
		expect(field).toBeDefined();

		koffiMock.windowElement.children = [koffiMock.insertedPrefix, koffiMock.textField, koffiMock.targetButton];
		selectTextByIndex(process.pid, field?.id ?? -1, { selection: "text", text: "nit" });

		expect(koffiMock.observableState.selection).toEqual({ location: 1, length: 3 });
		expect(koffiMock.observableState.pressCount).toBe(0);
	});

	it("#when AXPress is unsupported #then the native error is preserved and the snapshot remains usable", async () => {
		const { extractAccessibilityTree, performActionByIndex } = await import("./accessibility.js");
		const snapshot = extractAccessibilityTree(process.pid);
		const field = snapshot.elements.find((element) => element.label === "Editable");
		const button = snapshot.elements.find((element) => element.label === "Target Button");

		expect(() => performActionByIndex(process.pid, field?.id ?? -1, "AXPress")).toThrow(
			"AXUIElementPerformAction failed with AXError -25206",
		);
		performActionByIndex(process.pid, button?.id ?? -1, "AXPress");
		expect(koffiMock.observableState.pressCount).toBe(1);
	});
});

describe("#given retained accessibility snapshots", () => {
	it.each(["refetch", "relocate"] as const)(
		"#when a container is validated by %s #then its temporary child references are released",
		async (operation) => {
			const {
				extractAccessibilityTree,
				refetchElement,
				releaseAXElement,
				releaseAccessibilitySnapshot,
				relocatedElementFrame,
			} = await import("./accessibility.js");
			const { CFRetain, CFRelease } = koffiMock.coreFoundationFunctions;
			extractAccessibilityTree(process.pid, { windowId: 42 });

			if (operation === "refetch") {
				releaseAXElement(refetchElement(process.pid, 0));
			} else {
				relocatedElementFrame(process.pid, 0);
			}
			releaseAccessibilitySnapshot(process.pid);

			for (const element of [koffiMock.textField, koffiMock.targetButton]) {
				const retained = CFRetain.mock.calls.filter(([reference]) => reference === element).length;
				const released = CFRelease.mock.calls.filter(([reference]) => reference === element).length;
				expect(retained - released).toBe(0);
			}
		},
	);

	it("#when explicitly released #then every snapshot reference is released once and fresh-walk fallback resumes", async () => {
		const { extractAccessibilityTree, performActionByIndex, releaseAccessibilitySnapshot } = await import(
			"./accessibility.js"
		);
		extractAccessibilityTree(process.pid);
		expect(koffiMock.coreFoundationFunctions.CFRetain).toHaveBeenCalledTimes(8);
		koffiMock.coreFoundationFunctions.CFRelease.mockClear();

		releaseAccessibilitySnapshot(process.pid);

		expect(koffiMock.coreFoundationFunctions.CFRelease).toHaveBeenCalledTimes(4);
		for (const element of [
			koffiMock.applicationElement,
			koffiMock.windowElement,
			koffiMock.textField,
			koffiMock.targetButton,
		]) {
			expect(koffiMock.coreFoundationFunctions.CFRelease).toHaveBeenCalledWith(element);
		}
		releaseAccessibilitySnapshot(process.pid);
		expect(koffiMock.coreFoundationFunctions.CFRelease).toHaveBeenCalledTimes(4);

		koffiMock.windowElement.children = [koffiMock.insertedPrefix, koffiMock.textField, koffiMock.targetButton];
		performActionByIndex(process.pid, 4, "AXPress");
		expect(koffiMock.observableState.pressCount).toBe(1);
	});

	it("#when the observed pid dies #then action lookup invalidates and releases its snapshot", async () => {
		const { extractAccessibilityTree, performActionByIndex } = await import("./accessibility.js");
		extractAccessibilityTree(process.pid);
		koffiMock.coreFoundationFunctions.CFRelease.mockClear();
		const kill = vi.spyOn(process, "kill").mockImplementation(() => {
			throw new Error("process is gone");
		});
		try {
			expect(() => performActionByIndex(process.pid, 3, "AXPress")).toThrow(
				`invalid process or element index: ${process.pid}:3`,
			);
		} finally {
			kill.mockRestore();
		}
		expect(koffiMock.coreFoundationFunctions.CFRelease).toHaveBeenCalledTimes(4);
		expect(koffiMock.accessibilityFunctions.AXUIElementPerformAction).not.toHaveBeenCalled();
	});

	it("#when accessibility becomes unavailable #then extraction invalidates and releases its snapshot", async () => {
		const { extractAccessibilityTree } = await import("./accessibility.js");
		extractAccessibilityTree(process.pid);
		koffiMock.coreFoundationFunctions.CFRelease.mockClear();
		koffiMock.accessibilityFunctions.AXIsProcessTrusted.mockReturnValue(false);

		expect(extractAccessibilityTree(process.pid)).toEqual({
			elements: [],
			axAvailable: false,
			axUnavailable: "accessibility-permission",
			truncated: false,
			walkKey: expect.any(String),
		});
		expect(koffiMock.coreFoundationFunctions.CFRelease).toHaveBeenCalledTimes(4);
	});
});

describe("#given an outline that holds more rows than it shows #when it is walked by its shown rows #then only those are read", () => {
	it("returns the outline and its shown rows where a whole walk returns every row it holds", async () => {
		const { extractAccessibilityTree } = await import("./accessibility.js");
		koffiMock.windowElement.children = [koffiMock.outlineElement];

		const whole = extractAccessibilityTree(process.pid, { windowId: 42 });
		const shown = extractAccessibilityTree(process.pid, { windowId: 42, visibleOnly: true });

		expect(whole.elements.map((element) => element.label)).toEqual([
			"Fixture",
			"list",
			"row-0",
			"row-1",
			"row-2",
			"row-3",
		]);
		expect(shown.elements.map((element) => element.label)).toEqual(["Fixture", "list", "row-1", "row-2"]);
		expect(shown.elements[1]?.children).toEqual([2, 3]);
		expect(shown.walkKey).not.toBe(whole.walkKey);
	});

	it("acts on the row an id names, with the ids numbered over the shown rows only", async () => {
		const { extractAccessibilityTree, performActionByIndex } = await import("./accessibility.js");
		koffiMock.windowElement.children = [koffiMock.outlineElement];
		const outline = extractAccessibilityTree(process.pid, { windowId: 42 }).elements.find(
			(element) => element.role === "AXOutline",
		);

		const page = extractAccessibilityTree(process.pid, {
			windowId: 42,
			subtreeOf: outline?.id ?? -1,
			visibleOnly: true,
		});
		const row = page.elements.find((element) => element.label === "row-2");
		performActionByIndex(process.pid, row?.id ?? -1, "AXPress");

		expect(page.elements.map((element) => element.label)).toEqual(["list", "row-1", "row-2"]);
		expect(koffiMock.observableState.pressedTitles).toEqual(["row-2"]);
	});

	it("finds the same row when the element has to be located by walking again", async () => {
		const { extractAccessibilityTree, performActionByIndex } = await import("./accessibility.js");
		koffiMock.windowElement.children = [koffiMock.outlineElement];
		// A different element cap than the action's own, so the retained references are not used.
		const shown = extractAccessibilityTree(process.pid, { windowId: 42, visibleOnly: true, maxElements: 50 });
		const row = shown.elements.find((element) => element.label === "row-2");

		performActionByIndex(process.pid, row?.id ?? -1, "AXPress");

		expect(koffiMock.observableState.pressedTitles).toEqual(["row-2"]);
	});
});
