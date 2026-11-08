import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { IsolationDriver } from "./team-input-driver.mjs";
import {
	DURATION_MS,
	lockSummary,
	main,
	managed,
	oracle,
	payload,
	runSession,
	schedule,
} from "./team-input-isolation.mjs";
import { instrumentLock } from "./team-input-lock-metrics.mjs";

function evidence() {
	return {
		expected: [payload("A"), payload("B")],
		actual: [payload("A"), payload("B")],
		sessions: [0, 1].map(() => ({
			kind: "apple",
			refusals: 0,
			errors: [],
			typed_characters: 400,
			lock_acquisitions: 4,
		})),
		sampler: {
			samples: Array.from({ length: 401 }, (_, i) => ({ ms: i * 50, x: 30, y: 40, pid: 99 })),
			activations: [],
		},
		duration_ms: DURATION_MS,
		recording: { valid: true },
	};
}

test("#given exact AX documents and undisturbed samples #when evaluated #then the repetition passes", () => {
	assert.equal(oracle(evidence()).pass, true);
});

test("#given misleading tool success but altered AX punctuation #when evaluated #then text equality fails", () => {
	const input = evidence();
	input.actual[0] = input.actual[0].replace("!", "?");
	assert.deepEqual(oracle(input).classes, ["text-mismatch"]);
});

test("#given both sessions write the same window #when independent documents are read #then interleaving is detected", () => {
	const input = evidence();
	input.actual = [payload("A") + payload("B"), ""];
	assert.deepEqual(oracle(input).classes, ["text-mismatch", "interleaving"]);
});

test("#given repeated lock refusals and correct final text #when evaluated #then refusals are their own failure class", () => {
	const input = evidence();
	input.sessions[0].refusals = 3;
	assert.deepEqual(oracle(input).classes, ["input-lock-busy"]);
});

test("#given pointer and focus return to baseline #when intermediate samples differ #then both disturbances fail", () => {
	const input = evidence();
	input.sampler.samples[100].x = 30.01;
	input.sampler.activations.push({ ms: 5030, pid: 88 });
	assert.deepEqual(oracle(input).classes, ["frontmost-changed", "pointer-displaced"]);
});

test("#given a sampler gap #when endpoints look correct #then missing coverage cannot pass", () => {
	const input = evidence();
	input.sampler.samples.splice(100, 4);
	assert.deepEqual(oracle(input).classes, ["sampler-gap"]);
});

test("#given absent AX reads metrics and recording #when evaluated #then infrastructure cannot claim success", () => {
	const input = evidence();
	input.actual = [];
	input.sessions[0].lock_acquisitions = 0;
	input.recording.valid = false;
	assert.deepEqual(oracle(input).classes, ["oracle-infra", "lock-metrics-missing", "recording-infra"]);
});

test("#given deterministic seeds #when making both schedules #then each carries distinct 400 character punctuation text", () => {
	const first = schedule(1, 0);
	assert.deepEqual(first, schedule(1, 0));
	assert.notDeepEqual(
		first.map((event) => event.at_ms),
		schedule(1, 1).map((event) => event.at_ms),
	);
	assert.equal(first.map((event) => event.text).join(""), payload("A"));
	assert.equal(
		schedule(1, 1)
			.map((event) => event.text)
			.join(""),
		payload("B"),
	);
	assert.equal(payload("A").length, 400);
	assert.notEqual(payload("A"), payload("B"));
	assert.ok(first.every((event) => event.at_ms >= 0 && event.at_ms < DURATION_MS));
});

test("#given two sessions blocked inside input #when both start #then their bursts overlap without a real timer", async () => {
	let arrived = 0;
	let release;
	const held = new Promise((resolve) => {
		release = resolve;
	});
	const calls = [[], []];
	const drivers = calls.map((seen) => ({
		kind: "apple",
		target: { button: {}, editor: {} },
		refusals: 0,
		trace: [],
		async input(op, value) {
			seen.push([op, value]);
			if (op === "click" && seen.length === 1) {
				arrived++;
				if (arrived === 2) release();
				await held;
			}
		},
	}));
	const timing = { now: () => 0, until: () => Promise.resolve(), started: 0 };
	const results = await Promise.all(drivers.map((driver, index) => runSession(driver, schedule(1, index), timing)));
	assert.equal(arrived, 2);
	assert.deepEqual(
		results.map((result) => result.typed_characters),
		[400, 400],
	);
	assert.equal(
		calls[0]
			.filter(([op]) => op === "type")
			.map(([, text]) => text)
			.join(""),
		payload("A"),
	);
});

