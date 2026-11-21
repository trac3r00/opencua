import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VoiceServer, speechLocaleOption } from "./buddy-commands.js";
import { replyLanguage, uiLanguageOf } from "./buddy-i18n.js";
import { DEFAULT_BUDDY_SETTINGS } from "./buddy-settings.js";

// A stand-in for the native voice-input that speaks its JSON-lines protocol without a microphone. It logs each
// launch, and with CRASH set it exits on the first "start" of its first launch, like a crashed recognizer.
const FAKE_VOICE_INPUT = `#!/usr/bin/env bun
const args = process.argv.slice(2);
const log = process.env.FAKE_LOG;
const locale = args[args.indexOf("--locale") + 1];
const { appendFileSync, existsSync } = await import("node:fs");
const first = !existsSync(log);
appendFileSync(log, args.join(" ") + "\\n");
const say = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const heard = { text: "hello from " + locale, locale: locale.split(",").at(-1) };
if (args.includes("--mic")) {
	say({ ready: true, locales: [locale] });
	say({ listening: true });
	for await (const _ of process.stdin) {}
	say(heard);
	process.exit(0);
}
say({ ready: true, locales: locale.split(",") });
let buffered = "";
for await (const chunk of process.stdin) {
	buffered += chunk.toString();
	let index;
	while ((index = buffered.indexOf("\\n")) >= 0) {
		const line = buffered.slice(0, index);
		buffered = buffered.slice(index + 1);
		if (line === "start") {
			if (process.env.CRASH === "1" && first) process.exit(3);
			say({ listening: true });
		}
		if (line === "stop") say(heard);
	}
}
`;

const roots: string[] = [];
const servers: VoiceServer[] = [];
afterEach(() => {
	for (const server of servers.splice(0)) server.stop();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fake(crash = false): { readonly binary: string; readonly launches: () => string[] } {
	const root = mkdtempSync(join(tmpdir(), "buddy-voice-"));
	roots.push(root);
	const binary = join(root, "voice-input");
	writeFileSync(binary, FAKE_VOICE_INPUT);
	chmodSync(binary, 0o755);
	process.env["FAKE_LOG"] = join(root, "launches.log");
	process.env["CRASH"] = crash ? "1" : "0";
	return {
		binary,
		launches: () => {
			try {
				return readFileSync(join(root, "launches.log"), "utf8").trim().split("\n");
			} catch {
				return [];
			}
		},
	};
}

function server(binary: string, locales: string, problems: string[] = []) {
	let readyCount = 0;
	const waiters: (() => void)[] = [];
	const voice = new VoiceServer(binary, locales, {
		onReady: () => {
			readyCount += 1;
			for (const resolve of waiters.splice(0)) resolve();
		},
		onProblem: (message) => problems.push(message),
	});
	servers.push(voice);
	// Resolves on the next ready event after the call, with a bound so a broken server fails the test, not hangs it.
	const nextReady = () =>
		Promise.race([
			new Promise<void>((resolve) => waiters.push(resolve)),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("voice-input never became ready")), 5_000),
			),
		]);
	return { voice, nextReady, readyCount: () => readyCount };
}

describe("dictation languages #given buddy settings", () => {
	it("#when none are chosen #then voice-input is told auto; chosen ones go comma-separated", () => {
		expect(speechLocaleOption(DEFAULT_BUDDY_SETTINGS)).toBe("auto");
		expect(speechLocaleOption({ ...DEFAULT_BUDDY_SETTINGS, speechLanguages: ["ko-KR", "en-US"] })).toBe(
			"ko-KR,en-US",
		);
	});

	it("#when buddy picks its own words #then the spoken language wins, then settings, then the Mac, then English", () => {
		expect(replyLanguage("ko-KR", "de", "en-US")).toBe("ko");
		expect(replyLanguage("it-IT", "de", "en-US")).toBe("de");
		expect(replyLanguage(undefined, "", "ja-JP")).toBe("ja");
		expect(replyLanguage(undefined, "", "sv-SE")).toBe("en");
		expect(uiLanguageOf("zh-Hant-TW")).toBe("zh");
	});
});

describe("VoiceServer #given a warm voice-input", () => {
	it("#when two questions are asked #then both go to the one running process with its languages", async () => {
		const { binary, launches } = fake();
		const { voice, nextReady } = server(binary, "ko-KR,en-US");
		const ready = nextReady();
		voice.start();
		await ready;
		for (let question = 0; question < 2; question++) {
			const capture = voice.capture();
			capture.release();
			expect(await capture.transcript).toEqual({ text: "hello from ko-KR,en-US", locale: "en-US" });
		}
		expect(launches()).toEqual(["--serve --locale ko-KR,en-US"]);
	});

	it("#when a press comes before it is ready #then that question is still heard, through a one-shot capture", async () => {
		const { binary, launches } = fake();
		const { voice } = server(binary, "auto");
		const capture = voice.capture();
		capture.release();
		expect(await capture.transcript).toEqual({ text: "hello from auto", locale: "auto" });
		expect(launches()).toEqual(["--mic --locale auto"]);
	});

	it("#when a new press comes while the last answer is still being heard #then neither question is lost", async () => {
		const { binary, launches } = fake();
		const { voice, nextReady } = server(binary, "en-US");
		const ready = nextReady();
		voice.start();
		await ready;
		const first = voice.capture();
		const second = voice.capture();
		second.release();
		first.release();
		expect(await second.transcript).toEqual({ text: "hello from en-US", locale: "en-US" });
		expect(await first.transcript).toEqual({ text: "hello from en-US", locale: "en-US" });
		expect(launches()).toEqual(["--serve --locale en-US", "--mic --locale en-US"]);
	});

	it("#when it crashes mid-question #then that question fails with a reason and the server comes back by itself", async () => {
		const { binary, launches } = fake(true);
		const problems: string[] = [];
		const { voice, nextReady } = server(binary, "auto", problems);
		const firstReady = nextReady();
		voice.start();
		await firstReady;
		const restarted = nextReady();
		const lost = voice.capture();
		await expect(lost.transcript).rejects.toThrow("voice-input stopped (code 3).");
		await restarted;
		const next = voice.capture();
		next.release();
		expect((await next.transcript).text).toBe("hello from auto");
		expect(launches()).toEqual(["--serve --locale auto", "--serve --locale auto"]);
	});

	it("#when the dictation languages change in settings #then the next press restarts it with the new ones", async () => {
		const { binary, launches } = fake();
		const { voice, nextReady } = server(binary, "auto");
		const first = nextReady();
		voice.start();
		await first;
		const second = nextReady();
		voice.useLocales("ja-JP");
		voice.useLocales("ja-JP");
		await second;
		const capture = voice.capture();
		capture.release();
		expect((await capture.transcript).locale).toBe("ja-JP");
		expect(launches()).toEqual(["--serve --locale auto", "--serve --locale ja-JP"]);
	});
});
