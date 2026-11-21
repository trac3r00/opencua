import { randomBytes } from "node:crypto";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { APP_AGENT_PREFIX, APP_PRESETS, appTokenService, connectApp, disconnectApp } from "./buddy-apps.js";
import {
	PAGE_STRINGS,
	SPEECH_LANGUAGES,
	UI_LANGUAGES,
	UI_LANGUAGE_LABELS,
	phrase,
	replyLanguage,
} from "./buddy-i18n.js";
import {
	DEFAULT_BUDDY_SETTINGS,
	KNOWN_AGENTS,
	type SecretStore,
	coerceBuddySettings,
	detectAgents,
	keychain,
	readBuddySettings,
	readElevenLabsKey,
	resolveAgent,
	saveElevenLabsKey,
	writeBuddySettings,
} from "./buddy-settings.js";
import { elevenLabsVoices, speak, systemVoices } from "./buddy-voice.js";
const IDLE_CLOSE_MILLISECONDS = 15 * 60_000;
const MAX_BODY_BYTES = 64 * 1024;

export interface BuddySettingsUiOptions {
	readonly stateDir: string;
	readonly hudBinary?: string | undefined;
	readonly secrets?: SecretStore;
	readonly fetch?: typeof fetch;
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
	const secrets = options.secrets ?? keychain;
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
			response.end(SETTINGS_PAGE.replace("__PAGE_DATA__", () => PAGE_DATA));
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
			const [hasElevenLabsKey, voices, apps] = await Promise.all([
				readElevenLabsKey().then((key) => key !== undefined),
				systemVoices(),
				Promise.all(
					APP_PRESETS.map(async (preset) => {
						const connection = settings.apps[preset.id];
						return {
							id: preset.id,
							label: preset.label,
							setup: preset.setup,
							baseUrl: connection?.baseUrl ?? preset.baseUrl,
							model: connection?.model ?? preset.model,
							connected: connection !== undefined,
							hasToken: (await secrets.read(appTokenService(preset.id))) !== undefined,
						};
					}),
				),
			]);
			send(response, 200, {
				settings,
				defaults: DEFAULT_BUDDY_SETTINGS,
				agents: detectAgents().map(({ id, label, executable }) => ({ id, label, executable })),
				knownAgents: KNOWN_AGENTS.map(({ id, label }) => ({ id, label })),
				activeAgent: settings.agent.startsWith(APP_AGENT_PREFIX) ? settings.agent : active,
				hasElevenLabsKey,
				systemVoices: voices.map((voice) => voice.name),
				apps,
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
			// Apps change only through api/app/connect, which checks the token first.
			const { apps: _apps, ...fields } = body;
			const next = coerceBuddySettings(fields, readBuddySettings(options.stateDir));
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
			const language = typeof body["language"] === "string" ? body["language"] : undefined;
			await speak(phrase("testVoice", replyLanguage(language, settings.uiLanguage)), {
				stateDir: options.stateDir,
				settings: { ...settings, speak: true },
				hudBinary: options.hudBinary,
				language,
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
		if (path === "api/app/connect" || path === "api/app/disconnect") {
			const id = typeof body["id"] === "string" ? body["id"] : "";
			const field = (key: string): string | undefined => (typeof body[key] === "string" ? body[key] : undefined);
			try {
				if (path === "api/app/disconnect") {
					await disconnectApp(options.stateDir, id, secrets);
				} else {
					await connectApp(
						options.stateDir,
						id,
						{ token: field("token"), baseUrl: field("baseUrl"), model: field("model") },
						secrets,
						{ fetch: options.fetch ?? fetch },
					);
				}
				send(response, 200, { ok: true });
			} catch (error: unknown) {
				send(response, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
			}
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

const PAGE_DATA = JSON.stringify({
	strings: PAGE_STRINGS,
	uiLanguages: UI_LANGUAGES.map((id) => ({ id, label: UI_LANGUAGE_LABELS[id] })),
	speechLanguages: SPEECH_LANGUAGES,
	appPrefix: APP_AGENT_PREFIX,
}).replace(/</g, "\\u003c");

const SETTINGS_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>opencua buddy settings</title>
<style>
:root { color-scheme: light dark; --accent: #ff7a1a; --line: color-mix(in srgb, CanvasText 14%, transparent); }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.45 -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif; background: Canvas; color: CanvasText; }
main { max-width: 680px; margin: 0 auto; padding: 32px 24px 64px; }
h1 { font-size: 22px; margin: 0 0 4px; }
.lede { margin: 0 0 24px; opacity: .7; }
section { border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px; margin-bottom: 16px; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; opacity: .65; margin: 0 0 12px; }
label.row, div.row { display: grid; grid-template-columns: 170px 1fr; gap: 12px; align-items: center; margin: 10px 0; }
.hint { grid-column: 2; font-size: 12px; opacity: .6; margin-top: -6px; }
input[type=text], input[type=password], input[type=url], select { width: 100%; padding: 7px 9px; border: 1px solid var(--line); border-radius: 8px; background: Field; color: FieldText; font: inherit; }
button { font: inherit; padding: 7px 14px; border-radius: 8px; border: 1px solid var(--line); background: ButtonFace; color: ButtonText; cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button:disabled { opacity: .5; cursor: default; }
.inline { display: flex; gap: 8px; }
.status { min-height: 20px; font-size: 13px; margin-top: 8px; }
.ok { color: #2e9d57; } .bad { color: #d9483b; }
.langs { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 4px 12px; }
.langs label { display: flex; gap: 6px; align-items: center; font-size: 13px; }
details.app { border-top: 1px solid var(--line); padding: 8px 0; }
details.app summary { cursor: pointer; display: flex; justify-content: space-between; list-style: none; }
details.app summary::-webkit-details-marker { display: none; }
.badge { font-size: 12px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--line); }
.badge.on { color: #2e9d57; border-color: #2e9d57; }
footer { display: flex; gap: 10px; justify-content: flex-end; align-items: center; }
div.row.top { align-items: start; }
@media (max-width: 560px) {
  main { padding: 20px 14px 48px; }
  label.row, div.row { grid-template-columns: 1fr; gap: 6px; }
  .hint { grid-column: 1; margin-top: 0; }
}
</style></head>
<body><main>
<h1 data-t="title"></h1>
<p class="lede" data-t="lede"></p>

<section><h2 data-t="sectionLanguage"></h2>
<label class="row"><span data-t="uiLanguage"></span> <select id="uiLanguage"></select></label>
<div class="row top"><span data-t="dictation"></span><div class="langs" id="speechLanguages"></div></div>
<div class="hint" id="dictationHint" data-t="dictationHint"></div>
</section>

<section><h2 data-t="sectionWho"></h2>
<label class="row"><span data-t="agent"></span> <select id="agent"></select></label>
<div class="hint" id="agentHint"></div>
<label class="row"><span data-t="model"></span> <input type="text" id="model"></label>
<div class="hint" data-t="modelHint"></div>
</section>

<section><h2 data-t="sectionApps"></h2>
<p class="hint" style="margin:0 0 8px" data-t="appsLede"></p>
<div id="apps"></div>
</section>

<section><h2 data-t="sectionVoice"></h2>
<label class="row"><span data-t="speak"></span> <span><input type="checkbox" id="speak"></span></label>
<label class="row"><span data-t="voice"></span> <select id="voiceProvider"><option value="elevenlabs" data-t="voiceEleven"></option><option value="system" data-t="voiceMac"></option></select></label>
<div id="elevenBox">
<label class="row"><span data-t="elevenKey"></span> <span class="inline"><input type="password" id="key" autocomplete="off"><button id="saveKey" data-t="saveKey"></button></span></label>
<div class="hint" id="keyHint"></div>
<label class="row"><span data-t="elevenVoice"></span> <select id="elevenLabsVoiceId"></select></label>
<label class="row"><span data-t="elevenModel"></span> <select id="elevenLabsModel">
<option value="eleven_flash_v2_5" data-t="modelFlash"></option><option value="eleven_turbo_v2_5" data-t="modelTurbo"></option>
<option value="eleven_multilingual_v2" data-t="modelMultilingual"></option></select></label>
</div>
<div id="systemBox"><label class="row"><span data-t="macVoice"></span> <select id="systemVoice"></select></label></div>
<div class="inline" style="justify-content:flex-end"><button id="test" data-t="testVoice"></button></div>
<div class="status" id="voiceStatus"></div>
</section>

<section><h2 data-t="sectionScreen"></h2>
<label class="row"><span data-t="captions"></span> <span><input type="checkbox" id="captions"></span></label>
<div class="hint" data-t="captionsHint"></div>
<label class="row"><span data-t="sounds"></span> <span><input type="checkbox" id="sounds"></span></label>
</section>

<footer><span class="status" id="saveStatus"></span><button class="primary" id="save" data-t="save"></button></footer>
</main>
<script>
const DATA = __PAGE_DATA__;
const $ = (id) => document.getElementById(id);
const api = (path, body) => fetch("api/" + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
let state;
let t = DATA.strings.en;
const appStatus = {};
function pickLanguage(setting) {
  if (DATA.strings[setting]) return setting;
  for (const tag of navigator.languages || [navigator.language]) { const id = String(tag).toLowerCase().split("-")[0]; if (DATA.strings[id]) return id; }
  return "en";
}
function translate() {
  const lang = pickLanguage($("uiLanguage").value);
  t = DATA.strings[lang]; document.documentElement.lang = lang; document.title = t.title;
  for (const node of document.querySelectorAll("[data-t]")) node.textContent = t[node.dataset.t];
  $("model").placeholder = t.modelPlaceholder; $("key").placeholder = t.keyPlaceholder;
  $("uiLanguage").options[0].textContent = t.automatic;
  if (state) render();
}
function option(select, value, text) { const o = document.createElement("option"); o.value = value; o.textContent = text; select.append(o); }
function checkedLanguages() { return [...document.querySelectorAll("#speechLanguages input:checked")].map((box) => box.value); }
function form() {
  return { agent: $("agent").value, model: $("model").value, voiceProvider: $("voiceProvider").value,
    elevenLabsVoiceId: $("elevenLabsVoiceId").value || state.settings.elevenLabsVoiceId, elevenLabsModel: $("elevenLabsModel").value,
    systemVoice: $("systemVoice").value, speak: $("speak").checked, captions: $("captions").checked, sounds: $("sounds").checked,
    speechLanguages: checkedLanguages(), uiLanguage: $("uiLanguage").value };
}
function showVoiceBoxes() {
  const eleven = $("voiceProvider").value === "elevenlabs";
  $("elevenBox").style.display = eleven ? "" : "none"; $("systemBox").style.display = eleven ? "none" : "";
}
async function loadElevenVoices() {
  const select = $("elevenLabsVoiceId"); select.textContent = "";
  if (!state.hasElevenLabsKey) { option(select, state.settings.elevenLabsVoiceId, t.saveKeyFirst); return; }
  const { voices, error } = await api("elevenlabs-voices");
  if (error) { $("keyHint").textContent = error; $("keyHint").className = "hint bad"; }
  for (const voice of voices) option(select, voice.id, voice.name);
  if (!voices.some((v) => v.id === state.settings.elevenLabsVoiceId)) option(select, state.settings.elevenLabsVoiceId, t.defaultVoice);
  select.value = state.settings.elevenLabsVoiceId;
}
function renderAgents() {
  const agent = $("agent"); const chosen = agent.value || state.settings.agent; agent.textContent = "";
  option(agent, "", t.agentAuto);
  for (const a of state.agents) option(agent, a.id, a.label);
  for (const app of state.apps.filter((a) => a.connected)) option(agent, DATA.appPrefix + app.id, app.label + " \u2014 " + t.appSuffix);
  agent.value = [...agent.options].some((o) => o.value === chosen) ? chosen : "";
  const missing = state.knownAgents.filter((k) => !state.agents.some((a) => a.id === k.id)).map((k) => k.label);
  $("agentHint").textContent = t.installed + ": " + (state.agents.map((a) => a.label).join(", ") || t.none) + (missing.length ? ". " + t.notInstalled + ": " + missing.join(", ") : "") + ".";
}
function renderApps() {
  const root = $("apps"); const open = new Set([...root.querySelectorAll("details[open]")].map((d) => d.dataset.id)); root.textContent = "";
  for (const app of state.apps) {
    const box = document.createElement("details"); box.className = "app"; box.dataset.id = app.id; box.open = open.has(app.id);
    box.innerHTML = '<summary><b></b><span class="badge"></span></summary><p class="hint" style="margin:6px 0"></p>' +
      '<label class="row"><span></span><input type="url" data-f="baseUrl"></label>' +
      '<label class="row"><span></span><input type="text" data-f="model"></label>' +
      '<label class="row"><span></span><input type="password" data-f="token" autocomplete="off"></label>' +
      '<div class="inline" style="justify-content:flex-end"><button data-a="disconnect"></button><button class="primary" data-a="connect"></button></div><div class="status"></div>';
    const [name, badge] = box.querySelectorAll("summary > *");
    name.textContent = app.label; badge.textContent = app.connected ? t.connected : t.notConnected; badge.className = "badge" + (app.connected ? " on" : "");
    box.querySelector("p").textContent = app.setup;
    const labels = box.querySelectorAll("label > span"); labels[0].textContent = t.address; labels[1].textContent = t.model; labels[2].textContent = t.token;
    const field = (f) => box.querySelector('[data-f="' + f + '"]');
    field("baseUrl").value = app.baseUrl; field("baseUrl").placeholder = "https://\u2026/v1"; field("model").value = app.model;
    field("token").placeholder = app.hasToken ? t.tokenSaved : t.tokenPlaceholder;
    const connect = box.querySelector('[data-a="connect"]'); const disconnect = box.querySelector('[data-a="disconnect"]'); const status = box.querySelector(".status");
    connect.textContent = app.connected ? t.saveChanges : t.connect; disconnect.textContent = t.disconnect; disconnect.style.display = app.connected || app.hasToken ? "" : "none";
    const shown = appStatus[app.id];
    if (shown) { status.textContent = shown.ok ? t[shown.key] : shown.error; status.className = "status " + (shown.ok ? "ok" : "bad"); }
    const finish = async (result, key) => {
      appStatus[app.id] = { ok: result.ok, key, error: result.error };
      if (result.ok) await refresh(); else renderApps();
    };
    connect.onclick = async () => {
      connect.disabled = true; status.textContent = t.checking; status.className = "status";
      await finish(await api("app/connect", { id: app.id, baseUrl: field("baseUrl").value, model: field("model").value, token: field("token").value }), "connectedOk");
    };
    disconnect.onclick = async () => finish(await api("app/disconnect", { id: app.id }), "disconnected");
    root.append(box);
  }
}
function renderLanguages() {
  const root = $("speechLanguages"); root.textContent = "";
  const chosen = new Set(state.settings.speechLanguages.map((id) => id.toLowerCase()));
  const known = DATA.speechLanguages.concat(state.settings.speechLanguages.filter((id) => !DATA.speechLanguages.some((l) => l.id.toLowerCase() === id.toLowerCase())).map((id) => ({ id, label: id })));
  for (const language of known) {
    const label = document.createElement("label"); const box = document.createElement("input");
    box.type = "checkbox"; box.value = language.id; box.checked = chosen.has(language.id.toLowerCase());
    box.onchange = () => { if (checkedLanguages().length > 3) { box.checked = false; $("dictationHint").textContent = t.dictationLimit; $("dictationHint").className = "hint bad"; } };
    label.append(box, language.label); root.append(label);
  }
}
function render() { renderAgents(); renderApps(); }
async function refresh() {
  const agentChoice = $("agent").value;
  state = await api("state");
  if (agentChoice) state.settings = { ...state.settings, agent: agentChoice };
  render();
}
async function load() {
  state = await api("state");
  const ui = $("uiLanguage"); ui.textContent = ""; option(ui, "", "");
  for (const l of DATA.uiLanguages) option(ui, l.id, l.label);
  ui.value = state.settings.uiLanguage;
  renderLanguages();
  $("agent").value = "";
  translate();
  $("agent").value = [...$("agent").options].some((o) => o.value === state.settings.agent) ? state.settings.agent : "";
  $("model").value = state.settings.model;
  $("voiceProvider").value = state.settings.voiceProvider;
  $("elevenLabsModel").value = state.settings.elevenLabsModel;
  const sv = $("systemVoice"); sv.textContent = ""; option(sv, "", t.systemVoice);
  for (const v of state.systemVoices) option(sv, v, v);
  sv.value = state.settings.systemVoice;
  for (const id of ["speak", "captions", "sounds"]) $(id).checked = state.settings[id];
  $("keyHint").textContent = state.hasElevenLabsKey ? t.keySaved : t.keyStored;
  $("keyHint").className = "hint " + (state.hasElevenLabsKey ? "ok" : "");
  showVoiceBoxes(); await loadElevenVoices();
}
$("uiLanguage").onchange = () => { translate(); $("systemVoice").options[0].textContent = t.systemVoice; $("keyHint").textContent = state.hasElevenLabsKey ? t.keySaved : t.keyStored; };
$("voiceProvider").onchange = showVoiceBoxes;
$("saveKey").onclick = async () => { await api("key", { key: $("key").value }); $("key").value = ""; await load(); };
$("test").onclick = async () => {
  $("voiceStatus").textContent = t.speaking; $("voiceStatus").className = "status";
  const result = await api("test-voice", { ...form(), language: document.documentElement.lang });
  $("voiceStatus").textContent = result.ok ? t.voiceOk : result.error;
  $("voiceStatus").className = "status " + (result.ok ? "ok" : "bad");
};
$("save").onclick = async () => {
  const { settings, error } = await api("settings", form());
  $("saveStatus").textContent = error ? error : t.saved;
  $("saveStatus").className = "status " + (error ? "bad" : "ok");
  if (settings) state.settings = settings;
};
load();
</script></body></html>`;