test("#given a refused burst #when later scheduled work proceeds #then the failed burst is never replayed", async () => {
	let calls = 0;
	const driver = {
		kind: "apple",
		target: { button: {}, editor: {} },
		refusals: 0,
		trace: [],
		async input() {
			calls++;
			if (calls === 1) {
				this.refusals++;
				throw new Error("input-lock-busy");
			}
		},
	};
	const result = await runSession(driver, schedule(1, 0), {
		now: () => 0,
		until: () => Promise.resolve(),
		started: 0,
	});
	assert.equal(result.refusals, 1);
	assert.equal(result.typed_characters, 300);
	assert.equal(calls, 13);
});

test("#given an overrun session #when its next burst is due #then no further input starts beyond the window", async () => {
	let called = false;
	const result = await runSession(
		{
			kind: "cua",
			target: {},
			refusals: 0,
			trace: [],
			async input() {
				called = true;
			},
		},
		schedule(1, 0),
		{ now: () => DURATION_MS, until: () => Promise.resolve(), started: 0 },
	);
	assert.equal(called, false);
	assert.equal(result.typed_characters, 0);
});

for (const kind of ["apple", "cua", "peekaboo"]) {
	test(`#given ${kind} exact target #when typing #then its own MCP session receives window-bound calls`, async () => {
		const calls = [];
		const client = {
			async callTool(name, args) {
				calls.push({ name, args });
				return { structuredContent: { observation_token: "token" }, _meta: { snapshot_id: "snapshot" } };
			},
		};
		const driver = new IsolationDriver(kind, client, { app: "TextEdit", pid: 123, window_id: 45 });
		await driver.input("type", "test!?");
		assert.equal(calls.length, 2);
		assert.deepEqual(
			calls[1],
			kind === "apple"
				? { name: "type_text", args: { app: "123", observation_token: "token", text: "test!?" } }
				: kind === "cua"
					? { name: "type_text", args: { pid: 123, window_id: 45, text: "test!?" } }
					: { name: "type", args: { snapshot: "snapshot", text: "test!?" } },
		);
	});
}

test("#given a lock refusal response #when dispatched once #then it is retained and counted without retry", async () => {
	const driver = new IsolationDriver(
		"cua",
		{
			async callTool(name) {
				return name === "get_window_state"
					? {}
					: { isError: true, content: [{ type: "text", text: "input-lock-busy" }] };
			},
		},
		{ pid: 5, window_id: 6 },
	);
	await assert.rejects(driver.input("type", "x"), /input-lock-busy/);
	assert.equal(driver.refusals, 1);
	assert.equal(driver.trace.length, 2);
});

test("#given a control without window snapshots #when observing #then cannot target is explicit", async () => {
	const driver = new IsolationDriver(
		"peekaboo",
		{
			async callTool() {
				return {};
			},
		},
		{ app: "TextEdit", window_id: 4 },
	);
	await assert.rejects(driver.observe(), /cannot target/);
	assert.equal(driver.trace.length, 1);
});

test("#given a lock taking a deterministic interval #when instrumented #then wait and return value are preserved", async () => {
	let time = 0;
	const records = [];
	const prototype = {
		async acquire(budget) {
			time += budget;
			return false;
		},
	};
	instrumentLock(
		prototype,
		(entry) => records.push(entry),
		() => time,
	);
	assert.equal(await prototype.acquire(1500), false);
	assert.deepEqual(lockSummary(records, "apple"), {
		lock_wait_ms: 1500,
		lock_acquisitions: 1,
		lock_wait_source: "InputLock.acquire promise elapsed; includes acquire overhead",
		lock_refused_acquisitions: 1,
	});
	assert.equal(lockSummary([], "cua").lock_wait_ms, null);
});

