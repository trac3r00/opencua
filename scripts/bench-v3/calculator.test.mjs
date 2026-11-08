import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as runner from "./calculator-run.mjs";
import {
	calculatorOutcome,
	calculatorOwnership,
	calculatorPlan,
	calculatorProcessGone,
	calculatorSchedule,
	subscribedEvent,
} from "./calculator-run.mjs";
import { Driver } from "./drivers.mjs";

test("#given a direct Node launch #when recording provenance #then hashes the actual executable and server bytes", () => {
	const server = fileURLToPath(import.meta.url);
	const spec = { command: process.execPath, args: [server] };
	const provenance = runner.calculatorLaunchProvenance(spec);
	assert.equal(provenance.mode, "direct-node");
	assert.equal(provenance.command, spec.command);
	assert.deepEqual(provenance.args, spec.args);
	assert.equal(provenance.executable_path, process.execPath);
	assert.equal(
		provenance.executable_sha256,
		createHash("sha256").update(readFileSync(process.execPath)).digest("hex"),
	);
	assert.equal(provenance.server_path, server);
	assert.equal(provenance.server_sha256, createHash("sha256").update(readFileSync(server)).digest("hex"));
});

test("#given process launch without a ready window #when transitioning #then cannot start driver timing", async () => {
	const windowReady = Promise.reject(new Error("window unavailable"));
	windowReady.catch(() => undefined);
	await assert.rejects(
		runner.calculatorTransition(
			{ ready: Promise.resolve(), event: Promise.resolve("42") },
			() => undefined,
			null,
			windowReady,
		),
		/window unavailable/,
	);
});

function attemptFixture() {
	let clock = 0;
	let pid = 40;
	let active = null;
	let displayReads = 0;
	const events = [];
	const driver = {
		allCallsSucceeded: true,
		async step(step) {
			events.push(step.op);
			clock += 10;
		},
	};
	const services = {
		async launch() {
			assert.equal(active, null);
			active = ++pid;
			events.push(`launch ${active}`);
			clock += 1000;
		},
		setSentinel() {
			clock += 1000;
		},
		async startTrace() {
			clock += 1000;
			return {};
		},
		readClipboard() {
			clock += 20;
			return "5";
		},
		readDisplay() {
			clock += 10;
			return displayReads++ % 2 === 0 ? "0" : "5";
		},
		now: () => clock,
		async finishTrace() {
			clock += 1000;
			return true;
		},
		async cleanup() {
			events.push(`gone ${active}`);
			active = null;
			clock += 1000;
			return { verified: true };
		},
	};
	return { driver, services, events };
}

test("#given image payloads #when calculator records an attempt #then image token estimates count once", async () => {
	const { services } = attemptFixture();
	const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+lmQAAAABJRU5ErkJggg==";
	const driver = new Driver("apple", {
		async callTool() {
			return {
				content: [
					{ type: "text", text: "{}" },
					{ type: "image", mimeType: "image/png", data: image },
				],
			};
		},
	});
	driver.step = async () => await driver.call("payload", {});
	const row = {};
	assert.equal(await runner.runCalculatorAttempt(row, driver, services), true);
	assert.equal(driver.image_tokens, calculatorPlan.length);
	assert.equal(row.tokens, calculatorPlan.length * (2 / 4 + 1));
	assert.equal(row.calls, calculatorPlan.length);
});

test("#given paired attempts #when running #then fresh processes enclose only driver and oracle timing", async () => {
	const { driver, services, events } = attemptFixture();
	for (let index = 0; index < 2; index++) {
		const row = {};
		assert.equal(await runner.runCalculatorAttempt(row, driver, services), true);
		assert.equal(row.e2e_seconds, 0.09);
		assert.equal(row.pass, true);
		assert.deepEqual(row.cleanup, { verified: true });
	}
	assert.deepEqual(
		events.filter((event) => /launch|gone/.test(event)),
		["launch 41", "gone 41", "launch 42", "gone 42"],
	);
});

