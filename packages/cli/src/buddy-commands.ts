import { type ChildProcess, type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { ComputerInterface, PointerOverlay } from "@opencua/core";
import type { Command } from "commander";
import {
	APP_AGENT_PREFIX,
	APP_PRESETS,
	type AppImage,
	type ConnectedApp,
	appTokenService,
	askApp,
	connectApp,
	connectedApp,
	disconnectApp,
} from "./buddy-apps.js";
import { type Phrase, languageName, phrase, replyLanguage } from "./buddy-i18n.js";
import {
	type AgentKind,
	type BuddySettings,
	type SecretStore,
	detectAgents,
	keychain,
	readBuddySettings,
	resolveAgent,
	writeBuddySettings,
} from "./buddy-settings.js";
import { BuddyStatus } from "./buddy-status.js";
import { speak, stopSpeaking } from "./buddy-voice.js";
import {
	type BuddyJob,
	type ImageGeometry,
	type Mark,
	agentJobPrompt,
	askPrompt,
	createJob,
	jobsRoot,
	listJobs,
	parseBuddyReply,
	parseHudOutput,
	parseMarkOption,
	readJob,
	routeUtterance,
	summaryOf,
	writeJob,
} from "./buddy.js";
import { daemonStatus, forwardToDaemon, stopDaemon } from "./daemon.js";
import { generateHistoryText } from "./history-agent.js";

export interface BuddyCommandDeps {
	readonly isJsonOutput: () => boolean;
	readonly stateDir: string;
	readonly entryScript: string;
	readonly withComputer: <T>(action: (computer: ComputerInterface) => Promise<T>) => Promise<T>;
	readonly overlay: () => Promise<PointerOverlay>;
	/** Where app tokens are read from; the login Keychain unless a test supplies another store. */
	readonly secrets?: SecretStore;
}

/** The connected app chosen to answer (OPENCUA_BUDDY_AGENT or settings, as app:<id>), if one is. */
export function chosenApp(settings: BuddySettings, env: NodeJS.ProcessEnv = process.env): ConnectedApp | undefined {
	const chosen = env["OPENCUA_BUDDY_AGENT"] || settings.agent;
	if (!chosen.startsWith(APP_AGENT_PREFIX)) return undefined;
	const id = chosen.slice(APP_AGENT_PREFIX.length);
	const app = connectedApp(settings, id);
	if (app === undefined) {
		const label = APP_PRESETS.find((preset) => preset.id === id)?.label ?? id;
		throw new Error(`${label} is not connected. Connect it in buddy settings, or run: opencua buddy connect ${id}`);
	}
	return app;
}

async function appToken(app: ConnectedApp, deps: BuddyCommandDeps): Promise<string> {
	const token = await (deps.secrets ?? keychain).read(appTokenService(app.id));
	if (token === undefined) {
		throw new Error(`${app.label}'s token is missing from the Keychain. Connect it again in buddy settings.`);
	}
	return token;
}

/** The agent CLI and its arguments for an ask or a job; OPENCUA_BUDDY_MODEL overrides the model in settings. */
export function buddyAgentCommand(
	kind: AgentKind,
	settings: BuddySettings,
	env: NodeJS.ProcessEnv = process.env,
	exists?: (path: string) => boolean,
	home?: string,
): { readonly executable: string; readonly args: readonly string[] } {
	const agent = resolveAgent(settings, env, exists, home);
	return { executable: agent.executable, args: agent.args(kind, env["OPENCUA_BUDDY_MODEL"] || settings.model) };
}

const LISTENING = "Listening… let go to send";
const NOT_HEARD = "Didn't catch that. Hold Control+Option while you talk, then let go.";
const ERROR_TTL_S = 6;
const DONE_TTL_S = 3;
const JOB_RESULT_TTL_S = 8;

const SOUNDS = { start: "Pop", done: "Glass", failed: "Basso", listen: "Tink" } as const;

function play(sound: keyof typeof SOUNDS, settings: BuddySettings): void {
	if (!settings.sounds || process.env["OPENCUA_BUDDY_SOUNDS"] === "off") return;
	spawn("afplay", [`/System/Library/Sounds/${SOUNDS[sound]}.aiff`], { stdio: "ignore", detached: true }).unref();
}

function hudOrUndefined(): string | undefined {
	try {
		return nativeBinary("buddy-hud");
	} catch {
		return undefined;
	}
}

function say(
	text: string,
	deps: BuddyCommandDeps,
	settings: BuddySettings = readBuddySettings(deps.stateDir),
	language?: string,
) {
	return speak(text, {
		stateDir: deps.stateDir,
		settings,
		hudBinary: hudOrUndefined(),
		language,
		onVoiceError: (message) => process.stderr.write(`buddy: ${message}\n`),
	});
}

/** One of buddy's own lines, in the language the person spoke (or the settings language). */
function sayPhrase(key: Phrase, deps: BuddyCommandDeps, spoken: string | undefined): ReturnType<typeof say> {
	const settings = readBuddySettings(deps.stateDir);
	const language = replyLanguage(spoken, settings.uiLanguage);
	return say(phrase(key, language), deps, settings, spoken ?? language);
}

async function notify(title: string, body: string): Promise<void> {
	const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`;
	await new Promise<void>((resolve) => execFile("osascript", ["-e", script], { timeout: 5_000 }, () => resolve()));
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export interface CapturedScreen {
	readonly image: {
		readonly data: Uint8Array;
		readonly mimeType: "image/png" | "image/jpeg";
		readonly width: number;
		readonly height: number;
	};
	readonly screen: { readonly width: number; readonly height: number };
}

/** Takes the question's screenshot; `scratch` is the question's private folder, deleted once it is answered. */
export type ScreenCapture = (scratch: string) => Promise<CapturedScreen>;

export interface AskOptions {
	readonly voice: boolean;
	readonly point: boolean;
	readonly marks?: readonly Mark[];
	/** The locale the question was spoken in, such as ko-KR. */
	readonly language?: string | undefined;
	/** Where the screenshot comes from; default: this process's own computer. */
	readonly capture?: ScreenCapture;
	/** Aborts the agent or app call when the person talks over buddy. */
	readonly signal?: AbortSignal;
	/** Called with the answer once it is in, before it is spoken. */
	readonly onAnswer?: (speech: string) => void;
}

/** Thrown when the warm capture process cannot be reached, so the caller can take the slower path instead. */
export class CaptureUnavailable extends Error {}

const JPEG_QUALITY = 85;
const DAEMON_START_TIMEOUT_MS = 10_000;

/**
 * Captures through the opencua daemon, a warm process inside the permitted helper: no Node start, helper relaunch or
 * cold ScreenCaptureKit session per question.
 */
export function daemonCapture(stateDir: string, env: NodeJS.ProcessEnv = process.env): ScreenCapture {
	return async (scratch) => {
		const path = join(scratch, "screen.jpg");
		const ask = async (argv: readonly string[]): Promise<Record<string, unknown>> => {
			const response = await forwardToDaemon(["--json", ...argv], { stateDir, cwd: scratch, env });
			if (response === undefined) throw new CaptureUnavailable("The opencua daemon is not answering.");
			if (response.exitCode !== 0) throw new Error(response.stderr.trim() || `opencua ${argv[0]} failed.`);
			return JSON.parse(response.stdout) as Record<string, unknown>;
		};
		const [shot, screen] = await Promise.all([
			ask(["screenshot", "-f", "jpeg", "-q", String(JPEG_QUALITY), "-o", path]),
			ask(["screen"]),
		]);
		return {
			image: {
				data: readFileSync(path),
				mimeType: shot["mimeType"] === "image/png" ? "image/png" : "image/jpeg",
				width: Number(shot["width"]),
				height: Number(shot["height"]),
			},
			screen: { width: Number(screen["width"]), height: Number(screen["height"]) },
		};
	};
}

export interface AskResult {
	readonly question: string;
	readonly answer: string;
	readonly points: readonly { readonly x: number; readonly y: number; readonly label: string }[];
}

export async function askAboutScreen(
	question: string,
	options: AskOptions,
	deps: BuddyCommandDeps,
): Promise<AskResult> {
	const overlay = options.point ? await deps.overlay() : undefined;
	overlay?.setMode("thinking");
	// The screenshot lives only for this question, like Clicky's: it is deleted as soon as the answer is in.
	const scratch = join(deps.stateDir, "buddy", "asks", `${Date.now()}-${process.pid}`);
	mkdirSync(scratch, { recursive: true, mode: 0o700 });
	try {
		const settings = readBuddySettings(deps.stateDir);
		// Resolve who answers before capturing, so a missing agent or app fails without touching the screen.
		const app = chosenApp(settings);
		const answerer = app === undefined ? { command: buddyAgentCommand("ask", settings) } : { app };
		// JPEG at screen-point size: a fraction of a Retina PNG's bytes, so it reaches the model sooner.
		const capture: ScreenCapture =
			options.capture ??
			(() =>
				deps.withComputer(async (computer) => ({
					image: await computer.screenshot({ format: "jpeg", quality: JPEG_QUALITY }),
					screen: await computer.getScreenSize(),
				})));
		const { image, screen } = await capture(scratch);
		const geometry: ImageGeometry = {
			imageWidth: image.width,
			imageHeight: image.height,
			screenWidth: screen.width,
			screenHeight: screen.height,
		};
		const context = { marks: options.marks, language: languageName(options.language) };
		let raw: string;
		if ("app" in answerer) {
			const attached: AppImage = { data: image.data, mimeType: image.mimeType };
			const prompt = askPrompt(question, geometry, context);
			raw = await askApp(answerer.app, await appToken(answerer.app, deps), prompt, attached, {
				fetch,
				...(options.signal === undefined ? {} : { signal: options.signal }),
			});
		} else {
			const screenshotPath = join(scratch, image.mimeType === "image/png" ? "screen.png" : "screen.jpg");
			if (!existsSync(screenshotPath)) writeFileSync(screenshotPath, image.data);
			raw = await generateHistoryText(askPrompt(question, geometry, { ...context, screenshotPath }), {
				...answerer.command,
				label: "Buddy answer",
				timeoutMs: 180_000,
				includeFailureDetail: true,
				...(options.signal === undefined ? {} : { signal: options.signal }),
			});
		}
		const reply = parseBuddyReply(raw, geometry);
		if (options.signal?.aborted === true) return { question, answer: "", points: [] };
		options.onAnswer?.(reply.speech);
		const pointing = (async () => {
			if (overlay === undefined) return;
			overlay.setMode("pointer");
			for (const point of reply.points) {
				overlay.set(point);
				overlay.highlight({ x: point.x - 22, y: point.y - 22, width: 44, height: 44 });
				await new Promise((resolve) => setTimeout(resolve, 1_600));
			}
		})();
		await Promise.all([
			pointing,
			options.voice ? say(reply.speech, deps, settings, options.language) : Promise.resolve(),
		]);
		return { question, answer: reply.speech, points: reply.points };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
		overlay?.close();
	}
}

/** A failed question must be heard and seen: the person is looking at their screen, not this terminal. */
async function reportAskFailure(message: string, voice: boolean, language: string | undefined, deps: BuddyCommandDeps) {
	play("failed", readBuddySettings(deps.stateDir));
	await notify("opencua buddy couldn't answer", message);
	if (voice) await sayPhrase("sorry", deps, language);
}

/**
 * Starts the opencua daemon for `buddy listen` unless one already runs, and returns how to stop it again: only a
 * daemon this call started is stopped. It runs inside the permitted helper, so it can capture the screen.
 */
export async function ensureCaptureDaemon(deps: BuddyCommandDeps): Promise<() => Promise<void>> {
	if ((await daemonStatus(deps.stateDir)) !== undefined) return async () => undefined;
	const child = spawn(process.execPath, [deps.entryScript, "daemon", "run"], { detached: true, stdio: "ignore" });
	let exited = false;
	child.once("exit", () => {
		exited = true;
	});
	child.unref();
	return async () => {
		// Quitting while the daemon is still starting must not leave it behind: wait for it to answer (or to fail to
		// start), the same way `opencua daemon start` waits, then stop it.
		const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
		while (!(await stopDaemon(deps.stateDir)) && !exited && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	};
}

// Agent jobs must never descend from the opencua-mcp helper: an agent started under it (it is their responsible
// process) fails to reach its model provider. So `buddy listen` stays a plain process and asks there, with only the
// screen capture inside the helper (the daemon). This `buddy ask` child in the helper is the fallback when the daemon
// cannot be reached.
function askInHelper(
	question: string,
	voice: boolean,
	marks: readonly Mark[],
	language: string | undefined,
	deps: BuddyCommandDeps,
	onChild: (child: ChildProcess) => void,
	interrupted: () => boolean,
): Promise<void> {
	const entryScript = deps.entryScript;
	return new Promise((resolve) => {
		const markArguments = marks.flatMap((mark) => ["--mark", `${mark.x},${mark.y},${mark.width},${mark.height}`]);
		const child = spawn(
			process.execPath,
			[
				entryScript,
				"buddy",
				"ask",
				...(voice ? [] : ["--no-voice"]),
				...(language ? ["--language", language] : []),
				...markArguments,
				"--",
				question,
			],
			{ stdio: ["ignore", "inherit", "pipe"] },
		);
		onChild(child);
		let lastError = "";
		child.stderr.on("data", (chunk: Buffer) => {
			process.stderr.write(chunk);
			lastError = `${lastError}${chunk.toString("utf8")}`.trim().split("\n").at(-1) ?? "";
		});
		const failed = async (message: string): Promise<void> => {
			if (!interrupted()) await reportAskFailure(message, voice, language, deps);
		};
		child.on("close", (code) => {
			if (code === 0) resolve();
			else void failed(lastError || `buddy ask exited with code ${code ?? "unknown"}`).then(resolve);
		});
		child.on("error", (error) => {
			void failed(error.message).then(resolve);
		});
	});
}

export function startAgentJob(task: string, deps: BuddyCommandDeps, language?: string): BuddyJob {
	const root = jobsRoot(deps.stateDir);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const job = createJob(root, task, new Date(), language);
	const child = spawn(process.execPath, [deps.entryScript, "buddy", "job-run", job.id], {
		detached: true,
		stdio: "ignore",
		cwd: join(root, job.id),
	});
	child.unref();
	const started = { ...job, ...(child.pid === undefined ? {} : { pid: child.pid }) };
	writeJob(root, started);
	play("start", readBuddySettings(deps.stateDir));
	return started;
}

async function runAgentJob(id: string, deps: BuddyCommandDeps): Promise<BuddyJob> {
	const root = jobsRoot(deps.stateDir);
	const job = { ...readJob(root, id), pid: process.pid };
	writeJob(root, job);
	const settings = readBuddySettings(deps.stateDir);
	const { defaultActivityFeed } = await import("@opencua/core/light");
	const feed = defaultActivityFeed(deps.stateDir);
	const source = `job-${id}`;
	const report = (entry: Parameters<typeof feed.write>[0]): void => {
		try {
			feed.write(entry);
		} catch {}
	};
	// The job's line stays on the pill while its process lives, so the person sees background work is going on.
	report({ source, agent: "Buddy agent", state: "working", text: job.task, pid: process.pid });
	let finished: BuddyJob;
	try {
		const app = chosenApp(settings);
		const language = languageName(job.language);
		const result =
			app === undefined
				? await generateHistoryText(agentJobPrompt(job.task, { language }), {
						...buddyAgentCommand("job", settings),
						label: "Buddy agent",
						timeoutMs: 30 * 60_000,
						cwd: join(root, id),
						includeFailureDetail: true,
					})
				: await askApp(
						app,
						await appToken(app, deps),
						agentJobPrompt(job.task, { remote: true, language }),
						undefined,
						{
							fetch,
							timeoutMs: 30 * 60_000,
						},
					);
		writeFileSync(join(root, id, "result.md"), `${result}\n`);
		finished = { ...job, status: "done", finishedAt: new Date().toISOString(), summary: summaryOf(result) };
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		finished = { ...job, status: "failed", finishedAt: new Date().toISOString(), summary: message };
	}
	writeJob(root, finished);
	report({
		source,
		agent: "Buddy agent",
		state: finished.status === "done" ? "done" : "error",
		text: `${finished.status === "done" ? "Done" : "Failed"}: ${finished.summary ?? job.task}`,
		ttl: JOB_RESULT_TTL_S,
	});
	play(finished.status === "done" ? "done" : "failed", settings);
	await notify(
		finished.status === "done" ? "opencua buddy: agent done" : "opencua buddy: agent failed",
		finished.summary ?? "",
	);
	return finished;
}

export function nativeBinary(name: "voice-input" | "buddy-hud"): string {
	const core = fileURLToPath(import.meta.resolve("@opencua/core"));
	const path = join(dirname(core), "..", "native", name);
	if (!existsSync(path)) throw new Error(`${name} is not built: ${path}. Run packages/core/native/build.sh.`);
	return path;
}

export function runHud(
	binary: string,
	mode: "listen" | "lasso",
): {
	readonly release: () => void;
	readonly result: Promise<{ readonly marks: readonly Mark[]; readonly cancelled: boolean }>;
} {
	const child: ChildProcessWithoutNullStreams = spawn(binary, [`--${mode}`]);
	const result = new Promise<{ readonly marks: readonly Mark[]; readonly cancelled: boolean }>((resolve, reject) => {
		let line: string | undefined;
		createInterface({ input: child.stdout }).on("line", (text) => {
			line = text;
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (line === undefined) reject(new Error(`buddy-hud exited with code ${code ?? "unknown"} and no result.`));
			else resolve(parseHudOutput(line));
		});
	});
	return { release: () => child.stdin.end(), result };
}

export interface Heard {
	readonly text: string;
	/** The locale voice-input heard best, such as ko-KR. */
	readonly locale: string | undefined;
}

interface VoiceMessage {
	readonly text?: string;
	readonly locale?: string;
	readonly partial?: string;
	readonly ready?: boolean;
	readonly error?: string;
	readonly message?: string;
}

function parseVoiceLine(line: string): VoiceMessage | undefined {
	try {
		const parsed: unknown = JSON.parse(line);
		return typeof parsed === "object" && parsed !== null ? (parsed as VoiceMessage) : undefined;
	} catch {
		return undefined;
	}
}

function heardFrom(message: VoiceMessage): Heard {
	return { text: message.text ?? "", locale: message.locale || undefined };
}

/** The --locale value for voice-input: the chosen dictation languages, or "auto" for the Mac's preferred ones. */
export function speechLocaleOption(settings: BuddySettings): string {
	return settings.speechLanguages.length > 0 ? settings.speechLanguages.join(",") : "auto";
}

export interface SpeechCapture {
	readonly release: () => void;
	readonly transcript: Promise<Heard>;
}

/** One question through `voice-input --mic`, which sets everything up first (about half a second). */
export function captureSpeech(binary: string, locales: string, onPartial?: (text: string) => void): SpeechCapture {
	const child: ChildProcessWithoutNullStreams = spawn(binary, ["--mic", "--locale", locales]);
	const transcript = new Promise<Heard>((resolve, reject) => {
		let heard: Heard | undefined;
		let failure: string | undefined;
		createInterface({ input: child.stdout }).on("line", (line) => {
			const message = parseVoiceLine(line);
			if (message === undefined) return;
			if (message.partial !== undefined) {
				process.stderr.write(`\r  … ${message.partial}`);
				onPartial?.(message.partial);
			}
			if (message.text !== undefined) heard = heardFrom(message);
			if (message.error !== undefined) failure = message.message ?? message.error;
		});
		child.on("error", (error) => reject(error));
		child.on("close", () => {
			process.stderr.write("\n");
			if (failure !== undefined) reject(new Error(failure));
			else resolve(heard ?? { text: "", locale: undefined });
		});
	});
	return { release: () => child.stdin.end(), transcript };
}

const MAX_SERVER_RESTARTS = 5;

export interface VoiceServerHooks {
	readonly onReady?: () => void;
	/** The words heard so far while the person is still talking. */
	readonly onPartial?: (text: string) => void;
	readonly onProblem?: (message: string) => void;
}

/**
 * Keeps `voice-input --serve` running between questions, so a press starts listening in about a tenth of a second
 * instead of half a second, and the first words are not lost. When the server is not ready (still starting, crashed,
 * restarting) a press falls back to a one-shot capture; a crashed server restarts, up to a limit.
 */
export class VoiceServer {
	private child: ChildProcessWithoutNullStreams | undefined;
	private ready = false;
	private stopped = false;
	private restarts = 0;
	private pending: { resolve: (heard: Heard) => void; reject: (error: Error) => void } | undefined;

	private readonly binary: string;
	private locales: string;
	private readonly hooks: VoiceServerHooks;

	// Plain fields, not parameter properties: the CLI also runs from source under Node's strip-only TypeScript.
	constructor(binary: string, locales: string, hooks: VoiceServerHooks = {}) {
		this.binary = binary;
		this.locales = locales;
		this.hooks = hooks;
	}

	private problem(message: string): void {
		if (this.hooks.onProblem === undefined) process.stderr.write(`buddy: ${message}\n`);
		else this.hooks.onProblem(message);
	}

	start(): void {
		this.stopped = false;
		const child = spawn(this.binary, ["--serve", "--locale", this.locales]);
		this.child = child;
		this.ready = false;
		createInterface({ input: child.stdout }).on("line", (line) => {
			const message = parseVoiceLine(line);
			if (message === undefined || this.child !== child) return;
			if (message.ready === true) {
				this.ready = true;
				this.hooks.onReady?.();
			}
			if (message.partial !== undefined) {
				process.stderr.write(`\r  … ${message.partial}`);
				this.hooks.onPartial?.(message.partial);
			}
			if (message.text !== undefined) {
				process.stderr.write("\n");
				this.restarts = 0;
				this.settle((pending) => pending.resolve(heardFrom(message)));
			}
			if (message.error !== undefined) {
				const error = new Error(message.message ?? message.error);
				this.settle((pending) => pending.reject(error));
				this.problem(error.message);
			}
		});
		child.on("error", (error) => this.problem(`voice-input could not start: ${error.message}`));
		child.on("close", (code) => {
			if (this.child !== child) return;
			this.child = undefined;
			this.ready = false;
			this.settle((pending) => pending.reject(new Error(`voice-input stopped (code ${code ?? "unknown"}).`)));
			if (this.stopped) return;
			if (this.restarts >= MAX_SERVER_RESTARTS) {
				this.problem("voice-input keeps stopping; each question now starts it fresh.");
				return;
			}
			this.restarts += 1;
			this.start();
		});
	}

	get isReady(): boolean {
		return this.ready && this.child !== undefined && this.pending === undefined;
	}

	/** Restarts with other dictation languages when settings changed since the last question. */
	useLocales(locales: string): void {
		if (locales === this.locales) return;
		this.locales = locales;
		if (this.child === undefined) return;
		this.shutdown();
		this.start();
	}

	capture(): SpeechCapture {
		const child = this.child;
		if (child === undefined || !this.isReady) return captureSpeech(this.binary, this.locales, this.hooks.onPartial);
		const transcript = new Promise<Heard>((resolve, reject) => {
			this.pending = { resolve, reject };
		});
		child.stdin.write("start\n");
		return { release: () => child.stdin.write("stop\n"), transcript };
	}

	stop(): void {
		this.stopped = true;
		this.shutdown();
	}

	private shutdown(): void {
		const child = this.child;
		this.child = undefined;
		this.ready = false;
		this.settle((pending) => pending.reject(new Error("voice-input was restarted.")));
		child?.stdin.end();
	}

	private settle(
		action: (pending: { resolve: (heard: Heard) => void; reject: (error: Error) => void }) => void,
	): void {
		const pending = this.pending;
		this.pending = undefined;
		if (pending !== undefined) action(pending);
	}
}

export function registerBuddyCommands(program: Command, deps: BuddyCommandDeps): void {
	const buddy = program
		.command("buddy")
		.description(
			"A screen buddy: ask about your screen by voice, get pointed at the spot, or start background agents",
		);

	const emit = (value: unknown, text: string): void => {
		process.stdout.write(deps.isJsonOutput() ? `${JSON.stringify(value)}\n` : `${text}\n`);
	};

	buddy
		.command("ask")
		.description("Ask about what is on screen; the answer is spoken and the cursor points at what it names")
		.argument("<question...>", "the question")
		.option("--no-voice", "print the answer without speaking it")
		.option("--no-point", "do not move the opencua cursor overlay")
		.option("--lasso", "first circle (drag) or box (Shift-drag) what the question is about")
		.option("--language <locale>", "the locale the question is in, such as ko-KR; the answer comes back in it")
		.option(
			"--mark <x,y,width,height>",
			"an area the question is about, in screen points (repeatable)",
			(value: string, previous: readonly Mark[]) => [...previous, parseMarkOption(value)],
			[] as readonly Mark[],
		)
		.action(
			async (
				words: readonly string[],
				command: {
					readonly voice: boolean;
					readonly point: boolean;
					readonly lasso?: boolean;
					readonly mark: readonly Mark[];
					readonly language?: string;
				},
			) => {
				let marks = command.mark;
				if (command.lasso === true) {
					const drawn = await runHud(nativeBinary("buddy-hud"), "lasso").result;
					if (drawn.cancelled) {
						emit({ cancelled: true }, "Cancelled.");
						return;
					}
					marks = [...marks, ...drawn.marks];
				}
				const result = await askAboutScreen(words.join(" "), { ...command, marks }, deps);
				const where = result.points
					.map((point) => `  → ${point.label || "here"} (${point.x}, ${point.y})`)
					.join("\n");
				emit({ ...result, marks }, where.length === 0 ? result.answer : `${result.answer}\n${where}`);
			},
		);

	buddy
		.command("agent")
		.description("Hand a task to a background agent; you get a sound and a notification when it is done")
		.argument("<task...>", "what the agent should do")
		.action((words: readonly string[]) => {
			const job = startAgentJob(words.join(" "), deps);
			emit(job, `Agent ${job.id} started. Check on it with: opencua buddy jobs`);
		});

	buddy
		.command("jobs")
		.description("List background agent jobs, or show one job's result")
		.argument("[id]", "job id")
		.action((id: string | undefined) => {
			const root = jobsRoot(deps.stateDir);
			if (id !== undefined) {
				const job = readJob(root, id);
				emit(
					{ ...job, folder: join(root, id) },
					`${job.status}: ${job.task}\n${job.summary ?? ""}\n${join(root, id)}`,
				);
				return;
			}
			const jobs = listJobs(root, isAlive);
			emit(
				{ jobs },
				jobs.length === 0
					? "No agent jobs yet."
					: jobs.map((job) => `${job.id}  ${job.status.padEnd(7)}  ${job.task}`).join("\n"),
			);
		});

	buddy
		.command("job-run", { hidden: true })
		.argument("<id>", "job id")
		.action(async (id: string) => {
			const job = await runAgentJob(id, deps);
			emit(job, `${job.status}: ${job.summary ?? ""}`);
		});

	buddy
		.command("stop")
		.description("Stop what buddy is saying right now")
		.action(() => {
			const stopped = stopSpeaking(deps.stateDir);
			emit({ stopped }, stopped ? "Stopped." : "Buddy was not speaking.");
		});

	buddy
		.command("agents")
		.description("List the agent CLIs buddy can use, and the one it uses now")
		.action(() => {
			const agents = detectAgents();
			let active: string | undefined;
			try {
				active = resolveAgent(readBuddySettings(deps.stateDir)).executable;
			} catch {
				active = undefined;
			}
			emit(
				{ agents: agents.map(({ id, label, executable }) => ({ id, label, executable })), active },
				agents.length === 0
					? "No agent CLI found."
					: agents
							.map(
								(agent) =>
									`${agent.executable === active ? "*" : " "} ${agent.label.padEnd(14)} ${agent.executable}`,
							)
							.join("\n"),
			);
		});

	buddy
		.command("settings")
		.description(
			"Open buddy's settings page: languages, agent or connected app, model, voice (ElevenLabs or Mac), captions, sounds",
		)
		.option("--no-open", "print the address instead of opening it")
		.action(async (command: { readonly open: boolean }) => {
			const { startBuddySettingsUi } = await import("./buddy-settings-ui.js");
			const ui = await startBuddySettingsUi({ stateDir: deps.stateDir, hudBinary: hudOrUndefined() });
			emit({ url: ui.url }, `Buddy settings: ${ui.url}`);
			if (command.open) spawn("open", [ui.url], { stdio: "ignore" });
			await ui.closed;
		});

	buddy
		.command("listen")
		.description('Hold Control+Option to talk: ask about the screen, or say "agent ..." to start a background agent')
		.option(
			"--locale <ids>",
			"dictation locales, comma-separated (such as ko-KR,en-US), or auto (default: buddy settings, else the Mac's preferred languages)",
		)
		.option("--no-voice", "print answers without speaking them")
		.action(async (command: { readonly locale?: string; readonly voice: boolean }) => {
			const { StopChordDetector, TALK_CHORD_FORBIDDEN_MASK, TALK_CHORD_MASK, readHidModifierFlags } = await import(
				"@opencua/core"
			);
			const locales = (): string => command.locale ?? speechLocaleOption(readBuddySettings(deps.stateDir));
			const { defaultActivityFeed } = await import("@opencua/core/light");
			const hud = new BuddyStatus(defaultActivityFeed(deps.stateDir));
			const voiceServer = new VoiceServer(nativeBinary("voice-input"), locales(), {
				onPartial: (text) => {
					const state = hud.current.state;
					if (state === "listening" || state === "hearing") hud.set({ state: "hearing", text });
				},
			});
			voiceServer.start();
			const stopCaptureDaemon = await ensureCaptureDaemon(deps);
			const screenCapture = daemonCapture(deps.stateDir);
			let asking: ChildProcess | undefined;
			let askAbort: AbortController | undefined;
			let interrupted = false;
			const hudBinary = nativeBinary("buddy-hud");
			let capture: { readonly speech: SpeechCapture; hud: ReturnType<typeof runHud> | undefined } | undefined;
			let busy = false;
			const startListening = (): void => {
				if (capture !== undefined) return;
				voiceServer.useLocales(locales());
				capture = { speech: voiceServer.capture(), hud: undefined };
			};
			// The question runs here, with the screenshot from the warm daemon; only when the daemon cannot be reached
			// does it fall back to a `buddy ask` child inside the helper (slower: a fresh Node and capture session).
			const ask = async (question: string, marks: readonly Mark[], language: string | undefined): Promise<void> => {
				const abort = new AbortController();
				askAbort = abort;
				try {
					await askAboutScreen(
						question,
						{
							voice: command.voice,
							point: true,
							marks,
							language,
							capture: screenCapture,
							signal: abort.signal,
							onAnswer: (speech) => hud.set({ state: "speaking", text: speech }),
						},
						deps,
					);
					if (!abort.signal.aborted) hud.set({ state: "idle" });
				} catch (error: unknown) {
					if (error instanceof CaptureUnavailable) {
						hud.set({ state: "thinking", text: question });
						await askInHelper(
							question,
							command.voice,
							marks,
							language,
							deps,
							(child) => {
								asking = child;
							},
							() => interrupted,
						);
						if (!interrupted) hud.set({ state: "idle" });
						return;
					}
					if (!abort.signal.aborted) {
						const message = error instanceof Error ? error.message : String(error);
						process.stderr.write(`buddy: ${message}\n`);
						hud.set({ state: "error", text: `Couldn't answer: ${message}`, ttl: ERROR_TTL_S });
						await reportAskFailure(message, command.voice, language, deps);
					}
				} finally {
					askAbort = undefined;
					asking = undefined;
				}
			};
			const handle = async (heard: Heard, marks: readonly Mark[]): Promise<void> => {
				const utterance = routeUtterance(heard.text);
				if (utterance === undefined) {
					// Nothing heard used to end here in silence, which looked exactly like buddy being broken.
					hud.set({ state: "error", text: NOT_HEARD, ttl: ERROR_TTL_S });
					return;
				}
				process.stdout.write(`you${heard.locale ? ` (${heard.locale})` : ""}: ${heard.text}\n`);
				if (utterance.kind === "agent") {
					const job = startAgentJob(utterance.task, deps, heard.locale);
					process.stdout.write(`buddy: started agent ${job.id}\n`);
					hud.set({ state: "done", text: `Agent started: ${utterance.task}`, ttl: DONE_TTL_S });
					if (command.voice) await sayPhrase("onIt", deps, heard.locale);
					return;
				}
				interrupted = false;
				hud.set({ state: "thinking", text: utterance.question });
				await ask(utterance.question, marks, heard.locale);
			};
			const detector = new StopChordDetector({
				readFlags: readHidModifierFlags,
				mask: TALK_CHORD_MASK,
				forbiddenMask: TALK_CHORD_FORBIDDEN_MASK,
				// Sampled every 25 ms; a press counts after 6 samples (~150 ms) so quick Control+Option shortcuts do not.
				intervalMs: 25,
				requiredSamples: 6,
				// The microphone opens on the first sample, so words said during that confirmation are not lost.
				onEngage: startListening,
				onAbandon: () => {
					const current = capture;
					capture = undefined;
					current?.speech.release();
					current?.speech.transcript.catch(() => undefined);
				},
				onChord: () => {
					// Talking over buddy stops it: the answer being spoken (or still being worked out) is dropped.
					if (busy) {
						interrupted = true;
						stopSpeaking(deps.stateDir);
						askAbort?.abort();
						asking?.kill("SIGTERM");
					}
					startListening();
					if (capture === undefined || capture.hud !== undefined) return;
					hud.set({ state: "listening", text: LISTENING });
					play("listen", readBuddySettings(deps.stateDir));
					capture.hud = runHud(hudBinary, "listen");
				},
				onRelease: () => {
					const current = capture;
					capture = undefined;
					if (current === undefined) return;
					busy = true;
					hud.set({ state: "thinking", text: hud.current.state === "hearing" ? (hud.current.text ?? "") : "" });
					current.speech.release();
					current.hud?.release();
					const drawn = current.hud?.result ?? Promise.resolve({ marks: [] as readonly Mark[], cancelled: false });
					// The HUD is gone before the question's screenshot is taken, so its strokes never cover the screen.
					Promise.all([current.speech.transcript, drawn])
						.then(([heard, drawn]) => handle(heard, drawn.marks))
						.catch((error: unknown) => {
							const message = error instanceof Error ? error.message : String(error);
							process.stderr.write(`buddy: ${message}\n`);
							hud.set({ state: "error", text: message, ttl: ERROR_TTL_S });
						})
						.finally(() => {
							busy = false;
						});
				},
			});
			detector.start();
			process.stdout.write(
				'Hold Control+Option and talk; let go to send. Hold it again to stop buddy talking. Say "agent ..." for a background task. Ctrl+C quits.\n',
			);
			// The chord poller's timer is unref'd, so without this the process would exit at once when no terminal is attached.
			const keepAlive = setInterval(() => undefined, 2 ** 30);
			await new Promise<void>((resolve) => {
				process.once("SIGINT", resolve);
				process.once("SIGTERM", resolve);
			});
			clearInterval(keepAlive);
			detector.stop();
			voiceServer.stop();
			hud.close();
			await stopCaptureDaemon();
		});

	buddy
		.command("apps")
		.description(
			"List the apps buddy can connect to (Muse, Dots, Grok, OpenClaw, Hermes, Bop) and which are connected",
		)
		.action(() => {
			const settings = readBuddySettings(deps.stateDir);
			const apps = APP_PRESETS.map((preset) => ({
				id: preset.id,
				label: preset.label,
				connected: settings.apps[preset.id] !== undefined,
				baseUrl: settings.apps[preset.id]?.baseUrl ?? preset.baseUrl,
				model: settings.apps[preset.id]?.model ?? preset.model,
				setup: preset.setup,
			}));
			emit(
				{ apps, active: settings.agent },
				apps
					.map(
						(app) =>
							`${settings.agent === `${APP_AGENT_PREFIX}${app.id}` ? "*" : " "} ${app.id.padEnd(9)} ${(app.connected ? "connected" : "-").padEnd(10)} ${app.label}${app.connected ? `  ${app.baseUrl} (${app.model})` : `\n             ${app.setup}`}`,
					)
					.join("\n"),
			);
		});

	buddy
		.command("connect")
		.description("Connect an app once: its token is checked, kept in the Keychain, and never asked for again")
		.argument("<app>", `one of: ${APP_PRESETS.map((preset) => preset.id).join(", ")}`)
		.option("--url <address>", "the app's OpenAI-compatible address (needed for Dots and Bop)")
		.option("--model <id>", "the model or agent id the app expects")
		.option("--use", "also make it the one that answers")
		.action(
			async (id: string, command: { readonly url?: string; readonly model?: string; readonly use?: boolean }) => {
				// The token comes on stdin, never as an argument, so it stays out of shell history and process lists.
				const token = process.stdin.isTTY ? "" : (await readStdin()).trim();
				const app = await connectApp(
					deps.stateDir,
					id,
					{ token, baseUrl: command.url, model: command.model },
					keychain,
					{ fetch },
				);
				if (command.use === true) {
					writeBuddySettings(deps.stateDir, {
						...readBuddySettings(deps.stateDir),
						agent: `${APP_AGENT_PREFIX}${id}`,
					});
				}
				emit(
					{ connected: app.id, baseUrl: app.baseUrl, model: app.model, active: command.use === true },
					`${app.label} is connected (${app.baseUrl}, ${app.model}).${command.use === true ? " Buddy answers with it now." : ` Use it with: opencua buddy connect ${id} --use, or pick it in buddy settings.`}`,
				);
			},
		);

	buddy
		.command("disconnect")
		.description("Disconnect an app and delete its token from the Keychain")
		.argument("<app>", "the app id")
		.action(async (id: string) => {
			await disconnectApp(deps.stateDir, id, keychain);
			emit({ disconnected: id }, `Disconnected ${id}.`);
		});
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}
