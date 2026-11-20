import { type ChildProcess, type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { ComputerInterface, PointerOverlay } from "@opencua/core";
import type { Command } from "commander";
import { type AgentKind, type BuddySettings, detectAgents, readBuddySettings, resolveAgent } from "./buddy-settings.js";
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
	pngSize,
	readJob,
	routeUtterance,
	summaryOf,
	writeJob,
} from "./buddy.js";
import { generateHistoryText } from "./history-agent.js";

export interface BuddyCommandDeps {
	readonly isJsonOutput: () => boolean;
	readonly stateDir: string;
	readonly entryScript: string;
	readonly withComputer: <T>(action: (computer: ComputerInterface) => Promise<T>) => Promise<T>;
	readonly overlay: () => Promise<PointerOverlay>;
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

function say(text: string, deps: BuddyCommandDeps, settings: BuddySettings = readBuddySettings(deps.stateDir)) {
	return speak(text, {
		stateDir: deps.stateDir,
		settings,
		hudBinary: hudOrUndefined(),
		onVoiceError: (message) => process.stderr.write(`buddy: ${message}\n`),
	});
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

export interface AskOptions {
	readonly voice: boolean;
	readonly point: boolean;
	readonly marks?: readonly Mark[];
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
		const { image, screen } = await deps.withComputer(async (computer) => ({
			image: await computer.screenshot({ format: "png" }),
			screen: await computer.getScreenSize(),
		}));
		const screenshotPath = join(scratch, "screen.png");
		writeFileSync(screenshotPath, image.data);
		const size = pngSize(image.data);
		const geometry: ImageGeometry = {
			imageWidth: size.width,
			imageHeight: size.height,
			screenWidth: screen.width,
			screenHeight: screen.height,
		};
		const settings = readBuddySettings(deps.stateDir);
		const command = buddyAgentCommand("ask", settings);
		const raw = await generateHistoryText(askPrompt(question, screenshotPath, geometry, options.marks), {
			executable: command.executable,
			args: command.args,
			label: "Buddy answer",
			timeoutMs: 180_000,
			includeFailureDetail: true,
		});
		const reply = parseBuddyReply(raw, geometry);
		const pointing = (async () => {
			if (overlay === undefined) return;
			overlay.setMode("pointer");
			for (const point of reply.points) {
				overlay.set(point);
				overlay.highlight({ x: point.x - 22, y: point.y - 22, width: 44, height: 44 });
				await new Promise((resolve) => setTimeout(resolve, 1_600));
			}
		})();
		await Promise.all([pointing, options.voice ? say(reply.speech, deps, settings) : Promise.resolve()]);
		return { question, answer: reply.speech, points: reply.points };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
		overlay?.close();
	}
}

// Agent jobs must never descend from the opencua-mcp helper: an agent started under it (it is their responsible
// process) fails to reach its model provider. So `buddy listen` stays a plain process and only the screen capture of
// each question runs in the helper, as a `buddy ask` child; jobs are spawned from the plain process.
function askInHelper(
	question: string,
	voice: boolean,
	marks: readonly Mark[],
	deps: BuddyCommandDeps,
	onChild: (child: ChildProcess) => void,
	interrupted: () => boolean,
): Promise<void> {
	const entryScript = deps.entryScript;
	return new Promise((resolve) => {
		const markArguments = marks.flatMap((mark) => ["--mark", `${mark.x},${mark.y},${mark.width},${mark.height}`]);
		const child = spawn(
			process.execPath,
			[entryScript, "buddy", "ask", ...(voice ? [] : ["--no-voice"]), ...markArguments, "--", question],
			{ stdio: ["ignore", "inherit", "pipe"] },
		);
		onChild(child);
		let lastError = "";
		child.stderr.on("data", (chunk: Buffer) => {
			process.stderr.write(chunk);
			lastError = `${lastError}${chunk.toString("utf8")}`.trim().split("\n").at(-1) ?? "";
		});
		const failed = async (message: string): Promise<void> => {
			// The person is looking at their screen, not this terminal: a failure must be heard and seen.
			if (interrupted()) return;
			play("failed", readBuddySettings(deps.stateDir));
			await notify("opencua buddy couldn't answer", message);
			if (voice) await say("Sorry, I couldn't answer that. The notification says why.", deps);
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

export function startAgentJob(task: string, deps: BuddyCommandDeps): BuddyJob {
	const root = jobsRoot(deps.stateDir);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const job = createJob(root, task);
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
	const command = buddyAgentCommand("job", settings);
	let finished: BuddyJob;
	try {
		const result = await generateHistoryText(agentJobPrompt(job.task), {
			executable: command.executable,
			args: command.args,
			label: "Buddy agent",
			timeoutMs: 30 * 60_000,
			cwd: join(root, id),
			includeFailureDetail: true,
		});
		writeFileSync(join(root, id, "result.md"), `${result}\n`);
		finished = { ...job, status: "done", finishedAt: new Date().toISOString(), summary: summaryOf(result) };
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		finished = { ...job, status: "failed", finishedAt: new Date().toISOString(), summary: message };
	}
	writeJob(root, finished);
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

export function captureSpeech(
	binary: string,
	locale: string | undefined,
): {
	readonly release: () => void;
	readonly transcript: Promise<string>;
} {
	const child: ChildProcessWithoutNullStreams = spawn(binary, ["--mic", ...(locale ? ["--locale", locale] : [])]);
	const transcript = new Promise<string>((resolve, reject) => {
		let text: string | undefined;
		let failure: string | undefined;
		createInterface({ input: child.stdout }).on("line", (line) => {
			let message: { text?: string; partial?: string; error?: string; message?: string };
			try {
				message = JSON.parse(line) as typeof message;
			} catch {
				return;
			}
			if (message.partial !== undefined) process.stderr.write(`\r  … ${message.partial}`);
			if (message.text !== undefined) text = message.text;
			if (message.error !== undefined) failure = message.message ?? message.error;
		});
		child.on("error", (error) => reject(error));
		child.on("close", () => {
			process.stderr.write("\n");
			if (failure !== undefined) reject(new Error(failure));
			else resolve(text ?? "");
		});
	});
	return { release: () => child.stdin.end(), transcript };
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
		.description("Open buddy's settings page: agent, model, voice (ElevenLabs or Mac), captions, sounds, language")
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
		.option("--locale <id>", "speech locale such as en-US or ko-KR (default: the system language)")
		.option("--no-voice", "print answers without speaking them")
		.action(async (command: { readonly locale?: string; readonly voice: boolean }) => {
			const { StopChordDetector, TALK_CHORD_FORBIDDEN_MASK, TALK_CHORD_MASK, readHidModifierFlags } = await import(
				"@opencua/core"
			);
			const binary = nativeBinary("voice-input");
			const locale = command.locale ?? (readBuddySettings(deps.stateDir).locale || undefined);
			let asking: ChildProcess | undefined;
			let interrupted = false;
			const hudBinary = nativeBinary("buddy-hud");
			let capture:
				| { readonly speech: ReturnType<typeof captureSpeech>; readonly hud: ReturnType<typeof runHud> }
				| undefined;
			let busy = false;
			const handle = async (text: string, marks: readonly Mark[]): Promise<void> => {
				const utterance = routeUtterance(text);
				if (utterance === undefined) return;
				process.stdout.write(`you: ${text}\n`);
				if (utterance.kind === "agent") {
					const job = startAgentJob(utterance.task, deps);
					process.stdout.write(`buddy: started agent ${job.id}\n`);
					if (command.voice) await say("On it. I'll let you know when it's done.", deps);
					return;
				}
				interrupted = false;
				await askInHelper(
					utterance.question,
					command.voice,
					marks,
					deps,
					(child) => {
						asking = child;
					},
					() => interrupted,
				);
				asking = undefined;
			};
			const detector = new StopChordDetector({
				readFlags: readHidModifierFlags,
				mask: TALK_CHORD_MASK,
				forbiddenMask: TALK_CHORD_FORBIDDEN_MASK,
				onChord: () => {
					// Talking over buddy stops it: the answer being spoken (or still being worked out) is dropped.
					if (busy) {
						interrupted = true;
						stopSpeaking(deps.stateDir);
						asking?.kill("SIGTERM");
					}
					if (capture !== undefined) return;
					play("listen", readBuddySettings(deps.stateDir));
					capture = { speech: captureSpeech(binary, locale), hud: runHud(hudBinary, "listen") };
				},
				onRelease: () => {
					const current = capture;
					capture = undefined;
					if (current === undefined) return;
					busy = true;
					current.speech.release();
					current.hud.release();
					// The HUD is gone before the question's screenshot is taken, so its strokes never cover the screen.
					Promise.all([current.speech.transcript, current.hud.result])
						.then(([text, drawn]) => handle(text, drawn.marks))
						.catch((error: unknown) => {
							process.stderr.write(`buddy: ${error instanceof Error ? error.message : String(error)}\n`);
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
		});
}
