#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { isScreenLocked } from "../../packages/core/dist/platform/macos-ffi/lock-screen.js";
import { McpClient } from "../bench-v2/client.mjs";
import { startDisturbance } from "./disturbance.mjs";
import { Driver } from "./drivers.mjs";
import { mulberry32, shuffle } from "./stats.mjs";
import { subscribeWindow } from "./window-event.mjs";

export const calculatorPlan = [
	{ op: "observe", app: "Calculator" },
	{ op: "key", app: "Calculator", value: "2" },
	{ op: "key", app: "Calculator", value: "+" },
	{ op: "key", app: "Calculator", value: "3" },
	{ op: "key", app: "Calculator", value: "=" },
	{ op: "key", app: "Calculator", value: "c", apple: "cmd+c", cua: "c", modifiers: ["cmd"] },
];

export function calculatorOutcome(display, clipboard, callsSucceeded, error = null) {
	const pass = display === "5";
	return {
		pass,
		clipboard_pass: clipboard === "5",
		false_success: callsSucceeded && !pass,
		error: error ?? (pass ? null : "display mismatch"),
	};
}

export function calculatorOwnership(existingPids, launchedPid, eventPid = launchedPid) {
	return {
		refuseStart: existingPids.length > 0,
		mayQuit: Number.isInteger(launchedPid) && launchedPid > 0 && launchedPid === eventPid,
	};
}

export function calculatorProcessGone(pid, probe = (target) => process.kill(target, 0)) {
	try {
		probe(pid);
		return false;
	} catch (error) {
		if (error?.code === "ESRCH") return true;
		throw error;
	}
}

export async function calculatorTransition(subscription, trigger, expectedPid = null, windowReady = Promise.resolve()) {
	await subscription.ready;
	if (trigger() === false) return null;
	const pid = Number(await subscription.event);
	if (!calculatorOwnership([], pid, expectedPid ?? pid).mayQuit) throw new Error("Calculator transition pid mismatch");
	await windowReady;
	return pid;
}

export async function runCalculatorAttempt(row, driver, services) {
	let trace = null;
	let start = null;
	let keepRunning = true;
	row.e2e_seconds = null;
	row.display = null;
	row.clipboard = null;
	try {
		try {
			await services.launch();
		} catch (error) {
			keepRunning = false;
			throw error;
		}
		services.setSentinel();
		row.initial_display = services.readDisplay();
		if (row.initial_display !== "0") throw new Error("Calculator starting display is not zero");
		trace = await services.startTrace();
		start = services.now();
		try {
			for (const step of calculatorPlan) await driver.step(step);
		} catch (error) {
			row.error = String(error);
		} finally {
			try {
				for (const [field, read] of [
					["display", services.readDisplay],
					["clipboard", services.readClipboard],
				]) {
					try {
						row[field] = read();
					} catch (error) {
						row[`${field}_error`] = String(error);
						row.error ??= String(error);
					}
				}
			} finally {
				row.e2e_seconds = (services.now() - start) / 1000;
			}
		}
		Object.assign(row, calculatorOutcome(row.display, row.clipboard, driver.allCallsSucceeded, row.error));
	} catch (error) {
		row.error = String(error);
		Object.assign(row, calculatorOutcome(row.display, row.clipboard, driver.allCallsSucceeded, row.error));
	} finally {
		row.calls = driver.calls;
		row.tokens = driver.estimated_tokens;
		row.cost = null;
		row.raw = driver.raw;
		try {
			if (trace) keepRunning = await services.finishTrace(row, trace);
		} finally {
			try {
				row.cleanup = await services.cleanup();
			} catch (error) {
				row.cleanup = { verified: false, error: String(error) };
			}
			if (!row.cleanup.verified || row.focus_disturbance || row.pointer_disturbance) keepRunning = false;
		}
	}
	return keepRunning;
}

export function calculatorSchedule(seed = 20261009, runs = 30, exploratory = false) {
	if (!Number.isInteger(seed) || !Number.isInteger(runs) || (runs !== 30 && !(exploratory && runs === 1)))
		throw new Error("calculator benchmark requires an integer seed and preregistered n=30");
	const random = mulberry32(seed);
	return Array.from({ length: runs }, (_, index) => ({
		iteration: index + 1,
		routes: shuffle(["apple", "cua"], random),
	}));
}

const root = fileURLToPath(new URL("../..", import.meta.url));
const flags = process.argv.slice(2);
const arg = (name, fallback) => {
	const index = flags.indexOf(`--${name}`);
	return index < 0 ? fallback : flags[index + 1];
};
const seed = Number(arg("seed", "20261009"));
const runs = Number(arg("runs", "30"));
const output = arg("out", `${root}/.bench/v3/calculator-30.json`);
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	if (flags.includes("--dry-run")) {
		const schedule = calculatorSchedule(seed, runs, flags.includes("--exploratory"));
		process.stdout.write(`Validated ${schedule.length} paired calculator blocks; no desktop input\n`);
	} else await main();
}

