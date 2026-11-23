import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InputObservation } from "@opencua/core";
import { CursorKeyedObservations } from "../../core/src/platform/cursor-observations.js";
import { registerOwnedSurface, setSurfaceBinaryForTesting } from "../../core/src/platform/owned-surfaces.js";
import { GuardedSession } from "./guarded-session.js";
import { Deferred, FakeGuardedComputer } from "./protocol-test-harness.js";
import type { RunStep } from "./tool-schemas.js";
import { WorkerCoordinator } from "./worker-coordinator.js";

const steps: readonly RunStep[] = [{ type: "set_value", element_index: "20", value: "stroke" }];

/** An owned surface: this test process stands in for it, and observations are kept per cursor as the driver does. */
class SharedSurfaceComputer extends FakeGuardedComputer {
	readonly cursorObservations = new CursorKeyedObservations<InputObservation>(() => true);
	firstWrite: Deferred<void> | undefined;

	override async listApps() {
		return (await super.listApps()).map((app) => (app.name === "Finder" ? { ...app, pid: process.pid } : app));
	}

	override async getAppState(...args: Parameters<FakeGuardedComputer["getAppState"]>) {
		const state = await super.getAppState(...args);
		const observation = super.getInputObservation(state.pid);
		if (observation !== undefined) this.cursorObservations.set(state.pid, observation);
		return state;
	}

	override getInputObservation(targetPid: number): InputObservation | undefined {
		return this.cursorObservations.get(targetPid);
	}

	override async setValue(pid: number, id: number, value: string): Promise<void> {
		const gate = this.firstWrite;
		this.firstWrite = undefined;
		await gate?.promise;
		await super.setValue(pid, id, value);
	}
}

let stateDir: string;
let previousStateDir: string | undefined;

beforeEach(() => {
	stateDir = realpathSync(mkdtempSync(join(tmpdir(), "opencua-shared-surface-")));
	previousStateDir = process.env["OPENCUA_STATE_DIR"];
	process.env["OPENCUA_STATE_DIR"] = stateDir;
	setSurfaceBinaryForTesting(process.execPath);
	registerOwnedSurface({ pid: process.pid, title: "shared canvas", url: "http://127.0.0.1/" });
});

afterEach(() => {
	setSurfaceBinaryForTesting(undefined);
	if (previousStateDir === undefined) Reflect.deleteProperty(process.env, "OPENCUA_STATE_DIR");
	else process.env["OPENCUA_STATE_DIR"] = previousStateDir;
	rmSync(stateDir, { recursive: true, force: true });
});

describe("#given one opencua-owned surface #when two workers share it #then each keeps its own token and lane", () => {
	it("assigns both workers to the window and lets the second act while the first is still acting", async () => {
		const computer = new SharedSurfaceComputer();
		computer.delivery = "background";
		const coordinator = new WorkerCoordinator(new GuardedSession(computer), computer);
		try {
			const [one, two] = await coordinator.assign([
				{ worker_id: "painter-1", task: "left half", app: "Finder" },
				{ worker_id: "painter-2", task: "right half", app: "Finder" },
			]);
			if (one?.observation_token === undefined || two?.observation_token === undefined) {
				throw new Error("both workers need an observation token");
			}
			expect(one.observation_token).not.toBe(two.observation_token);

			const blocked = new Deferred<void>();
			computer.firstWrite = blocked;
			const first = coordinator.run("painter-1", one.observation_token, steps, undefined);
			const second = await coordinator.run("painter-2", two.observation_token, steps, undefined);
			expect(second.result.isError).not.toBe(true);

			blocked.resolve(undefined);
			expect((await first).result.isError).not.toBe(true);
		} finally {
			await coordinator.close();
		}
	});

	it("still gives an app that is not an owned surface to one worker", async () => {
		const computer = new SharedSurfaceComputer();
		computer.delivery = "background";
		const coordinator = new WorkerCoordinator(new GuardedSession(computer), computer);
		try {
			await expect(
				coordinator.assign([
					{ worker_id: "reader-1", task: "read", app: "Other" },
					{ worker_id: "reader-2", task: "read too", app: "Other" },
				]),
			).rejects.toThrow(/already owned/);
		} finally {
			await coordinator.close();
		}
	});
});
