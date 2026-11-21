import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { promisify } from "node:util";
import {
	DEFAULT_BUDDY_SETTINGS,
	KNOWN_AGENTS,
	coerceBuddySettings,
	detectAgents,
	readBuddySettings,
	readElevenLabsKey,
	resolveAgent,
	saveElevenLabsKey,
	writeBuddySettings,
} from "./buddy-settings.js";
import { elevenLabsVoices, speak } from "./buddy-voice.js";

const execFileAsync = promisify(execFile);
const IDLE_CLOSE_MILLISECONDS = 15 * 60_000;
const MAX_BODY_BYTES = 64 * 1024;

export interface BuddySettingsUiOptions {
	readonly stateDir: string;
	readonly hudBinary?: string | undefined;
}

export async function systemVoices(): Promise<readonly string[]> {
	try {
		const { stdout } = await execFileAsync("say", ["-v", "?"]);
		return parseSayVoices(stdout);
	} catch {
		return [];
	}
}

/** `say -v ?` lines look like "Samantha            en_US    # Hello..."; names may contain spaces and parentheses. */
export function parseSayVoices(listing: string): readonly string[] {
	return listing
		.split("\n")
		.map((line) => /^(.+?)\s+[a-z]{2,3}[_-][A-Za-z0-9]+\s+#/.exec(line)?.[1]?.trim())
		.filter((name): name is string => name !== undefined && name.length > 0);
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = chunk as Buffer;
		size += buffer.length;
		if (size > MAX_BODY_BYTES) throw new Error("Request body is too large.");
		chunks.push(buffer);
	}
	const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
	if (typeof parsed !== "object" || parsed === null) throw new Error("Expected a JSON object.");
	return parsed as Record<string, unknown>;
}

function send(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
	response.end(JSON.stringify(body));
}

/**
 * Serves the settings page on 127.0.0.1 under a random path, so only the person who opened it (the URL holds the
 * token) can read or change settings; it closes after 15 idle minutes or when the page says so.
 */
export async function startBuddySettingsUi(
	options: BuddySettingsUiOptions,
): Promise<{ readonly url: string; readonly closed: Promise<void> }> {
	const token = randomBytes(18).toString("base64url");
	const prefix = `/${token}/`;
	let idle: NodeJS.Timeout | undefined;
	let resolveClosed: () => void = () => undefined;
	const closed = new Promise<void>((resolve) => {
		resolveClosed = resolve;
	});
	const server = createServer((request, response) => {
		touch();
		void route(request, response).catch((error: unknown) => {
			send(response, 400, { error: error instanceof Error ? error.message : String(error) });
		});
	});
	const close = (): void => {
		if (idle !== undefined) clearTimeout(idle);
		server.close(() => resolveClosed());
	};
	const touch = (): void => {
		if (idle !== undefined) clearTimeout(idle);
		idle = setTimeout(close, IDLE_CLOSE_MILLISECONDS);
	};

	async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = request.url ?? "";
		if (!url.startsWith(prefix)) {
			send(response, 404, { error: "Not found." });
			return;
		}
		const path = url.slice(prefix.length);
		if (request.method === "GET" && path === "") {
			response.writeHead(200, {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
				"content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
			});
			response.end(SETTINGS_PAGE);
			return;
		}
		if (request.method === "GET" && path === "api/state") {
			const settings = readBuddySettings(options.stateDir);
			let active: string | undefined;
			try {
				active = resolveAgent(settings).id;
			} catch {
				active = undefined;
			}
			send(response, 200, {
				settings,
				defaults: DEFAULT_BUDDY_SETTINGS,
				agents: detectAgents().map(({ id, label, executable }) => ({ id, label, executable })),
				knownAgents: KNOWN_AGENTS.map(({ id, label }) => ({ id, label })),
				activeAgent: active,
				hasElevenLabsKey: (await readElevenLabsKey()) !== undefined,
				systemVoices: await systemVoices(),
			});
			return;
		}
		if (request.method === "GET" && path === "api/elevenlabs-voices") {
			const key = await readElevenLabsKey();
			if (key === undefined) {
				send(response, 200, { voices: [], error: "Save an API key first." });
				return;
			}
			try {
				send(response, 200, { voices: await elevenLabsVoices(key) });
			} catch (error: unknown) {
				send(response, 200, { voices: [], error: error instanceof Error ? error.message : String(error) });
			}
			return;
		}
		if (request.method !== "POST") {
			send(response, 404, { error: "Not found." });
			return;
		}
		const body = await readBody(request);
		if (path === "api/settings") {
			const next = coerceBuddySettings(body, readBuddySettings(options.stateDir));
			writeBuddySettings(options.stateDir, next);
			send(response, 200, { settings: next });
			return;
		}
		if (path === "api/key") {
			const key = typeof body["key"] === "string" ? body["key"].trim() : "";
			await saveElevenLabsKey(key);
			send(response, 200, { hasElevenLabsKey: key.length > 0 });
			return;
		}
		if (path === "api/test-voice") {
			const settings = coerceBuddySettings(body, readBuddySettings(options.stateDir));
			let voiceError: string | undefined;
			await speak("Hi! This is how I'll sound when I answer you.", {
				stateDir: options.stateDir,
				settings: { ...settings, speak: true },
				hudBinary: options.hudBinary,
				onVoiceError: (message) => {
					voiceError = message;
				},
			});
			send(response, 200, {
				ok: voiceError === undefined,
				...(voiceError === undefined ? {} : { error: voiceError }),
			});
			return;
		}
		if (path === "api/close") {
			send(response, 200, { closed: true });
			close();
			return;
		}
		send(response, 404, { error: "Not found." });
	}

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("Settings server has no port.");
	touch();
	return { url: `http://127.0.0.1:${address.port}${prefix}`, closed };
}

