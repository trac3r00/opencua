import {
	type AppConnection,
	type BuddySettings,
	type SecretStore,
	readBuddySettings,
	writeBuddySettings,
} from "./buddy-settings.js";

// Apps buddy can hand questions and jobs to over the OpenAI Chat Completions protocol. Each is connected once: the
// token is checked against the app, kept in the Keychain, and never asked for again.

export interface AppPreset {
	readonly id: string;
	readonly label: string;
	/** Empty when the app has no public endpoint and the person supplies one. */
	readonly baseUrl: string;
	readonly model: string;
	readonly readsImages: boolean;
	readonly setup: string;
}

export const APP_PRESETS: readonly AppPreset[] = [
	{
		id: "muse",
		label: "Muse (Meta)",
		baseUrl: "https://api.meta.ai/v1",
		model: "muse-spark-1.3",
		readsImages: true,
		setup: "A Meta Model API key from dev.meta.ai.",
	},
	{
		id: "dots",
		label: "Dots (OpenAI)",
		baseUrl: "",
		model: "dots",
		readsImages: false,
		setup: "OpenAI has no public Dots API yet. Enter the address of an OpenAI-compatible relay that forwards to your dot, and its token.",
	},
	{
		id: "grok",
		label: "Grok (xAI)",
		baseUrl: "https://api.x.ai/v1",
		model: "grok-4.7",
		readsImages: true,
		setup: "An xAI API key from console.x.ai. Grok Bot's app chats have no public API, so buddy talks to Grok directly.",
	},
	{
		id: "openclaw",
		label: "OpenClaw",
		baseUrl: "http://127.0.0.1:18789/v1",
		model: "openclaw/default",
		readsImages: true,
		setup: "Your gateway token. Turn on gateway.http.endpoints.chatCompletions in the OpenClaw config first.",
	},
	{
		id: "hermes",
		label: "Hermes Agent",
		baseUrl: "http://127.0.0.1:8642/v1",
		model: "hermes-agent",
		readsImages: true,
		setup: "API_SERVER_KEY from ~/.hermes/.env, with API_SERVER_ENABLED=true and `hermes gateway` running.",
	},
	{
		id: "bop",
		label: "Bop",
		baseUrl: "",
		model: "bop",
		readsImages: false,
		setup: "Enter Bop's OpenAI-compatible address and its token.",
	},
];

export const APP_AGENT_PREFIX = "app:";

export function appPreset(id: string): AppPreset {
	const preset = APP_PRESETS.find((app) => app.id === id);
	if (preset === undefined) {
		throw new Error(`Unknown app "${id}". Known apps: ${APP_PRESETS.map((app) => app.id).join(", ")}.`);
	}
	return preset;
}

export function appTokenService(id: string): string {
	return `dev.opencua.buddy.app.${id}`;
}

export interface ConnectedApp extends AppConnection {
	readonly id: string;
	readonly label: string;
	readonly readsImages: boolean;
}

export function connectedApp(settings: BuddySettings, id: string): ConnectedApp | undefined {
	const connection = settings.apps[id];
	const preset = APP_PRESETS.find((app) => app.id === id);
	if (connection === undefined || preset === undefined) return undefined;
	return { ...connection, id, label: preset.label, readsImages: preset.readsImages };
}

function normalizeBaseUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new Error(`"${value}" is not an address. Use one like https://example.com/v1.`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("The address must start with https://.");
	const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
	// A token sent over plain http to another machine can be read on the way.
	if (url.protocol === "http:" && !local) throw new Error("Use https:// for an app on another machine.");
	return url.toString().replace(/\/+$/, "");
}

export interface AppHttp {
	readonly fetch: typeof fetch;
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
}

async function request(
	url: string,
	init: RequestInit,
	http: AppHttp,
	label: string,
	defaultTimeoutMs: number,
): Promise<Response> {
	const timeout = AbortSignal.timeout(http.timeoutMs ?? defaultTimeoutMs);
	const signal = http.signal === undefined ? timeout : AbortSignal.any([timeout, http.signal]);
	try {
		return await http.fetch(url, { ...init, signal });
	} catch (error: unknown) {
		if (timeout.aborted) throw new Error(`${label} did not answer in time.`);
		const reason = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : "";
		throw new Error(`Could not reach ${label} at ${new URL(url).origin}${reason ? `: ${reason}` : ""}.`);
	}
}

