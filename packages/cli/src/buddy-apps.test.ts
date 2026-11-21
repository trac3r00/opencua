import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_PRESETS, type ConnectedApp, askApp, checkApp, connectApp, disconnectApp } from "./buddy-apps.js";
import { chosenApp } from "./buddy-commands.js";
import { DEFAULT_BUDDY_SETTINGS, type SecretStore, readBuddySettings, writeBuddySettings } from "./buddy-settings.js";

const roots: string[] = [];
function scratch(): string {
	const root = mkdtempSync(join(tmpdir(), "buddy-apps-"));
	roots.push(root);
	return root;
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Seen {
	readonly url: string;
	readonly method: string;
	readonly authorization: string | null;
	readonly body: unknown;
}

function fakeApp(answer: (seen: Seen) => Response): { readonly fetch: typeof fetch; readonly seen: Seen[] } {
	const seen: Seen[] = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const entry: Seen = {
			url: String(input),
			method: init?.method ?? "GET",
			authorization: new Headers(init?.headers).get("authorization"),
			body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
		};
		seen.push(entry);
		return answer(entry);
	}) as typeof fetch;
	return { fetch: fetchImpl, seen };
}

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

const MUSE: ConnectedApp = {
	id: "muse",
	label: "Muse (Meta)",
	baseUrl: "https://api.meta.ai/v1",
	model: "muse-spark-1.3",
	readsImages: true,
};

describe("app presets #given the apps the person named", () => {
	it("#when listed #then Muse, Dots, Grok, OpenClaw, Hermes and Bop are there, with the documented endpoints", () => {
		expect(APP_PRESETS.map((app) => [app.id, app.baseUrl, app.model])).toEqual([
			["muse", "https://api.meta.ai/v1", "muse-spark-1.3"],
			["dots", "", "dots"],
			["grok", "https://api.x.ai/v1", "grok-4.7"],
			["openclaw", "http://127.0.0.1:18789/v1", "openclaw/default"],
			["hermes", "http://127.0.0.1:8642/v1", "hermes-agent"],
			["bop", "", "bop"],
		]);
	});
});

describe("askApp #given a connected app", () => {
	it("#when asked with a screenshot #then it gets a bearer token, the model, and the image inline as a data URL", async () => {
		const app = fakeApp(() => Response.json({ choices: [{ message: { content: " The Save button. " } }] }));
		const reply = await askApp(
			MUSE,
			"tok",
			"what is this?",
			{ data: new Uint8Array([1, 2, 3]), mimeType: "image/jpeg" },
			app,
		);
		expect(reply).toBe("The Save button.");
		expect(app.seen).toEqual([
			{
				url: "https://api.meta.ai/v1/chat/completions",
				method: "POST",
				authorization: "Bearer tok",
				body: {
					model: "muse-spark-1.3",
					stream: false,
					messages: [
						{
							role: "user",
							content: [
								{ type: "text", text: "what is this?" },
								{ type: "image_url", image_url: { url: "data:image/jpeg;base64,AQID" } },
							],
						},
					],
				},
			},
		]);
	});

	it("#when the app cannot read images or answers in parts #then text alone goes out and the parts are joined", async () => {
		const app = fakeApp(() =>
			Response.json({
				choices: [
					{
						message: {
							content: [
								{ type: "text", text: "Hi " },
								{ type: "text", text: "there" },
							],
						},
					},
				],
			}),
		);
		const textOnly = { ...MUSE, readsImages: false };
		expect(await askApp(textOnly, "t", "q", { data: new Uint8Array([1]), mimeType: "image/jpeg" }, app)).toBe(
			"Hi there",
		);
		expect((app.seen[0]?.body as { messages: { content: unknown }[] }).messages[0]?.content).toBe("q");
	});

	it("#when the app refuses, fails or says nothing #then the error names the app and what happened", async () => {
		await expect(
			askApp(
				MUSE,
				"t",
				"q",
				undefined,
				fakeApp(() => new Response("", { status: 401 })),
			),
		).rejects.toThrow("Muse (Meta) refused the token (401)");
		await expect(
			askApp(
				MUSE,
				"t",
				"q",
				undefined,
				fakeApp(() => new Response("overloaded", { status: 529 })),
			),
		).rejects.toThrow("Muse (Meta) answered 529: overloaded");
		await expect(
			askApp(
				MUSE,
				"t",
				"q",
				undefined,
				fakeApp(() => Response.json({ choices: [{ message: { content: "" } }] })),
			),
		).rejects.toThrow("Muse (Meta) sent an empty answer.");
		const offline = (async () => {
			throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:8642") });
		}) as unknown as typeof fetch;
		await expect(askApp(MUSE, "t", "q", undefined, { fetch: offline })).rejects.toThrow(
			"Could not reach Muse (Meta) at https://api.meta.ai: connect ECONNREFUSED 127.0.0.1:8642.",
		);
	});
});