test("#given setup failure #when running #then no elapsed driver time and owned process cleanup", async () => {
	const { driver, services, events } = attemptFixture();
	services.setSentinel = () => {
		throw new Error("sentinel failed");
	};
	const row = {};
	await runner.runCalculatorAttempt(row, driver, services);
	assert.equal(row.e2e_seconds, null);
	assert.equal(row.pass, false);
	assert.match(row.error, /sentinel failed/);
	assert.deepEqual(events, ["launch 41", "gone 41"]);
});

test("#given unverified cleanup #when completing an attempt #then collection stops", async () => {
	const { driver, services } = attemptFixture();
	services.cleanup = async () => ({ verified: false });
	assert.equal(await runner.runCalculatorAttempt({}, driver, services), false);
});

test("#given driver or oracle failure #when recording an attempt #then elapsed failure time and cleanup survive", async () => {
	for (const failure of ["driver", "oracle"]) {
		const { driver, services, events } = attemptFixture();
		if (failure === "driver") {
			services.readDisplay = () => {
				// No arithmetic was delivered; the independent read remains zero.
				return "0";
			};
			driver.step = async () => {
				throw new Error("driver failed");
			};
		} else {
			let reads = 0;
			services.readDisplay = () => {
				if (reads++ === 0) return "0";
				throw new Error("oracle failed");
			};
		}
		const row = {};
		await runner.runCalculatorAttempt(row, driver, services);
		assert.equal(row.e2e_seconds, failure === "driver" ? 0.02 : 0.08);
		assert.equal(row.pass, false);
		assert.match(row.error, new RegExp(`${failure} failed`));
		assert.equal(events.at(-1), "gone 41");
	}
});

test("#given failed launch or disturbance #when running #then the next attempt is prohibited", async () => {
	for (const failure of ["launch", "trace", "focus", "pointer"]) {
		const { driver, services } = attemptFixture();
		if (failure === "launch") {
			services.launch = async () => {
				throw new Error("launch failed");
			};
		} else {
			services.finishTrace = async (row) => {
				if (failure !== "trace") row[`${failure}_disturbance`] = true;
				return failure !== "trace";
			};
		}
		assert.equal(await runner.runCalculatorAttempt({}, driver, services), false);
	}
});

test("#given lifecycle notifications #when triggering a transition #then subscription precedes input and pid must match", async () => {
	let ready;
	let event;
	const subscription = {
		ready: new Promise((resolve) => {
			ready = resolve;
		}),
		event: new Promise((resolve) => {
			event = resolve;
		}),
	};
	let triggered = false;
	const pending = runner.calculatorTransition(
		subscription,
		() => {
			triggered = true;
			event("42");
		},
		42,
	);
	assert.equal(triggered, false);
	ready();
	assert.equal(await pending, 42);
	assert.equal(triggered, true);
	await assert.rejects(
		runner.calculatorTransition({ ready: Promise.resolve(), event: Promise.resolve("43") }, () => undefined, 42),
		/pid mismatch/,
	);
});

test("#given a process event subscription #when the helper emits readiness and pid #then no registry reaches its argv", async () => {
	const children = new Set();
	const fixture = 'process.stdout.write("SUBSCRIBED\\n42\\n");';
	const event = subscribedEvent(process.execPath, ["-e", fixture], children);
	await event.ready;
	assert.equal(await event.event, "42");
	assert.equal(children.size, 0);
});

test("#given owned process absence #when checking termination #then only ESRCH proves cleanup", () => {
	assert.equal(
		calculatorProcessGone(42, () => undefined),
		false,
	);
	assert.equal(
		calculatorProcessGone(42, () => {
			throw Object.assign(new Error("gone"), { code: "ESRCH" });
		}),
		true,
	);
	assert.throws(
		() =>
			calculatorProcessGone(42, () => {
				throw Object.assign(new Error("denied"), { code: "EPERM" });
			}),
		/denied/,
	);
});

