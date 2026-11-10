import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GuardedSession } from "./guarded-session.js";
import { Deferred, FakeGuardedComputer } from "./protocol-test-harness.js";
import { WorkerCoordinator } from "./worker-coordinator.js";
import { type SharedWorkerClaim, type WorkerRegistry, fileWorkerRegistry } from "./worker-registry.js";

// Several opencua processes are modelled as several coordinators over one registry directory, each registry acting
// for its own fake pid; `dead` names the fake pids that have exited.
let directory: string;
let dead: Set<number>;

beforeEach(async () => {
	directory = await realpath(await mkdtemp(join(tmpdir(), "opencua-worker-lifecycle-")));
	dead = new Set();
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

const FINDER_PID = 1234;

function registryFor(pid: number): WorkerRegistry {
	return fileWorkerRegistry(directory, (candidate) => !dead.has(candidate), pid);
}

function processAt(pid: number): {
	readonly computer: FakeGuardedComputer;
	readonly session: GuardedSession;
	readonly coordinator: WorkerCoordinator;
	readonly registry: WorkerRegistry;
} {
	const computer = new FakeGuardedComputer();
	computer.delivery = "background";
	const session = new GuardedSession(computer);
	const registry = registryFor(pid);
	return { computer, session, coordinator: new WorkerCoordinator(session, computer, registry), registry };
}

const claimOf = (worker_id: string, ownerPid: number, appPid = FINDER_PID): SharedWorkerClaim => ({
	worker_id,
	task: "task",
	app: "Finder",
	appPid,
	ownerPid,
});

/** Holds the first input whose JSON mentions `marker` at the fake computer's gate until `open` is called. */
function gateOn(computer: FakeGuardedComputer, marker: string): { readonly entered: Promise<void>; open(): void } {
	const entered = new Deferred<void>();
	const release = new Deferred<void>();
	let armed = true;
	let opened = false;
	computer.inputGate = async (effect) => {
		if (!armed || !JSON.stringify(effect).includes(marker)) return;
		armed = false;
		entered.resolve();
		await release.promise;
	};
	return {
		entered: entered.promise,
		open: () => {
			if (opened) return;
			opened = true;
			release.resolve();
		},
	};
}

const sent = (computer: FakeGuardedComputer, marker: string): boolean =>
	computer.effects.some((effect) => JSON.stringify(effect).includes(marker));

describe("#given a worker running in its assigning process #when another process adopts and releases it #then the claim stays", () => {
	it("refuses the release naming the running process, keeps the app claimed, and lets the run finish", async () => {
		const a = processAt(1);
		const b = processAt(2);
		const gate = gateOn(a.computer, "late");
		try {
			const [assigned] = await a.coordinator.assign([{ worker_id: "w", task: "task", app: "Finder" }]);
			const run = a.coordinator.run(
				"w",
				assigned?.observation_token ?? "",
				[{ type: "type_text", text: "late" }],
				undefined,
			);
			await gate.entered;

			expect(() => b.coordinator.release("w")).toThrow(
				/worker "w" is running in another opencua session \(process 1\)/,
			);
			expect(a.registry.find("w")?.ownerPid).toBe(1);
			expect(() => registryFor(3).claim([claimOf("x", 3)])).toThrow(/already owned by worker "w"/);

			gate.open();
			await run;
			expect(a.coordinator.status().map((status) => status.worker_id)).toEqual(["w"]);
			a.coordinator.release("w");
			expect(a.registry.find("w")).toBeUndefined();
		} finally {
			gate.open();
			await a.coordinator.close();
			await b.coordinator.close();
		}
	});
});

describe("#given a worker id released and claimed again by a third process #when a stale adopter releases it #then the new owner keeps it", () => {
	it("refuses the stale release naming the new owner and retires the adopter's old token", async () => {
		registryFor(1).claim([claimOf("w", 1)]);
		const b = processAt(2);
		try {
			const adopted = await b.coordinator.observe("w");
			registryFor(1).release("w");
			registryFor(3).claim([claimOf("w", 3, 5678)]);

			expect(() => b.coordinator.release("w")).toThrow(
				/worker "w" was assigned by another opencua session \(process 3\)/,
			);
			expect(registryFor(3).find("w")?.appPid).toBe(5678);
			await expect(
				b.coordinator.run("w", adopted.observation_token ?? "", [{ type: "type_text", text: "stale" }], undefined),
			).rejects.toThrow(/token/);
			expect(sent(b.computer, "stale")).toBe(false);
		} finally {
			await b.coordinator.close();
		}
	});
});

describe("#given an adopted worker run in flight #when its assigning process exits and a third process claims the app #then the run stops", () => {
	it("sends no step after the lease is gone and reports the loss", async () => {
		registryFor(1).claim([claimOf("w", 1)]);
		const b = processAt(2);
		const gate = gateOn(b.computer, "first");
		try {
			const adopted = await b.coordinator.observe("w");
			const run = b.coordinator.run(
				"w",
				adopted.observation_token ?? "",
				[
					{ type: "type_text", text: "first" },
					{ type: "type_text", text: "late" },
				],
				undefined,
			);
			await gate.entered;
			dead.add(1);
			registryFor(3).claim([claimOf("x", 3)]);
			gate.open();

			const outcome = await run.then(
				(result) => JSON.stringify(result.result),
				(error: unknown) => (error instanceof Error ? error.message : String(error)),
			);
			expect(outcome).toMatch(/lost its lease mid-run: .*earlier steps of this run were sent/);
			expect(outcome).toMatch(/"stoppedEarly\\":true/);
			expect(sent(b.computer, "first")).toBe(true);
			expect(sent(b.computer, "late")).toBe(false);
		} finally {
			gate.open();
			await b.coordinator.close();
		}
	});
});

describe("#given a worker run in flight #when its coordinator closes #then the claim outlives the input", () => {
	it("keeps the app claimed until the in-flight call drains, then releases it", async () => {
		const a = processAt(1);
		const [assigned] = await a.coordinator.assign([{ worker_id: "w", task: "task", app: "Finder" }]);
		const gate = gateOn(a.computer, "late");
		const run = a.coordinator.run(
			"w",
			assigned?.observation_token ?? "",
			[{ type: "type_text", text: "late" }],
			undefined,
		);
		await gate.entered;

		const closing = a.coordinator.close();
		expect(a.registry.find("w")?.ownerPid).toBe(1);
		expect(() => registryFor(3).claim([claimOf("x", 3)])).toThrow(/already owned by worker "w"/);

		gate.open();
		await run.catch(() => undefined);
		await closing;
		expect(sent(a.computer, "late")).toBe(true);
		expect(a.registry.find("w")).toBeUndefined();
		expect(() => registryFor(3).claim([claimOf("x", 3)])).not.toThrow();
	});
});

describe("#given an assigned idle worker #when an unassigned call observes its app #then the worker keeps its token", () => {
	it("refuses the unassigned observation naming the worker, and the worker's token still runs", async () => {
		const a = processAt(1);
		try {
			const [assigned] = await a.coordinator.assign([{ worker_id: "w", task: "task", app: "Finder" }]);

			await expect(a.session.observe({ app: "Finder", diffOnly: false })).rejects.toThrow(
				/app "Finder" is owned by worker "w"/,
			);

			const run = await a.coordinator.run(
				"w",
				assigned?.observation_token ?? "",
				[{ type: "type_text", text: "mine" }],
				undefined,
			);
			expect(run.result.isError).not.toBe(true);
			expect(sent(a.computer, "mine")).toBe(true);
		} finally {
			await a.coordinator.close();
		}
	});

	it("refuses an unassigned observation of an app a worker in another opencua process owns", async () => {
		registryFor(1).claim([claimOf("w", 1)]);
		const b = processAt(2);
		try {
			await expect(b.session.observe({ app: "Finder", diffOnly: false })).rejects.toThrow(
				/app "Finder" is owned by worker "w" in another opencua session/,
			);
		} finally {
			await b.coordinator.close();
		}
	});
});