describe("checkApp #given an app without a model list", () => {
	it("#when /models is missing #then a one-token chat proves the token instead", async () => {
		const app = fakeApp((seen) =>
			seen.url.endsWith("/models") ? new Response("", { status: 404 }) : Response.json({}),
		);
		await checkApp(MUSE, "t", app);
		expect(app.seen.map((entry) => [entry.method, entry.url])).toEqual([
			["GET", "https://api.meta.ai/v1/models"],
			["POST", "https://api.meta.ai/v1/chat/completions"],
		]);
		expect(app.seen[1]?.body).toMatchObject({ max_tokens: 1 });
	});
});

describe("connectApp #given the person connects an app once", () => {
	it("#when the token works #then it is saved and the app is chosen by app:<id>; nothing is asked again", async () => {
		const state = scratch();
		const secrets = memorySecrets();
		const app = fakeApp(() => Response.json({ data: [] }));
		const connected = await connectApp(state, "grok", { token: " xai-1 " }, secrets, app);
		expect(connected).toMatchObject({ id: "grok", baseUrl: "https://api.x.ai/v1", model: "grok-4.7" });
		expect(secrets.saved.get("dev.opencua.buddy.app.grok")).toBe("xai-1");
		expect(app.seen[0]?.authorization).toBe("Bearer xai-1");

		writeBuddySettings(state, { ...readBuddySettings(state), agent: "app:grok" });
		expect(chosenApp(readBuddySettings(state), {})).toMatchObject({ id: "grok", readsImages: true });
		expect(chosenApp(readBuddySettings(state), { OPENCUA_BUDDY_AGENT: "omo" })).toBeUndefined();

		await connectApp(state, "grok", {}, secrets, app);
		expect(app.seen[1]?.authorization).toBe("Bearer xai-1");
	});

	it("#when something is missing or unsafe #then nothing is saved and the reason is given", async () => {
		const state = scratch();
		const secrets = memorySecrets();
		const ok = fakeApp(() => Response.json({}));
		await expect(connectApp(state, "dots", { token: "t" }, secrets, ok)).rejects.toThrow(
			"Dots (OpenAI) needs an address",
		);
		await expect(connectApp(state, "muse", {}, secrets, ok)).rejects.toThrow("Paste Muse (Meta)'s token");
		await expect(
			connectApp(state, "bop", { token: "t", baseUrl: "http://10.0.0.5/v1" }, secrets, ok),
		).rejects.toThrow("Use https://");
		await expect(connectApp(state, "bop", { token: "t", baseUrl: "ftp://x" }, secrets, ok)).rejects.toThrow(
			"must start with https://",
		);
		await expect(connectApp(state, "siri", { token: "t" }, secrets, ok)).rejects.toThrow('Unknown app "siri"');
		await expect(
			connectApp(
				state,
				"muse",
				{ token: "bad" },
				secrets,
				fakeApp(() => new Response("", { status: 403 })),
			),
		).rejects.toThrow("refused the token (403)");
		expect(secrets.saved.size).toBe(0);
		expect(readBuddySettings(state).apps).toEqual({});
		expect(ok.seen).toEqual([]);
	});

	it("#when a person-supplied address is given #then it is used, trimmed of trailing slashes", async () => {
		const state = scratch();
		const app = fakeApp(() => Response.json({}));
		await connectApp(state, "bop", { token: "t", baseUrl: "https://bop.example.com/v1/" }, memorySecrets(), app);
		expect(app.seen[0]?.url).toBe("https://bop.example.com/v1/models");
		expect(readBuddySettings(state).apps["bop"]).toEqual({ baseUrl: "https://bop.example.com/v1", model: "bop" });
	});

	it("#when the chosen app is disconnected #then buddy goes back to automatic and asking for it explains how to connect", async () => {
		const state = scratch();
		const secrets = memorySecrets();
		await connectApp(
			state,
			"hermes",
			{ token: "k" },
			secrets,
			fakeApp(() => Response.json({})),
		);
		writeBuddySettings(state, { ...readBuddySettings(state), agent: "app:hermes" });
		await disconnectApp(state, "hermes", secrets);
		expect(readBuddySettings(state)).toMatchObject({ agent: "", apps: {} });
		expect(secrets.saved.size).toBe(0);
		expect(() => chosenApp({ ...DEFAULT_BUDDY_SETTINGS, agent: "app:hermes" }, {})).toThrow(
			"Hermes Agent is not connected. Connect it in buddy settings, or run: opencua buddy connect hermes",
		);
	});
});
