import { afterEach, describe, expect, it } from "bun:test";
import type { AppState } from "../../accessibility/types.js";
import type { ComputerInterface } from "../../computer/interface.js";
import {
	type WindowsHostComputer,
	WindowsHostError,
	type WindowsTransport,
	createWindowsHostComputer,
} from "./index.js";

function snapshot(sequence: number): AppState {
	return {
		app: "Fixture",
		bundleId: "Fixture.exe",
		pid: 42,
		frontmost: false,
		axAvailable: true,
		elements: [
			{
				id: sequence * 10,
				role: "AXButton",
				label: "Run",
				value: null,
				frame: { x: 110, y: 220, width: 80, height: 30 },
				actions: ["press", "toggle", "setValue", "selectText", "scroll"],
				children: [],
			},
		],
		observationKey: `snapshot-${sequence}`,
		screenshotBase64: Buffer.from("png").toString("base64"),
		screenshotWidth: 200,
		screenshotHeight: 100,
		screenshotMimeType: "image/png",
		display: { width: 1920, height: 1080, scaleFactor: 1 },
		windowBounds: { x: 100, y: 200, width: 400, height: 200 },
		windowId: 123,
		windowTitle: "Fixture window",
		windowCandidates: [{ id: 123, title: "Fixture window", bounds: { x: 100, y: 200, width: 400, height: 200 } }],
		elementsTruncated: false,
		treeSkipped: false,
	};
}

/** Wire fixture retains snapshot identity and mutable text, rather than echoing request arguments. */
class FakeTransport implements WindowsTransport {
	generation = 1;
	sequence = 0;
	activeSequence = 0;
	value = "";
	closed = false;
	staleRuntime = false;
	readonly requests: Array<{ method: string; params: Readonly<Record<string, unknown>> }> = [];
	async request(method: string, params: Readonly<Record<string, unknown>> = {}): Promise<unknown> {
		this.requests.push({ method, params });
		switch (method) {
			case "snapshot": {
				const state = snapshot(++this.sequence);
				const options = params["options"];
				const probe =
					typeof options === "object" && options !== null && "probe" in options && options.probe === true;
				if (!probe) this.activeSequence = this.sequence;
				if (typeof options === "object" && options !== null && "includeAccessibilityTree" in options) {
					if (options.includeAccessibilityTree === false) {
						state.treeSkipped = true;
						state.elements = [];
					}
				}
				return state;
			}
			case "action":
				if (this.staleRuntime || params["snapshot"] !== `snapshot-${this.activeSequence}`) {
					throw new WindowsHostError("STALE_REF", "RuntimeId no longer matches");
				}
				if (params["action"] === "setValue") this.value = String(params["value"]);
				return null;
			case "type":
				this.value += String(params["text"]);
				return true;
			case "listApps":
				return [{ name: "Fixture", bundleId: "Fixture.exe", pid: 42, isRunning: true, isFrontmost: false }];
			case "listWindows":
				return snapshot(1).windowCandidates;
			case "screenshot":
				return { data: Buffer.from("png").toString("base64"), width: 200, height: 100, mimeType: "image/png" };
			case "screen":
				return { width: 1920, height: 1080 };
			case "cursor":
				return { x: 900, y: 700 };
			case "physical":
				return null;
			case "postTarget":
				return { hwnd: 777, originX: 100, originY: 200 };
			case "post":
				return true;
			default:
				throw new Error(`Unexpected method: ${method}`);
		}
	}
	async close(): Promise<void> {
		this.closed = true;
	}
}

const computers: WindowsHostComputer[] = [];
afterEach(async () => {
	for (const computer of computers.splice(0)) await computer.close();
});

async function fixture(physical = false) {
	const transport = new FakeTransport();
	const computer = createWindowsHostComputer({ transport, physical });
	computers.push(computer);
	computer.setTarget(42);
	await computer.getAppState();
	return { computer, transport };
}

