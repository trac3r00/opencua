// Wedge B: a real iPhone driven over MCP. Each repetition observes the iPhone Mirroring window, opens Notes,
// creates a note holding a fresh nonce, returns to the note list, and reads the nonce back through the OCR
// observation. Only that OCR read-back decides a pass; tool success flags are recorded, never trusted.
//
//   node scripts/scenarios/iphone-notes.mjs [--out <dir>] [--reps 5] [--cli <apple-cua>] [--helper <apple-cua-mcp>]
//                                           [--no-record]
//
// Precondition: `apple-cua --json ios status` must report "ready". Anything else is a readiness failure: the
// scenario writes its JSON and exits 2 without starting the server or sending one input.
// On-screen text is data. Nothing read from the phone is ever interpreted as an instruction.
import { spawn } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA = "wedge-iphone-notes/1";
/** OCR-unambiguous: no O/0, I/1/L, S/5, B/8, Z/2, G/6. */
export const NONCE_ALPHABET = "ACDEFHJKMNPRTUVWXY3479";
export const NONCE_PREFIX = "CUA";
export const NONCE_BODY_LENGTH = 8;
export const SERVER_ENV = Object.freeze({
	APPLE_CUA_IPHONE: "1",
	APPLE_CUA_DELIVERY: "background",
	APPLE_CUA_CURSOR: "off",
});
const CALL_TIMEOUT_MS = 20_000;
const STATUS_TIMEOUT_MS = 15_000;
const RECORDING_CAP_SECONDS = 120;
const RECORDING_STOP_TIMEOUT_MS = 10_000;
const TEXT_SAMPLE = 40;

/** Parse `apple-cua --json ios status`; only an explicit "ready" state is ready. */
export function parseIosStatus(stdout, exitCode) {
	let parsed;
	try {
		parsed = JSON.parse(String(stdout).trim());
	} catch {
		return { ready: false, state: "unparseable", message: String(stdout).slice(0, 500), exitCode };
	}
	const state = typeof parsed?.state === "string" ? parsed.state : "unknown";
	const message = typeof parsed?.message === "string" ? parsed.message : "";
	return { ready: state === "ready" && exitCode === 0, state, message, exitCode };
}

export function makeNonce(pick = (n) => randomInt(n)) {
	let body = "";
	for (let index = 0; index < NONCE_BODY_LENGTH; index++) body += NONCE_ALPHABET[pick(NONCE_ALPHABET.length)];
	return `${NONCE_PREFIX}${body}`;
}

function squash(text) {
	return String(text).replace(/\s+/g, "");
}

function editDistance(left, right) {
	const row = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let i = 1; i <= left.length; i++) {
		let diagonal = row[0];
		row[0] = i;
		for (let j = 1; j <= right.length; j++) {
			const above = row[j];
			row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
			diagonal = above;
		}
	}
	return row[right.length];
}

/**
 * Compare an OCR read-back with the nonce. A match is the exact, case-sensitive nonce inside one OCR line
 * (whitespace ignored, since OCR may split it). A line one or two edits away is a near miss and fails.
 */
export function compareReadBack(texts, nonce) {
	const lines = texts.map((text) => String(text.text ?? ""));
	const matches = lines.filter((line) => squash(line).includes(nonce));
	const nearMisses =
		matches.length > 0
			? []
			: lines.filter((line) => {
					const candidate = squash(line);
					for (let start = 0; start + nonce.length - 1 <= candidate.length; start++) {
						for (const width of [nonce.length - 1, nonce.length, nonce.length + 1]) {
							const slice = candidate.slice(start, start + width);
							if (slice.length === width && editDistance(slice, nonce) <= 2) return true;
						}
					}
					return false;
				});
	return { matched: matches.length > 0, matches, nearMisses };
}

/** The Notes list, not the editor: an editor read-back would be a misleading success. */
export function classifyNotesView(texts) {
	const lines = texts.map((text) => String(text.text ?? "").trim());
	if (lines.some((line) => line === "Done")) return "editor";
	if (lines.some((line) => /^\d+\s+Notes?$/i.test(line) || /^Search$/i.test(line))) return "list";
	return "unknown";
}

/** The editor's top-left back control (labelled with the folder name), skipping the status-bar clock. */
export function findBackTarget(texts, window) {
	const top = window.y + window.height * 0.15;
	const left = window.x + window.width * 0.5;
	const candidates = texts.filter((text) => {
		const label = String(text.text ?? "").trim();
		if (label.length === 0 || /^\d{1,2}:\d{2}/.test(label)) return false;
		return text.y < top && text.x < left && text.y > window.y + window.height * 0.03;
	});
	candidates.sort((a, b) => b.y - a.y || a.x - b.x);
	const hit = candidates[0];
	return hit === undefined ? undefined : { x: hit.x + hit.width / 2, y: hit.y + hit.height / 2, label: hit.text };
}

