#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { McpClient } from "../bench-v2/client.mjs";
import { IsolationDriver } from "./team-input-driver.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const execute = promisify(execFile);
const command = async (file, args, timeout = 15000) =>
	(
		await execute(file, args, {
			timeout,
			maxBuffer: 8 * 1024 * 1024,
			cwd: root,
			env: file === "git" ? { ...process.env, GIT_MASTER: "1" } : process.env,
		})
	).stdout.trim();
export const DURATION_MS = 20000;
export const payload = (session) => `[TEAM_${session}]: aZ09!?;(){}.,+-=/ `.repeat(20).slice(0, 400);

/** Deterministic PRNG: the exact planned interference is saved with every row. */
export function schedule(seed, session) {
	let value = (seed + session * 7919) >>> 0;
	return Array.from({ length: 4 }, (_, index) => {
		value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
		return {
			at_ms: index * 5000 + (value / 2 ** 32) * 500,
			text: payload(session ? "B" : "A").slice(index * 100, index * 100 + 100),
		};
	});
}

/** Classes accumulate: a refusal never disappears behind text equality or another error. */
export function oracle({ expected, actual, sessions, sampler, duration_ms, recording }) {
	const classes = new Set();
	if (sessions.length !== 2) classes.add("session-infra");
	if (!Array.isArray(actual) || actual.length !== 2 || actual.some((text) => typeof text !== "string"))
		classes.add("oracle-infra");
	else {
		if (actual.some((text, index) => text !== expected[index])) classes.add("text-mismatch");
		if (actual[0].includes("[TEAM_B]") || actual[1].includes("[TEAM_A]")) classes.add("interleaving");
	}
	for (const session of sessions) {
		if (session.refusals > 0) classes.add("input-lock-busy");
		if (session.errors?.length)
			classes.add(
				session.errors.some((error) => error.includes("cannot target")) ? "cannot-target" : "driver-error",
			);
		if (session.typed_characters !== 400) classes.add("incomplete-workload");
		if (session.kind === "apple" && !(session.lock_acquisitions > 0)) classes.add("lock-metrics-missing");
	}
	const samples = sampler?.samples ?? [];
	const baseline = samples[0];
	if (
		!baseline ||
		samples.length < 2 ||
		!Number.isFinite(duration_ms) ||
		samples.at(-1).ms < duration_ms ||
		duration_ms < DURATION_MS
	)
		classes.add("sampler-infra");
	if (samples.some((sample, index) => index > 0 && sample.ms - samples[index - 1].ms > 150))
		classes.add("sampler-gap");
	if (
		baseline &&
		(samples.some((sample) => sample.pid !== baseline.pid) ||
			(sampler.activations ?? []).some((event) => event.pid !== baseline.pid))
	)
		classes.add("frontmost-changed");
	const displacement = baseline
		? Math.max(...samples.map((sample) => Math.hypot(sample.x - baseline.x, sample.y - baseline.y)))
		: null;
	if (displacement !== null && displacement !== 0) classes.add("pointer-displaced");
	if (!recording?.valid) classes.add("recording-infra");
	return { pass: classes.size === 0, classes: [...classes], max_pointer_px: displacement };
}

/** Injected event scheduler makes concurrency testable without time-based test luck. */
export async function runSession(driver, plan, { now, until, started }) {
	const errors = [];
	let typed = 0;
	let inputFinished = started;
	for (const event of plan) {
		if (now() >= started + DURATION_MS) break;
		await until(started + event.at_ms);
		try {
			await driver.input("click", driver.target.button);
			await driver.input("click", { ...driver.target.editor, editor: true });
			await driver.input("key", "cmd+end");
			await driver.input("type", event.text);
			typed += event.text.length;
		} catch (error) {
			errors.push(String(error));
			// A rejected or uncertain burst is not replayed; later scheduled bursts still run.
		}
		inputFinished = now();
	}
	await until(started + DURATION_MS);
	return {
		kind: driver.kind,
		wall_ms: now() - started,
		input_finished_ms: inputFinished - started,
		typed_characters: typed,
		throughput_characters_per_second: typed / ((now() - started) / 1000),
		errors,
		refusals: driver.refusals,
		trace: driver.trace,
	};
}

export function lockSummary(entries, kind) {
	if (kind !== "apple")
		return { lock_wait_ms: null, lock_acquisitions: null, lock_wait_source: "not exposed by control" };
	return {
		lock_wait_ms: entries.reduce((sum, entry) => sum + entry.wait_ms, 0),
		lock_acquisitions: entries.length,
		lock_wait_source: "InputLock.acquire promise elapsed; includes acquire overhead",
		lock_refused_acquisitions: entries.filter((entry) => !entry.acquired).length,
	};
}