test("#given an event helper that exits before subscription #when waiting #then both bounded signals reject and the registry clears", async () => {
	const children = new Set();
	const event = subscribedEvent(process.execPath, ["-e", "process.exit(2)"], children);
	await assert.rejects(event.ready, /exited 2/);
	await assert.rejects(event.event, /exited 2/);
	assert.equal(children.size, 0);
});

test("#given the v2 calculator task #when building its plan #then preserves all prescribed actions", () => {
	assert.deepEqual(
		calculatorPlan.map(({ op, value }) => [op, value]),
		[
			["observe", undefined],
			["key", "2"],
			["key", "+"],
			["key", "3"],
			["key", "="],
			["key", "c"],
		],
	);
	assert.deepEqual(calculatorPlan.at(-1).modifiers, ["cmd"]);
});

test("#given a fixed seed #when scheduling #then creates reproducible paired randomized blocks", () => {
	const first = calculatorSchedule(20261009);
	assert.equal(first.length, 30);
	assert.deepEqual(first, calculatorSchedule(20261009));
	assert.ok(first.every(({ routes }) => routes.length === 2 && new Set(routes).size === 2));
	assert.notDeepEqual(
		first.map(({ routes }) => routes),
		Array.from({ length: 30 }, () => ["apple", "cua"]),
	);
	assert.throws(() => calculatorSchedule(1, 29), /n=30/);
	assert.throws(() => calculatorSchedule(1, 1), /n=30/);
	assert.equal(calculatorSchedule(1, 1, true).length, 1);
});

test("#given independent display and clipboard #when scoring #then display determines arithmetic success", () => {
	assert.deepEqual(calculatorOutcome("5", "sentinel", false, "copy refused"), {
		pass: true,
		clipboard_pass: false,
		false_success: false,
		error: "copy refused",
	});
	assert.deepEqual(calculatorOutcome("4", "5", true), {
		pass: false,
		clipboard_pass: true,
		false_success: true,
		error: "display mismatch",
	});
	assert.equal(calculatorOutcome("4", "sentinel", false).false_success, false);
});

test("#given Copy refusal after arithmetic #when recording #then both independent oracle values survive", async () => {
	const { driver, services } = attemptFixture();
	driver.step = async (step) => {
		if (step.value === "c") {
			driver.allCallsSucceeded = false;
			throw new Error("copy refused");
		}
	};
	services.readClipboard = () => "calculator benchmark sentinel";
	const row = {};
	await runner.runCalculatorAttempt(row, driver, services);
	assert.equal(row.display, "5");
	assert.equal(row.clipboard, "calculator benchmark sentinel");
	assert.equal(row.pass, true);
	assert.equal(row.clipboard_pass, false);
	assert.match(row.error, /copy refused/);
});

test("#given a stale starting display #when recording #then refuses input and still cleans up", async () => {
	const { driver, services, events } = attemptFixture();
	services.readDisplay = () => "5";
	const row = {};
	await runner.runCalculatorAttempt(row, driver, services);
	assert.equal(row.pass, false);
	assert.equal(row.e2e_seconds, null);
	assert.match(row.error, /starting display/);
	assert.deepEqual(events, ["launch 41", "gone 41"]);
});

test("#given a failed secondary read #when recording #then display success and clipboard error remain distinct", async () => {
	const { driver, services } = attemptFixture();
	services.readClipboard = () => {
		throw new Error("clipboard unavailable");
	};
	const row = {};
	await runner.runCalculatorAttempt(row, driver, services);
	assert.equal(row.pass, true);
	assert.equal(row.clipboard, null);
	assert.equal(row.clipboard_pass, false);
	assert.match(row.clipboard_error, /clipboard unavailable/);
});

test("#given Calculator process ownership #when checking startup and cleanup #then refuses reuse and only quits the owned pid", () => {
	assert.equal(calculatorOwnership([42], null).refuseStart, true);
	assert.equal(calculatorOwnership([], 42, 42).mayQuit, true);
	assert.equal(calculatorOwnership([], 42, 43).mayQuit, false);
	assert.equal(calculatorOwnership([], null).mayQuit, false);
});
