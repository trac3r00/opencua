import { afterEach, describe, expect, it } from "bun:test";
import type { AppState, AppStateOptions, InvokeMenuResult, TopLevelWindow, TopLevelWindowOptions } from "@opencua/core";
import { createHarness, jsonPayload } from "./protocol-client-harness.js";
import { type Effect, FakeGuardedComputer } from "./protocol-test-harness.js";

let closeHarness: (() => Promise<void>) | undefined;

afterEach(async () => {
	if (closeHarness !== undefined) {
		await closeHarness();
		closeHarness = undefined;
	}
});

/** Two documents of one app: a.txt (71) has focus, so a read that names no window lands on it. */
class TwoDocuments extends FakeGuardedComputer {
	/** The window the app's latest observation was on when each menu command ran. */
	readonly menuWindows: (number | undefined)[] = [];

	override async getAppState(targetPid = 1234, options?: AppStateOptions): Promise<AppState> {
		this.windowId = options?.windowId ?? 71;
		return { ...(await super.getAppState(targetPid, options)), windowId: this.windowId };
	}

	override async invokeMenu(pid: number, path: readonly string[]): Promise<InvokeMenuResult> {
		this.menuWindows.push(this.getInputObservation(pid)?.windowId);
		return await super.invokeMenu(pid, path);
	}
}

const BOUNDS = { x: 300, y: 150, width: 1000, height: 800 };

interface ProbeState {
	/** b.txt is open; false drops it from the listing, as closing it would. */
	open: boolean;
	readonly asked: (TopLevelWindowOptions | undefined)[];
}

/** The WindowServer listing as a server without Screen Recording sees it: b.txt is untitled until its app is asked. */
function windowProbe(state: ProbeState) {
	return async (options?: TopLevelWindowOptions): Promise<readonly TopLevelWindow[]> => {
		state.asked.push(options);
		const wanted = options?.titlesFor;
		const titled = wanted === "all" || wanted?.includes(1234) === true;
		return [
			{ id: 71, ownerPid: 1234, ownerName: "Finder", title: "a.txt", bounds: BOUNDS },
			...(state.open
				? [{ id: 72, ownerPid: 1234, ownerName: "Finder", title: titled ? "b.txt" : "", bounds: BOUNDS }]
				: []),
			{ id: 90, ownerPid: 5678, ownerName: "Other", title: "b.txt notes", bounds: BOUNDS },
		];
	};
}

async function start() {
	const computer = new TwoDocuments();
	const probe: ProbeState = { open: true, asked: [] };
	const harness = await createHarness(computer, windowProbe(probe));
	closeHarness = harness.close;
	return { harness, computer, probe };
}

async function runScript(harness: Awaited<ReturnType<typeof start>>["harness"], code: string) {
	return jsonPayload(await harness.client.callTool({ name: "run_script", arguments: { code } }));
}

function inputEffects(effects: readonly Effect[]): Effect[] {
	return effects.filter((effect) => effect.kind !== "close");
}

