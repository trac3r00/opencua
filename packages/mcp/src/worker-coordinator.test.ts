import { describe, expect, it } from "bun:test";
import { currentCursorIdentity, currentInputScope } from "@opencua/core";
import { copyForMatch, vi, whenSettled } from "@opencua/test-support";
import { GuardedSession } from "./guarded-session.js";
import * as notify from "./notify.js";
import { Deferred, FakeGuardedComputer } from "./protocol-test-harness.js";
import type { RunStep } from "./tool-schemas.js";
import { WorkerCoordinator } from "./worker-coordinator.js";

const steps: readonly RunStep[] = [{ type: "set_value", element_index: "20", value: "worker" }];

describe("WorkerCoordinator #given a failed assignment #when sibling reads remain pending #then ownership stays reserved", () => {
	it("waits for all observations before rolling back the assignment batch", async () => {
		const computer = new FakeGuardedComputer();
		computer.delivery = "background";
		const session = new GuardedSession(computer);
		const coordinator = new WorkerCoordinator(session, computer);
		const reading = new Deferred<void>();
		const finish = new Deferred<void>();
		const observe = session.observe.bind(session);
		vi.spyOn(session, "observe").mockImplementation(async (request) => {
			if (request.app === "1234") {
				throw new Error("first app unavailable");
			}
			reading.resolve();
			await finish.promise;
			return observe(request);
		});
		const assignment = coordinator.assign([
			{ worker_id: "one", task: "first", app: "Finder" },
			{ worker_id: "two", task: "second", app: "Other" },
		]);
		const failure = whenSettled(assignment, (settled) => expect(settled).rejects.toThrow("first app unavailable"));
		try {
			await reading.promise;
			await expect(coordinator.assign([{ worker_id: "three", task: "overlapping", app: "Other" }])).rejects.toThrow(
				/already owned/,
			);
			expect(() => coordinator.release("two")).toThrow(/busy/);
		} finally {
			finish.resolve();
			await failure;
			expect(coordinator.status()).toEqual([]);
			await coordinator.close();
		}
	});
});

class CursorObservationComputer extends FakeGuardedComputer {
	readonly observedCursors: (string | undefined)[] = [];

	override async getAppState(...args: Parameters<FakeGuardedComputer["getAppState"]>) {
		this.observedCursors.push(currentCursorIdentity());
		return super.getAppState(...args);
	}
}

class RelaunchedComputer extends FakeGuardedComputer {
	finderPid = 1234;

	override async listApps() {
		return (await super.listApps()).map((app) => (app.name === "Finder" ? { ...app, pid: this.finderPid } : app));
	}
}

describe("WorkerCoordinator #given a worker cursor #when observing #then feedback stays attributed and status stays compact", () => {
	it("scopes assignment and recovery observations without repeating cached images in status", async () => {
		const computer = new CursorObservationComputer();
		const coordinator = new WorkerCoordinator(new GuardedSession(computer), computer);
		try {
			const [assigned] = await coordinator.assign([{ worker_id: "one", task: "edit note", app: "Finder" }]);
			if (assigned === undefined) throw new Error("missing assignment");
			await coordinator.observe("one");

			expect(computer.observedCursors).toEqual([assigned.cursor_id, assigned.cursor_id]);
			expect(coordinator.status()[0]).not.toHaveProperty("observation");
		} finally {
			await coordinator.close();
		}
	});
});