test("#given a live child process #when cancellation is requested after readiness #then the owned process is reaped", async () => {
	const child = managed(process.execPath, ["-e", "process.stdout.write('READY\\n'); process.stdin.resume()"], 5000);
	try {
		const [chunk] = await once(child.child.stdout, "data", { signal: AbortSignal.timeout(4000) });
		assert.equal(chunk.toString(), "READY\n");
		const result = await child.stop();
		assert.equal(result.signal, "SIGTERM");
		assert.throws(() => process.kill(child.child.pid, 0), { code: "ESRCH" });
	} finally {
		await child.stop();
	}
});

test("#given a cancelled schedule #when a deadline rejects #then no input is dispatched", async () => {
	let inputs = 0;
	await assert.rejects(
		runSession(
			{
				kind: "apple",
				target: {},
				refusals: 0,
				trace: [],
				input: async () => {
					inputs++;
				},
			},
			schedule(1, 0),
			{
				now: () => 0,
				started: 0,
				until: () => Promise.reject(new Error("cancelled")),
			},
		),
		/cancelled/,
	);
	assert.equal(inputs, 0);
});

test("#given no two-session evidence #when evaluated #then missing sessions cannot pass", () => {
	const input = evidence();
	input.sessions = [];
	assert.deepEqual(oracle(input).classes, ["session-infra"]);
});

test("#given Peekaboo dispatches but cannot verify #when AX will decide later #then no input is retried", async () => {
	const calls = [];
	const driver = new IsolationDriver(
		"peekaboo",
		{
			async callTool(name, args) {
				calls.push({ name, args });
				if (name === "see") return { _meta: { snapshot_id: "snapshot" } };
				return {
					isError: true,
					_meta: {
						state: "dispatched_unverified",
						mutation_dispatched: true,
						escalation: "observe_before_retry",
					},
				};
			},
		},
		{ app: "TextEdit", window_id: 4 },
	);
	await driver.input("type", "punctuation!?");
	assert.equal(calls.length, 2);
	assert.equal(driver.refusals, 0);
});

test("#given no desktop authorization #when invoked #then execution stops before any GUI or filesystem work", async () => {
	await assert.rejects(main([]), /DESKTOP GO required/);
});

test("#given a hung process #when its lifetime expires #then the process is killed and classified as timed out", async () => {
	// Time itself (the process deadline), rather than scheduler luck, is the behavior under test.
	const child = managed(process.execPath, ["-e", "process.stdin.resume()"], 100);
	try {
		const result = await child.done;
		assert.equal(result.timedOut, true);
		assert.equal(result.signal, "SIGKILL");
	} finally {
		await child.stop();
	}
});

for (const kind of ["apple", "cua", "peekaboo"]) {
	test(`#given ${kind} observed controls #when clicking and restoring append focus #then each mapping retains its target`, async () => {
		const calls = [];
		const client = {
			async callTool(name, args) {
				calls.push({ name, args });
				return {
					structuredContent: { observation_token: "token" },
					_meta: {
						snapshot_id: "snapshot",
						ui_elements: [
							{ id: 7, label: "Bold" },
							{ id: 8, role: "AXTextArea" },
						],
					},
				};
			},
		};
		const driver = new IsolationDriver(kind, client, { app: "TextEdit", pid: 123, window_id: 45 });
		await driver.input("click", { x: 10, y: 20, label: "Bold" });
		await driver.input("click", { x: 50, y: 60, editor: true });
		await driver.input("key", "cmd+end");
		const mutations = calls.filter((_, index) => index % 2 === 1);
		if (kind === "peekaboo") {
			assert.deepEqual(mutations, [
				{ name: "click", args: { snapshot: "snapshot", on: "7" } },
				{ name: "click", args: { snapshot: "snapshot", on: "8" } },
				{ name: "press", args: { snapshot: "snapshot", keys: ["cmd+end"] } },
			]);
		} else {
			assert.deepEqual(
				mutations[0].args,
				kind === "apple"
					? { app: "123", observation_token: "token", x: 10, y: 20 }
					: { pid: 123, window_id: 45, x: 10, y: 20 },
			);
			assert.deepEqual(
				mutations[2],
				kind === "apple"
					? { name: "press_keys", args: { app: "123", observation_token: "token", keys: ["cmd+end"] } }
					: { name: "press_key", args: { pid: 123, window_id: 45, key: "end", modifiers: ["cmd"] } },
			);
		}
	});
}
