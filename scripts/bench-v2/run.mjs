#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isScreenLocked } from "../../packages/core/dist/platform/macos-ffi/lock-screen.js";
import { AttemptRunner } from "./attempt.mjs";
import { cleanupAttempt, cleanupPlan } from "./cleanup.mjs";
import { McpClient } from "./client.mjs";
import { desktopProbe } from "./desktop.mjs";
import { Driver } from "./drivers.mjs";
import { ROOT, ensureFixtureRoot, validateFixture } from "./fixture.mjs";
import { OmoAgentDriver, PROFILES } from "./omo-agent.mjs";
import { startOracleServer } from "./oracle-server.mjs";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const flags = process.argv.slice(2);
const option = (name, fallback) => {
	const index = flags.indexOf(`--${name}`);
	if (index < 0) return fallback;
	if (!flags[index + 1] || flags[index + 1].startsWith("--")) throw new Error(`missing --${name} value`);
	return flags[index + 1];
};
const readDefault = (domain, key) => {
	try {
		return execFileSync("defaults", ["read", domain, key], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim() === "1"
			? "true"
			: "false";
	} catch {
		return undefined;
	}
};
const command = (name, args) => execFileSync(name, args, { encoding: "utf8", timeout: 10000 }).trim();
// Pinned third-party drivers: package, version and the exact MCP launch command (see README).
const pins = JSON.parse(readFileSync(new URL("./pins.json", import.meta.url), "utf8"));
async function main() {
	const available = await Promise.all(
		readdirSync(new URL("./scenarios/", import.meta.url))
			.filter((f) => f.endsWith(".mjs"))
			.map(async (file) => (await import(`./scenarios/${file}`)).scenario),
	);
	const ids = option("scenarios", "all");
	const chosen =
		ids === "all"
			? available
			: ids.split(",").map((id) => {
					const spec = available.find((item) => item.id === id);
					if (!spec) throw new Error(`unknown scenario: ${id}`);
					return spec;
				});
	if (new Set(available.map((s) => s.id)).size !== available.length) throw new Error("duplicate scenario id");
	for (const spec of available) validateFixture(spec);
	if (flags.includes("--dry-run")) {
		process.stdout.write(
			`Validated ${available.length} scenario modules, ${chosen.length} selected; fixture paths under /tmp/cua-bench; desktop untouched\n`,
		);
		return;
	}
	// The session this process runs in, not whichever user owns the console: with fast user switching
	// another user's locked console says nothing about whether this session can be driven.
	if (process.platform !== "darwin" || isScreenLocked())
		throw new Error(
			"Screen locked (IOConsoleUsers CGSSessionScreenIsLocked) or macOS unavailable: refusing live runs. Unlock this Mac before scheduling a run.",
		);
	const drivers = option("drivers", "apple,cua").split(",");
	const scripted = ["apple", "apple-legacy", "cua", "peekaboo"];
	if (drivers.some((d) => !scripted.includes(d) && !(d in PROFILES)) || new Set(drivers).size !== drivers.length)
		throw new Error(
			`--drivers must be a comma-separated subset of ${[...scripted, ...Object.keys(PROFILES)].join(",")} (peekaboo runs ${pins.peekaboo.mcp_command.join(" ")}; Node 22+)`,
		);
	if (drivers.includes("peekaboo") && Number(process.versions.node.split(".")[0]) < 22)
		throw new Error(`--drivers peekaboo needs Node 22+ (${pins.peekaboo.package} engines); found ${process.version}`);
	// Agent profiles share one model and thinking level so only the computer-use hand differs.
	const agentOptions = {
		model: option("agent-model", "anthropic-subscription/claude-opus-5-5"),
		thinking: option("agent-thinking", "high"),
	};
	// Real paths: the server only starts when argv[1] equals its own resolved module path, and /tmp is
	// a symlink to /private/tmp on macOS, so an unresolved /tmp path made it exit silently.
	const serverFor = {
		apple: realpathSync(option("apple-server", path.join(root, "packages/mcp/dist/server.js"))),
		"apple-legacy": realpathSync(option("legacy-server", path.join(root, "packages/mcp/dist/server.js"))),
	};
	const runs = Number(option("runs", "5"));
	if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
	const commit = command("git", ["rev-parse", "HEAD"]);
	const out = option("out", `.bench/${new Date().toISOString().replaceAll(":", "-")}-${commit.slice(0, 8)}.json`);
	const report = {
		schema: "bench-v2",
		started_at: new Date().toISOString(),
		env: {
			commit,
			dirty: command("git", ["status", "--porcelain"]) !== "",
			macos: command("sw_vers", ["-productVersion"]),
			machine: os.cpus()[0]?.model ?? os.arch(),
			screen_locked: false,
			// Off the physical console (fast user switching / Screen Sharing), macOS returns broken AX
			// window elements to every driver, so success rates from such a run are not comparable.
			session_on_console: JSON.parse(
				execFileSync("plutil", ["-extract", "IOConsoleUsers", "json", "-o", "-", "-"], {
					input: execFileSync("ioreg", ["-n", "Root", "-d1", "-a"]),
					encoding: "utf8",
				}),
			).some((s) => s.kCGSSessionUserNameKey === os.userInfo().username && s.kCGSSessionOnConsoleKey === true),
			driver_versions: {
				apple: JSON.parse(readFileSync(path.join(root, "packages/mcp/package.json"), "utf8")).version,
				cua: command(`${os.homedir()}/.local/bin/cua-driver`, ["--version"]),
				...(drivers.includes("peekaboo") ? { peekaboo: pins.peekaboo.version_output } : {}),
			},
			apple_servers: serverFor,
			node: process.version,
		},
		selected: chosen.map((s) => s.id),
		runs,
		results: [],
	};
	ensureFixtureRoot();
	const lockPath = path.join(ROOT, ".run.lock");
	const lock = openSync(lockPath, "wx");
	const archive = path.join(ROOT, `clipboard-${randomUUID()}.plist`);
	const clipboardScript = path.join(root, "scripts/bench-v2/clipboard.swift");
	const clients = new Map();
	/** Tool names a server listed at start, for drivers that check every call against them. */
	const toolNames = new Map();
	let clipboardSaved = false;
	// TextEdit preferences scoped to this run, each restored to its exact prior value afterwards.
	// NSCloseAlwaysConfirmsChanges: textedit-alert-dismiss needs Cmd+W on an edited document to ask
	// about changes; with macOS's default "Ask to keep changes" off, TextEdit silently saves instead.
	// Auto-capitalization and spelling correction rewrite typed text nondeterministically ("first
	// line" sometimes becomes "First line"), which is TextEdit's choice, not the driver's input.
	const scopedDefaults = [
		{ key: "NSCloseAlwaysConfirmsChanges", value: "true", set: false, previous: undefined },
		{ key: "NSAutomaticCapitalizationEnabled", value: "false", set: false, previous: undefined },
		{ key: "CorrectSpellingAutomatically", value: "false", set: false, previous: undefined },
		// A TextEdit terminated by cleanup (stuck behind a Save panel off-console) would otherwise restore
		// its windows and unsaved edits on the next launch, and the next attempt would start from those.
		{ key: "ApplePersistence", value: "false", set: false, previous: undefined },
	];
	let pageServer;
	let probe;
	let beforeRun;
	let attemptRunner;
	try {
		pageServer = await startOracleServer();
		probe = desktopProbe();
		beforeRun = probe.snapshot();
		attemptRunner = new AttemptRunner(probe, pageServer, beforeRun);
		execFileSync("swift", [clipboardScript, "save", archive], { timeout: 60000 });
		clipboardSaved = true;
		for (const scoped of scopedDefaults) {
			scoped.previous = readDefault("com.apple.TextEdit", scoped.key);
			execFileSync("defaults", ["write", "com.apple.TextEdit", scoped.key, "-bool", scoped.value]);
			scoped.set = true;
		}
		for (const kind of drivers) {
			if (kind in PROFILES) continue;
			const [peekabooCommand, ...peekabooArgs] = pins.peekaboo.mcp_command;
			const client =
				kind === "peekaboo"
					? new McpClient({ command: peekabooCommand, args: peekabooArgs })
					: kind in serverFor
						? new McpClient({
								command: "node",
								args: [serverFor[kind]],
								env: {
									OPENCUA_ALLOWED_BUNDLE_IDS:
										"com.apple.finder,com.apple.TextEdit,com.apple.Safari,com.apple.systempreferences,com.apple.calculator",
									OPENCUA_DELIVERY: "background",
								},
							})
						: new McpClient({
								command: `${os.homedir()}/.local/bin/cua-driver`,
								args: ["mcp"],
								env: { PATH: `${os.homedir()}/.local/bin:${process.env.PATH ?? ""}` },
							});
			clients.set(kind, client);
			await client.start();
			// Read Peekaboo's schema at run time: a mapped tool the pinned server does not list fails that
			// attempt as a driver error instead of being sent.
			if (kind === "peekaboo")
				toolNames.set(kind, new Set((await client.request("tools/list", {})).tools.map((tool) => tool.name)));
		}
		// A stopped run must still restore the clipboard and TextEdit preferences, so a signal ends the
		// run after the current attempt and lets the cleanup below run instead of exiting mid-state.
		let stopSignal;
		for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
			process.once(signal, () => {
				stopSignal = signal;
				process.stderr.write(`${signal}: stopping after the current attempt and restoring state\n`);
			});
		for (let iteration = 1; iteration <= runs; iteration++) {
			for (const spec of chosen) {
				for (const kind of drivers) {
					if (stopSignal) throw new Error(`run stopped by ${stopSignal}`);
					const driver =
						kind in PROFILES
							? new OmoAgentDriver(kind, agentOptions)
							: new Driver(kind, clients.get(kind), toolNames.get(kind));
					const { row } = await attemptRunner.run(spec, driver, iteration);
					if (row.cleanup.forced.length)
						process.stderr.write(`CLEANUP FORCED ${kind} ${spec.id}: ${row.cleanup.forced.join("; ")}\n`);
					if (row.cleanup.leftover.length)
						process.stderr.write(`CLEANUP LEFTOVER ${kind} ${spec.id}: ${row.cleanup.leftover.join("; ")}\n`);
					report.results.push(row);
					mkdirSync(path.dirname(out), { recursive: true });
					writeFileSync(out, JSON.stringify(report, null, 2));
					process.stdout.write(
						`${kind} ${spec.id} ${iteration}/${runs}: ${row.pass ? "PASS" : `FAIL ${row.error_class}`} (${driver.calls} calls)\n`,
					);
				}
			}
		}
	} finally {
		for (const client of clients.values()) client.stop();
		for (const scoped of scopedDefaults.filter((item) => item.set)) {
			execFileSync(
				"defaults",
				scoped.previous === undefined
					? ["delete", "com.apple.TextEdit", scoped.key]
					: ["write", "com.apple.TextEdit", scoped.key, "-bool", scoped.previous],
			);
		}
		try {
			if (probe && beforeRun) {
				const cleanup = { closed: [], quit: [], forced: [], leftover: [] };
				for (const { spec, pageUrl } of attemptRunner.contexts) {
					const result = await cleanupAttempt(probe, beforeRun, spec, pageUrl);
					cleanup.closed.push(...result.closed);
					cleanup.quit.push(...result.quit);
					cleanup.forced.push(...result.forced);
					cleanup.leftover.push(...result.leftover);
				}
				try {
					const final = probe.snapshot();
					for (const spec of chosen) {
						const plan = cleanupPlan(beforeRun, final, spec);
						cleanup.leftover.push(
							...plan.quit.map((app) => `run-launched app ${app.bundle} (${app.pid}) still running`),
						);
						cleanup.leftover.push(
							...plan.newWindows.map(
								(window) =>
									`fixture candidate window ${window.pid}:${window.number} ${window.title} still open`,
							),
						);
					}
				} catch (error) {
					cleanup.leftover.push(`Final window inventory failed: ${String(error)}`);
				}
				cleanup.leftover = [...new Set(cleanup.leftover)];
				report.cleanup = cleanup;
				if (cleanup.forced.length) process.stderr.write(`CLEANUP FORCED FINAL: ${cleanup.forced.join("; ")}\n`);
				if (cleanup.leftover.length)
					process.stderr.write(`CLEANUP LEFTOVER FINAL: ${cleanup.leftover.join("; ")}\n`);
				writeFileSync(out, JSON.stringify(report, null, 2));
			}
		} finally {
			try {
				probe?.close();
				if (pageServer) await pageServer.close();
			} finally {
				try {
					if (clipboardSaved) {
						execFileSync("swift", [clipboardScript, "restore", archive], { timeout: 60000 });
						rmSync(archive);
					}
				} finally {
					closeSync(lock);
					rmSync(lockPath);
				}
			}
		}
	}
	report.finished_at = new Date().toISOString();
	writeFileSync(out, JSON.stringify(report, null, 2));
	process.stdout.write(`Evidence: ${out}\n`);
}

main().catch((error) => {
	process.stderr.write(`${error}\n`);
	process.exitCode = 1;
});
