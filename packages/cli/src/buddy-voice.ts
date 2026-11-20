import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BuddySettings, readElevenLabsKey } from "./buddy-settings.js";

const ELEVENLABS_API = "https://api.elevenlabs.io/v1";

export function speakingPidPath(stateDir: string): string {
	return join(stateDir, "buddy", "speaking.pid");
}

export function captionPositionPath(stateDir: string): string {
	return join(stateDir, "buddy", "caption-position.json");
}

/** Stops whatever buddy is saying right now, from any process. Returns whether something was speaking. */
export function stopSpeaking(
	stateDir: string,
	kill: (pid: number) => void = (pid) => process.kill(pid, "SIGTERM"),
): boolean {
	const path = speakingPidPath(stateDir);
	let pid: number;
	try {
		pid = Number.parseInt(readFileSync(path, "utf8"), 10);
	} catch {
		return false;
	}
	try {
		unlinkSync(path);
	} catch {
		// Another stop removed it first.
	}
	if (!Number.isSafeInteger(pid) || pid <= 1) return false;
	try {
		kill(pid);
		return true;
	} catch {
		return false;
	}
}

export async function elevenLabsSpeech(
	text: string,
	settings: Pick<BuddySettings, "elevenLabsVoiceId" | "elevenLabsModel">,
	key: string,
	fetchImpl: typeof fetch = fetch,
	signal?: AbortSignal,
): Promise<Uint8Array> {
	const response = await fetchImpl(
		`${ELEVENLABS_API}/text-to-speech/${encodeURIComponent(settings.elevenLabsVoiceId)}?output_format=mp3_44100_128`,
		{
			method: "POST",
			headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
			body: JSON.stringify({ text, model_id: settings.elevenLabsModel }),
			...(signal === undefined ? {} : { signal }),
		},
	);
	if (!response.ok) {
		const detail = (await response.text()).slice(0, 200);
		throw new Error(`ElevenLabs answered ${response.status}: ${detail}`);
	}
	return new Uint8Array(await response.arrayBuffer());
}

export interface ElevenLabsVoice {
	readonly id: string;
	readonly name: string;
}

export async function elevenLabsVoices(
	key: string,
	fetchImpl: typeof fetch = fetch,
): Promise<readonly ElevenLabsVoice[]> {
	const response = await fetchImpl(`${ELEVENLABS_API}/voices`, { headers: { "xi-api-key": key } });
	if (!response.ok) throw new Error(`ElevenLabs answered ${response.status}`);
	const body = (await response.json()) as { voices?: { voice_id?: unknown; name?: unknown }[] };
	return (body.voices ?? []).flatMap((voice) =>
		typeof voice.voice_id === "string" && typeof voice.name === "string"
			? [{ id: voice.voice_id, name: voice.name }]
			: [],
	);
}

export interface SpeakOptions {
	readonly stateDir: string;
	readonly settings: BuddySettings;
	readonly hudBinary?: string | undefined;
	readonly onVoiceError?: (message: string) => void;
}

function waitForExit(child: ChildProcess): Promise<void> {
	return new Promise((resolve) => {
		if (child.exitCode !== null || child.signalCode !== null) resolve();
		else {
			child.once("close", () => resolve());
			child.once("error", () => resolve());
		}
	});
}

/**
 * Says `text` in the chosen voice while a caption bubble shows the words. It ends when the speech ends, when the
 * person presses the bubble's stop button, or when `stopSpeaking` (menu, hotkey, `buddy stop`) signals this process.
 */
export async function speak(text: string, options: SpeakOptions): Promise<"finished" | "stopped"> {
	const { settings, stateDir } = options;
	if (text.length === 0 || (!settings.speak && !settings.captions)) return "finished";
	mkdirSync(join(stateDir, "buddy"), { recursive: true, mode: 0o700 });
	const pidPath = speakingPidPath(stateDir);
	writeFileSync(pidPath, String(process.pid));
	const scratch = mkdtempSync(join(tmpdir(), "opencua-buddy-voice-"));
	const abort = new AbortController();
	let player: ChildProcess | undefined;
	let stopped = false;
	let resolveStop: () => void = () => undefined;
	const stopRequested = new Promise<void>((resolve) => {
		resolveStop = resolve;
	});
	const stop = (): void => {
		stopped = true;
		abort.abort();
		player?.kill("SIGTERM");
		resolveStop();
	};
	process.once("SIGTERM", stop);

	let caption: ChildProcess | undefined;
	if (settings.captions && options.hudBinary !== undefined && existsSync(options.hudBinary)) {
		caption = spawn(options.hudBinary, ["--caption", "--position-file", captionPositionPath(stateDir)], {
			stdio: ["pipe", "pipe", "ignore"],
		});
		caption.stdin?.write(`${text.replace(/\s+/g, " ")}\n`);
		caption.stdout?.on("data", (chunk: Buffer) => {
			if (chunk.toString("utf8").includes('"stopped":true')) stop();
		});
	}

	try {
		const voiced = (async (): Promise<void> => {
			if (!settings.speak) {
				// Captions only: leave the words up long enough to read (about 3 words a second, at least 4 s).
				await Promise.race([
					new Promise((resolve) => setTimeout(resolve, Math.max(4_000, (text.split(/\s+/).length / 3) * 1_000))),
					stopRequested,
				]);
				return;
			}
			if (settings.voiceProvider === "elevenlabs") {
				const key = await readElevenLabsKey();
				try {
					if (key === undefined) throw new Error("No ElevenLabs API key is saved; add one in buddy settings.");
					const audio = await elevenLabsSpeech(text, settings, key, fetch, abort.signal);
					if (stopped) return;
					const file = join(scratch, "speech.mp3");
					writeFileSync(file, audio);
					player = spawn("afplay", [file], { stdio: "ignore" });
					await waitForExit(player);
					return;
				} catch (error: unknown) {
					if (stopped) return;
					options.onVoiceError?.(`${error instanceof Error ? error.message : String(error)} Using the Mac voice.`);
				}
			}
			player = spawn("say", [...(settings.systemVoice ? ["-v", settings.systemVoice] : []), text], {
				stdio: "ignore",
			});
			await waitForExit(player);
		})();
		await Promise.race([voiced, stopRequested]);
	} finally {
		process.removeListener("SIGTERM", stop);
		player?.kill("SIGTERM");
		caption?.stdin?.end();
		if (caption !== undefined) await waitForExit(caption);
		rmSync(scratch, { recursive: true, force: true });
		try {
			if (readFileSync(pidPath, "utf8") === String(process.pid)) unlinkSync(pidPath);
		} catch {
			// Already removed by a stop.
		}
	}
	return stopped ? "stopped" : "finished";
}
