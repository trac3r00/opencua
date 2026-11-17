import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { vi } from "@opencua/test-support";

const WINDOW = { id: 99, bounds: { x: 10, y: 20, width: 300, height: 200 } };
const MAIN_DISPLAY = { x: 0, y: 0, width: 1920, height: 1080 };
const EVENT_LATENCY_MILLISECONDS = 300;

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
vi.mock("node:timers/promises", () => ({ setTimeout: () => Promise.resolve() }));
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

const RELEASED = `active:false:${String(WINDOW.id)}`;
const savedEnvironment = {
	delay: process.env["OPENCUA_TYPE_CHARACTER_DELAY_MS"],
	rhythm: process.env["OPENCUA_TYPE_RHYTHM"],
};

function backgroundController() {
	return new input.MacOSInputController(
		1234,
		{ set: vi.fn(), highlight: vi.fn(), setMode: vi.fn(), hide: vi.fn(), close: vi.fn() },
		() => false,
		{ acquire: vi.fn(), release: vi.fn() },
		"background",
		true,
	);
}

/** A window command whose body stays inside until `finish` is called, as a long invoke_menu does. */
async function parkedWindowCommand(controller: ReturnType<typeof backgroundController>) {
	let finish = (): void => undefined;
	const held = new Promise<void>((resolve) => {
		finish = resolve;
	});
	let entered = (): void => undefined;
	const inside = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const command = controller.withWindowCommand(
		1234,
		WINDOW,
		() => true,
		async () => {
			entered();
			await held;
		},
	);
	await inside;
	return { command, finish };
}

beforeEach(() => {
	log.events.length = 0;
	log.latency = 0;
	log.failOn = undefined;
	process.env["OPENCUA_TYPE_CHARACTER_DELAY_MS"] = "0";
	// Activation holding is under test here, not the typing rhythm: keystrokes go back to back.
	process.env["OPENCUA_TYPE_RHYTHM"] = "constant";
	input.setOnscreenWindowIdsSourceForTesting(() => [WINDOW.id]);
	input.setScreenLayoutSourceForTesting(() => ({ displays: [MAIN_DISPLAY], windows: [WINDOW.bounds] }));
	input.setFocusStealWatcherForTesting(() => undefined);
	input.setKeyboardPidResolverForTesting((pid) => pid);
	input.setKeyboardWindowFocuserForTesting(async () => undefined);
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	for (const [name, value] of [
		["OPENCUA_TYPE_CHARACTER_DELAY_MS", savedEnvironment.delay],
		["OPENCUA_TYPE_RHYTHM", savedEnvironment.rhythm],
	] as const) {
		if (value === undefined) {
			Reflect.deleteProperty(process.env, name);
		} else {
			process.env[name] = value;
		}
	}
});

describe("#given a background app the controller tells it is active", () => {
	it("#when one type_text outlasts the idle period #then the app stays active until its last character, then is released once idle", async () => {
		const controller = backgroundController();
		try {
			await controller.click({ x: 50, y: 70 });
			vi.advanceTimersByTime(input.BACKGROUND_ACTIVATION_IDLE_MILLISECONDS);
			log.events.length = 0;
			log.latency = EVENT_LATENCY_MILLISECONDS;

			await controller.typeText("abcdefghijkl");
			log.latency = 0;

			expect(log.events).toEqual([
				`active:true:${String(WINDOW.id)}`,
				..."abcdefghijkl".split("").map((c) => `text:${c}`),
			]);
			vi.advanceTimersByTime(input.BACKGROUND_ACTIVATION_IDLE_MILLISECONDS - 1);
			expect(log.events).not.toContain(RELEASED);
			vi.advanceTimersByTime(1);
			expect(log.events.at(-1)).toBe(RELEASED);
		} finally {
			controller.close();
		}
	});

	it("#when a short call on the same app ends while a window command is still running #then the app stays active until both have finished", async () => {
		const controller = backgroundController();
		try {
			const { command, finish } = await parkedWindowCommand(controller);

			await controller.pressKey("Return");
			vi.advanceTimersByTime(input.BACKGROUND_ACTIVATION_IDLE_MILLISECONDS * 2);
			expect(log.events).not.toContain(RELEASED);

			finish();
			await command;
			vi.advanceTimersByTime(input.BACKGROUND_ACTIVATION_IDLE_MILLISECONDS - 1);
			expect(log.events).not.toContain(RELEASED);
			vi.advanceTimersByTime(1);
			expect(log.events.filter((event) => event === RELEASED)).toEqual([RELEASED]);
		} finally {
			controller.close();
		}
	});

	it("#when an overlapping call fails part-way #then its hold is dropped: the other call keeps the app active and the app is released once idle after it", async () => {
		const controller = backgroundController();
		try {
			const { command, finish } = await parkedWindowCommand(controller);
			log.failOn = "text:c";

			await expect(controller.typeText("abcdef")).rejects.toThrow("post failed");
			vi.advanceTimersByTime(input.BACKGROUND_ACTIVATION_IDLE_MILLISECONDS * 2);
			expect(log.events).not.toContain(RELEASED);

			finish();
			await command;
			vi.advanceTimersByTime(input.BACKGROUND_ACTIVATION_IDLE_MILLISECONDS);
			expect(log.events.at(-1)).toBe(RELEASED);
		} finally {
			controller.close();
		}
	});
});
