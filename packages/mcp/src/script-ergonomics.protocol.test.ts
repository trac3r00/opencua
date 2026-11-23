import { afterEach, describe, expect, it } from "bun:test";
import type { Rect } from "@opencua/core";
import { createHarness, jsonPayload } from "./protocol-client-harness.js";
import { FakeGuardedComputer } from "./protocol-test-harness.js";
import { setVisibleFramesSourceForTesting } from "./script-tools.js";

let closeHarness: (() => Promise<void>) | undefined;

afterEach(async () => {
	setVisibleFramesSourceForTesting(undefined);
	if (closeHarness !== undefined) {
		await closeHarness();
		closeHarness = undefined;
	}
});

async function runScript(code: string, computer = new FakeGuardedComputer()) {
	const harness = await createHarness(computer);
	closeHarness = harness.close;
	const payload = jsonPayload(await harness.client.callTool({ name: "run_script", arguments: { code } }));
	return { payload, computer };
}

describe("run_script #given the shapes agents write #when a script uses them #then they work instead of failing", () => {
	it("#when a script waits with setTimeout #then the timer fires", async () => {
		const { payload } = await runScript(`
			const order = [];
			await new Promise((resolve) => setTimeout(() => { order.push("fired"); resolve(); }, 5));
			const cancelled = setTimeout(() => order.push("cancelled"), 1);
			clearTimeout(cancelled);
			await sleep(5);
			return order;
		`);

		expect(payload).toMatchObject({ ok: true, value: ["fired"] });
	});

	it("#when observe gets snake_case options and a profile hint #then it observes", async () => {
		const { payload } = await runScript(`
			const state = await apple.app("Finder").observe({ max_elements: 5, include_screenshot: false, profile: "fast" });
			return Array.isArray(state.elements);
		`);

		expect(payload).toMatchObject({ ok: true, value: true });
	});

	it("#when observe gets an unknown option #then the error names it and the valid keys", async () => {
		const { payload } = await runScript(`await apple.app("Finder").observe({ bogus: 1 });`);

		expect(payload["ok"]).toBe(false);
		expect(String(payload["error"])).toContain('unknown key "bogus"');
		expect(String(payload["error"])).toContain("valid keys: diffOnly, maxElements");
	});

	it("#when app.getAppState is called #then it observes like app.observe", async () => {
		const { payload } = await runScript(`
			const state = await apple.app("Finder").getAppState();
			return state.app;
		`);

		expect(payload).toMatchObject({ ok: true, value: "Finder" });
	});

	it("#when app.click gets {x, y} after an observation #then it clicks that point", async () => {
		const { payload, computer } = await runScript(`
			const finder = apple.app("Finder");
			await finder.observe();
			await finder.click({ x: 120, y: 210 });
			return "clicked";
		`);

		expect(payload).toMatchObject({ ok: true, value: "clicked" });
		expect(computer.effects).toContainEqual(expect.objectContaining({ kind: "click" }));
	});

	it.each([
		["a bare point", "{ x: 120, y: 210 }"],
		["kind instead of type", '{ kind: "click", x: 120, y: 210 }'],
	])("#when a hands pointer step is %s #then it is a click", async (_name, step) => {
		const { payload, computer } = await runScript(`
			const finder = apple.app("Finder");
			await finder.observe();
			await finder.hands({ chunks: [{ pointer: [${step}] }] });
			return "done";
		`);

		expect(payload).toMatchObject({ ok: true, value: "done" });
		expect(computer.effects).toContainEqual(expect.objectContaining({ kind: "click" }));
	});
});

describe("run_script #given two app handles #when apple.arrange puts them side by side #then each window gets one column of the usable screen", () => {
	it("sets both frames from the screen's visible area, one per app process", async () => {
		const frames: { readonly pid: number; readonly frame: Rect }[] = [];
		const computer = Object.assign(new FakeGuardedComputer(), {
			setWindowFrame: async (pid: number, _windowId: number, frame: Rect) => {
				frames.push({ pid, frame });
				return { requested: frame, applied: frame, verified: true, attempts: 1 };
			},
		});
		setVisibleFramesSourceForTesting(() => [
			{ frame: { x: 0, y: 0, width: 2560, height: 1440 }, visible: { x: 0, y: 31, width: 2560, height: 1345 } },
		]);

		const { payload } = await runScript(
			`return await apple.arrange([apple.app("Finder"), apple.app("Other")], { gap: 8 });`,
			computer,
		);

		expect(payload).toMatchObject({
			ok: true,
			value: [
				{ app: "Finder", frame: { x: 0, y: 31, width: 1276, height: 1345 } },
				{ app: "Other", frame: { x: 1284, y: 31, width: 1276, height: 1345 } },
			],
		});
		expect(frames).toEqual(
			expect.arrayContaining([
				{ pid: 1234, frame: { x: 0, y: 31, width: 1276, height: 1345 } },
				{ pid: 5678, frame: { x: 1284, y: 31, width: 1276, height: 1345 } },
			]),
		);
	});

	it("refuses, naming the app, when one window is on another Space, and moves nothing", async () => {
		const frames: Rect[] = [];
		const computer = Object.assign(new FakeGuardedComputer(), {
			setWindowFrame: async (_pid: number, _windowId: number, frame: Rect) => {
				frames.push(frame);
				return { requested: frame, applied: frame, verified: true, attempts: 1 };
			},
		});
		setVisibleFramesSourceForTesting(() => [
			{ frame: { x: 0, y: 0, width: 2560, height: 1440 }, visible: { x: 0, y: 31, width: 2560, height: 1345 } },
		]);
		const harness = await createHarness(computer, async () => [
			{
				id: computer.windowId,
				ownerPid: 5678,
				ownerName: "Other",
				title: "Elsewhere",
				bounds: { x: 0, y: 0, width: 800, height: 600 },
				space: { spaceIds: [9], current: false },
			},
		]);
		closeHarness = harness.close;

		const payload = jsonPayload(
			await harness.client.callTool({
				name: "run_script",
				arguments: { code: `return await apple.arrange([apple.app("Finder"), apple.app("Other")]);` },
			}),
		);

		expect(payload["ok"]).toBe(false);
		expect(String(payload["error"])).toContain("cannot bring Other here");
		expect(frames).toEqual([]);
	});

	it("refuses anything that is not an app handle", async () => {
		const { payload } = await runScript(`return await apple.arrange(["Finder"]);`);

		expect(payload["ok"]).toBe(false);
		expect(String(payload["error"])).toContain("handles from apple.app");
	});
});