describe("run_script #given an app with two documents #when a handle is bound to one by its title", () => {
	it("#then its observation, every read around its actions, and its menu command stay on that window", async () => {
		const { harness, computer } = await start();

		const payload = await runScript(
			harness,
			`const b = apple.app("Finder", { window: "b.txt" });
			const state = await b.observe();
			await b.setValue(20, "BBB edited");
			await b.menu(["File", "Save"]);
			return { windowId: state.windowId, window: b.window };`,
		);

		expect(payload).toMatchObject({ ok: true, value: { windowId: 72, window: "b.txt" } });
		expect(computer.menuWindows).toEqual([72]);
		expect(computer.stateOptions.map((options) => options?.windowId)).toEqual(computer.stateOptions.map(() => 72));
		// The first step resolved its element against the observation's own read instead of reading again.
		expect(computer.stateOptions.some((options) => options?.settleMs === 80)).toBe(false);
		expect(inputEffects(computer.effects)).toEqual([
			{ kind: "setValue", pid: 1234, id: 20, value: "BBB edited" },
			{ kind: "invokeMenu", pid: 1234, path: ["File", "Save"] },
		]);
	});

	it("#then a unique part of the title binds too, and no match or several are refused before anything is sent", async () => {
		const { harness, computer } = await start();

		const payload = await runScript(
			harness,
			`const outcomes = {};
			for (const window of ["zzz", ".txt"]) {
				try {
					await apple.app("Finder", { window }).observe();
					outcomes[window] = "observed";
				} catch (error) {
					outcomes[window] = error.refused;
				}
			}
			const part = await apple.app("Finder", { window: "B.TX" }).observe();
			return { outcomes, part: part.windowId };`,
		);

		expect(payload).toMatchObject({
			ok: true,
			value: { outcomes: { zzz: "window-not-found", ".txt": "window-ambiguous" }, part: 72 },
		});
		expect(inputEffects(computer.effects)).toEqual([]);
	});

	it("#then a handle that follows the focused window does not act on the bound window's element ids", async () => {
		const { harness, computer } = await start();

		const payload = await runScript(
			harness,
			`const b = apple.app("Finder", { window: "b.txt" });
			const focused = apple.app("Finder");
			await b.observe();
			try {
				await focused.setValue(20, "into the wrong document");
				return "dispatched";
			} catch (error) {
				return error.refused;
			}`,
		);

		expect(payload).toMatchObject({ ok: true, value: "needs-observation" });
		expect(inputEffects(computer.effects)).toEqual([]);
	});

	it("#then apple.windows lists only that app's windows, titled by the app", async () => {
		const { harness, probe } = await start();

		const payload = await runScript(harness, `return await apple.windows("Finder");`);

		expect(payload["value"]).toEqual([
			{ window_id: 71, pid: 1234, app: "Finder", title: "a.txt", bounds: BOUNDS, z_order: 0 },
			{ window_id: 72, pid: 1234, app: "Finder", title: "b.txt", bounds: BOUNDS, z_order: 1 },
		]);
		expect(probe.asked).toContainEqual({
			titlesFor: [1234],
			includeOffscreen: true,
			withSpaces: true,
			withDisplays: true,
			withFocus: true,
		});
	});
});

describe("list_windows #given window titles the WindowServer withholds #when it runs #then every app is asked to name its windows", () => {
	it("reports the title the app gives", async () => {
		const { harness, probe } = await start();

		const payload = jsonPayload(await harness.client.callTool({ name: "list_windows", arguments: {} }));

		expect(payload["windows"]).toContainEqual(expect.objectContaining({ window_id: 72, title: "b.txt" }));
		expect(probe.asked).toEqual([
			{ titlesFor: "all", includeOffscreen: true, withSpaces: true, withDisplays: true, withFocus: true },
		]);
	});
});

describe("get_app_state #given window_id named a window #when actions follow", () => {
	it("#then their outcome reads stay on that window until it closes, then follow the focused one", async () => {
		const { harness, computer, probe } = await start();
		const observed = jsonPayload(
			await harness.client.callTool({ name: "get_app_state", arguments: { app: "Finder", window_id: 72 } }),
		);

		const first = jsonPayload(
			await harness.client.callTool({
				name: "set_value",
				arguments: {
					app: "Finder",
					observation_token: observed["observation_token"],
					element_index: "20",
					value: "one",
				},
			}),
		);
		expect(computer.stateOptions.at(-1)?.windowId).toBe(72);

		probe.open = false;
		await harness.client.callTool({
			name: "set_value",
			arguments: { app: "Finder", observation_token: first["observation_token"], element_index: "21", value: "two" },
		});

		expect(computer.stateOptions.at(-1)?.windowId).toBeUndefined();
		expect(inputEffects(computer.effects)).toEqual([
			{ kind: "setValue", pid: 1234, id: 20, value: "one" },
			{ kind: "setValue", pid: 1234, id: 21, value: "two" },
		]);
	});
});
