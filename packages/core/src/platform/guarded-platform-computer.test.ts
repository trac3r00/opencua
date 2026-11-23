import { describe, expect, it } from "bun:test";
import { vi } from "@opencua/test-support";
import type { AppState } from "../accessibility/types.js";
import type { ComputerInterface } from "../computer/interface.js";
import { AppApprovalStore } from "../permission/app-approval.js";
import { GuardedPlatformComputer } from "./guarded-platform-computer.js";

function element(id: number): AppState["elements"][number] {
	return {
		id,
		role: "Edit",
		label: "",
		value: null,
		frame: { x: 0, y: 0, width: 1, height: 1 },
		actions: [],
		children: [],
	};
}

function state(windowBounds: { x: number; y: number; width: number; height: number }, windowId = 7): AppState {
	return {
		app: "notepad",
		bundleId: "notepad.exe",
		pid: 42,
		frontmost: false,
		axAvailable: true,
		elements: [element(1), element(2)],
		screenshotBase64: "",
		screenshotWidth: windowBounds.width,
		screenshotHeight: windowBounds.height,
		display: { width: 1920, height: 1080, scaleFactor: 1 },
		windowBounds,
		windowId,
	};
}

function fakeInner(states: AppState[]): { readonly computer: ComputerInterface; readonly calls: string[] } {
	const calls: string[] = [];
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
		getAppState: async () => {
			const next = states.shift();
			if (next === undefined) throw new Error("no state queued");
			return next;
		},
		getScreenshotViewport: vi.fn<ComputerInterface["getScreenshotViewport"]>(),
		listApps: vi.fn<ComputerInterface["listApps"]>(),
		setValue: async (pid, id, value) => {
			calls.push(`setValue ${pid} ${id} ${value}`);
		},
		selectText: vi.fn<ComputerInterface["selectText"]>(),
		performAction: vi.fn<ComputerInterface["performAction"]>(),
		pressAtPosition: vi.fn<ComputerInterface["pressAtPosition"]>(),
		typeIntoFocused: vi.fn<ComputerInterface["typeIntoFocused"]>(),
		assertObservationCurrent: vi.fn(),
		close: async () => {
			calls.push("close");
		},
	};
	return { computer, calls };
}

const BOUNDS = { x: 10, y: 20, width: 800, height: 600 };

describe("#given a fresh observation #when preflighting input from it #then input is allowed", () => {
	it("records the observation and passes preflight", async () => {
		const guarded = new GuardedPlatformComputer(fakeInner([state(BOUNDS)]).computer, { inputAllowed: true });
		await guarded.getAppState(42);
		const observation = guarded.getInputObservation(42);
		expect(observation?.observedElementIds).toEqual(new Set([1, 2]));
		expect(observation === undefined ? undefined : await guarded.preflightInput(observation)).toEqual({ ok: true });
		expect(guarded.delivery).toBe("background");
	});
});

describe("#given a newer observation #when preflighting the older one #then it is refused as replaced", () => {
	it("refuses observation-replaced", async () => {
		const guarded = new GuardedPlatformComputer(fakeInner([state(BOUNDS), state(BOUNDS)]).computer, {
			inputAllowed: true,
		});
		await guarded.getAppState(42);
		const old = guarded.getInputObservation(42);
		await guarded.getAppState(42);
		if (old === undefined) throw new Error("expected an observation");
		expect(await guarded.preflightInput(old)).toEqual({ ok: false, reason: "observation-replaced" });
	});
});

describe("#given a moved window #when preflighting #then bounds-dependent input is refused", () => {
	it("refuses window-bounds-changed unless the caller opts out", async () => {
		const guarded = new GuardedPlatformComputer(fakeInner([state(BOUNDS)]).computer, { inputAllowed: true });
		await guarded.getAppState(42);
		const observation = guarded.getInputObservation(42);
		if (observation === undefined) throw new Error("expected an observation");
		const moved = { ...observation, windowBounds: { ...BOUNDS, x: 99 } };
		expect(await guarded.preflightInput(moved)).toEqual({ ok: false, reason: "window-bounds-changed" });
		expect(await guarded.preflightInput(moved, { requireSameBounds: false })).toEqual({ ok: true });
		expect(await guarded.preflightInput({ ...observation, windowId: 8 })).toEqual({
			ok: false,
			reason: "window-changed",
		});
	});
});

describe("#given a host app restriction #when the app is not listed #then preflight refuses it", () => {
	it("returns app-not-approved and still delegates allowed calls", async () => {
		const inner = fakeInner([state(BOUNDS)]);
		const guarded = new GuardedPlatformComputer(inner.computer, {
			approval: new AppApprovalStore(["calc.exe"]),
			inputAllowed: true,
		});
		await guarded.getAppState(42);
		const observation = guarded.getInputObservation(42);
		if (observation === undefined) throw new Error("expected an observation");
		expect(await guarded.preflightInput(observation)).toEqual({ ok: false, reason: "app-not-approved" });
		await guarded.setValue(42, 1, "x");
		await guarded.close();
		expect(inner.calls).toEqual(["setValue 42 1 x", "close"]);
	});
});

describe("#given the user's own desktop (no isolated session) #when input is attempted #then it is refused before delivery", () => {
	it("allows observation but refuses preflight and direct input", async () => {
		const inner = fakeInner([state(BOUNDS)]);
		const guarded = new GuardedPlatformComputer(inner.computer);
		await guarded.getAppState(42);
		const observation = guarded.getInputObservation(42);
		if (observation === undefined) throw new Error("expected an observation");
		expect(await guarded.preflightInput(observation)).toEqual({ ok: false, reason: "isolated-session-required" });
		await expect(guarded.setValue(42, 1, "x")).rejects.toThrow("agent-owned isolated session");
		await expect(guarded.click({ x: 1, y: 1 })).rejects.toThrow("agent-owned isolated session");
		expect(inner.calls).toEqual([]);
	});
});

describe("#given a backend that takes input #when the guard refuses input (the host MCP default) #then capabilities say so", () => {
	it("reports supportsInput false without input allowed and true with it", () => {
		const refusing = new GuardedPlatformComputer(fakeInner([]).computer);
		const allowing = new GuardedPlatformComputer(fakeInner([]).computer, { inputAllowed: true });

		expect(refusing.capabilities).toEqual({
			supportsScreenshot: true,
			supportsInput: false,
			supportsAccessibility: true,
			supportsClipboard: false,
		});
		expect(allowing.capabilities.supportsInput).toBe(true);
	});
});
