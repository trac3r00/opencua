import { describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "@opencua/test-support";

import type { ListedWindow } from "./macos-ffi/window-list.js";
import * as windowListing from "./macos-ffi/window-list.js";
import {
	observedWindowForPid,
	openWindowsForTargeting,
	setOpenWindowsSourceForTesting,
	targetableWindows,
	withoutMenuBarStrips,
} from "./macos-open-windows.js";
import type { MacOSWindowInfo } from "./macos-window-target.js";
import { registerOwnedSurface, setSurfaceBinaryForTesting } from "./owned-surfaces.js";

function listed(partial: Partial<ListedWindow> & { id: number }): ListedWindow {
	return {
		ownerPid: 100,
		layer: 0,
		ownerName: "Finder",
		title: "",
		bounds: { x: 0, y: 0, width: 100, height: 100 },
		...partial,
	};
}

function window(id: number): MacOSWindowInfo {
	return { id, bounds: { x: 0, y: 0, width: 10, height: 10 } };
}

describe("#given a WindowServer listing with app windows and chrome #when it is mapped for targeting #then only normal windows survive", () => {
	it("keeps layer 0 and drops menu bar, control centre and drag-helper layers", () => {
		const windows = targetableWindows([
			listed({ id: 1, ownerName: "Finder", title: "opencua", bounds: { x: 10, y: 20, width: 30, height: 40 } }),
			listed({ id: 2, layer: 25, ownerName: "Control Center", title: "Item-0" }),
			listed({ id: 3, layer: 500, ownerName: "SSDragHelper" }),
		]);

		expect(windows).toEqual([
			{
				id: 1,
				bounds: { x: 10, y: 20, width: 30, height: 40 },
				owner: { processId: 100, name: "Finder" },
				title: "opencua",
				layer: 0,
			},
		]);
	});
});

describe("#given a Phone call banner #when it is mapped for targeting #then its verified helper window survives", () => {
	const helper = {
		bundleId: "com.apple.FaceTime.FaceTimeNotificationExtension",
		path: "/System/Library/ExtensionKit/Extensions/FaceTimeNotificationExtension.appex",
	};

	it("includes a layer 21 banner by process identity, not its localized owner name", () => {
		const banner = listed({ id: 219, layer: 21, ownerName: "Localized helper" });

		const windows = targetableWindows([banner], () => helper);

		expect(windows.map((entry) => entry.id)).toEqual([219]);
	});

	it("excludes a lookalike helper outside the system bundle", () => {
		const banner = listed({ id: 219, layer: 21, ownerName: "FaceTimeNotificationExtension" });

		const windows = targetableWindows([banner], () => ({ ...helper, path: "/tmp/Fake.appex" }));

		expect(windows).toEqual([]);
	});

	it("excludes unverified processes and other helper layers", () => {
		const banner = listed({ id: 219, layer: 21 });
		const chrome = listed({ id: 220, layer: 25 });

		expect(targetableWindows([banner], () => undefined)).toEqual([]);
		expect(targetableWindows([chrome], () => helper)).toEqual([]);
	});

	it("includes the compositing Notification Center host at notification layer", () => {
		const host = listed({ id: 11, layer: 21, ownerName: "Notification Center" });

		const windows = targetableWindows([host], () => ({
			bundleId: "com.apple.notificationcenterui",
			path: "/System/Library/CoreServices/NotificationCenter.app",
		}));

		expect(windows.map((entry) => entry.id)).toEqual([11]);
	});
});

describe("#given the in-process listing answers #when windows are wanted for targeting #then the helper binary is never consulted", () => {
	it("uses the in-process listing as-is, chrome already filtered", async () => {
		const listBinary = vi.fn(async () => [window(99)]);

		const windows = await openWindowsForTargeting({ listNative: () => [window(1), window(2)], listBinary });

		expect(windows.map((entry) => entry.id)).toEqual([1, 2]);
		expect(listBinary).not.toHaveBeenCalled();
	});

	it("answers an empty in-process list as an empty list instead of falling back", async () => {
		const listBinary = vi.fn(async () => [window(99)]);

		const windows = await openWindowsForTargeting({ listNative: () => [], listBinary });

		expect(windows).toEqual([]);
		expect(listBinary).not.toHaveBeenCalled();
	});
});

describe("#given all-Spaces enumeration #when explicitly requested #then the native listing is required", () => {
	it("uses the injected native all-Spaces source without calling the binary", async () => {
		const listBinary = vi.fn(async () => [window(99)]);
		const windows = await openWindowsForTargeting(
			{
				listNative: () => [window(1)],
				listNativeAllSpaces: () => [window(1), window(2)],
				listBinary,
			},
			{ includeOffscreen: true },
		);

		expect(windows.map((entry) => entry.id)).toEqual([1, 2]);
		expect(listBinary).not.toHaveBeenCalled();
	});

	it("uses a separate all-Spaces fixture through the default source path", async () => {
		setOpenWindowsSourceForTesting(
			() => [window(1)],
			() => [window(1), window(2)],
		);
		try {
			expect((await openWindowsForTargeting()).map((entry) => entry.id)).toEqual([1]);
			const windows = await openWindowsForTargeting(undefined, { includeOffscreen: true });
			expect(windows.map((entry) => entry.id)).toEqual([1, 2]);
		} finally {
			setOpenWindowsSourceForTesting(undefined);
		}
	});

	it("reports unavailable native all-Spaces listing instead of using the binary", async () => {
		const listBinary = vi.fn(async () => [window(7)]);
		await expect(
			openWindowsForTargeting({ listNative: () => undefined, listBinary }, { includeOffscreen: true }),
		).rejects.toThrow(/all-Spaces window listing is unavailable/);
		expect(listBinary).not.toHaveBeenCalled();
	});

	it("reports an unreadable native all-Spaces listing honestly", async () => {
		const listBinary = vi.fn(async () => [window(7)]);
		await expect(
			openWindowsForTargeting(
				{ listNative: () => undefined, listNativeAllSpaces: () => undefined, listBinary },
				{ includeOffscreen: true },
			),
		).rejects.toThrow(/all-Spaces WindowServer listing could not be read/);
		expect(listBinary).not.toHaveBeenCalled();
	});
});

describe("#given an explicitly observed hidden window #when validating its owner and id #then only a retained exact window resolves", () => {
	it("keeps the hidden window and refuses it after destruction", () => {
		let inventory: readonly MacOSWindowInfo[] = [
			{ ...window(16205), owner: { processId: 100 } },
			{ ...window(17182), owner: { processId: 200 } },
		];
		setOpenWindowsSourceForTesting(() => inventory);
		try {
			expect(observedWindowForPid(100, 16205)?.id).toBe(16205);
			expect(observedWindowForPid(100, 17182)).toBeUndefined();
			inventory = [];
			expect(observedWindowForPid(100, 16205)).toBeUndefined();
		} finally {
			setOpenWindowsSourceForTesting(undefined);
		}
	});

	it("does not consult host windows when an installed source is unreadable", () => {
		const native = vi.spyOn(windowListing, "listWindows").mockReturnValue([listed({ id: 16205 })]);
		setOpenWindowsSourceForTesting(() => undefined);
		try {
			expect(observedWindowForPid(100, 16205)).toBeUndefined();
			expect(native).not.toHaveBeenCalled();
		} finally {
			setOpenWindowsSourceForTesting(undefined);
			native.mockRestore();
		}
	});
});

describe("#given the in-process binding cannot read windows #when windows are wanted for targeting #then the helper binary answers", () => {
	it("falls back to the binary listing", async () => {
		const windows = await openWindowsForTargeting({
			listNative: () => undefined,
			listBinary: async () => [window(7)],
		});

		expect(windows.map((entry) => entry.id)).toEqual([7]);
	});
});

describe("#given a window one level below normal windows #when it is mapped for targeting #then only an opencua-owned surface survives", () => {
	it("keeps the owned surface at layer -1 and drops another process's window at that layer", () => {
		const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "opencua-owned-window-")));
		const previous = process.env["OPENCUA_STATE_DIR"];
		process.env["OPENCUA_STATE_DIR"] = stateDir;
		// This test process stands in for the surface, so the file it executes stands in for the surface binary.
		setSurfaceBinaryForTesting(process.execPath);
		try {
			registerOwnedSurface({ pid: process.pid, title: "canvas", url: "http://127.0.0.1/" }, { stateDir });

			const windows = targetableWindows([
				listed({ id: 7, layer: -1, ownerPid: process.pid, ownerName: "opencua-surface" }),
				listed({ id: 8, layer: -1, ownerPid: 100, ownerName: "Finder" }),
			]);

			expect(windows.map((entry) => entry.id)).toEqual([7]);
		} finally {
			setSurfaceBinaryForTesting(undefined);
			if (previous === undefined) Reflect.deleteProperty(process.env, "OPENCUA_STATE_DIR");
			else process.env["OPENCUA_STATE_DIR"] = previous;
			rmSync(stateDir, { recursive: true, force: true });
		}
	});
});

