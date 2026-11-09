import { beforeEach, describe, expect, it } from "bun:test";
import { vi } from "@opencua/test-support";

const overlayMock = vi.hoisted(() => ({
	createCursorOverlay: vi.fn(() => ({
		set: vi.fn(),
		highlight: vi.fn(),
		setMode: vi.fn(),
		hide: vi.fn(),
		close: vi.fn(),
	})),
}));

const actualCursorOverlay = { ...(await import("./macos-ffi/cursor-overlay.js")) };
vi.mock("./macos-ffi/cursor-overlay.js", () => ({
	...actualCursorOverlay,
	createCursorOverlay: overlayMock.createCursorOverlay,
}));

describe("#given host cursor overlay policy", () => {
	beforeEach(() => {
		overlayMock.createCursorOverlay.mockClear();
	});

	it("#when background delivery has cues enabled by default #then it draws no overlay on the human desktop", async () => {
		const { MacOSHostComputer } = await import("./macos.js");

		const host = new MacOSHostComputer({ delivery: "background" });

		expect(overlayMock.createCursorOverlay).not.toHaveBeenCalled();
		await host.close();
	});

	it("#when background delivery has background cues disabled #then it does not create a default overlay", async () => {
		const { MacOSHostComputer } = await import("./macos.js");
		const previous = process.env["OPENCUA_CURSOR_BACKGROUND_CUES"];
		process.env["OPENCUA_CURSOR_BACKGROUND_CUES"] = "off";
		try {
			const host = new MacOSHostComputer({ delivery: "background" });

			expect(overlayMock.createCursorOverlay).not.toHaveBeenCalled();
			await host.close();
		} finally {
			if (previous === undefined) {
				Reflect.deleteProperty(process.env, "OPENCUA_CURSOR_BACKGROUND_CUES");
			} else {
				process.env["OPENCUA_CURSOR_BACKGROUND_CUES"] = previous;
			}
		}
	});

	it("#when attended delivery is requested #then it creates no overlay either", async () => {
		const { MacOSHostComputer } = await import("./macos.js");
		const { setAttendedHostDelivery } = await import("../computer/host-interaction-policy.js");
		try {
			const host = new MacOSHostComputer({ delivery: "attended" });

			expect(overlayMock.createCursorOverlay).not.toHaveBeenCalled();
			await host.close();
		} finally {
			setAttendedHostDelivery(false);
		}
	});

	it("#when an overlay is injected #then background delivery uses it instead of creating one", async () => {
		const { MacOSHostComputer } = await import("./macos.js");
		const overlay = {
			state: vi.fn(async () => null),
			set: vi.fn(),
			highlight: vi.fn(),
			setMode: vi.fn(),
			hide: vi.fn(),
			close: vi.fn(),
		};

		new MacOSHostComputer({ delivery: "background", overlay });
		expect(overlayMock.createCursorOverlay).not.toHaveBeenCalled();
	});
});
