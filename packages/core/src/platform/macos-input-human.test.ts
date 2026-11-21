import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { vi } from "@opencua/test-support";

const WINDOW = { id: 99, bounds: { x: 10, y: 20, width: 300, height: 200 } };
const MAIN_DISPLAY = { x: 0, y: 0, width: 1920, height: 1080 };

const log = vi.hoisted(() => ({ events: [] as string[], latency: 0, failOn: undefined as string | undefined }));

/** Every posted event is logged and advances fake time by the current latency, as a slow app would. */
function posted(event: string): void {
	log.events.push(event);
	if (log.failOn === event) {
		throw new Error("post failed");
	}
	if (log.latency > 0) {
		vi.advanceTimersByTime(log.latency);
	}
}

const skyLightMock = vi.hoisted(() => ({
	personPsn: Buffer.alloc(8, 1),
	targetPsn: Buffer.alloc(8, 2),
}));

vi.mock("get-windows", () => ({
	openWindows: () => Promise.resolve([{ id: WINDOW.id, owner: { processId: 1234 }, bounds: WINDOW.bounds }]),
}));
vi.mock("./macos-ffi/lock-screen.js", () => ({ isScreenLocked: () => false }));
vi.mock("./macos-ffi/skylight.js", () => ({
	focusGuardFor: () => ({ previousPsn: skyLightMock.personPsn, targetPsn: skyLightMock.targetPsn }),
	frontProcessSerialNumber: () => skyLightMock.personPsn,
	setProcessAppActive: (_psn: Buffer, windowId: number, active: boolean) => {
		log.events.push(`active:${String(active)}:${windowId}`);
		return true;
	},
}));
vi.mock("./macos-ffi/coregraphics.js", () => ({
	K_CG_EVENT_FLAG_MASK_ALTERNATE: 0x00080000,
	K_CG_EVENT_FLAG_MASK_COMMAND: 0x00100000,
	K_CG_EVENT_FLAG_MASK_CONTROL: 0x00040000,
	K_CG_EVENT_FLAG_MASK_SHIFT: 0x00020000,
	getCurrentCursorPosition: () => ({ x: 1, y: 2 }),
	postKeyboardEvent: (call: { readonly keyCode: number; readonly keyDown: boolean }) => {
		posted(`key:${String(call.keyCode)}:${call.keyDown ? "down" : "up"}`);
	},
	postMouseEvent: (call: { readonly kind: string; readonly position: { readonly x: number } }) => {
		posted(`mouse:${call.kind}:${String(call.position.x)}`);
	},
	postScrollEvent: () => undefined,
	postUnicodeText: (text: string) => {
		posted(`text:${text}`);
	},
	warpCursorPosition: () => undefined,
}));

const input = await import("./macos-input.js");
const { setOpenWindowsSourceForTesting } = await import("./macos-open-windows.js");
setOpenWindowsSourceForTesting(() => undefined);

/** An overlay whose glide is logged in the same stream as posted events, so order is observable. */
function overlay() {
	return {
		set: vi.fn((point: { x: number; y: number }) => log.events.push(`set:${point.x},${point.y}`)),
		glide: vi.fn(async (point: { x: number; y: number }) => {
			log.events.push(`glide:${point.x},${point.y}`);
		}),
		highlight: vi.fn(),
		frame: vi.fn((rect: { x: number; y: number; width: number; height: number }, pid: number) =>
			log.events.push(`frame:${pid}:${rect.x},${rect.y},${rect.width},${rect.height}`),
		),
		setMode: vi.fn(),
		hide: vi.fn(),
		close: vi.fn(),
	};
}

function controllerWith(drawn: ReturnType<typeof overlay>) {
	return new input.MacOSInputController(
		1234,
		drawn,
		() => false,
		{ acquire: vi.fn(), release: vi.fn() },
		"background",
		true,
	);
}

beforeEach(() => {
	log.events.length = 0;
	process.env["OPENCUA_TYPE_CHARACTER_DELAY_MS"] = "0";
	process.env["OPENCUA_TYPE_RHYTHM"] = "constant";
	input.setOnscreenWindowIdsSourceForTesting(() => [WINDOW.id]);
	input.setScreenLayoutSourceForTesting(() => ({ displays: [MAIN_DISPLAY], windows: [WINDOW.bounds] }));
	input.setFocusStealWatcherForTesting(() => undefined);
	input.setKeyboardPidResolverForTesting((pid) => pid);
	input.setKeyboardWindowFocuserForTesting(async () => undefined);
	input.setCaretFrameSourceForTesting(() => ({ x: 120, y: 80, width: 1, height: 16 }));
});

afterEach(() => {
	input.setCaretFrameSourceForTesting(undefined);
	Reflect.deleteProperty(process.env, "OPENCUA_TYPE_CHARACTER_DELAY_MS");
	Reflect.deleteProperty(process.env, "OPENCUA_TYPE_RHYTHM");
});

describe("#given background delivery with the drawn cursor #when the agent acts #then the cursor arrives first, as a hand does", () => {
	it("#when clicking #then the glide to the point finishes before the button goes down", async () => {
		const drawn = overlay();
		const controller = controllerWith(drawn);
		await controller.click({ x: 50, y: 70 });

		const glide = log.events.indexOf("glide:50,70");
		// The activation primer goes to an offscreen point first; the press under test is the one at the target.
		const down = log.events.indexOf("mouse:down:50");
		expect(glide).toBeGreaterThanOrEqual(0);
		expect(down).toBeGreaterThan(glide);
		controller.close();
	});

	it("#when acting on a window #then that window is marked with its bounds before the press", async () => {
		const drawn = overlay();
		const controller = controllerWith(drawn);
		await controller.click({ x: 50, y: 70 });

		const frame = log.events.indexOf("frame:1234:10,20,300,200");
		expect(frame).toBeGreaterThanOrEqual(0);
		expect(frame).toBeLessThan(log.events.indexOf("mouse:down:50"));
		controller.close();
	});

	it("#when typing #then the cursor glides to the caret line before the first character", async () => {
		const drawn = overlay();
		const controller = controllerWith(drawn);
		await controller.click({ x: 50, y: 70 });
		log.events.length = 0;

		await controller.typeText("hi");

		const glide = log.events.indexOf("glide:120,88");
		expect(glide).toBeGreaterThanOrEqual(0);
		expect(log.events.indexOf("text:h")).toBeGreaterThan(glide);
		controller.close();
	});
});