/** Parse an MCP tool result into { ok, value }; refusals and isError results are not ok. */
export function toolPayload(result) {
	const text = result?.content?.find?.((item) => item.type === "text")?.text;
	let value;
	try {
		value = text === undefined ? undefined : JSON.parse(text);
	} catch {
		value = { raw: String(text).slice(0, 500) };
	}
	const ok = result?.isError !== true && typeof value?.observation_token === "string";
	return { ok, value };
}

function sampleTexts(value) {
	return Array.isArray(value?.texts) ? value.texts.slice(0, TEXT_SAMPLE).map((text) => text.text) : [];
}

/**
 * One repetition. `call(name, args)` is a bounded MCP tools/call. Every step consumes the token of the
 * observation just before it; the first refusal stops the repetition with what the phone reported.
 */
export async function runRepetition({ call, nonce, now = () => performance.now() }) {
	const started = now();
	const row = { nonce, pass: false, steps: [], readback: undefined, failure: undefined };
	let token;
	let last;
	const step = async (tool, args = {}) => {
		const t0 = now();
		let result;
		try {
			result = await call(tool, tool === "ios_observe" ? {} : { ...args, observation_token: token });
		} catch (error) {
			row.steps.push({ tool, ok: false, ms: now() - t0, error: String(error) });
			throw new StepFailure(tool, String(error));
		}
		const { ok, value } = toolPayload(result);
		row.steps.push({
			tool,
			ok,
			ms: now() - t0,
			...(ok ? {} : { reason: value?.reason ?? "no-observation-token", message: value?.message }),
		});
		if (!ok) throw new StepFailure(tool, value?.message ?? value?.reason ?? JSON.stringify(value));
		token = value.observation_token;
		last = value;
		return value;
	};
	try {
		const first = await step("ios_observe");
		if (compareReadBack(first.texts ?? [], nonce).matched)
			throw new StepFailure("stale-check", "the nonce was on screen before it was typed");
		await step("ios_open_app", { name: "Notes" });
		await step("ios_press_keys", { combo: "cmd+n" });
		await step("ios_type_text", { text: nonce, mode: "paste" });
		const back = findBackTarget(last.texts ?? [], last.window);
		if (back !== undefined) await step("ios_tap", { x: back.x, y: back.y });
		let view = classifyNotesView((await step("ios_observe")).texts ?? []);
		if (view !== "list") {
			const w = last.window;
			await step("ios_swipe", {
				direction: "right",
				kind: "drag",
				distance: 0.5,
				at: { x: w.x + w.width * 0.3, y: w.y + w.height * 0.5 },
			});
			view = classifyNotesView((await step("ios_observe")).texts ?? []);
		}
		const readBack = await step("ios_observe");
		view = classifyNotesView(readBack.texts ?? []);
		const comparison = compareReadBack(readBack.texts ?? [], nonce);
		row.readback = { view, ...comparison, ocr_sample: sampleTexts(readBack) };
		row.pass = comparison.matched && view === "list";
		if (!row.pass) row.failure = view !== "list" ? "not-in-list-view" : "nonce-not-read-back";
	} catch (error) {
		row.failure = error instanceof StepFailure ? `${error.tool}: ${error.message}` : String(error);
		row.last_ocr_sample = sampleTexts(last);
	}
	row.e2e_ms = now() - started;
	return row;
}

class StepFailure extends Error {
	constructor(tool, message) {
		super(message);
		this.tool = tool;
	}
}

/**
 * The whole scenario with injected effects: `status()` runs the CLI precondition, `startServer()` returns
 * { call, listTools, stop, describe }, `recorder(window, path)` returns { stop() } or undefined.
 */
export async function runScenario({ reps, status, startServer, recorder, outDir, nonce = makeNonce, log = () => {} }) {
	const report = {
		schema: SCHEMA,
		date: new Date().toISOString(),
		scope: "single-system scenario: apple-cua over MCP on a real iPhone via iPhone Mirroring; not a head-to-head",
		precondition: undefined,
		server: undefined,
		repetitions: [],
		summary: { passed: 0, total: reps, steps_attempted: 0 },
	};
	const precondition = await status();
	report.precondition = precondition;
	if (!precondition.ready) {
		report.readiness_failure = `ios status is ${precondition.state}: ${precondition.message}`;
		return report;
	}
	const server = await startServer();
	report.server = server.describe();
	try {
		const tools = await server.listTools();
		report.server.ios_tools = tools.filter((name) => name.startsWith("ios_"));
		const probe = toolPayload(await server.call("ios_observe", {}));
		if (!probe.ok) {
			report.readiness_failure =
				`ios_observe refused: ${probe.value?.reason ?? ""} ${probe.value?.message ?? ""}`.trim();
			return report;
		}
		for (let index = 1; index <= reps; index++) {
			const value = nonce();
			const movie = outDir === undefined ? undefined : join(outDir, `rep-${index}.mov`);
			const recording = movie === undefined ? undefined : await recorder?.(probe.value.window, movie);
			const row = await runRepetition({ call: server.call, nonce: value });
			if (recording !== undefined) row.recording = await recording.stop();
			row.repetition = index;
			report.repetitions.push(row);
			report.summary.steps_attempted += row.steps.length;
			if (row.pass) report.summary.passed++;
			log(`rep ${index}/${reps}: ${row.pass ? "PASS" : `FAIL (${row.failure})`}`);
		}
	} finally {
		server.stop();
	}
	return report;
}

