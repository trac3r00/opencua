import { describe, expect, it } from "bun:test";
import { vi } from "@opencua/test-support";
import type { AppState } from "../accessibility/types.js";
import type { ComputerInterface } from "../computer/interface.js";
import type { AppStateOptions } from "../types/index.js";
import { GuardedPlatformComputer, type SettleClock } from "./guarded-platform-computer.js";

function element(id: number, label: string, y: number, value: string | null = null): AppState["elements"][number] {
	return { id, role: "Button", label, value, frame: { x: 0, y, width: 10, height: 10 }, actions: [], children: [] };
}

function state(elements: AppState["elements"], windowId = 7): AppState {
	return {
		app: "notepad",
		bundleId: "notepad.exe",
		pid: 42,
		frontmost: false,
		axAvailable: true,
		elements,
		screenshotBase64: "",
		screenshotWidth: 800,
		screenshotHeight: 600,
		display: { width: 1920, height: 1080, scaleFactor: 1 },
		windowBounds: { x: 0, y: 0, width: 800, height: 600 },
		windowId,
	};
}

function fakeInner(states: AppState[]): { readonly computer: ComputerInterface; readonly seen: AppStateOptions[] } {
	const seen: AppStateOptions[] = [];
	const computer: ComputerInterface = {
		capabilities: {
			supportsScreenshot: true,
			supportsInput: true,
			supportsAccessibility: true,
			supportsClipboard: false,
		},
		screenshot: vi.fn<ComputerInterface["screenshot"]>(),
		setTarget: vi.fn<ComputerInterface["setTarget"]>(),
		move: vi.fn<ComputerInterface["move"]>(),
		click: vi.fn<ComputerInterface["click"]>(),
		rightClick: vi.fn<ComputerInterface["rightClick"]>(),
		middleClick: vi.fn<ComputerInterface["middleClick"]>(),
		doubleClick: vi.fn<ComputerInterface["doubleClick"]>(),
		type: vi.fn<ComputerInterface["type"]>(),
		key: vi.fn<ComputerInterface["key"]>(),
		scroll: vi.fn<ComputerInterface["scroll"]>(),
		drag: vi.fn<ComputerInterface["drag"]>(),
		getCursorPosition: vi.fn<ComputerInterface["getCursorPosition"]>(),
		getScreenSize: vi.fn<ComputerInterface["getScreenSize"]>(),
		getAppState: async (_pid, options) => {
			seen.push(options ?? {});
			const next = states.shift();
			if (next === undefined) throw new Error("no state queued");
			return next;
		},
		getScreenshotViewport: vi.fn<ComputerInterface["getScreenshotViewport"]>(),
		listApps: vi.fn<ComputerInterface["listApps"]>(),
		setValue: vi.fn<ComputerInterface["setValue"]>(),
		selectText: vi.fn<ComputerInterface["selectText"]>(),
		performAction: vi.fn<ComputerInterface["performAction"]>(),
		pressAtPosition: vi.fn<ComputerInterface["pressAtPosition"]>(),
		typeIntoFocused: vi.fn<ComputerInterface["typeIntoFocused"]>(),
		assertObservationCurrent: vi.fn(),
		close: async () => {},
	};
	return { computer, seen };
}

function fakeClock(): SettleClock & { readonly slept: number[] } {
	let time = 1_000;
	const slept: number[] = [];
	return {
		slept,
		now: () => time,
		sleep: async (milliseconds) => {
			slept.push(milliseconds);
			time += milliseconds;
		},
	};
}

const OK = element(1, "OK", 10);
const CANCEL = element(2, "Cancel", 30);

describe("#given a Windows or Linux backend that returns full trees #when diffOnly is asked #then the guard answers it", () => {
	it("returns the change and omits the elements once a prior tree of the same window exists", async () => {
		const inner = fakeInner([state([OK]), state([OK, CANCEL])]);
		const guarded = new GuardedPlatformComputer(inner.computer);

		const first = await guarded.getAppState(42, { diffOnly: true });
		expect(first.elements).toEqual([OK]);
		expect(first.treeOmitted).toBeUndefined();

		const second = await guarded.getAppState(42, { diffOnly: true });
		expect(second.elements).toEqual([]);
		expect(second.treeOmitted).toBe(true);
		expect(second.axChangeSummary).toEqual({ added: 1, removed: 0, changed: 0 });
		expect(second.axChanges?.added).toEqual([CANCEL]);
		expect([...(guarded.getInputObservation(42)?.observedElementIds ?? [])]).toEqual([1, 2]);
		expect(inner.seen.every((options) => !("diffOnly" in options) && !("settleMs" in options))).toBe(true);
	});

	it("does not compare trees of different windows", async () => {
		const inner = fakeInner([state([OK], 7), state([CANCEL], 8)]);
		const guarded = new GuardedPlatformComputer(inner.computer);
		await guarded.getAppState(42);
		const other = await guarded.getAppState(42, { diffOnly: true });
		expect(other.elements).toEqual([CANCEL]);
		expect(other.axChangeSummary).toBeUndefined();
	});
});

describe("#given settleMs #when the tree is still changing #then the guard waits for two matching probes or the cap", () => {
	it("stops waiting as soon as two consecutive probes match", async () => {
		const clock = fakeClock();
		const inner = fakeInner([state([OK]), state([OK, CANCEL]), state([OK, CANCEL]), state([OK, CANCEL])]);
		const guarded = new GuardedPlatformComputer(inner.computer, { clock });
		const settled = await guarded.getAppState(42, { settleMs: 1_000 });
		expect(settled.elements).toEqual([OK, CANCEL]);
		expect(clock.slept).toEqual([50, 50]);
		expect(inner.seen.map((options) => options.probe === true)).toEqual([true, true, true, false]);
		expect(inner.seen.slice(0, 3).every((options) => options.includeScreenshot === false)).toBe(true);
	});

	it("gives up at the cap when the tree never settles", async () => {
		const clock = fakeClock();
		const changing = Array.from({ length: 4 }, (_, index) => state([element(1, "Clock", 10, String(index))]));
		const inner = fakeInner([...changing, state([OK])]);
		const guarded = new GuardedPlatformComputer(inner.computer, { clock });
		await guarded.getAppState(42, { settleMs: 120 });
		expect(clock.slept).toEqual([50, 50, 20]);
		expect(inner.seen.at(-1)?.probe).toBeUndefined();
	});

	it("rejects a negative or non-finite settleMs before touching the backend", async () => {
		const inner = fakeInner([]);
		const guarded = new GuardedPlatformComputer(inner.computer);
		for (const settleMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
			await expect(guarded.getAppState(42, { settleMs })).rejects.toThrow(RangeError);
		}
		expect(inner.seen).toEqual([]);
	});
});