async function main() {
	if (process.platform !== "darwin" || isScreenLocked()) throw new Error("locked or unavailable desktop");
	if (existsSync(output)) throw new Error("existing benchmark artifact refused");
	const dir = "/tmp/cua-bench";
	mkdirSync(dir, { recursive: true });
	const lockPath = `${dir}/.run.lock`;
	const lock = openSync(lockPath, "wx");
	const scratch = mkdtempSync(`${dir}/calculator-A39-`);
	const archive = `${scratch}/clipboard.plist`;
	const clipboard = `${root}/scripts/bench-v2/clipboard.swift`;
	const eventSource = `${root}/scripts/bench-v3/calculator-event.swift`;
	const eventBinary = `${scratch}/calculator-event`;
	const traceBinary = `${scratch}/calculator-trace`;
	const windowBinary = `${scratch}/calculator-window`;
	const displayBinary = `${scratch}/calculator-display`;
	const clients = new Map();
	const children = new Set();
	const schedule = calculatorSchedule(seed, runs, flags.includes("--exploratory"));
	const report = { schema: "bench-v3", seed, runs, scope: "background calculator-add", results: [] };
	report.exploratory = flags.includes("--exploratory");
	report.oracle_amendment = "A39";
	report.fixture_lifecycle = "fresh owned process per attempt; AX window ready before timing";
	report.source_sha256 = Object.fromEntries(
		[
			"scripts/bench-v3/calculator-run.mjs",
			"scripts/bench-v3/calculator-display-probe.swift",
			"scripts/bench-v3/drivers.mjs",
			"scripts/bench-v3/disturbance.swift",
			"scripts/bench-v3/calculator-event.swift",
			"scripts/bench-v3/window-event.swift",
			"scripts/bench-v3/window-event.mjs",
			"packages/core/dist/platform/macos.js",
		].map((path) => [
			path,
			createHash("sha256")
				.update(readFileSync(`${root}/${path}`))
				.digest("hex"),
		]),
	);
	let saved = false;
	let launchedPid = null;
	let trace = null;
	const protectedChildren = new Set();
	let stopped = false;
	const stop = () => {
		stopped = true;
		for (const client of clients.values()) client.stop();
		for (const child of children) if (!protectedChildren.has(child)) child.kill("SIGTERM");
		trace?.cancel();
	};
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, stop);
	const readClipboard = () =>
		execFileSync("swift", ["-e", 'import AppKit; print(NSPasteboard.general.string(forType: .string) ?? "")'], {
			encoding: "utf8",
			timeout: 10000,
		}).replace(/\r?\n$/, "");
	const readDisplay = () =>
		execFileSync(displayBinary, [String(launchedPid)], { encoding: "utf8", timeout: 10000 }).replace(/\r?\n$/, "");
	const checkExisting = () => {
		const apps = spawnSync("pgrep", ["-x", "Calculator"], { encoding: "utf8", timeout: 10000 });
		if (apps.error || apps.status > 1) throw apps.error ?? new Error("could not check Calculator process ownership");
		const existingPids = apps.status === 0 ? apps.stdout.trim().split(/\s+/).map(Number) : [];
		if (calculatorOwnership(existingPids, null).refuseStart)
			throw new Error("Calculator already running; refusing reuse");
	};
	const launchOwned = async () => {
		checkExisting();
		const launch = subscribedEvent(eventBinary, ["launched"], children);
		protectedChildren.add(launch.child);
		let window;
		try {
			window = await subscribeWindow(windowBinary, "*", false, "com.apple.calculator");
			launchedPid = await calculatorTransition(launch, () => {
				if (stopped || isScreenLocked()) throw new Error("stopped or locked");
				execFileSync("open", ["-g", "-n", "-a", "Calculator"], { timeout: 10000 });
			});
			await window.ready;
			if (stopped || isScreenLocked()) throw new Error("stopped or locked");
		} finally {
			window?.cancel();
			protectedChildren.delete(launch.child);
			launch.child.kill("SIGTERM");
		}
	};
	const cleanupOwned = async () => {
		const pid = launchedPid;
		if (pid === null) return { pid, verified: true };
		if (!calculatorOwnership([], pid).mayQuit) return { pid, verified: false };
		let error = null;
		if (!calculatorProcessGone(pid)) {
			const termination = subscribedEvent(eventBinary, ["terminated"], children);
			protectedChildren.add(termination.child);
			try {
				await calculatorTransition(
					termination,
					() => {
						if (calculatorProcessGone(pid)) return false;
						execFileSync("kill", ["-TERM", String(pid)], { timeout: 10000 });
					},
					pid,
				);
			} catch (failure) {
				error = String(failure);
			} finally {
				protectedChildren.delete(termination.child);
				termination.child.kill("SIGTERM");
			}
		}
		const verified = calculatorProcessGone(pid);
		if (verified) launchedPid = null;
		return { pid, verified: verified && error === null, ...(error ? { error } : {}) };
	};
	try {
		checkExisting();
		execFileSync("swiftc", [eventSource, "-o", eventBinary], { timeout: 60000 });
		execFileSync("swiftc", [`${root}/scripts/bench-v3/window-event.swift`, "-o", windowBinary], { timeout: 60000 });
		execFileSync("swiftc", [`${root}/scripts/bench-v3/disturbance.swift`, "-o", traceBinary], { timeout: 60000 });
		execFileSync("swiftc", ["-O", `${root}/scripts/bench-v3/calculator-display-probe.swift`, "-o", displayBinary], {
			timeout: 60000,
		});
		execFileSync("swift", [clipboard, "save", archive], { timeout: 60000 });
		saved = true;
		for (const route of ["apple", "cua"]) {
			let spec;
			if (route === "apple") {
				spec = {
					command: "node",
					args: [`${root}/packages/mcp/dist/server.js`],
					env: { OPENCUA_ALLOWED_BUNDLE_IDS: "com.apple.calculator", OPENCUA_DELIVERY: "background" },
				};
			} else {
				spec = { command: `${homedir()}/.local/bin/cua-driver`, args: ["mcp"] };
			}
			const client = new McpClient(spec);
			clients.set(route, client);
			await client.start();
		}
		for (const block of schedule)
			for (const route of block.routes) {
				if (stopped || isScreenLocked()) throw new Error("stopped or locked");
				const row = {
					iteration: block.iteration,
					route,
					scenario: "calculator-add",
					pass: false,
					false_success: false,
				};
				const driver = new Driver(route, clients.get(route));
				try {
					if (
						!(await runCalculatorAttempt(row, driver, {
							launch: launchOwned,
							setSentinel: () =>
								execFileSync("pbcopy", [], { input: "calculator benchmark sentinel", timeout: 10000 }),
							startTrace: async () => {
								trace = await startDisturbance(traceBinary);
								return trace;
							},
							readClipboard,
							readDisplay,
							now: () => performance.now(),
							finishTrace: async (result, activeTrace) => {
								try {
									result.disturbance_trace = await activeTrace.stop();
									result.focus_disturbance = result.disturbance_trace.activations.length > 0;
									result.pointer_disturbance = result.disturbance_trace.max_cursor_px > 2;
									return true;
								} catch (error) {
									result.disturbance_error = String(error);
									return false;
								} finally {
									trace = null;
								}
							},
							cleanup: cleanupOwned,
						}))
					)
						stopped = true;
				} finally {
					report.cleanup = row.cleanup;
					report.results.push(row);
					mkdirSync(fileURLToPath(new URL(".", `file://${output}`)), { recursive: true });
					writeFileSync(output, JSON.stringify(report, null, 2));
					process.stdout.write(
						`${route} calculator-add ${block.iteration}/${runs}: ${row.pass ? "PASS" : "FAIL"}\n`,
					);
				}
			}
	} finally {
		stop();
		for (const client of clients.values()) client.stop();
		if (launchedPid !== null && calculatorOwnership([], launchedPid, launchedPid).mayQuit) {
			try {
				report.cleanup = await cleanupOwned();
			} catch (error) {
				report.cleanup_error = String(error);
			}
		}
		trace?.cancel();
		try {
			if (saved) {
				execFileSync("swift", [clipboard, "restore", archive], { timeout: 60000 });
				rmSync(archive);
			}
		} finally {
			closeSync(lock);
			rmSync(lockPath);
			rmSync(scratch, { recursive: true, force: true });
			for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.removeListener(signal, stop);
			report.finished_at = new Date().toISOString();
			mkdirSync(fileURLToPath(new URL(".", `file://${output}`)), { recursive: true });
			writeFileSync(output, JSON.stringify(report, null, 2));
		}
	}
}