/** SHA256SUMS over every regular file in dir except itself, sorted by name. */
export function writeSha256Sums(dir) {
	const lines = readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name !== "SHA256SUMS")
		.map((entry) => entry.name)
		.sort()
		.map(
			(name) =>
				`${createHash("sha256")
					.update(readFileSync(join(dir, name)))
					.digest("hex")}  ${name}`,
		);
	writeFileSync(join(dir, "SHA256SUMS"), `${lines.join("\n")}\n`);
	return lines;
}

function runBounded(command, args, timeoutMs) {
	return new Promise((done) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			done({ code: 127, stdout, stderr: String(error) });
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			done({ code: code ?? 128, signal, stdout, stderr });
		});
	});
}

function startRecording(window, path) {
	const region = [window.x, window.y, window.width, window.height].map((n) => Math.round(n)).join(",");
	const child = spawn("screencapture", ["-v", "-x", "-V", String(RECORDING_CAP_SECONDS), "-R", region, path], {
		stdio: ["pipe", "ignore", "pipe"],
	});
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const exited = new Promise((done) => child.on("close", (code, signal) => done({ code, signal })));
	return {
		stop: async () => {
			child.kill("SIGINT");
			const outcome = await Promise.race([
				exited,
				new Promise((done) => setTimeout(() => done(undefined), RECORDING_STOP_TIMEOUT_MS).unref()),
			]);
			if (outcome === undefined) child.kill("SIGKILL");
			return { path, region, exit: outcome ?? "killed", stderr: stderr.slice(0, 500) };
		},
	};
}

async function main(argv) {
	const args = {
		reps: 5,
		out: undefined,
		cli: [process.execPath, fileURLToPath(new URL("../../packages/cli/dist/cli.js", import.meta.url))],
		helper: fileURLToPath(
			new URL("../../packages/mcp/dist/apple-cua-mcp.app/Contents/MacOS/apple-cua-mcp", import.meta.url),
		),
		record: true,
	};
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		if (flag === "--reps") args.reps = Number(argv[++index]);
		else if (flag === "--out") args.out = resolve(argv[++index]);
		else if (flag === "--cli") args.cli = [argv[++index]];
		else if (flag === "--helper") args.helper = resolve(argv[++index]);
		else if (flag === "--no-record") args.record = false;
		else throw new Error(`unknown argument ${flag}`);
	}
	if (!Number.isInteger(args.reps) || args.reps < 1) throw new Error("--reps must be a positive integer");
	const day = new Date().toISOString().slice(0, 10);
	const outDir =
		args.out ?? resolve(fileURLToPath(new URL(`../../docs/benchmarks/wedges/iphone-notes-${day}`, import.meta.url)));
	mkdirSync(outDir, { recursive: true });
	const { McpClient } = await import("../bench-v2/client.mjs");
	const helper = args.helper;
	const serverJs = fileURLToPath(new URL("../../packages/mcp/dist/server.js", import.meta.url));
	const report = await runScenario({
		reps: args.reps,
		outDir: args.record ? outDir : undefined,
		log: (line) => process.stdout.write(`${line}\n`),
		status: async () => {
			const command = [...args.cli, "--json", "ios", "status"];
			const result = await runBounded(command[0], command.slice(1), STATUS_TIMEOUT_MS);
			return {
				command: command.join(" "),
				...parseIosStatus(result.stdout, result.code),
				stdout: result.stdout.trim(),
				stderr: result.stderr.trim().slice(0, 500),
			};
		},
		startServer: async () => {
			const client = new McpClient({
				command: helper,
				args: [serverJs],
				env: { ...SERVER_ENV },
				timeoutMs: CALL_TIMEOUT_MS,
			});
			await client.start();
			return {
				call: (name, input) => client.callTool(name, input),
				listTools: async () => (await client.request("tools/list", {})).tools.map((tool) => tool.name),
				stop: () => client.stop(),
				describe: () => ({ command: helper, args: [serverJs], env: { ...SERVER_ENV } }),
			};
		},
		recorder: async (window, path) => startRecording(window, path),
	});
	writeFileSync(join(outDir, "results.json"), `${JSON.stringify(report, null, 2)}\n`);
	writeSha256Sums(outDir);
	process.stdout.write(
		`${report.readiness_failure ? `READINESS FAILURE: ${report.readiness_failure}` : `${report.summary.passed}/${report.summary.total} round-trips`}; ${join(outDir, "results.json")}\n`,
	);
	if (report.readiness_failure) return 2;
	return report.summary.passed === report.summary.total ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = await main(process.argv.slice(2));
}
