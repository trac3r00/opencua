import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processStartTime } from "@opencua/core";
import { GuardedSession } from "./guarded-session.js";
import { FakeGuardedComputer } from "./protocol-test-harness.js";
import { failurePayload, normalizeToolError } from "./tool-errors.js";
import { WorkerCoordinator } from "./worker-coordinator.js";
import {
	type SharedWorkerEntry,
	appOwnedByWorker,
	fileWorkerRegistry,
	workerBusy,
	workerConflict,
	workerNotAssigned,
} from "./worker-registry.js";

let directory: string;

beforeEach(async () => {
	directory = await realpath(await mkdtemp(join(tmpdir(), "opencua-workers-")));
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

const entry = (overrides: Partial<SharedWorkerEntry> = {}): SharedWorkerEntry => ({
	worker_id: "one",
	task: "read Finder",
	app: "Finder",
	appPid: 1234,
	ownerPid: process.pid,
	...overrides,
});

/** Every pid runs as one unchanged process: the registries built with it only differ in whom they act for. */
const running = (): string => "boot";
/** Every pid but `gone` runs. */
const runningExcept =
	(gone: number) =>
	(pid: number): string | undefined =>
		pid === gone ? undefined : "boot";

const STARTED = "1763900000.100";
const RESTARTED = "1763900500.200";
/** Which process holds each pid now, by start time; a pid left out runs nothing. */
const processes =
	(starts: Readonly<Record<number, string>>) =>
	(pid: number): string | undefined =>
		starts[pid];

function coordinator(): WorkerCoordinator {
	const computer = new FakeGuardedComputer();
	computer.delivery = "background";
	return new WorkerCoordinator(new GuardedSession(computer), computer, fileWorkerRegistry(directory));
}

describe("#given the shared worker registry #when processes claim workers #then an app has one owner", () => {
	it("finds and releases a claim", () => {
		const registry = fileWorkerRegistry(directory);
		registry.claim([entry()]);
		expect(registry.find("one")?.appPid).toBe(1234);
		registry.release("one");
		expect(registry.find("one")).toBeUndefined();
	});

	it("refuses a worker id or app another live process holds, and frees the claims of a process that exited", () => {
		const live = fileWorkerRegistry(directory, running);
		live.claim([entry({ ownerPid: 999_999 })]);
		expect(() => live.claim([entry({ worker_id: "two" })])).toThrow(/already owned by worker "one"/);
		expect(() => live.claim([entry({ appPid: 42 })])).toThrow(/already assigned by another opencua session/);
		const afterExit = fileWorkerRegistry(directory, runningExcept(999_999));
		expect(afterExit.find("one")).toBeUndefined();
		afterExit.claim([entry({ worker_id: "two" })]);
		expect(afterExit.find("two")?.ownerPid).toBe(process.pid);
	});

	it("lets workers of different processes share an owned surface, but not an app one worker holds alone", () => {
		const live = fileWorkerRegistry(directory, running);
		live.claim([entry({ ownerPid: 999_999, shared: true })]);
		live.claim([entry({ worker_id: "two", shared: true })]);
		expect(live.find("two")?.appPid).toBe(1234);
		expect(() => live.claim([entry({ worker_id: "three" })])).toThrow(/already owned by worker "one"/);
	});

	it("takes over a lock a crashed process left behind", async () => {
		await writeFile(join(directory, "registry.json"), JSON.stringify({ workers: [] }));
		await mkdir(join(directory, "registry.lock"));
		const old = new Date(Date.now() - 60_000);
		await utimes(join(directory, "registry.lock"), old, old);
		fileWorkerRegistry(directory).claim([entry()]);
		expect(fileWorkerRegistry(directory).find("one")?.worker_id).toBe("one");
	});

	it.each([
		["not JSON", '{"workers": [', /is not valid JSON/],
		["not a worker list", JSON.stringify({ workers: [{ worker_id: 1 }] }), /does not hold a valid worker list/],
	])(
		"#given a registry file that is %s #when it is read #then it throws instead of looking empty",
		async (_, text, error) => {
			await writeFile(join(directory, "registry.json"), text);
			const registry = fileWorkerRegistry(directory);
			expect(() => registry.find("one")).toThrow(error);
			expect(() => registry.claim([entry()])).toThrow(error);
			expect(await readFile(join(directory, "registry.json"), "utf8")).toBe(text);
		},
	);

	it("#given an old lock whose owner is still alive #when another process claims #then the lock is not stolen", async () => {
		const lock = join(directory, "registry.lock");
		const holder = `${process.pid} other-holder`;
		await mkdir(lock);
		await writeFile(join(lock, "owner"), holder);
		const old = new Date(Date.now() - 60_000);
		await utimes(lock, old, old);

		expect(() => fileWorkerRegistry(directory).claim([entry()])).toThrow(/registry is busy/);

		expect(await readFile(join(lock, "owner"), "utf8")).toBe(holder);
		expect(fileWorkerRegistry(directory).find("one")).toBeUndefined();
	});

	it("#given a lock whose owner exited #when another process claims #then it takes the lock over at once", async () => {
		const lock = join(directory, "registry.lock");
		await mkdir(lock);
		await writeFile(join(lock, "owner"), "999999 exited-holder");

		fileWorkerRegistry(directory, runningExcept(999_999)).claim([entry()]);

		expect(fileWorkerRegistry(directory, running).find("one")?.worker_id).toBe("one");
	});

	it("#given a holder whose lock another process took #when the holder finishes #then the other process's lock stays", () => {
		fileWorkerRegistry(directory, running).claim([entry()]);
		const owner = join(directory, "registry.lock", "owner");
		const successor = "1 successor";
		// Processes are identified while the lock is held, so this stands in for another process taking the lock mid-work.
		const preempted = fileWorkerRegistry(directory, () => {
			writeFileSync(owner, successor);
			return running();
		});

		preempted.claim([entry({ worker_id: "two", appPid: 42 })]);

		expect(readFileSync(owner, "utf8")).toBe(successor);
	});
});

describe("#given a claim or run recorded for a pid #when another process holds that pid now #then the record is stale", () => {
	it("#given a claim by a session that exited #when a new session reuses its pid #then it does not inherit the worker", () => {
		fileWorkerRegistry(directory, processes({ 500: STARTED }), 500).claim([entry({ ownerPid: 500 })]);

		const reused = fileWorkerRegistry(directory, processes({ 500: RESTARTED }), 500);

		expect(reused.find("one")).toBeUndefined();
		expect(() => reused.beginRun("one")).toThrow(/is not assigned/);
	});

	it("#given a claim by a session that exited #when an unrelated process reuses its pid #then the app is free for another session", () => {
		fileWorkerRegistry(directory, processes({ 500: STARTED }), 500).claim([entry({ ownerPid: 500 })]);

		const other = fileWorkerRegistry(directory, processes({ 500: RESTARTED, 600: STARTED }), 600);

		expect(other.holder(1234)).toBeUndefined();
		other.claim([entry({ worker_id: "two", ownerPid: 600 })]);
		expect(other.find("two")?.ownerPid).toBe(600);
	});

	it("#given the claiming session still runs #when another session reads the registry #then the claim holds", () => {
		const both = processes({ 500: STARTED, 600: STARTED });
		fileWorkerRegistry(directory, both, 500).claim([entry({ ownerPid: 500 })]);

		const other = fileWorkerRegistry(directory, both, 600);

		expect(other.holder(1234)?.worker_id).toBe("one");
		expect(() => other.claim([entry({ worker_id: "two", ownerPid: 600 })])).toThrow(/already owned by worker "one"/);
	});

	it("#given a run by a session that exited #when its pid is reused #then the worker is idle and its owner can release it", () => {
		const both = processes({ 500: STARTED, 600: STARTED });
		fileWorkerRegistry(directory, both, 500).claim([entry({ ownerPid: 500 })]);
		fileWorkerRegistry(directory, both, 600).beginRun("one");
		expect(() => fileWorkerRegistry(directory, both, 500).release("one")).toThrow(
			/running in another opencua session/,
		);

		const owner = fileWorkerRegistry(directory, processes({ 500: STARTED, 600: RESTARTED }), 500);

		expect(owner.find("one")?.busy).toBeUndefined();
		owner.release("one");
		expect(owner.find("one")).toBeUndefined();
	});

	it("#given a lock whose holder's pid was reused #when another session claims #then it takes the lock over at once", async () => {
		const lock = join(directory, "registry.lock");
		await mkdir(lock);
		await writeFile(join(lock, "owner"), `500 crashed-holder ${STARTED}`);

		const other = fileWorkerRegistry(directory, processes({ 500: RESTARTED, 600: STARTED }), 600);
		other.claim([entry({ ownerPid: 600 })]);

		expect(other.find("one")?.ownerPid).toBe(600);
	});

	it("#given a lock whose holder still runs as the same process #when another session claims #then the lock is not stolen", async () => {
		const lock = join(directory, "registry.lock");
		const holder = `500 live-holder ${STARTED}`;
		await mkdir(lock);
		await writeFile(join(lock, "owner"), holder);
		const old = new Date(Date.now() - 60_000);
		await utimes(lock, old, old);

		const other = fileWorkerRegistry(directory, processes({ 500: STARTED, 600: STARTED }), 600);

		expect(() => other.claim([entry({ ownerPid: 600 })])).toThrow(/registry is busy/);
		expect(await readFile(join(lock, "owner"), "utf8")).toBe(holder);
	});

	it("#given a claim an older opencua wrote without a start time #when its owner still runs #then the claim holds", async () => {
		await writeFile(join(directory, "registry.json"), JSON.stringify({ workers: [entry({ ownerPid: 500 })] }));

		const other = fileWorkerRegistry(directory, processes({ 500: STARTED, 600: STARTED }), 600);

		expect(other.holder(1234)?.worker_id).toBe("one");
	});

	it("#given a claim without a start time that names this session's pid #when this session reads it #then it is not its own", async () => {
		await writeFile(join(directory, "registry.json"), JSON.stringify({ workers: [entry({ ownerPid: 500 })] }));

		const reused = fileWorkerRegistry(directory, processes({ 500: STARTED }), 500);

		expect(reused.find("one")).toBeUndefined();
	});

	it("#given this process claims and runs a worker #when the registry file is read #then both carry its kernel start time", () => {
		const registry = fileWorkerRegistry(directory);
		registry.claim([entry()]);
		registry.beginRun("one");

		const written = JSON.parse(readFileSync(join(directory, "registry.json"), "utf8")).workers[0];

		const started = processStartTime(process.pid);
		expect(started).toMatch(/^\d+\.\d+$/);
		expect(written.ownerStartedAt).toBe(started);
		expect(written.busy.startedAt).toBe(started);
		expect(registry.find("one")?.busy?.pid).toBe(process.pid);
	});
});

describe("#given a worker assigned by one opencua process #when a subagent's own process uses it #then it works there", () => {
	it("observes it from another coordinator, keeps the claim when that one closes, and forgets it once released", async () => {
		const parent = coordinator();
		const subagent = coordinator();
		try {
			await parent.assign([{ worker_id: "one", task: "read Finder", app: "Finder", agent_name: "sub" }]);

			const observed = await subagent.observe("one");

			expect(observed.observation_token).toEqual(expect.any(String));
			expect(observed.cursor_owner.agentName).toBe("sub");
			await subagent.close();
			expect(fileWorkerRegistry(directory).find("one")).toBeDefined();
			parent.release("one");
			const later = coordinator();
			await expect(later.observe("one")).rejects.toThrow(/is not assigned/);
			await later.close();
		} finally {
			await parent.close();
		}
	});
});

describe("#given a worker assigned by another process #when the subagent runs steps for it #then they run there", () => {
	it("accepts the token the subagent observed and runs its steps", async () => {
		const parent = coordinator();
		const subagent = coordinator();
		try {
			await parent.assign([{ worker_id: "one", task: "fill Finder", app: "Finder" }]);
			const observed = await subagent.observe("one");

			const run = await subagent.run(
				"one",
				observed.observation_token ?? "",
				[{ type: "set_value", element_index: "20", value: "worker" }],
				undefined,
			);

			expect(run.worker_id).toBe("one");
			expect(run.result.isError).not.toBe(true);
		} finally {
			await subagent.close();
			await parent.close();
		}
	});
});

describe("#given a worker lookup that fails before anything is sent #when the error is reported #then retrying is safe", () => {
	it.each([
		["WORKER_NOT_ASSIGNED", workerNotAssigned("w")],
		["WORKER_BUSY", workerBusy("w")],
		["WORKER_CONFLICT", workerConflict('app "Finder" is already owned')],
		[
			"APP_OWNED_BY_WORKER",
			appOwnedByWorker('app "Finder" is owned by worker "one"; act through run_worker for that worker'),
		],
	])("#given a thrown %s failure #when normalized #then the code is read from its fields", (code, failure) => {
		const normalized = normalizeToolError({
			isError: true,
			content: [{ type: "text", text: JSON.stringify({ error: failure.message, ...failurePayload(failure) }) }],
		});
		const text = normalized.content[0]?.type === "text" ? normalized.content[0].text : "";
		expect(JSON.parse(text)).toMatchObject({ code, retry: "safe", disposition: { delivery: "not_sent" } });
	});

	it("#given another session holds the app or the worker is unknown #when the registry refuses #then it throws the typed failure", () => {
		fileWorkerRegistry(directory).claim([entry({ ownerPid: 1 })]);
		const registry = fileWorkerRegistry(directory);
		expect(() => registry.claim([entry({ worker_id: "two" })])).toThrow(
			expect.objectContaining({ code: "WORKER_CONFLICT", delivery: "not_sent", retry: "safe" }),
		);
		expect(() => registry.beginRun("missing")).toThrow(
			expect.objectContaining({ code: "WORKER_NOT_ASSIGNED", evidence: { worker_id: "missing" } }),
		);
	});

	it.each([
		["worker-owned-elsewhere", "WORKER_OWNED_ELSEWHERE"],
		["worker-running-elsewhere", "WORKER_RUNNING_ELSEWHERE"],
	])(
		"#given a lease refusal with reason %s #when normalized #then its code is %s and retry is safe",
		(reason, code) => {
			const normalized = normalizeToolError({
				isError: true,
				content: [
					{ type: "text", text: JSON.stringify({ error: 'worker "w" refused', reason, actionDispatched: false }) },
				],
			});
			const text = normalized.content[0]?.type === "text" ? normalized.content[0].text : "";
			expect(JSON.parse(text)).toMatchObject({ code, retry: "safe" });
		},
	);
});

describe("#given shared-surface regions #when processes claim workers #then regions travel with the claim and must stay disjoint", () => {
	const shared = (overrides: Partial<SharedWorkerEntry>): SharedWorkerEntry =>
		entry({ shared: true, region: { x: 0, y: 0, width: 100, height: 100 }, ...overrides });

	it("#given a region in a claim #when it is found #then the region comes back", () => {
		const registry = fileWorkerRegistry(directory);
		registry.claim([shared({})]);
		expect(registry.find("one")?.region).toEqual({ x: 0, y: 0, width: 100, height: 100 });
	});

	it("#given another live process holds a region #when an overlapping or whole-window worker claims the surface #then it is refused", () => {
		const registry = fileWorkerRegistry(directory, running);
		registry.claim([shared({ ownerPid: 1 })]);
		expect(() =>
			registry.claim([shared({ worker_id: "two", region: { x: 50, y: 50, width: 100, height: 100 } })]),
		).toThrow(
			/worker "two" cannot share app "Finder" with worker "one" in another opencua session: their regions overlap/,
		);
		expect(() => registry.claim([entry({ worker_id: "three", shared: true })])).toThrow(/one owns the whole window/);
		expect(() =>
			registry.claim([shared({ worker_id: "four", region: { x: 100, y: 0, width: 100, height: 100 } })]),
		).not.toThrow();
	});

	it("#given a confined worker assigned by another process #when this process acts for it #then its region still confines it", async () => {
		const registry = fileWorkerRegistry(directory, running);
		registry.claim([shared({ worker_id: "remote", ownerPid: 1, region: { x: 0, y: 0, width: 10, height: 10 } })]);
		const computer = new FakeGuardedComputer();
		computer.delivery = "background";
		const local = new WorkerCoordinator(new GuardedSession(computer), computer, registry, (pid) => pid === 1234);
		try {
			const observed = await local.observe("remote");
			const token = observed.observation_token;
			if (token === undefined) throw new Error("observing the adopted worker should issue a token");
			await expect(local.run("remote", token, [{ type: "click", x: 300, y: 100 }], undefined)).rejects.toThrow(
				/outside its region/,
			);
			expect(computer.effects).toEqual([]);
		} finally {
			await local.close();
		}
	});
});