describe("withoutMenuBarStrips #given the undrawn menu bar windows macOS keeps per app on each display", () => {
	const displays = [
		{ x: 0, y: 0, width: 2560 },
		{ x: 2560, y: 0, width: 2560 },
	];
	const listed = (id: number, bounds: ListedWindow["bounds"], extra: Partial<ListedWindow> = {}): ListedWindow => ({
		id,
		ownerPid: 7,
		layer: 0,
		ownerName: "Calculator",
		title: "",
		bounds,
		onScreen: false,
		...extra,
	});

	it("#when listing every Space #then only those strips are dropped and every real or look-alike window stays", () => {
		const { onScreen: _unknown, ...unknownOnScreen } = listed(8, { x: 0, y: 0, width: 2560, height: 30 });
		const windows = [
			listed(1, { x: 0, y: 0, width: 2560, height: 30 }),
			listed(2, { x: 2560, y: 0, width: 2560, height: 30 }),
			listed(3, { x: 740, y: 400, width: 230, height: 408 }),
			listed(4, { x: 0, y: 0, width: 2560, height: 30 }, { onScreen: true }),
			listed(5, { x: 0, y: 0, width: 2560, height: 30 }, { title: "Toolbar" }),
			listed(6, { x: 0, y: 0, width: 2560, height: 1440 }),
			listed(7, { x: 10, y: 0, width: 2560, height: 30 }),
			unknownOnScreen,
		];

		expect(withoutMenuBarStrips(windows, displays).map((window) => window.id)).toEqual([3, 4, 5, 6, 7, 8]);
	});
});
