import { afterEach, describe, expect, it } from "bun:test";
import type { Rect } from "@opencua/core";
import { createHarness, jsonPayload } from "./protocol-client-harness.js";
import { FakeGuardedComputer } from "./protocol-test-harness.js";
import {
	restoreBrowserCallerForTesting,
	setBrowserCallerForTesting,
	setCleanupDepsForTesting,
	setVisibleFramesSourceForTesting,
} from "./script-tools.js";
import { keySequenceEntries } from "./tool-schemas.js";

let closeHarness: (() => Promise<void>) | undefined;

afterEach(async () => {
	setVisibleFramesSourceForTesting(undefined);
	setCleanupDepsForTesting(undefined);
	restoreBrowserCallerForTesting();
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

describe("press_keys #given a shortcut written as a list #when it runs #then it is one chord, not a lone modifier and a typed letter", () => {
	it.each([
		[["cmd", "a"], ["cmd+a"]],
		[["cmd", "shift", "z"], ["cmd+shift+z"]],
		[
			["cmd", "a", "return"],
			["cmd+a", "return"],
		],
		[[{ key: "cmd" }, { key: "s", hold_seconds: 0.1 }], [{ key: "cmd+s", hold_seconds: 0.1 }]],
		[["shift"], ["shift"]],
		[
			["a", "cmd"],
			["a", "cmd"],
		],
	])("%j -> %j", (keys, expected) => {
		expect(keySequenceEntries(keys)).toEqual(expected);
	});

	it("#when run_script presses ['cmd', 'a'] #then exactly one key event reaches the app", async () => {
		const { payload, computer } = await runScript(`
			const finder = apple.app("Finder");
			await finder.observe();
			await finder.press(["cmd", "a"]);
			return "pressed";
		`);

		expect(payload).toMatchObject({ ok: true, value: "pressed" });
		expect(computer.effects.filter((effect) => effect.kind === "key")).toEqual([{ kind: "key", key: "a" }]);
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

	it("#when the script calls apple.cleanUp after arranging #then each window gets its own frame back", async () => {
		const frames: { readonly pid: number; readonly frame: Rect }[] = [];
		const restored: { readonly pid: number; readonly frame: Rect }[] = [];
		const computer = Object.assign(new FakeGuardedComputer(), {
			setWindowFrame: async (pid: number, _windowId: number, frame: Rect) => {
				frames.push({ pid, frame });
				return { requested: frame, applied: frame, verified: true, attempts: 1 };
			},
		});
		setVisibleFramesSourceForTesting(() => [
			{ frame: { x: 0, y: 0, width: 2560, height: 1440 }, visible: { x: 0, y: 31, width: 2560, height: 1345 } },
		]);
		setCleanupDepsForTesting({
			nameOf: (pid) => `pid ${pid}`,
			frontmostPid: () => undefined,
			isRunning: () => true,
			quit: () => true,
			setFrame: async (pid, _windowId, frame) => {
				restored.push({ pid, frame });
				return true;
			},
		});

		const { payload } = await runScript(
			`await apple.arrange([apple.app("Finder"), apple.app("Other")]); return await apple.cleanUp();`,
			computer,
		);

		expect(payload).toMatchObject({ ok: true });
		expect(frames).toHaveLength(2);
		expect(restored.map((entry) => entry.pid).sort()).toEqual([1234, 5678]);
		expect(restored.every((entry) => entry.frame.width !== 1280)).toBe(true);
	});

	it("refuses anything that is not an app handle", async () => {
		const { payload } = await runScript(`return await apple.arrange(["Finder"]);`);

		expect(payload["ok"]).toBe(false);
		expect(String(payload["error"])).toContain("handles from apple.app");
	});
});

describe("run_script #given OpenCUA Browser #when a script drives a page through apple.browser #then one call carries the whole flow", () => {
	it("passes the context from each answer to the next call and returns only what the script keeps", async () => {
		const calls: { readonly tool: string; readonly args: Record<string, unknown> }[] = [];
		setBrowserCallerForTesting({
			async call(tool, args) {
				calls.push({ tool, args });
				if (tool === "bsk_session")
					return {
						session_id: "s1",
						context_id: "ctx-1",
						observation_id: "obs-1",
						observation: { text: "textbox Name [ref=@e3]" },
					};
				if (tool === "bsk_plan") return { completed: 2, post: { context_id: "ctx-2", observation_id: "obs-2" } };
				return { fields: { title: "Thanks, Ada" } };
			},
			async close() {},
		});

		const { payload } = await runScript(`
			const b = apple.browser();
			const page = await b.open("https://example.test/form");
			const ref = page.observation.text.match(/@e\\d+/)[0];
			await b.plan([{ action: "fill", ref, value: "Ada" }, { action: "click", ref: "@e4" }]);
			const read = await b.read([{ key: "title", read: "text", selector: "h1" }]);
			return read.fields.title;
		`);

		expect(payload).toMatchObject({ ok: true, value: "Thanks, Ada" });
		expect(calls.map((entry) => entry.tool)).toEqual(["bsk_session", "bsk_plan", "bsk_inspect"]);
		expect(calls[1]?.args).toMatchObject({ context: "ctx-1", observation: "obs-1", scope: "opencua" });
		expect(calls[1]?.args["steps"]).toEqual([
			{ action: "fill", ref: "@e3", value: "Ada" },
			{ action: "click", ref: "@e4" },
		]);
		expect(calls[2]?.args).toMatchObject({ action: "read", context: "ctx-2" });
	});

	it("refuses with the setup command when OpenCUA Browser is not installed", async () => {
		setBrowserCallerForTesting(null);
		const { payload } = await runScript(`await apple.browser().call("bsk_tabs", { action: "list" });`);

		expect(payload["ok"]).toBe(false);
		expect(String(payload["error"])).toContain("opencua browser setup");
	});
});
