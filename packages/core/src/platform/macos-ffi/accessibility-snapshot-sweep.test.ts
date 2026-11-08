import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { defined, vi } from "@opencua/test-support";

const fixture = vi.hoisted(() => {
	const firstWindow = { role: "AXWindow" };
	const secondWindow = { role: "AXWindow" };
	const thirdWindow = { role: "AXWindow" };
	const applications = new Map([
		[
			41001,
			{ role: "AXApplication", children: [firstWindow, secondWindow], roleAttribute: { value: "AXApplication" } },
		],
		[41002, { role: "AXApplication", children: [thirdWindow], roleAttribute: { value: "AXApplication" } }],
		[41003, { role: "AXApplication", children: [{ role: "AXWindow" }], roleAttribute: { value: "AXApplication" } }],
	]);
	return {
		applications,
		firstWindow,
		secondWindow,
		thirdWindow,
		release: vi.fn<(reference: object | null) => void>(),
		retain: vi.fn((reference: object) => reference),
		getRunningApps: vi.fn(async () => [41002, 49999].map(runningFixture)),
		findRunningApp: vi.fn(async (pid: number) => ([41002, 49999].includes(pid) ? runningFixture(pid) : undefined)),
	};

	function runningFixture(pid: number) {
		return {
			pid,
			name: `Fixture ${pid}`,
			bundleId: `test.fixture.${pid}`,
			isActive: false,
			isRunning: true,
			path: "",
		};
	}
});