export function subscribedEvent(binary, args, children) {
	let resolveReady;
	let rejectReady;
	let resolveEvent;
	let rejectEvent;
	const ready = new Promise((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});
	ready.catch(() => undefined);
	const fail = (error) => {
		clearTimeout(timeout);
		children.delete(child);
		rejectReady(error);
		rejectEvent(error);
	};
	const event = new Promise((resolve, reject) => {
		resolveEvent = resolve;
		rejectEvent = reject;
	});
	event.catch(() => undefined);
	const child = spawn(binary, args, { stdio: ["ignore", "pipe", "inherit"] });
	const timeout = setTimeout(() => {
		child.kill("SIGTERM");
		fail(new Error("Calculator event deadline exceeded"));
	}, 10000);
	let data = "";
	let observedPid = false;
	children.add(child);
	child.stdout.on("data", (chunk) => {
		data += String(chunk);
		if (data.includes("SUBSCRIBED")) resolveReady();
		const pid = Number(
			data
				.split(/\r?\n/)
				.find((line) => /^\d+$/.test(line.trim()))
				?.trim(),
		);
		if (Number.isInteger(pid) && pid > 0) {
			observedPid = true;
			clearTimeout(timeout);
			children.delete(child);
			resolveEvent(String(pid));
		}
	});
	child.once("error", fail);
	child.once("exit", (code) => {
		if (!observedPid) {
			fail(new Error(`Calculator event helper exited ${code}`));
		}
	});
	return { ready, event, child };
}
