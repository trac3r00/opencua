import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSayVoices, startBuddySettingsUi } from "./buddy-settings-ui.js";
import {
	DEFAULT_BUDDY_SETTINGS,
	coerceBuddySettings,
	detectAgents,
	readBuddySettings,
	resolveAgent,
	writeBuddySettings,
} from "./buddy-settings.js";
import { elevenLabsSpeech, speakingPidPath, stopSpeaking } from "./buddy-voice.js";

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
		expect(parseSayVoices(listing)).toEqual(["Albert", "Eddy (English (UK))", "Yuna"]);
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