const actualKoffi = { ...(await import("./koffi.js")) };
vi.mock("./koffi.js", () => {
	return {
		koffi: {
			...actualKoffi.koffi,
			opaque: actualKoffi.koffi.opaque ?? (() => ({})),
			pointer: actualKoffi.koffi.pointer ?? ((_name: string, value: unknown) => value),
			struct: (_name: string, fields: object) => fields,
			load: (path: string) => {
				if (!path.includes("ApplicationServices.framework")) return actualKoffi.koffi.load(path);
				return {
					func: (prototype: string) => {
						const name = prototype.match(/\s([A-Za-z_][A-Za-z0-9_]*)\(/)?.[1] ?? prototype;
						switch (name) {
							case "AXIsProcessTrusted":
								return () => true;
							case "AXUIElementCreateApplication":
								return (pid: number) => fixture.applications.get(pid) ?? null;
							case "AXUIElementGetTypeID":
								return () => 4;
							case "AXValueGetTypeID":
								return () => 5;
							case "AXUIElementCopyMultipleAttributeValues":
								return () => -25205;
							case "AXUIElementCopyAttributeValue":
								return (element: object, attribute: { value: string }, out: Array<object | null>) => {
									if (attribute.value === "AXChildren") {
										const children = "children" in element ? element.children : [];
										out[0] = Array.isArray(children) ? children : [];
										return 0;
									}
									if (attribute.value === "AXRole" && "role" in element) {
										const roleAttribute =
											"roleAttribute" in element ? element.roleAttribute : { value: element.role };
										out[0] =
											typeof roleAttribute === "object" && roleAttribute !== null ? roleAttribute : null;
										return 0;
									}
									return -25205;
								};
							default:
								return vi.fn(() => 0);
						}
					},
				};
			},
		},
	};
});

vi.mock("./corefoundation.js", () => ({
	cfRelease: fixture.release,
	cfRetain: fixture.retain,
	cfGetTypeId: (reference: object) => ("role" in reference ? 4 : 1),
	cfBooleanTrue: {},
	fromCFBoolean: () => false,
	fromCFNumber: () => 0,
	fromCFString: (reference: { value: string }) => reference.value,
	isCFArray: Array.isArray,
	isCFBoolean: () => false,
	isCFNull: () => false,
	isCFNumber: () => false,
	isCFString: (reference: object) => "value" in reference,
	toCFNumber: (value: number) => value,
	toCFString: (value: string) => ({ value }),
	withCFString: <T>(value: string, use: (reference: object) => T): T => use({ value }),
	withCFArray: <T>(values: readonly object[], use: (reference: object) => T): T => use(values),
	cfArrayLength: (reference: readonly object[]) => reference.length,
	cfArrayValueAt: (reference: readonly object[], index: number) => reference[index] ?? null,
}));

vi.mock("../app-list.js", () => ({
	getRunningMacOSApps: fixture.getRunningApps,
	findRunningApp: fixture.findRunningApp,
}));
vi.mock("./power.js", () => ({ createDisplaySleepAssertion: () => ({ release: () => undefined }) }));
vi.mock("./coregraphics.js", () => ({
	createEvent: vi.fn(),
	postEvent: vi.fn(),
	getCursorPosition: vi.fn(() => ({ x: 0, y: 0 })),
}));

vi.mock("./window-list.js", () => ({ listWindows: vi.fn(() => []), listOnscreenWindows: vi.fn(() => []) }));
vi.mock("./display-list.js", () => ({ onlineDisplayInfo: vi.fn(() => []) }));
vi.mock("./lock-screen.js", () => ({ isScreenLocked: () => false }));
vi.mock("./skylight.js", () => ({}));
vi.mock("./macos-cursor.js", () => ({ readRealCursorPosition: () => ({ x: 0, y: 0 }) }));
vi.mock("./screenshot.js", () => ({
	getMainDisplayId: vi.fn(() => 1),
	getMainDisplayLogicalSize: vi.fn(() => ({ width: 1920, height: 1080 })),
	getMainDisplayNativePixelSize: vi.fn(() => ({ width: 1920, height: 1080 })),
	screenCaptureAllowed: vi.fn(() => true),
	captureDisplayImage: vi.fn(),
	captureWindowImage: vi.fn(),
	captureWindowImageAsync: vi.fn(),
	captureDisplayRegionImage: vi.fn(),
}));

const { setOnscreenWindowIdsSourceForTesting } = await import("../macos-input.js");
const { MacOSHostComputer } = await import("../macos.js");
const accessibility = await import("./accessibility.js");

setOnscreenWindowIdsSourceForTesting(() => []);

beforeEach(() => {
	vi.spyOn(process, "kill").mockImplementation(() => true);
	fixture.release.mockClear();
	fixture.retain.mockClear();
	fixture.getRunningApps.mockClear();
	fixture.findRunningApp.mockClear();
});

afterEach(() => {
	accessibility.releaseSnapshotsForExitedPids([]);
	vi.restoreAllMocks();
});

function observe(pid: number): string {
	const result = accessibility.extractAccessibilityTree(pid);
	expect(result.axAvailable).toBe(true);
	expect(result.elements).toHaveLength((fixture.applications.get(pid)?.children.length ?? 0) + 1);
	const key = accessibility.currentObservationKey(pid);
	expect(key).toBeDefined();
	if (key === undefined) throw new Error(`No snapshot installed for ${pid}`);
	return key;
}

describe("#given retained accessibility snapshots #when sweeping exited pids #then ownership follows the running set", () => {
	it("releases every retained element of exited pids once and counts snapshots rather than elements", () => {
		observe(41001);
		observe(41003);
		fixture.release.mockClear();

		expect(accessibility.releaseSnapshotsForExitedPids([])).toBe(2);

		expect(fixture.release.mock.calls.map(([reference]) => reference)).toEqual([
			defined(fixture.applications.get(41001)),
			fixture.firstWindow,
			fixture.secondWindow,
			defined(fixture.applications.get(41003)),
			...(fixture.applications.get(41003)?.children ?? []),
		]);
		expect(accessibility.currentObservationKey(41001)).toBeUndefined();
		expect(accessibility.currentObservationKey(41003)).toBeUndefined();
		fixture.release.mockClear();
		expect(accessibility.releaseSnapshotsForExitedPids([])).toBe(0);
		expect(fixture.release).not.toHaveBeenCalled();
	});

	it("preserves running snapshots and their exact observation keys without retaining or releasing them", () => {
		observe(41001);
		const key = observe(41002);
		fixture.release.mockClear();
		fixture.retain.mockClear();

		expect(accessibility.releaseSnapshotsForExitedPids([41002, 41002, 49999])).toBe(1);

		expect(fixture.release.mock.calls.map(([reference]) => reference)).toEqual([
			defined(fixture.applications.get(41001)),
			fixture.firstWindow,
			fixture.secondWindow,
		]);
		expect(fixture.retain).not.toHaveBeenCalled();
		expect(accessibility.currentObservationKey(41001)).toBeUndefined();
		expect(accessibility.currentObservationKey(41002)).toBe(key);
		fixture.release.mockClear();
		expect(accessibility.releaseSnapshotsForExitedPids([41002, 49999])).toBe(0);
		expect(fixture.release).not.toHaveBeenCalled();
		accessibility.releaseAccessibilitySnapshot(41002);
		expect(fixture.release.mock.calls.map(([reference]) => reference)).toEqual([
			defined(fixture.applications.get(41002)),
			fixture.thirdWindow,
		]);
	});

	it("returns zero without releasing references when no snapshots exist, including absent running pids", () => {
		expect(accessibility.releaseSnapshotsForExitedPids([])).toBe(0);
		expect(accessibility.releaseSnapshotsForExitedPids([49999, 49999])).toBe(0);
		expect(fixture.release).not.toHaveBeenCalled();
	});
});

describe("#given app-state capture #when the target pid resolves #then snapshots of apps that quit are swept", () => {
	it("asks only about the pids holding snapshots instead of enumerating every app", async () => {
		observe(41001);
		const key = observe(41002);
		const sweep = vi.spyOn(accessibility, "releaseSnapshotsForExitedPids");
		const computer = new MacOSHostComputer();
		const state = await computer.getAppState(41002, { settleMs: 0, includeScreenshot: false });

		expect(fixture.getRunningApps).not.toHaveBeenCalled();
		expect(sweep).toHaveBeenCalledTimes(1);
		expect(sweep).toHaveBeenCalledWith([41002]);
		expect(accessibility.currentObservationKey(41001)).toBeUndefined();
		expect(state.observationKey).not.toBe(key);
		expect(accessibility.currentObservationKey(41002)).toBe(state.observationKey);
	});
});