const SETTINGS_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>opencua buddy settings</title>
<style>
:root { color-scheme: light dark; --accent: #ff7a1a; --line: color-mix(in srgb, CanvasText 14%, transparent); }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.45 -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif; background: Canvas; color: CanvasText; }
main { max-width: 640px; margin: 0 auto; padding: 32px 24px 64px; }
h1 { font-size: 22px; margin: 0 0 4px; }
.lede { margin: 0 0 24px; opacity: .7; }
section { border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px; margin-bottom: 16px; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; opacity: .65; margin: 0 0 12px; }
label.row { display: grid; grid-template-columns: 170px 1fr; gap: 12px; align-items: center; margin: 10px 0; }
.hint { grid-column: 2; font-size: 12px; opacity: .6; margin-top: -6px; }
input[type=text], input[type=password], select { width: 100%; padding: 7px 9px; border: 1px solid var(--line); border-radius: 8px; background: Field; color: FieldText; font: inherit; }
.toggle { display: flex; gap: 10px; align-items: center; margin: 10px 0; }
button { font: inherit; padding: 7px 14px; border-radius: 8px; border: 1px solid var(--line); background: ButtonFace; color: ButtonText; cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.inline { display: flex; gap: 8px; }
.status { min-height: 20px; font-size: 13px; margin-top: 8px; }
.ok { color: #2e9d57; } .bad { color: #d9483b; }
.agent-list { font-size: 12px; opacity: .7; margin-top: 4px; }
footer { display: flex; gap: 10px; justify-content: flex-end; }
</style></head>
<body><main>
<h1>Buddy settings</h1>
<p class="lede">Hold <b>Control+Option</b> to talk. Hold it again while buddy talks to stop it, or press ■ on its caption.</p>

<section><h2>Who answers</h2>
<label class="row">Agent <select id="agent"></select></label>
<div class="hint" id="agentHint"></div>
<label class="row">Model <input type="text" id="model" placeholder="the agent's default"></label>
<div class="hint">For example sonnet, opus, gemini-2.5-pro, gpt-5. Leave empty for the agent's default.</div>
</section>

<section><h2>Voice</h2>
<label class="row">Speak answers <span><input type="checkbox" id="speak"></span></label>
<label class="row">Voice <select id="voiceProvider"><option value="elevenlabs">ElevenLabs</option><option value="system">Mac voice</option></select></label>
<div id="elevenBox">
<label class="row">ElevenLabs API key <span class="inline"><input type="password" id="key" placeholder="paste your key" autocomplete="off"><button id="saveKey">Save</button></span></label>
<div class="hint" id="keyHint">Stored in your macOS Keychain, never in a file.</div>
<label class="row">ElevenLabs voice <select id="elevenLabsVoiceId"></select></label>
<label class="row">ElevenLabs model <select id="elevenLabsModel">
<option value="eleven_flash_v2_5">Flash v2.5 (fastest)</option><option value="eleven_turbo_v2_5">Turbo v2.5</option>
<option value="eleven_multilingual_v2">Multilingual v2 (richest)</option></select></label>
</div>
<div id="systemBox"><label class="row">Mac voice <select id="systemVoice"></select></label></div>
<div class="inline" style="justify-content:flex-end"><button id="test">Test voice</button></div>
<div class="status" id="voiceStatus"></div>
</section>

<section><h2>Screen</h2>
<label class="row">Show captions <span><input type="checkbox" id="captions"></span></label>
<div class="hint">A small bubble with what buddy says. Drag it anywhere; it comes back to that spot next time.</div>
<label class="row">Sounds <span><input type="checkbox" id="sounds"></span></label>
<label class="row">Speech language <select id="locale">
<option value="">System language</option><option value="en-US">English (US)</option><option value="en-GB">English (UK)</option>
<option value="ko-KR">한국어</option><option value="ja-JP">日本語</option><option value="zh-CN">中文 (简体)</option>
<option value="es-ES">Español</option><option value="fr-FR">Français</option><option value="de-DE">Deutsch</option></select></label>
</section>

<footer><span class="status" id="saveStatus"></span><button class="primary" id="save">Save</button></footer>
</main>
<script>
const $ = (id) => document.getElementById(id);
const api = (path, body) => fetch("api/" + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
let state;
function option(select, value, text) { const o = document.createElement("option"); o.value = value; o.textContent = text; select.append(o); }
function form() {
  return { agent: $("agent").value, model: $("model").value, voiceProvider: $("voiceProvider").value,
    elevenLabsVoiceId: $("elevenLabsVoiceId").value || state.settings.elevenLabsVoiceId, elevenLabsModel: $("elevenLabsModel").value,
    systemVoice: $("systemVoice").value, speak: $("speak").checked, captions: $("captions").checked, sounds: $("sounds").checked, locale: $("locale").value };
}
function showVoiceBoxes() {
  const eleven = $("voiceProvider").value === "elevenlabs";
  $("elevenBox").style.display = eleven ? "" : "none"; $("systemBox").style.display = eleven ? "none" : "";
}
async function loadElevenVoices() {
  const select = $("elevenLabsVoiceId"); select.textContent = "";
  if (!state.hasElevenLabsKey) { option(select, state.settings.elevenLabsVoiceId, "Save a key to list your voices"); return; }
  const { voices, error } = await api("elevenlabs-voices");
  if (error) { $("keyHint").textContent = error; $("keyHint").className = "hint bad"; }
  for (const voice of voices) option(select, voice.id, voice.name);
  if (!voices.some((v) => v.id === state.settings.elevenLabsVoiceId)) option(select, state.settings.elevenLabsVoiceId, "Default (Rachel)");
  select.value = state.settings.elevenLabsVoiceId;
}
async function load() {
  state = await api("state");
  const agent = $("agent"); agent.textContent = "";
  option(agent, "", "Automatic (first installed)");
  for (const a of state.agents) option(agent, a.id, a.label);
  agent.value = state.agents.some((a) => a.id === state.settings.agent) || state.settings.agent === "" ? state.settings.agent : "";
  const missing = state.knownAgents.filter((k) => !state.agents.some((a) => a.id === k.id)).map((k) => k.label);
  $("agentHint").textContent = "Installed: " + (state.agents.map((a) => a.label).join(", ") || "none") + (missing.length ? ". Not installed: " + missing.join(", ") : "") + ".";
  $("model").value = state.settings.model;
  $("voiceProvider").value = state.settings.voiceProvider;
  $("elevenLabsModel").value = state.settings.elevenLabsModel;
  const sv = $("systemVoice"); sv.textContent = ""; option(sv, "", "System voice");
  for (const v of state.systemVoices) option(sv, v, v);
  sv.value = state.settings.systemVoice;
  for (const id of ["speak", "captions", "sounds"]) $(id).checked = state.settings[id];
  $("locale").value = state.settings.locale;
  $("keyHint").textContent = state.hasElevenLabsKey ? "A key is saved in your Keychain. Paste a new one to replace it, or save empty to remove it." : "Stored in your macOS Keychain, never in a file.";
  $("keyHint").className = "hint " + (state.hasElevenLabsKey ? "ok" : "");
  showVoiceBoxes(); await loadElevenVoices();
}
$("voiceProvider").onchange = showVoiceBoxes;
$("saveKey").onclick = async () => { await api("key", { key: $("key").value }); $("key").value = ""; await load(); };
$("test").onclick = async () => {
  $("voiceStatus").textContent = "Speaking…"; $("voiceStatus").className = "status";
  const result = await api("test-voice", form());
  $("voiceStatus").textContent = result.ok ? "That's the voice." : result.error;
  $("voiceStatus").className = "status " + (result.ok ? "ok" : "bad");
};
$("save").onclick = async () => {
  const { settings, error } = await api("settings", form());
  $("saveStatus").textContent = error ? error : "Saved. The next question uses these settings.";
  $("saveStatus").className = "status " + (error ? "bad" : "ok");
  if (settings) state.settings = settings;
};
load();
</script></body></html>`;