describe("WorkerCoordinator #given a worker run #when it succeeds or rejects #then status retains bounded report-back", () => {
	it("records successful result text and clears it when released", async () => {
		const computer = new FakeGuardedComputer();
		const coordinator = new WorkerCoordinator(new GuardedSession(computer), computer);
		try {
			const [worker] = await coordinator.assign([{ worker_id: "one", task: "edit note", app: "Finder" }]);
			if (worker?.observation_token === undefined) throw new Error("missing worker token");

			await coordinator.run("one", worker.observation_token, steps, undefined);
			expect(coordinator.status()[0]?.lastRun).toMatchObject({ ok: true, stepCount: 1 });
			expect(coordinator.status()[0]?.lastRun?.text).toContain("runSteps");

			coordinator.release("one");
			expect(coordinator.status()).toEqual([]);
		} finally {
			await coordinator.close();
		}
	});

	it("records a bounded rejection and notifies once", async () => {
		const computer = new FakeGuardedComputer();
		const session = new GuardedSession(computer);
		const failure = "x".repeat(250);
		vi.spyOn(session, "runSteps").mockRejectedValue(new Error(failure));
		const coordinator = new WorkerCoordinator(session, computer);
		const notification = vi.spyOn(notify, "postNotification").mockImplementation(() => undefined);
		try {
			const [worker] = await coordinator.assign([{ worker_id: "one", task: "edit note", app: "Finder" }]);
			if (worker?.observation_token === undefined) throw new Error("missing worker token");

			await expect(coordinator.run("one", worker.observation_token, steps, undefined)).rejects.toThrow();
			expect(coordinator.status()[0]?.lastRun).toMatchObject({
				ok: false,
				stepCount: 1,
				errorSummary: failure.slice(0, 200),
			});
			expect(notification).toHaveBeenCalledTimes(1);
			expect(notification).toHaveBeenCalledWith("opencua", `worker one task failed: ${failure.slice(0, 120)}`);
		} finally {
			notification.mockRestore();
			await coordinator.close();
		}
	});

	it("does not expose lastRun for a fresh worker", async () => {
		const computer = new FakeGuardedComputer();
		const coordinator = new WorkerCoordinator(new GuardedSession(computer), computer);
		try {
			await coordinator.assign([{ worker_id: "one", task: "edit note", app: "Finder" }]);
			expect(coordinator.status()[0]).not.toHaveProperty("lastRun");
		} finally {
			await coordinator.close();
		}
	});
});

describe("WorkerCoordinator #given an app relaunch #when refreshing a task #then ownership cannot migrate to a new PID", () => {
	it("refuses to observe the replacement process until the coordinator assigns it explicitly", async () => {
		const computer = new RelaunchedComputer();
		const coordinator = new WorkerCoordinator(new GuardedSession(computer), computer);
		try {
			await coordinator.assign([{ worker_id: "one", task: "edit note", app: "Finder" }]);
			const reads = computer.stateOptions.length;
			computer.finderPid = 7777;

			await expect(coordinator.observe("one")).rejects.toThrow();
			expect(computer.stateOptions).toHaveLength(reads);
			expect(computer.effects).toEqual([]);
		} finally {
			await coordinator.close();
		}
	});
});

describe("WorkerCoordinator #given cancellation #when a chain is interrupted #then later worker steps send no input", () => {
	it("keeps cancellation effective through the worker cursor scope", async () => {
		const computer = new FakeGuardedComputer();
		const coordinator = new WorkerCoordinator(new GuardedSession(computer), computer);
		const abort = new AbortController();
		try {
			const [assigned] = await coordinator.assign([{ worker_id: "one", task: "type then submit", app: "Finder" }]);
			if (assigned?.observation_token === undefined) throw new Error("missing worker token");
			computer.inputGate = async () => abort.abort();

			const run = await coordinator.run(
				"one",
				assigned.observation_token,
				[
					{ type: "type_text", text: "first" },
					{ type: "press_keys", keys: ["return"] },
				],
				undefined,
				{},
				{ signal: abort.signal },
			);
			const text = run.result.content.find((item) => item.type === "text");
			if (text?.type !== "text") throw new Error("missing worker result");
			const result: unknown = JSON.parse(text.text);

			expect(result).toMatchObject({ runSteps: { stoppedEarly: true } });
			expect(computer.targetedInputs.map(({ effect }) => effect.kind)).toEqual(["type"]);
			expect(coordinator.status()[0]?.busy).toBe(false);
		} finally {
			await coordinator.close();
		}
	});
});

describe("WorkerCoordinator #given attended delivery #when workers run concurrently #then gestures remain serialized", () => {
	it("preserves the session input lane and both cursor identities", async () => {
		const computer = new FakeGuardedComputer();
		computer.delivery = "attended";
		const coordinator = new WorkerCoordinator(new GuardedSession(computer), computer);
		const events: { phase: string; pid: number | undefined; cursor: string | undefined }[] = [];
		computer.inputGate = async () => {
			const pid = currentInputScope()?.target?.pid;
			const cursor = currentCursorIdentity();
			events.push({ phase: "start", pid, cursor });
			await Promise.resolve();
			events.push({ phase: "finish", pid, cursor });
		};
		try {
			const workers = await coordinator.assign([
				{ worker_id: "one", task: "first gesture", app: "Finder" },
				{ worker_id: "two", task: "second gesture", app: "Other" },
			]);

			await Promise.all(
				workers.map((worker) => {
					if (worker.observation_token === undefined) throw new Error("missing worker token");
					return coordinator.run(
						worker.worker_id,
						worker.observation_token,
						[{ type: "type_text", text: worker.worker_id }],
						undefined,
					);
				}),
			);

			expect(events).toEqual([
				{ phase: "start", pid: 1234, cursor: workers[0]?.cursor_id },
				{ phase: "finish", pid: 1234, cursor: workers[0]?.cursor_id },
				{ phase: "start", pid: 5678, cursor: workers[1]?.cursor_id },
				{ phase: "finish", pid: 5678, cursor: workers[1]?.cursor_id },
			]);
		} finally {
			await coordinator.close();
		}
	});
});