/** Spawn with a bounded lifetime, retain diagnostics, and always reap on cancellation. */
export function managed(file, args, lifetime = 90000, env = process.env) {
	const child = spawn(file, args, { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	let timedOut = false;
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const done = new Promise((resolvePromise) => {
		child.once("error", (error) => resolvePromise({ code: null, error: String(error), stdout, stderr }));
		child.once("close", (code, signal) => resolvePromise({ code, signal, timedOut, stdout, stderr }));
	});
	const deadline = setTimeout(() => {
		timedOut = true;
		child.kill("SIGKILL");
	}, lifetime);
	done.finally(() => clearTimeout(deadline));
	return {
		child,
		done,
		async stop(signal = "SIGTERM") {
			if (child.exitCode === null && child.signalCode === null) child.kill(signal);
			const escalation = setTimeout(() => child.kill("SIGKILL"), 3000);
			try {
				return await done;
			} finally {
				clearTimeout(escalation);
			}
		},
	};
}

async function startSampler(native) {
	const process = managed(native, ["sample"]);
	const lines = createInterface({ input: process.child.stdout });
	try {
		const ready = await Promise.race([
			once(lines, "line", { signal: AbortSignal.timeout(10000) }).then(([line]) => JSON.parse(line)),
			process.done.then((result) => {
				throw new Error(`sampler exited: ${JSON.stringify(result)}`);
			}),
		]);
		if (!ready.ready) throw new Error("sampler readiness missing");
	} catch (error) {
		await process.stop();
		throw error;
	} finally {
		lines.close();
	}
	return {
		async finish() {
			process.child.stdin.end("stop\n");
			const result = await process.done;
			if (result.code !== 0) throw new Error(`sampler failed: ${JSON.stringify(result)}`);
			return JSON.parse(result.stdout.trim().split("\n").at(-1));
		},
		stop: () => process.stop(),
	};
}

function server(kind, scratch, index) {
	const overrides = process.env[`TEAM_INPUT_${kind.toUpperCase()}_COMMAND`];
	const defaults = {
		apple: [process.execPath, join(root, "packages/mcp/dist/server.js")],
		cua: [join(homedir(), ".local/bin/cua-driver"), "mcp"],
		peekaboo: ["/opt/homebrew/bin/peekaboo", "mcp"],
	};
	const argv = overrides ? JSON.parse(overrides) : defaults[kind];
	if (!Array.isArray(argv) || !argv.every((part) => typeof part === "string") || !argv.length)
		throw new Error(`invalid command for ${kind}`);
	const env = {
		APPLE_CUA_DELIVERY: "background",
		APPLE_CUA_TOOLSET: "full",
		APPLE_CUA_ALLOWED_BUNDLE_IDS: "com.apple.TextEdit,com.apple.ScriptEditor2",
	};
	if (kind === "apple")
		Object.assign(env, {
			// Both sessions share the SAME input-lock path; never isolate the lock by session.
			APPLE_CUA_HOME: join(scratch, "home"),
			APPLE_CUA_BIN_DIR: join(scratch, "bin"),
			TEAM_INPUT_LOCK_LOG: join(scratch, `lock-${index}.jsonl`),
			TEAM_INPUT_LOCK_MODULE: join(root, "packages/core/dist/platform/input-lock.js"),
			NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(join(root, "scripts/scenarios/team-input-lock-metrics.mjs")).href}`,
		});
	return { command: argv[0], args: argv.slice(1), env, timeoutMs: 4000 };
}

async function readTarget(native, app, button) {
	const target = JSON.parse(await command(native, ["read", String(app.pid), app.bundle, app.path, button]));
	const matches = target.button_matches;
	if (matches.length !== 1 || !matches[0].toolbar)
		throw new Error(`fixture-infra: exact toolbar button ${button} missing: ${JSON.stringify(target.buttons)}`);
	return { ...target, app: app.name, button: { ...matches[0].point, label: button } };
}

async function repetition(kind, iteration, native, out, sameWindow, stopSignal) {
	const scratch = mkdtempSync(join(tmpdir(), "apple-cua-team-input-"));
	const clients = [];
	const owned = [];
	let sampler;
	let recorder;
	const row = { kind, iteration, seed: iteration, same_window: sameWindow, sessions: [], actual: [], cleanup: [] };
	const recordingPath = join(out, `${kind}-${sameWindow ? "collision-" : ""}${iteration}.mov`);
	try {
		mkdirSync(join(scratch, "home"));
		mkdirSync(join(scratch, "bin"));
		const fixtures = [
			{
				name: "TextEdit",
				bundle: "com.apple.TextEdit",
				extension: "rtf",
				initial: "{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Menlo;}}\\f0\\fs24 }",
				button: "Bold",
			},
			{
				name: "Script Editor",
				bundle: "com.apple.ScriptEditor2",
				extension: "applescript",
				initial: "",
				button: "Show or hide the log",
			},
		];
		for (const fixture of fixtures) {
			fixture.path = join(scratch, `${randomUUID()}.${fixture.extension}`);
			writeFileSync(fixture.path, fixture.initial);
			const app = JSON.parse(await command(native, ["launch", fixture.bundle, fixture.path]));
			owned.push({ ...fixture, ...app });
		}
		const buttons = process.env.TEAM_INPUT_BUTTONS
			? JSON.parse(process.env.TEAM_INPUT_BUTTONS)
			: fixtures.map((f) => f.button);
		const targets = await Promise.all(owned.map((app, index) => readTarget(native, app, buttons[index])));
		if (targets.some((target) => target.text !== "")) throw new Error("fixture-infra: nonempty initial AX text");
		row.fixture = targets;
		for (let index = 0; index < 2; index++) {
			const config = server(kind, scratch, index);
			const client = new McpClient(config);
			clients.push(client);
			await client.start();
			row.sessions.push({
				command: [config.command, ...config.args],
				tools: await client.request("tools/list", {}),
			});
		}
		recorder = managed("/usr/sbin/screencapture", ["-v", "-V", "70", recordingPath], 80000);
		// Recording setup is outside measured input and identical across all arms.
		await delay(1000, undefined, { signal: stopSignal });
		sampler = await startSampler(native);
		const started = performance.now();
		const timing = {
			started,
			now: () => performance.now(),
			until: (deadline) => delay(Math.max(0, deadline - performance.now()), undefined, { signal: stopSignal }),
		};
		const drivers = clients.map(
			(client, index) => new IsolationDriver(kind, client, targets[sameWindow ? 0 : index]),
		);
		row.plans = [schedule(iteration, 0), schedule(iteration, 1)];
		// A bounded call alone does not bound a session with repeated refusals.
		const deadline = setTimeout(() => {
			for (const client of clients) client.stop();
		}, 25000);
		let results;
		try {
			results = await Promise.allSettled(
				drivers.map((driver, index) => runSession(driver, row.plans[index], timing)),
			);
		} finally {
			clearTimeout(deadline);
		}
		if (results.some((result) => result.status === "rejected")) throw new Error("run interrupted");
		row.duration_ms = performance.now() - started;
		row.sessions = results.map((result, index) => {
			const path = join(scratch, `lock-${index}.jsonl`);
			let entries = [];
			if (existsSync(path)) entries = readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
			return { ...row.sessions[index], ...result.value, lock_events: entries, ...lockSummary(entries, kind) };
		});
		row.sampler = await sampler.finish();
		sampler = undefined;
		row.actual = await Promise.all(
			owned.map(async (app, index) => (await readTarget(native, app, buttons[index])).text),
		);
		const video = await recorder.stop("SIGINT");
		recorder = undefined;
		const bytes = existsSync(recordingPath) ? statSync(recordingPath).size : 0;
		let probe = {};
		if (bytes)
			probe = JSON.parse(
				await command("/opt/homebrew/bin/ffprobe", [
					"-v",
					"error",
					"-show_entries",
					"format=duration",
					"-of",
					"json",
					recordingPath,
				]),
			);
		row.recording = {
			path: recordingPath,
			bytes,
			duration_seconds: Number(probe.format?.duration),
			valid: !video.timedOut && bytes > 0 && Number(probe.format?.duration) * 1000 >= row.duration_ms,
			process: video,
		};
	} catch (error) {
		row.error = String(error);
	} finally {
		await sampler?.stop();
		if (recorder) row.recording_failure = await recorder.stop("SIGINT");
		for (const client of clients) {
			if (client.child) {
				const exited = client.child.exitCode !== null || client.child.signalCode !== null;
				const done = exited ? Promise.resolve() : once(client.child, "close");
				client.stop();
				const kill = setTimeout(() => client.child.kill("SIGKILL"), 2000);
				try {
					await done;
				} finally {
					clearTimeout(kill);
				}
			}
		}
		for (const app of owned) {
			try {
				row.cleanup.push(JSON.parse(await command(native, ["quit", String(app.pid), app.bundle])));
			} catch (error) {
				row.cleanup.push({ pid: app.pid, error: String(error) });
			}
		}
		if (row.cleanup.some((entry) => !entry.gone)) row.retained_scratch = scratch;
		else rmSync(scratch, { recursive: true, force: true });
	}
	row.oracle = oracle({ ...row, expected: [payload("A"), payload("B")] });
	if (row.error || row.cleanup.some((entry) => !entry.gone)) {
		row.oracle.pass = false;
		row.oracle.classes.push(row.error ? "fixture-or-run-infra" : "cleanup-failed");
	}
	return row;
}

export async function main(args = process.argv.slice(2)) {
	const option = (flag, fallback) => {
		const index = args.indexOf(flag);
		if (index < 0) return fallback;
		if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`missing ${flag}`);
		return args[index + 1];
	};
	if (!args.includes("--desktop-go"))
		throw new Error("DESKTOP GO required: pass --desktop-go only after coordinator authorization");
	if (process.platform !== "darwin") throw new Error("macOS required");
	const kinds = option("--drivers", "apple,cua,peekaboo").split(",");
	if (kinds.some((kind) => !["apple", "cua", "peekaboo"].includes(kind)) || new Set(kinds).size !== kinds.length)
		throw new Error("drivers must be unique apple,cua,peekaboo");
	const sameWindow = args.includes("--same-window");
	const out = resolve(
		option(
			"--out",
			join(root, `docs/benchmarks/wedges/team-input-isolation-${new Date().toISOString().slice(0, 10)}`),
		),
	);
	mkdirSync(out, { recursive: true });
	const lock = join(out, ".running");
	mkdirSync(lock);
	const build = mkdtempSync(join(tmpdir(), "apple-cua-team-build-"));
	const controller = new AbortController();
	const halt = () => controller.abort();
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, halt);
	try {
		const native = join(build, "native");
		await command(
			"swiftc",
			[
				"-O",
				"-module-cache-path",
				join(build, "cache"),
				join(root, "scripts/scenarios/team-input-native.swift"),
				"-o",
				native,
			],
			120000,
		);
		const versions = {
			node: process.version,
			macos: await command("sw_vers", ["-productVersion"]),
			commit: await command("git", ["rev-parse", "HEAD"]),
			commands: {},
			date: new Date().toISOString(),
		};
		for (const kind of kinds) {
			const reportPath = join(out, `${kind}${sameWindow ? "-collision" : ""}.json`);
			if (existsSync(reportPath)) throw new Error(`refusing to overwrite ${reportPath}`);
			const versionCommand = process.env[`TEAM_INPUT_${kind.toUpperCase()}_VERSION_COMMAND`];
			let driverVersion;
			try {
				if (versionCommand) {
					const argv = JSON.parse(versionCommand);
					driverVersion = await command(argv[0], argv.slice(1));
				} else if (kind === "apple") {
					driverVersion = JSON.parse(readFileSync(join(root, "packages/mcp/package.json"), "utf8")).version;
				} else {
					const config = server(kind, build, 0);
					driverVersion = await command(config.command, ["--version"]);
				}
			} catch (error) {
				driverVersion = { error: String(error) };
			}
			const report = { schema: "team-input-isolation-v1", versions, driver_version: driverVersion, repetitions: [] };
			for (let iteration = 1; iteration <= (sameWindow ? 1 : 10); iteration++) {
				if (controller.signal.aborted) throw new Error("interrupted");
				report.repetitions.push(await repetition(kind, iteration, native, out, sameWindow, controller.signal));
				writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
				const last = report.repetitions.at(-1);
				process.stdout.write(`${kind} ${iteration}: ${JSON.stringify(last.oracle)}\n`);
			}
		}
		const files = readdirSync(out).filter((file) => file !== "SHA256SUMS" && file !== ".running");
		writeFileSync(
			join(out, "SHA256SUMS"),
			files
				.map(
					(file) =>
						`${createHash("sha256")
							.update(readFileSync(join(out, file)))
							.digest("hex")}  ${file}\n`,
				)
				.join(""),
		);
	} finally {
		for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.removeListener(signal, halt);
		rmSync(build, { recursive: true, force: true });
		rmSync(lock, { recursive: true });
	}
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	main().catch((error) => {
		process.stderr.write(`${error}\n`);
		process.exitCode = 1;
	});
}