describe("Windows ComputerInterface", () => {
	it("#given window coordinates #when observing #then returns matching screenshot space and global frames", async () => {
		const { computer } = await fixture();
		const state = await computer.getAppState();
		expect(state.elements[0]?.frame).toEqual({ x: 5, y: 10, width: 40, height: 15 });
		expect(await computer.elementFrame(42, 1)).toEqual({ x: 110, y: 220, width: 80, height: 30 });
		expect(await computer.getScreenshotViewport(42)).toEqual({
			windowBounds: { x: 100, y: 200, width: 400, height: 200 },
			screenshotWidth: 200,
			screenshotHeight: 100,
		});
	});

	it("#given no target #when capturing #then requires an explicit process", async () => {
		const computer = createWindowsHostComputer({ transport: new FakeTransport() });
		computers.push(computer);
		await expect(computer.screenshot()).rejects.toMatchObject({ code: "TARGET_REQUIRED" });
		computer.setTarget(42);
		computer.setTarget();
		await expect(computer.type("text")).rejects.toMatchObject({ code: "TARGET_REQUIRED" });
	});

	it("#given an app #when listing apps identities and windows #then parses native inventory", async () => {
		const { computer } = await fixture();
		expect(await computer.listApps()).toEqual([
			{ name: "Fixture", bundleId: "Fixture.exe", pid: 42, isRunning: true, isFrontmost: false },
		]);
		expect(await computer.listAppIdentities()).toEqual(await computer.listApps());
		expect(await computer.listWindows(42)).toEqual([
			{ id: 123, title: "Fixture window", bounds: { x: 100, y: 200, width: 400, height: 200 } },
		]);
	});

	it("#given an observed window #when capturing #then decodes the image and dimensions", async () => {
		const { computer } = await fixture();
		expect(await computer.screenshot({ format: "png" })).toEqual({
			data: Buffer.from("png"),
			width: 200,
			height: 100,
			mimeType: "image/png",
		});
		expect(await computer.getScreenSize()).toEqual({ width: 1920, height: 1080 });
	});

	it("#given background mode #when moving #then tracks a logical cursor without transport input", async () => {
		const { computer, transport } = await fixture();
		await computer.move({ x: 13, y: 17 });
		expect(await computer.getCursorPosition()).toEqual({ x: 13, y: 17 });
		expect(transport.requests.map((request) => request.method)).toEqual(["snapshot"]);
	});

	it("#given writable text #when setting and typing #then updates the target without physical input", async () => {
		const { computer, transport } = await fixture();
		await computer.setValue(42, 0, "first");
		await computer.type(" second");
		expect(await computer.typeIntoFocused(42, " third", { settleWrite: true })).toBe(true);
		expect(transport.value).toBe("first second third");
	});

	interface SemanticCase {
		name: string;
		run(computer: WindowsHostComputer): Promise<unknown>;
		action: string;
	}
	const semanticCases: SemanticCase[] = [
		{ name: "click", run: (c) => c.click({ x: 120, y: 225 }), action: "press" },
		{ name: "pressAtPosition", run: (c) => c.pressAtPosition(42, { x: 120, y: 225 }), action: "press" },
		{ name: "performAction", run: (c) => c.performAction(42, 0, "AXPress"), action: "press" },
		{ name: "toggle", run: (c) => c.performAction(42, 0, "toggle"), action: "toggle" },
		{ name: "select", run: (c) => c.performAction(42, 0, "select"), action: "select" },
		{ name: "expand", run: (c) => c.performAction(42, 0, "expand"), action: "expand" },
		{ name: "collapse", run: (c) => c.performAction(42, 0, "collapse"), action: "collapse" },
		{ name: "selectText", run: (c) => c.selectText(42, 0, { selection: "text", text: "Run" }), action: "selectText" },
		{ name: "scroll", run: (c) => c.scroll({ direction: "down", amount: 2 }), action: "scroll" },
		{
			name: "positioned scroll",
			run: (c) => c.scroll({ direction: "left", amount: 1, position: { x: 120, y: 225 } }),
			action: "scroll",
		},
	];
	it.each(semanticCases)(
		"#given observed refs #when $name #then sends only a snapshot-scoped semantic action",
		async ({ run, action }) => {
			const { computer, transport } = await fixture();
			await run(computer);
			expect(transport.requests.at(-1)).toMatchObject({
				method: "action",
				params: { action, pid: 42, ref: 10, snapshot: "snapshot-1" },
			});
			const physical = /physical|SendInput|SetCursorPos|SetForegroundWindow/;
			expect(transport.requests.some((request) => physical.test(request.method))).toBe(false);
		},
	);

	const physicalCases: Array<{ name: string; run(computer: ComputerInterface): Promise<unknown> }> = [
		{ name: "rightClick", run: (c) => c.rightClick({ x: 1, y: 2 }) },
		{ name: "middleClick", run: (c) => c.middleClick({ x: 1, y: 2 }) },
		{ name: "doubleClick", run: (c) => c.doubleClick({ x: 1, y: 2 }) },
		{ name: "key", run: (c) => c.key("enter", { modifiers: ["ctrl"] }) },
		{ name: "drag", run: (c) => c.drag({ from: { x: 1, y: 2 }, to: { x: 3, y: 4 } }) },
		{ name: "unmatched click", run: (c) => c.click({ x: 1, y: 2 }) },
	];
	it("#given background #when key #then refuses physical input", async () => {
		const { computer, transport } = await fixture();
		await expect(computer.key("enter", { modifiers: ["ctrl"] })).rejects.toMatchObject({
			code: "PHYSICAL_INPUT_REQUIRED",
		});
		expect(transport.requests.map((request) => request.method)).toEqual(["snapshot"]);
	});

	it.each(physicalCases.filter((entry) => entry.name !== "key"))(
		"#given background #when $name #then posts window messages and never physical input",
		async ({ run }) => {
			const { computer, transport } = await fixture();
			await run(computer);
			expect(transport.requests.map((request) => request.method)).toEqual(["snapshot", "postTarget", "post"]);
			const post = transport.requests.at(-1)?.params;
			expect(post?.["hwnd"]).toBe(777);
			const messages = post?.["messages"];
			expect(Array.isArray(messages) ? messages[0] : undefined).toMatchObject({
				lParam: ((2 - 200) & 0xffff) * 0x10000 + ((1 - 100) & 0xffff),
			});
		},
	);

	it("#given background #when a modifier the messages cannot carry is held #then refuses before posting", async () => {
		const { computer, transport } = await fixture();
		await expect(computer.rightClick({ x: 1, y: 2 }, { modifiers: ["alt"] })).rejects.toMatchObject({
			code: "UNSUPPORTED",
		});
		await expect(computer.drag({ from: { x: 1, y: 2 }, to: { x: 3, y: 4 }, duration: 200 })).rejects.toMatchObject({
			code: "UNSUPPORTED",
		});
		expect(transport.requests.map((request) => request.method)).toEqual(["snapshot"]);
	});

	it.each(physicalCases)("#given physical #when $name #then sends physical input", async ({ run }) => {
		const { computer, transport } = await fixture(true);
		await run(computer);
		expect(transport.requests.at(-1)?.method).toBe("physical");
	});

	it("#given physical opt-in #when moving and reading cursor #then uses native coordinates", async () => {
		const { computer, transport } = await fixture(true);
		await computer.move({ x: 22, y: 44 });
		expect(transport.requests.at(-1)).toMatchObject({ method: "physical", params: { kind: "move", x: 22, y: 44 } });
		expect(await computer.getCursorPosition()).toEqual({ x: 900, y: 700 });
	});

	it("#given a new snapshot #when using an old ref or key #then rejects it as stale", async () => {
		const { computer } = await fixture();
		await computer.getAppState();
		expect(() => computer.assertObservationCurrent(42, "snapshot-1")).toThrow(/STALE_REF/);
		await expect(computer.setValue(42, 0, "wrong")).rejects.toMatchObject({ code: "STALE_REF" });
		expect(() => computer.assertObservationCurrent(42, "snapshot-2")).not.toThrow();
	});

	it("#given a changed RuntimeId #when acting on its ref #then propagates STALE_REF", async () => {
		const { computer, transport } = await fixture();
		transport.staleRuntime = true;
		await expect(computer.performAction(42, 0, "press")).rejects.toMatchObject({ code: "STALE_REF" });
	});

	it("#given a restarted host #when using the old observation #then rejects it before dispatch", async () => {
		const { computer, transport } = await fixture();
		transport.generation++;
		await expect(computer.performAction(42, 0, "press")).rejects.toMatchObject({ code: "STALE_REF" });
		expect(transport.requests.map((request) => request.method)).toEqual(["snapshot"]);
	});

	it("#given recycled helper ids #when observing after restart #then old client refs still cannot alias", async () => {
		const { computer, transport } = await fixture();
		transport.generation++;
		transport.sequence = 0;
		const state = await computer.getAppState();
		expect(state.elements[0]?.id).toBe(1);
		await expect(computer.performAction(42, 0, "press")).rejects.toMatchObject({ code: "STALE_REF" });
		await computer.performAction(42, 1, "press");
		expect(transport.requests.at(-1)).toMatchObject({ method: "action", params: { ref: 10 } });
	});

	it("#given an input observation #when probing #then preserves the original input refs and viewport", async () => {
		const { computer, transport } = await fixture();
		const probe = await computer.getAppState(42, { probe: true });
		expect(probe.observationKey).toBe("snapshot-2");
		computer.assertObservationCurrent(42, "snapshot-1");
		await computer.performAction(42, 0, "press");
		expect(transport.requests.at(-1)).toMatchObject({ method: "action", params: { snapshot: "snapshot-1" } });
	});

	it("#given capture-only observation #when attempting an element action #then rejects stale refs", async () => {
		const { computer } = await fixture();
		await computer.getAppState(42, { includeAccessibilityTree: false });
		await expect(computer.performAction(42, 0, "press")).rejects.toMatchObject({ code: "STALE_REF" });
	});

	it("#given an empty position #when pressing #then reports no semantic target", async () => {
		const { computer } = await fixture();
		expect(await computer.pressAtPosition(42, { x: 1, y: 2 })).toBe(false);
	});

	it("#given invalid or unsupported options #when requesting them #then rejects rather than silently degrading", async () => {
		const { computer } = await fixture();
		const invalidScroll = computer.scroll({ direction: "down", amount: -1 });
		await expect(invalidScroll).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
		await expect(computer.getAppState(42, { maxElements: 0 })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
		await expect(computer.screenshot({ quality: 90 })).rejects.toMatchObject({ code: "UNSUPPORTED" });
		await expect(computer.getAppState(42, { diffOnly: true })).rejects.toMatchObject({ code: "UNSUPPORTED" });
		await expect(computer.selectText(42, 0, { selection: "text", prefix: "a" })).rejects.toMatchObject({
			code: "UNSUPPORTED",
		});
	});

	it("#given a closed backend #when closing #then releases the host and invalidates refs", async () => {
		const { computer, transport } = await fixture();
		await computer.close();
		expect(transport.closed).toBe(true);
		expect(() => computer.assertObservationCurrent(42, "snapshot-1")).toThrow(/STALE_REF/);
	});
});