describe("WorkerCoordinator #given approved apps #when workers are assigned #then each receives an attributed cursor and token", () => {
	it("assigns distinct worker identities and keeps input targeted", async () => {
		const computer = new FakeGuardedComputer();
		const session = new GuardedSession(computer);
		const coordinator = new WorkerCoordinator(session, computer);
		try {
			const assigned = await coordinator.assign([
				{ worker_id: "one", task: "edit note", app: "Finder" },
				{ worker_id: "two", task: "edit other", app: "Other" },
			]);
			const firstAssignment = assigned[0];
			if (firstAssignment === undefined || firstAssignment.observation === undefined) {
				throw new Error("assignment was unexpectedly missing its observation");
			}
			expect(assigned.map(({ cursor_id }) => cursor_id)).toHaveLength(2);
			expect(new Set(assigned.map(({ observation_token }) => observation_token)).size).toBe(2);
			expect(assigned.map(({ worker_id, task, app }) => ({ worker_id, task, app }))).toEqual([
				{ worker_id: "one", task: "edit note", app: "Finder" },
				{ worker_id: "two", task: "edit other", app: "Other" },
			]);
			expect(firstAssignment.observation.content.some((content) => content.type === "image")).toBe(false);
			expect(computer.stateOptions[0]).toMatchObject({
				includeAccessibilityTree: true,
				includeScreenshot: false,
			});
			expect(coordinator.status().every(({ busy }) => !busy)).toBe(true);
		} finally {
			await coordinator.close();
		}
	});
});

describe("WorkerCoordinator #given a PID alias #when assigning overlapping apps #then no worker state is changed", () => {
	it("rejects aliases and duplicate worker ids before observation", async () => {
		const computer = new FakeGuardedComputer();
		const session = new GuardedSession(computer);
		const coordinator = new WorkerCoordinator(session, computer);
		try {
			await expect(
				coordinator.assign([
					{ worker_id: "one", task: "first", app: "Finder" },
					{ worker_id: "two", task: "second", app: "1234" },
				]),
			).rejects.toThrow(/already owned/);
			expect(coordinator.status()).toEqual([]);
			expect(computer.stateOptions).toEqual([]);
			await expect(
				coordinator.assign([
					{ worker_id: "same", task: "first", app: "Finder" },
					{ worker_id: "same", task: "second", app: "Other" },
				]),
			).rejects.toThrow(/already assigned/);
			expect(coordinator.status()).toEqual([]);
			expect(computer.stateOptions).toEqual([]);
		} finally {
			await coordinator.close();
		}
	});
});

describe("WorkerCoordinator #given two assigned workers #when tokens are used #then tokens cannot cross workers and refresh after execution", () => {
	it("rejects a foreign token without input and consumes each successor token once", async () => {
		const computer = new FakeGuardedComputer();
		const session = new GuardedSession(computer);
		const coordinator = new WorkerCoordinator(session, computer);
		try {
			const [one, two] = await coordinator.assign([
				{ worker_id: "one", task: "first", app: "Finder" },
				{ worker_id: "two", task: "second", app: "Other" },
			]);
			if (
				one === undefined ||
				one.observation_token === undefined ||
				two === undefined ||
				two.observation_token === undefined
			) {
				throw new Error("assignments were unexpectedly missing tokens");
			}
			await expect(coordinator.run("one", two.observation_token, steps, undefined)).rejects.toThrow(
				/not belong to worker/,
			);
			expect(computer.effects).toEqual([]);
			const firstRun = await coordinator.run("one", one.observation_token, steps, undefined);
			const refreshed = firstRun.observation_token;
			expect(refreshed).toEqual(expect.any(String));
			const secondRun = await coordinator.run("one", refreshed ?? "", steps, undefined);
			expect(secondRun.observation_token).not.toBe(refreshed);
			expect(computer.effects).toHaveLength(2);
			await expect(coordinator.run("one", one.observation_token, steps, undefined)).rejects.toThrow(
				/not belong to worker/,
			);
		} finally {
			await coordinator.close();
		}
	});
});

