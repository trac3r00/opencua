import { afterEach, describe, expect, it } from "bun:test";
import type { SystemPrompt, TopLevelWindow, TopLevelWindowOptions } from "@opencua/core";
import { createHarness, jsonPayload } from "./protocol-client-harness.js";
import { FakeGuardedComputer } from "./protocol-test-harness.js";

let closeHarness: (() => Promise<void>) | undefined;

afterEach(async () => {
	if (closeHarness !== undefined) {
		await closeHarness();
		closeHarness = undefined;
	}
});

const WINDOW_BOUNDS = { x: 352, y: 439, width: 920, height: 464 };

function probeWith(windows: readonly TopLevelWindow[]): () => Promise<readonly TopLevelWindow[]> {
	return async () => windows;
}

describe("window discovery #given a machine with on-screen windows #when the agent asks what it can target #then it gets ids and geometry", () => {
	it("lists window id, pid, app, title and bounds", async () => {
		const harness = await createHarness(
			undefined,
			probeWith([
				{ id: 38574, ownerPid: 489, ownerName: "Finder", title: "opencua", bounds: WINDOW_BOUNDS },
				{
					id: 38580,
					ownerPid: 76409,
					ownerName: "TextEdit",
					title: "scratch.txt",
					bounds: { ...WINDOW_BOUNDS, x: 213, y: 77 },
				},
			]),
		);
		closeHarness = harness.close;

		const result = await harness.client.callTool({ name: "list_windows", arguments: {} });
		const payload = jsonPayload(result);

		expect(result.isError).toBeFalsy();
		expect(payload["windows"]).toEqual([
			{ window_id: 38574, pid: 489, app: "Finder", title: "opencua", bounds: WINDOW_BOUNDS },
			{
				window_id: 38580,
				pid: 76409,
				app: "TextEdit",
				title: "scratch.txt",
				bounds: { ...WINDOW_BOUNDS, x: 213, y: 77 },
			},
		]);
	});

	it("lists a window on another Space, which attended input can still bring forward and target", async () => {
		const offSpace = {
			id: 8337,
			ownerPid: 42729,
			ownerName: "Calculator",
			title: "Calculator",
			bounds: WINDOW_BOUNDS,
		};
		const harness = await createHarness(undefined, async (options?: TopLevelWindowOptions) =>
			options?.includeOffscreen === true ? [offSpace] : [],
		);
		closeHarness = harness.close;

		const payload = jsonPayload(await harness.client.callTool({ name: "list_windows", arguments: {} }));

		expect(payload["windows"]).toEqual([
			{ window_id: 8337, pid: 42729, app: "Calculator", title: "Calculator", bounds: WINDOW_BOUNDS },
		]);
	});

	it("answers with an empty list instead of failing when no window probe is available", async () => {
		const harness = await createHarness();
		closeHarness = harness.close;

		const result = await harness.client.callTool({ name: "list_windows", arguments: {} });

		expect(result.isError).toBeFalsy();
		expect(jsonPayload(result)["windows"]).toEqual([]);
	});
});

const SCREEN_RECORDING_PROMPT: SystemPrompt = {
	windowId: 17196,
	ownerPid: 1752,
	owner: "universalAccessAuthWarn",
	title: "Screen Recording",
	kind: "permission",
	bounds: { x: 700, y: 300, width: 520, height: 220 },
};

describe("system dialogs #given macOS has a permission prompt on screen #when the agent looks around #then it is told only the person can answer it", () => {
	it("list_windows names the prompt beside the app windows", async () => {
		const harness = await createHarness(undefined, probeWith([]), undefined, {
			systemPromptProbe: () => [SCREEN_RECORDING_PROMPT],
		});
		closeHarness = harness.close;

		const payload = jsonPayload(await harness.client.callTool({ name: "list_windows", arguments: {} }));

		expect(payload["system_prompts"]).toEqual([
			{ owner: "universalAccessAuthWarn", title: "Screen Recording", kind: "permission", window_id: 17196 },
		]);
		expect(String(payload["system_prompt_note"])).toContain("ask_user");
	});

	it("list_windows stays exactly as before when no system dialog is up", async () => {
		const harness = await createHarness(undefined, probeWith([]), undefined, { systemPromptProbe: () => [] });
		closeHarness = harness.close;

		const payload = jsonPayload(await harness.client.callTool({ name: "list_windows", arguments: {} }));

		expect(payload).toMatchObject({ windows: [] });
		expect(payload["timing_ms"]).toMatchObject({ total: expect.any(Number) });
	});

	it("an app observation carries the prompt so the agent does not act into a blocked screen", async () => {
		const computer = new FakeGuardedComputer();
		computer.systemPrompts = [SCREEN_RECORDING_PROMPT];
		const harness = await createHarness(computer);
		closeHarness = harness.close;

		const payload = jsonPayload(
			await harness.client.callTool({
				name: "get_app_state",
				arguments: { app: "Finder", include_screenshot: false },
			}),
		);

		expect(payload["systemPrompts"]).toEqual([
			{ owner: "universalAccessAuthWarn", title: "Screen Recording", kind: "permission", window_id: 17196 },
		]);
		expect(String(payload["systemPromptNote"])).toContain("ask_user");
	});
});

describe("system dialogs #given a prompt stays on screen #when the agent acts #then action answers stay compact", () => {
	it("lists the prompt after an action without repeating the note an observation already gave", async () => {
		const computer = new FakeGuardedComputer();
		computer.systemPrompts = [SCREEN_RECORDING_PROMPT];
		const harness = await createHarness(computer);
		closeHarness = harness.close;
		const observed = jsonPayload(
			await harness.client.callTool({
				name: "get_app_state",
				arguments: { app: "Finder", include_screenshot: false },
			}),
		);

		const acted = jsonPayload(
			await harness.client.callTool({
				name: "press_keys",
				arguments: { app: "Finder", observation_token: observed["observation_token"], keys: ["a"] },
			}),
		);

		expect(acted["systemPrompts"]).toEqual([
			{ owner: "universalAccessAuthWarn", title: "Screen Recording", kind: "permission", window_id: 17196 },
		]);
		expect(acted["systemPromptNote"]).toBeUndefined();
	});
});

describe("screen recording #given the server lacks the permission #when the agent asks for an image #then it gets the elements and the reason, not a prompt", () => {
	it("answers without an image block and says why", async () => {
		const computer = new FakeGuardedComputer();
		computer.screenCaptureDenied = true;
		const harness = await createHarness(computer);
		closeHarness = harness.close;

		const result = await harness.client.callTool({ name: "get_app_state", arguments: { app: "Finder" } });
		const payload = jsonPayload(result);

		expect(result.isError).toBeFalsy();
		expect((result.content as { type: string }[]).some((block) => block.type === "image")).toBe(false);
		expect(String(payload["screenshotNote"])).toContain("Screen Recording");
		expect(payload["observation_token"]).toEqual(expect.any(String));
	});
});
