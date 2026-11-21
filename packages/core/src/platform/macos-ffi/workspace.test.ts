import { beforeEach, describe, expect, it } from "bun:test";
import { vi } from "@opencua/test-support";

const ffiMock = vi.hoisted(() => {
	const poolAllocation = { type: "pool-allocation" };
	const pool = { type: "pool" };
	const workspace = { type: "workspace" };
	const runningApplicationClass = { type: "class", name: "NSRunningApplication" };
	const bundleClass = { type: "class", name: "NSBundle" };
	const stringClass = { type: "class", name: "NSString" };
	const finder = { type: "application", name: "Finder" };
	const backgroundAgent = { type: "application", name: "Agent" };
	const applications = { type: "array", values: [backgroundAgent, finder] };
	const finderApplications = { type: "array", values: [finder] };
	const noApplications = { type: "array", values: [] };
	const finderUrl = { type: "url" };
	const finderBundle = { type: "bundle" };
	const classes = new Map<string, object>([
		["NSAutoreleasePool", { type: "class", name: "NSAutoreleasePool" }],
		["NSBundle", bundleClass],
		["NSRunningApplication", runningApplicationClass],
		["NSString", stringClass],
		["NSWorkspace", { type: "class", name: "NSWorkspace" }],
	]);
	const string = (value: string) => ({ type: "string", value });
	const sendImplementation = (receiver: unknown, selector: unknown, value?: unknown): unknown => {
		if (selector === "alloc") return poolAllocation;
		if (receiver === poolAllocation && selector === "init") return pool;
		if (receiver === pool && selector === "release") return null;
		if (selector === "sharedWorkspace") return workspace;
		if (receiver === workspace && selector === "runningApplications") return applications;
		if (receiver === runningApplicationClass && selector === "runningApplicationWithProcessIdentifier:") {
			return value === 489 ? finder : null;
		}
		if (receiver === runningApplicationClass && selector === "runningApplicationsWithBundleIdentifier:") {
			return isString(value, "com.apple.finder") ? finderApplications : noApplications;
		}
		if (receiver === workspace && selector === "fullPathForApplication:") {
			return isString(value, "Finder") ? string("/System/Library/CoreServices/Finder.app") : null;
		}
		if (receiver === bundleClass && selector === "bundleWithPath:") return finderBundle;
		if (receiver === finderBundle && selector === "bundleIdentifier") return string("com.apple.finder");
		if (receiver === stringClass && selector === "stringWithUTF8String:") {
			return typeof value === "string" ? string(value) : null;
		}
		if (isArray(receiver) && selector === "count") return receiver.values.length;
		if (isArray(receiver) && selector === "objectAtIndex:") return receiver.values[Number(value)] ?? null;
		if (receiver === backgroundAgent && selector === "activationPolicy") return 1;
		if (receiver === finder && selector === "activationPolicy") return 0;
		if (receiver === finder && selector === "localizedName") return string("Finder");
		if (receiver === finder && selector === "bundleIdentifier") return string("com.apple.finder");
		if (receiver === finder && selector === "processIdentifier") return 489;
		if (receiver === finder && selector === "isActive") return true;
		if (receiver === finder && selector === "bundleURL") return finderUrl;
		if (receiver === finderUrl && selector === "path") return string("/System/Library/CoreServices/Finder.app");
		if (isString(receiver) && selector === "UTF8String") return receiver.value;
		return null;
	};
	const send = vi.fn(sendImplementation);
	const runLoop = vi.fn(() => 0);
	const func = vi.fn((name: string) => {
		if (name.includes("CFRunLoopRunInMode")) return runLoop;
		// No process start time: every enumeration reads bundle identity afresh, as these cases expect.
		if (name.includes("proc_pidinfo")) return () => 0;
		if (name === "objc_getClass") return (className: string) => classes.get(className) ?? null;
		if (name === "sel_registerName") return (selector: string) => selector;
		if (name === "objc_msgSend") return send;
		throw new Error(`unexpected Objective-C function: ${name}`);
	});
	return {
		module: {
			load: vi.fn((path: string) =>
				path.includes("libobjc") || path.includes("CoreFoundation") || path.includes("libSystem") ? { func } : {},
			),
		},
		runLoop,
		pool,
		send,
		sendImplementation,
	};

	function isArray(value: unknown): value is { readonly type: "array"; readonly values: readonly object[] } {
		return typeof value === "object" && value !== null && Reflect.get(value, "type") === "array";
	}

	function isString(value: unknown, expected?: string): value is { readonly type: "string"; readonly value: string } {
		return (
			typeof value === "object" &&
			value !== null &&
			Reflect.get(value, "type") === "string" &&
			(expected === undefined || Reflect.get(value, "value") === expected)
		);
	}
});

vi.mock("koffi", () => ffiMock.module);

const { findRunningApplication, getRunningApplications } = await import("./workspace.js");

beforeEach(() => {
	ffiMock.send.mockClear();
});

describe("#given mocked NSWorkspace applications #when enumerating #then foreground properties are read safely", () => {
	it("maps AppKit properties, filters background agents, and releases the autorelease pool", () => {
		const applications = getRunningApplications();

		expect(applications).toEqual([
			{
				name: "Finder",
				bundleId: "com.apple.finder",
				pid: 489,
				isActive: true,
				path: "/System/Library/CoreServices/Finder.app",
			},
		]);
		expect(ffiMock.send).toHaveBeenCalledWith(ffiMock.pool, "release");
	});

	it("turns the run loop without waiting before reading, so relaunched apps are not reported stale", () => {
		ffiMock.runLoop.mockClear();

		getRunningApplications();

		expect(ffiMock.runLoop).toHaveBeenCalledWith(expect.anything(), 0, false);
	});
});

describe("#given a pid, bundle identifier, or application name #when looking up one app #then no full enumeration occurs", () => {
	it.each([489, "com.apple.finder", "Finder"])("resolves %s through a targeted AppKit selector", (identifier) => {
		const application = findRunningApplication(identifier);

		expect(application?.bundleId).toBe("com.apple.finder");
		expect(application?.pid).toBe(489);
		expect(ffiMock.send).not.toHaveBeenCalledWith(expect.anything(), "runningApplications");
		expect(ffiMock.send).toHaveBeenCalledWith(ffiMock.pool, "release");
	});
});

describe("#given the indexed AppKit query answers with nothing #when looking up a bundle identifier #then the enumeration still finds the app", () => {
	it("falls back to runningApplications instead of reporting a running app as missing", () => {
		const original = ffiMock.sendImplementation;
		ffiMock.send.mockImplementation((receiver: unknown, selector: unknown, value?: unknown): unknown =>
			selector === "runningApplicationsWithBundleIdentifier:"
				? { type: "array", values: [] }
				: original(receiver, selector, value),
		);

		const application = findRunningApplication("com.apple.finder");

		expect(application?.pid).toBe(489);
		expect(ffiMock.send).toHaveBeenCalledWith(expect.anything(), "runningApplications");
	});

	it("still answers nothing for a bundle identifier that is not running", () => {
		expect(findRunningApplication("com.opencua.definitely-not-running")).toBeUndefined();
	});
});