describe("WorkerCoordinator #given a run produces no successor token #when the worker observes again #then fresh attributed context is returned", () => {
	it("refreshes the worker token and returns requested observation options", async () => {
		const computer = new FakeGuardedComputer();
		const session = new GuardedSession(computer);
		const coordinator = new WorkerCoordinator(session, computer);
		try {
			const [worker] = await coordinator.assign([{ worker_id: "one", task: "edit note", app: "Finder" }]);
			if (worker === undefined || worker.observation_token === undefined) {
				throw new Error("assignment was unexpectedly missing its observation token");
			}
			computer.windowIdAfterAction = 72;
			const run = await coordinator.run("one", worker.observation_token, steps, undefined);
			expect(run.observation_token).toBeUndefined();
			const observed = await coordinator.observe("one", { includeScreenshot: false, maxElements: 4 });
			expect(copyForMatch(observed)).toMatchObject({
				worker_id: "one",
				task: "edit note",
				app: "Finder",
				cursor_id: worker.cursor_id,
				observation_token: expect.any(String),
			});
			expect(observed.result.content.some((content) => content.type === "image")).toBe(false);
			expect(computer.stateOptions.at(-1)).toMatchObject({
				includeAccessibilityTree: true,
				includeScreenshot: false,
				maxElements: 4,
			});
			expect(coordinator.status()[0]?.observation_token).toBe(observed.observation_token);
		} finally {
			await coordinator.close();
		}
	});
});

describe("WorkerCoordinator #given a worker run is pending #when release is requested #then ownership remains until completion", () => {
	it("rejects busy release and releases the app after completion", async () => {
		const computer = new FakeGuardedComputer();
		const session = new GuardedSession(computer);
		const coordinator = new WorkerCoordinator(session, computer);
		let resolveInput: (() => void) | undefined;
		let inputStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			inputStarted = resolve;
		});
		computer.inputGate = async () => {
			inputStarted?.();
			await new Promise<void>((resolve) => {
				resolveInput = resolve;
			});
		};
		try {
			const [worker] = await coordinator.assign([{ worker_id: "one", task: "first", app: "Finder" }]);
			if (worker === undefined || worker.observation_token === undefined) {
				throw new Error("assignment was unexpectedly empty");
			}
			const run = coordinator.run(
				"one",
				worker.observation_token,
				[{ type: "type_text", text: "pending" }],
				undefined,
			);
			await started;
			expect(() => coordinator.release("one")).toThrow(/busy/);
			await expect(coordinator.assign([{ worker_id: "two", task: "same app", app: "1234" }])).rejects.toThrow(
				/already owned/,
			);
			resolveInput?.();
			await run;
			coordinator.release("one");
			expect(coordinator.status()).toEqual([]);
		} finally {
			resolveInput?.();
			await coordinator.close();
		}
	});
});

describe("WorkerCoordinator #given a worker #when it is assigned or observed #then the observation stays bounded", () => {
	it("hands the worker a 250-element table on assign and caps observe at 250 unless asked otherwise", async () => {
		const computer = new FakeGuardedComputer();
		computer.delivery = "background";
		const session = new GuardedSession(computer);
		const coordinator = new WorkerCoordinator(session, computer);
		const requests: Parameters<GuardedSession["observe"]>[0][] = [];
		const observe = session.observe.bind(session);
		vi.spyOn(session, "observe").mockImplementation(async (request) => {
			requests.push(request);
			return observe(request);
		});
		try {
			await coordinator.assign([{ worker_id: "one", task: "read", app: "Finder" }]);
			await coordinator.observe("one");
			await coordinator.observe("one", { maxElements: 40 });

			expect(requests.map(({ maxElements, elementFormat }) => ({ maxElements, elementFormat }))).toEqual([
				{ maxElements: 250, elementFormat: "table" },
				{ maxElements: 250, elementFormat: undefined },
				{ maxElements: 40, elementFormat: undefined },
			]);
		} finally {
			await coordinator.close();
		}
	});
});
