import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBuddySettingsUi } from "./buddy-settings-ui.js";
import {
	DEFAULT_BUDDY_SETTINGS,
	coerceBuddySettings,
	detectAgents,
	readBuddySettings,
	resolveAgent,
	writeBuddySettings,
} from "./buddy-settings.js";
import type { SecretStore } from "./buddy-settings.js";
import { elevenLabsSpeech, macVoiceFor, parseSayVoices, speakingPidPath, stopSpeaking } from "./buddy-voice.js";

const roots: string[] = [];
function scratch(): string {
	const root = mkdtempSync(join(tmpdir(), "buddy-settings-"));
	roots.push(root);
	return root;
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("buddy settings #given a settings file", () => {
	it("#when it is missing or broken #then defaults are used", () => {
		const state = scratch();
		expect(readBuddySettings(state)).toEqual(DEFAULT_BUDDY_SETTINGS);
		writeFileSync(join(state, "x"), "");
		writeBuddySettings(state, DEFAULT_BUDDY_SETTINGS);
		writeFileSync(join(state, "buddy", "settings.json"), "{not json");
		expect(readBuddySettings(state)).toEqual(DEFAULT_BUDDY_SETTINGS);
	});

	it("#when values of the wrong type arrive #then they are ignored and the rest is kept", () => {
		const merged = coerceBuddySettings(
			{ voiceProvider: "elevenlabs", speak: "yes", captions: false, agent: " gemini ", elevenLabsVoiceId: "" },
			DEFAULT_BUDDY_SETTINGS,
		);
		expect(merged).toMatchObject({
			voiceProvider: "elevenlabs",
			speak: true,
			captions: false,
			agent: "gemini",
			elevenLabsVoiceId: DEFAULT_BUDDY_SETTINGS.elevenLabsVoiceId,
		});
		expect(coerceBuddySettings({ voiceProvider: "robot" }, DEFAULT_BUDDY_SETTINGS).voiceProvider).toBe("system");
	});

	it("#when a file from before several languages has one locale #then it becomes the only dictation language", () => {
		const state = scratch();
		writeBuddySettings(state, DEFAULT_BUDDY_SETTINGS);
		writeFileSync(join(state, "buddy", "settings.json"), JSON.stringify({ locale: "ko-KR", sounds: false }));
		expect(readBuddySettings(state)).toMatchObject({ speechLanguages: ["ko-KR"], sounds: false, uiLanguage: "" });
		writeFileSync(join(state, "buddy", "settings.json"), JSON.stringify({ locale: "" }));
		expect(readBuddySettings(state).speechLanguages).toEqual([]);
	});

	it("#when languages arrive #then bad ids, repeats and more than three are dropped, and unknown UI languages kept out", () => {
		const merged = coerceBuddySettings(
			{ speechLanguages: ["ko_KR", "en-US", "KO-kr", "not a locale", 7, "ja-JP", "fr-FR"], uiLanguage: "ko-KR" },
			DEFAULT_BUDDY_SETTINGS,
		);
		expect(merged.speechLanguages).toEqual(["ko-KR", "en-US", "ja-JP"]);
		expect(merged.uiLanguage).toBe("ko");
		expect(
			coerceBuddySettings({ uiLanguage: "xx" }, { ...DEFAULT_BUDDY_SETTINGS, uiLanguage: "de" }).uiLanguage,
		).toBe("de");
		expect(coerceBuddySettings({ uiLanguage: "" }, { ...DEFAULT_BUDDY_SETTINGS, uiLanguage: "de" }).uiLanguage).toBe(
			"",
		);
		expect(coerceBuddySettings({ speechLanguages: "en-US,ko-KR" }, DEFAULT_BUDDY_SETTINGS).speechLanguages).toEqual([
			"en-US",
			"ko-KR",
		]);
	});

	it("#when saved and read back #then the same settings return", () => {
		const state = scratch();
		const settings = { ...DEFAULT_BUDDY_SETTINGS, agent: "omo", model: "sonnet", sounds: false };
		writeBuddySettings(state, settings);
		expect(readBuddySettings(state)).toEqual(settings);
	});
});

describe("agent choice #given installed agent CLIs", () => {
	const installed = new Set(["/h/.local/bin/gemini", "/h/.bun/bin/omo"]);
	const exists = (path: string) => installed.has(path);

	it("#when nothing is chosen #then the first installed agent in the known order answers", () => {
		expect(detectAgents(exists, "/h").map((agent) => agent.id)).toEqual(["gemini", "omo"]);
		expect(resolveAgent(DEFAULT_BUDDY_SETTINGS, {}, exists, "/h").id).toBe("gemini");
	});

	it("#when settings or the environment choose one #then the environment wins over settings", () => {
		const settings = { ...DEFAULT_BUDDY_SETTINGS, agent: "omo" };
		expect(resolveAgent(settings, {}, exists, "/h").executable).toBe("/h/.bun/bin/omo");
		expect(resolveAgent(settings, { OPENCUA_BUDDY_AGENT: "gemini" }, exists, "/h").id).toBe("gemini");
	});

	it("#when a path to an unknown CLI is chosen #then it runs with the prompt on stdin", () => {
		const agent = resolveAgent({ ...DEFAULT_BUDDY_SETTINGS, agent: "/opt/my-agent" }, {}, exists, "/h");
		expect(agent).toMatchObject({ id: "custom", executable: "/opt/my-agent" });
		expect(agent.args("ask", "")).toEqual(["-"]);
	});

	it("#when no agent is installed #then it says which ones it looked for", () => {
		expect(() => resolveAgent(DEFAULT_BUDDY_SETTINGS, {}, () => false, "/h")).toThrow("No agent CLI found");
	});
});

describe("Mac voices #given say -v ? output", () => {
	it("#when parsed #then names with spaces and parentheses survive", () => {
		const listing = [
			"Albert              en_US    # Hello! My name is Albert.",
			"Eddy (English (UK)) en_GB    # Hello! My name is Eddy.",
			"Yuna                ko_KR    # 안녕하세요. 제 이름은 유나입니다.",
			"",
		].join("\n");
		expect(parseSayVoices(listing)).toEqual([
			{ name: "Albert", locale: "en-US" },
			{ name: "Eddy (English (UK))", locale: "en-GB" },
			{ name: "Yuna", locale: "ko-KR" },
		]);
	});

	it("#when an answer is in another language than the Mac's #then a voice of that language reads it", () => {
		const voices = parseSayVoices(
			"Albert   en_US    # Hi\nYuna     ko_KR    # 안녕\nKyoko    ja_JP    # こんにちは\n",
		);
		expect(macVoiceFor("", "ko-KR", voices, "en-US")).toBe("Yuna");
		expect(macVoiceFor("", "ja", voices, "en-US")).toBe("Kyoko");
		expect(macVoiceFor("", "en-GB", voices, "en-US")).toBeUndefined();
		expect(macVoiceFor("", "fr-FR", voices, "en-US")).toBeUndefined();
		expect(macVoiceFor("Albert", "ko-KR", voices, "en-US")).toBe("Albert");
		expect(macVoiceFor("", undefined, voices, "en-US")).toBeUndefined();
	});
});

describe("ElevenLabs #given a voice and a key", () => {
	it("#when speech is requested #then the API gets the voice, model, text and key", async () => {
		let seen: { url: string; init: RequestInit | undefined } | undefined;
		const fake = (async (url: string | URL | Request, init?: RequestInit) => {
			seen = { url: String(url), init };
			return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
		}) as typeof fetch;
		const audio = await elevenLabsSpeech("hello", { elevenLabsVoiceId: "voice 1", elevenLabsModel: "m" }, "k", fake);
		expect([...audio]).toEqual([1, 2, 3]);
		expect(seen?.url).toBe("https://api.elevenlabs.io/v1/text-to-speech/voice%201?output_format=mp3_44100_128");
		expect(seen?.init?.headers).toMatchObject({ "xi-api-key": "k" });
		expect(JSON.parse(String(seen?.init?.body))).toEqual({ text: "hello", model_id: "m" });
	});

	it("#when the API refuses #then the error says what it answered", async () => {
		const fake = (async () => new Response("invalid_api_key", { status: 401 })) as unknown as typeof fetch;
		await expect(elevenLabsSpeech("hi", DEFAULT_BUDDY_SETTINGS, "bad", fake)).rejects.toThrow(
			"ElevenLabs answered 401: invalid_api_key",
		);
	});
});

describe("stop speaking #given a speaking process", () => {
	it("#when stop is asked #then that process is signalled once and the record is removed", () => {
		const state = scratch();
		const killed: number[] = [];
		expect(stopSpeaking(state, (pid) => killed.push(pid))).toBe(false);
		writeBuddySettings(state, DEFAULT_BUDDY_SETTINGS);
		writeFileSync(speakingPidPath(state), "4321");
		expect(stopSpeaking(state, (pid) => killed.push(pid))).toBe(true);
		expect(killed).toEqual([4321]);
		expect(existsSync(speakingPidPath(state))).toBe(false);
	});
});

function memorySecrets(): SecretStore & { readonly saved: Map<string, string> } {
	const saved = new Map<string, string>();
	return {
		saved,
		read: async (service) => saved.get(service),
		save: async (service, secret) => {
			if (secret.length === 0) saved.delete(service);
			else saved.set(service, secret);
		},
	};
}

describe("settings page #given the local settings server", () => {
	it("#when a request lacks the secret path #then it is refused; with it, settings are read and saved", async () => {
		const state = scratch();
		const ui = await startBuddySettingsUi({ stateDir: state });
		try {
			const origin = new URL(ui.url).origin;
			expect((await fetch(`${origin}/api/state`)).status).toBe(404);
			const page = await fetch(ui.url);
			expect(page.status).toBe(200);
			expect(await page.text()).toContain("Buddy settings");
			const saved = await fetch(`${ui.url}api/settings`, {
				method: "POST",
				body: JSON.stringify({ agent: "omo", captions: false }),
			});
			expect(((await saved.json()) as { settings: { agent: string } }).settings.agent).toBe("omo");
			expect(readBuddySettings(state)).toMatchObject({ agent: "omo", captions: false });
			const stateResponse = (await (await fetch(`${ui.url}api/state`)).json()) as { settings: { agent: string } };
			expect(stateResponse.settings.agent).toBe("omo");
		} finally {
			await fetch(`${ui.url}api/close`, { method: "POST", body: "{}" });
			await ui.closed;
		}
	});
});

describe("settings page apps #given an app that speaks OpenAI Chat Completions", () => {
	it("#when it is connected once from the page #then the token is kept, the app is offered, and settings saves cannot rewrite it", async () => {
		const state = scratch();
		const secrets = memorySecrets();
		const app = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: (request) =>
				request.headers.get("authorization") === "Bearer good"
					? Response.json({ data: [{ id: "hermes-agent" }] })
					: new Response("no", { status: 401 }),
		});
		const ui = await startBuddySettingsUi({ stateDir: state, secrets });
		const post = async (path: string, body: unknown) =>
			(await (await fetch(`${ui.url}api/${path}`, { method: "POST", body: JSON.stringify(body) })).json()) as {
				ok?: boolean;
				error?: string;
			};
		try {
			const baseUrl = `http://127.0.0.1:${app.port}/v1`;
			const refused = await post("app/connect", { id: "hermes", baseUrl, token: "bad" });
			expect(refused).toMatchObject({ ok: false });
			expect(refused.error).toContain("refused the token (401)");
			expect(secrets.saved.size).toBe(0);

			expect(await post("app/connect", { id: "hermes", baseUrl, token: "good" })).toEqual({ ok: true });
			expect(secrets.saved.get("dev.opencua.buddy.app.hermes")).toBe("good");
			expect(readBuddySettings(state).apps).toEqual({ hermes: { baseUrl, model: "hermes-agent" } });

			// Once connected, the token is never needed again: changing the model re-checks with the saved one.
			expect(await post("app/connect", { id: "hermes", model: "other" })).toEqual({ ok: true });
			expect(readBuddySettings(state).apps["hermes"]?.model).toBe("other");

			await post("settings", {
				agent: "app:hermes",
				apps: { hermes: { baseUrl: "https://evil.example/v1", model: "x" } },
			});
			expect(readBuddySettings(state)).toMatchObject({ agent: "app:hermes", apps: { hermes: { baseUrl } } });

			const view = (await (await fetch(`${ui.url}api/state`)).json()) as {
				apps: { id: string; connected: boolean; hasToken: boolean }[];
				activeAgent: string;
			};
			expect(view.apps.map((entry) => entry.id)).toEqual(["muse", "dots", "grok", "openclaw", "hermes", "bop"]);
			expect(view.apps.find((entry) => entry.id === "hermes")).toMatchObject({ connected: true, hasToken: true });
			expect(view.activeAgent).toBe("app:hermes");

			expect(await post("app/disconnect", { id: "hermes" })).toEqual({ ok: true });
			expect(secrets.saved.size).toBe(0);
			expect(readBuddySettings(state)).toMatchObject({ agent: "", apps: {} });
		} finally {
			await fetch(`${ui.url}api/close`, { method: "POST", body: "{}" });
			await ui.closed;
			await app.stop(true);
		}
	});

	it("#when the page is served #then every UI language is embedded and the HTML cannot be closed early by data", async () => {
		const ui = await startBuddySettingsUi({ stateDir: scratch(), secrets: memorySecrets() });
		try {
			const html = await (await fetch(ui.url)).text();
			const data = /const DATA = (.*);\n/.exec(html)?.[1];
			expect(data).toBeDefined();
			expect(data).not.toContain("<");
			const parsed = JSON.parse(data ?? "{}") as { strings: Record<string, Record<string, string>> };
			expect(Object.keys(parsed.strings)).toEqual(["en", "ko", "ja", "zh", "es", "fr", "de"]);
			for (const strings of Object.values(parsed.strings)) {
				expect(Object.keys(strings).sort()).toEqual(Object.keys(parsed.strings["en"] ?? {}).sort());
			}
		} finally {
			await fetch(`${ui.url}api/close`, { method: "POST", body: "{}" });
			await ui.closed;
		}
	});
});
