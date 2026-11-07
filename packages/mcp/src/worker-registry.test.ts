import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GuardedSession } from "./guarded-session.js";
import { FakeGuardedComputer } from "./protocol-test-harness.js";
import { normalizeToolError } from "./tool-errors.js";
import { WorkerCoordinator } from "./worker-coordinator.js";
import { type SharedWorkerEntry, fileWorkerRegistry } from "./worker-registry.js";

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
		const live = fileWorkerRegistry(directory, () => true);
		live.claim([entry({ ownerPid: 999_999 })]);
		expect(() => live.claim([entry({ worker_id: "two" })])).toThrow(/already owned by worker "one"/);
		expect(() => live.claim([entry({ appPid: 42 })])).toThrow(/already assigned by another opencua session/);
		const afterExit = fileWorkerRegistry(directory, (pid) => pid !== 999_999);
		expect(afterExit.find("one")).toBeUndefined();
		afterExit.claim([entry({ worker_id: "two" })]);
		expect(afterExit.find("two")?.ownerPid).toBe(process.pid);
	});

	it("lets workers of different processes share an owned surface, but not an app one worker holds alone", () => {
		const live = fileWorkerRegistry(directory, () => true);
		live.claim([entry({ ownerPid: 999_999, shared: true })]);
		live.claim([entry({ worker_id: "two", shared: true })]);
		expect(live.find("two")?.appPid).toBe(1234);
		expect(() => live.claim([entry({ worker_id: "three" })])).toThrow(/already owned by worker "one"/);
	});

	it("takes over a lock a crashed process left behind", async () => {
		await writeFile(join(directory, "registry.json"), JSON.stringify({ workers: [] }));
		const { mkdir, utimes } = await import("node:fs/promises");
		await mkdir(join(directory, "registry.lock"));
		const old = new Date(Date.now() - 60_000);
		await utimes(join(directory, "registry.lock"), old, old);
		fileWorkerRegistry(directory).claim([entry()]);
		expect(fileWorkerRegistry(directory).find("one")?.worker_id).toBe("one");
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
		['worker "w" is not assigned', "WORKER_NOT_ASSIGNED"],
		['worker "w" is busy', "WORKER_BUSY"],
		['app "Finder" is already owned', "WORKER_CONFLICT"],
		['app "Finder" is already owned by worker "one" in another opencua session', "WORKER_CONFLICT"],
	])("%s -> %s", (message, code) => {
		const normalized = normalizeToolError({
			isError: true,
			content: [{ type: "text", text: JSON.stringify({ error: message }) }],
		});
		const text = normalized.content[0]?.type === "text" ? normalized.content[0].text : "";
		expect(JSON.parse(text)).toMatchObject({ code, retry: "safe" });
	});
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
		const registry = fileWorkerRegistry(directory, () => true);
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
		const registry = fileWorkerRegistry(directory, () => true);
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
