import { describe, expect, it } from "bun:test";
import { vi } from "@opencua/test-support";

import type { AppInfo } from "../accessibility/types.js";
import { resolveAppPid } from "./actions.js";
import type { ComputerInterface } from "./interface.js";

function app(name: string, bundleId: string, pid: number): AppInfo {
	return { name, bundleId, pid, isRunning: true };
}

const APPS: readonly AppInfo[] = [
	app("Safari Technology Preview", "com.apple.SafariTechnologyPreview", 10),
	app("Safari", "com.apple.Safari", 20),
	app("Notes", "com.apple.Notes", 30),
];

interface ResolverComputer {
	readonly computer: Pick<ComputerInterface, "listApps" | "listAppIdentities">;
	readonly listApps: ReturnType<typeof vi.fn<ComputerInterface["listApps"]>>;
	readonly listAppIdentities: ReturnType<typeof vi.fn<() => Promise<AppInfo[]>>>;
}

function resolverComputer(apps: () => AppInfo[] = () => [...APPS]): ResolverComputer {
	const listApps = vi.fn<ComputerInterface["listApps"]>(async () => apps());
	const listAppIdentities = vi.fn<() => Promise<AppInfo[]>>(async () => apps());
	return { computer: { listApps, listAppIdentities }, listApps, listAppIdentities };
}

describe("#given a computer with an identity inventory #when an app name is resolved #then usage enrichment is skipped", () => {
	it("reads the identity inventory and never the usage-enriched list", async () => {
		const fake = resolverComputer();

		const pid = await resolveAppPid({ ...stubComputer(), ...fake.computer }, "notes");

		expect(pid).toBe(30);
		expect(fake.listAppIdentities).toHaveBeenCalledTimes(1);
		expect(fake.listApps).not.toHaveBeenCalled();
	});

	it("prefers an exact name or bundle id over a partial match", async () => {
		const fake = resolverComputer();
		const computer = { ...stubComputer(), ...fake.computer };

		expect(await resolveAppPid(computer, "Safari")).toBe(20);
		expect(await resolveAppPid(computer, "com.apple.safari")).toBe(20);
		expect(await resolveAppPid(computer, "technology")).toBe(10);
	});

	it("keeps partial-match precedence in inventory order when nothing matches exactly", async () => {
		const fake = resolverComputer();

		expect(await resolveAppPid({ ...stubComputer(), ...fake.computer }, "safa")).toBe(10);
	});

	it("reads the inventory on every call so a restarted app is never resolved to its old pid", async () => {
		let pid = 30;
		const fake = resolverComputer(() => [app("Notes", "com.apple.Notes", pid)]);
		const computer = { ...stubComputer(), ...fake.computer };

		expect(await resolveAppPid(computer, "Notes")).toBe(30);
		pid = 44;
		expect(await resolveAppPid(computer, "Notes")).toBe(44);
		expect(fake.listAppIdentities).toHaveBeenCalledTimes(2);
	});

	it("rejects an app that is not running", async () => {
		const fake = resolverComputer();

		await expect(resolveAppPid({ ...stubComputer(), ...fake.computer }, "Mail")).rejects.toThrow(
			'No running app matched "Mail"',
		);
	});

	it("answers a numeric pid without listing anything", async () => {
		const fake = resolverComputer();

		expect(await resolveAppPid({ ...stubComputer(), ...fake.computer }, "4242")).toBe(4242);
		expect(fake.listAppIdentities).not.toHaveBeenCalled();
		expect(fake.listApps).not.toHaveBeenCalled();
	});
});

describe("#given an app whose bundle file name differs from its display name #when it is resolved #then the bundle file name matches", () => {
	const ZOOM: AppInfo = { ...app("Zoom", "us.zoom.xos", 50), path: "/Applications/zoom.us.app" };

	it("resolves the bundle file name the Dock and Activity Monitor show", async () => {
		const fake = resolverComputer(() => [...APPS, ZOOM]);

		expect(await resolveAppPid({ ...stubComputer(), ...fake.computer }, "zoom.us")).toBe(50);
		expect(await resolveAppPid({ ...stubComputer(), ...fake.computer }, "Zoom.us.app")).toBe(50);
	});

	it("prefers an exact bundle file name over a partial display-name match", async () => {
		const helper = { ...app("zoom.us helper tools", "com.example.helper", 60), path: "/Applications/Helper.app" };
		const fake = resolverComputer(() => [helper, ZOOM]);

		expect(await resolveAppPid({ ...stubComputer(), ...fake.computer }, "zoom.us")).toBe(50);
	});
});

describe("#given no running app matches #when an app name is resolved #then the error names running apps with a similar name", () => {
	const ZOOM: AppInfo = { ...app("Zoom", "us.zoom.xos", 50), path: "/Applications/zoom.us.app" };

	it("lists a running app that shares a word with the request", async () => {
		const fake = resolverComputer(() => [...APPS, ZOOM]);

		await expect(resolveAppPid({ ...stubComputer(), ...fake.computer }, "Zoom Workplace")).rejects.toThrow(
			'No running app matched "Zoom Workplace"; running apps with a similar name: Zoom (us.zoom.xos)',
		);
	});

	it("keeps the plain message when nothing running is similar", async () => {
		const fake = resolverComputer();

		expect(await rejectionMessage(resolveAppPid({ ...stubComputer(), ...fake.computer }, "Mail"))).toBe(
			'No running app matched "Mail"',
		);
	});

	it("lists at most three similar apps", async () => {
		const many = [1, 2, 3, 4].map((n) => app(`Notes ${n}`, `com.example.notes${n}`, 100 + n));
		const fake = resolverComputer(() => many);

		expect(await rejectionMessage(resolveAppPid({ ...stubComputer(), ...fake.computer }, "Notes Pro"))).toBe(
			'No running app matched "Notes Pro"; running apps with a similar name: Notes 1 (com.example.notes1), Notes 2 (com.example.notes2), Notes 3 (com.example.notes3)',
		);
	});
});

describe("#given a computer without an identity inventory #when an app name is resolved #then it falls back to listApps", () => {
	it("resolves through listApps", async () => {
		const listApps = vi.fn<ComputerInterface["listApps"]>(async () => [...APPS]);

		const pid = await resolveAppPid({ ...stubComputer(), listApps }, "Notes");

		expect(pid).toBe(30);
		expect(listApps).toHaveBeenCalledTimes(1);
	});
});

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("expected the promise to reject");
}

function stubComputer(): ComputerInterface {
	return {
		capabilities: {
			supportsScreenshot: true,
			supportsInput: true,
			supportsAccessibility: true,
			supportsClipboard: true,
		},
		screenshot: vi.fn(),
		setTarget: vi.fn(),
		move: vi.fn(),
		click: vi.fn(),
		rightClick: vi.fn(),
		middleClick: vi.fn(),
		doubleClick: vi.fn(),
		type: vi.fn(),
		key: vi.fn(),
		scroll: vi.fn(),
		drag: vi.fn(),
		getCursorPosition: vi.fn(),
		getScreenSize: vi.fn(),
		getAppState: vi.fn(),
		getScreenshotViewport: vi.fn(),
		listApps: vi.fn(),
		setValue: vi.fn(),
		selectText: vi.fn(),
		performAction: vi.fn(),
		pressAtPosition: vi.fn(),
		typeIntoFocused: vi.fn(),
		assertObservationCurrent: vi.fn(),
		close: vi.fn(),
	};
}