async function failure(response: Response, label: string): Promise<Error> {
	if (response.status === 401 || response.status === 403) {
		return new Error(`${label} refused the token (${response.status}). Connect it again with a new token.`);
	}
	const detail = (await response.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
	return new Error(`${label} answered ${response.status}${detail ? `: ${detail}` : ""}`);
}

/** Proves the token works: lists models, or (for apps without a model list) asks for a one-token reply. */
export async function checkApp(app: ConnectedApp, token: string, http: AppHttp): Promise<void> {
	const headers = { authorization: `Bearer ${token}` };
	const models = await request(`${app.baseUrl}/models`, { headers }, http, app.label, 15_000);
	if (models.ok) return;
	if (models.status !== 404 && models.status !== 405) throw await failure(models, app.label);
	const chat = await request(
		`${app.baseUrl}/chat/completions`,
		{
			method: "POST",
			headers: { ...headers, "content-type": "application/json" },
			body: JSON.stringify({ model: app.model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
		},
		http,
		app.label,
		30_000,
	);
	if (!chat.ok) throw await failure(chat, app.label);
}

export interface ConnectOptions {
	readonly token?: string | undefined;
	readonly baseUrl?: string | undefined;
	readonly model?: string | undefined;
}

/**
 * Connects an app once. With no new token the saved one is checked again, so a changed address or model can be
 * saved without pasting the token. Nothing is saved unless the app accepts the token.
 */
export async function connectApp(
	stateDir: string,
	id: string,
	options: ConnectOptions,
	secrets: SecretStore,
	http: AppHttp,
): Promise<ConnectedApp> {
	const preset = appPreset(id);
	const settings = readBuddySettings(stateDir);
	const previous = settings.apps[id];
	const rawUrl = options.baseUrl?.trim() || previous?.baseUrl || preset.baseUrl;
	if (rawUrl.length === 0) throw new Error(`${preset.label} needs an address: ${preset.setup}`);
	const token = options.token?.trim() || (await secrets.read(appTokenService(id)));
	if (token === undefined) throw new Error(`Paste ${preset.label}'s token. ${preset.setup}`);
	const app: ConnectedApp = {
		id,
		label: preset.label,
		readsImages: preset.readsImages,
		baseUrl: normalizeBaseUrl(rawUrl),
		model: options.model?.trim() || previous?.model || preset.model,
	};
	await checkApp(app, token, http);
	await secrets.save(appTokenService(id), token, `opencua buddy ${preset.label} token`);
	writeBuddySettings(stateDir, {
		...readBuddySettings(stateDir),
		apps: { ...readBuddySettings(stateDir).apps, [id]: { baseUrl: app.baseUrl, model: app.model } },
	});
	return app;
}

export async function disconnectApp(stateDir: string, id: string, secrets: SecretStore): Promise<void> {
	appPreset(id);
	await secrets.save(appTokenService(id), "", "");
	const settings = readBuddySettings(stateDir);
	const { [id]: _removed, ...apps } = settings.apps;
	const agent = settings.agent === `${APP_AGENT_PREFIX}${id}` ? "" : settings.agent;
	writeBuddySettings(stateDir, { ...settings, apps, agent });
}

export interface AppImage {
	readonly data: Uint8Array;
	readonly mimeType: string;
}

export async function askApp(
	app: ConnectedApp,
	token: string,
	prompt: string,
	image: AppImage | undefined,
	http: AppHttp,
): Promise<string> {
	const content =
		image !== undefined && app.readsImages
			? [
					{ type: "text", text: prompt },
					{
						type: "image_url",
						image_url: { url: `data:${image.mimeType};base64,${Buffer.from(image.data).toString("base64")}` },
					},
				]
			: prompt;
	const response = await request(
		`${app.baseUrl}/chat/completions`,
		{
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ model: app.model, stream: false, messages: [{ role: "user", content }] }),
		},
		http,
		app.label,
		180_000,
	);
	if (!response.ok) throw await failure(response, app.label);
	const body = (await response.json()) as { choices?: { message?: { content?: unknown } }[] };
	const reply = body.choices?.[0]?.message?.content;
	const text =
		typeof reply === "string"
			? reply
			: Array.isArray(reply)
				? reply
						.map((part: unknown) =>
							typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string"
								? (part as { text: string }).text
								: "",
						)
						.join("")
				: "";
	if (text.trim().length === 0) throw new Error(`${app.label} sent an empty answer.`);
	return text.trim();
}
