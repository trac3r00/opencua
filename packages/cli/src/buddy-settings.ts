import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { normalizeSpeechLanguages, uiLanguageOf } from "./buddy-i18n.js";

const execFileAsync = promisify(execFile);

export type VoiceProvider = "elevenlabs" | "system";

export interface BuddySettings {
	/** An agent id from KNOWN_AGENTS, or an absolute path to another agent CLI. Empty: the first installed one. */
	readonly agent: string;
	readonly model: string;
	readonly voiceProvider: VoiceProvider;
	readonly elevenLabsVoiceId: string;
	readonly elevenLabsModel: string;
	/** A `say -v` voice name; empty uses the system voice. */
	readonly systemVoice: string;
	readonly speak: boolean;
	readonly captions: boolean;
	readonly sounds: boolean;
	/** Dictation locales such as ko-KR and en-US (at most 3); empty is automatic: the Mac's preferred languages. */
	readonly speechLanguages: readonly string[];
	/** Settings page language (en, ko, ja, zh, es, fr, de); empty follows the browser. */
	readonly uiLanguage: string;
	/** Connected apps by id; their tokens live in the Keychain. */
	readonly apps: Readonly<Record<string, AppConnection>>;
}

export interface AppConnection {
	readonly baseUrl: string;
	readonly model: string;
}

export const DEFAULT_BUDDY_SETTINGS: BuddySettings = {
	agent: "",
	model: "",
	voiceProvider: "system",
	// "Rachel", one of ElevenLabs' default voices, available on every account.
	elevenLabsVoiceId: "21m00Tcm4TlvDq8ikWAM",
	elevenLabsModel: "eleven_flash_v2_5",
	systemVoice: "",
	speak: true,
	captions: true,
	sounds: true,
	speechLanguages: [],
	uiLanguage: "",
	apps: {},
};

export function buddySettingsPath(stateDir: string): string {
	return join(stateDir, "buddy", "settings.json");
}

export function readBuddySettings(stateDir: string): BuddySettings {
	let stored: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(buddySettingsPath(stateDir), "utf8"));
		if (typeof parsed === "object" && parsed !== null) stored = parsed as Record<string, unknown>;
	} catch {
		return DEFAULT_BUDDY_SETTINGS;
	}
	return coerceBuddySettings(stored, DEFAULT_BUDDY_SETTINGS);
}

export function coerceBuddySettings(input: Record<string, unknown>, base: BuddySettings): BuddySettings {
	const text = (key: keyof BuddySettings): string => {
		const value = input[key];
		return typeof value === "string" ? value.trim() : (base[key] as string);
	};
	const flag = (key: keyof BuddySettings): boolean => {
		const value = input[key];
		return typeof value === "boolean" ? value : (base[key] as boolean);
	};
	const provider = input["voiceProvider"];
	// Settings written before several languages were supported kept one `locale`.
	const speech = "speechLanguages" in input ? input["speechLanguages"] : input["locale"];
	const ui = input["uiLanguage"];
	return {
		agent: text("agent"),
		model: text("model"),
		voiceProvider: provider === "elevenlabs" || provider === "system" ? provider : base.voiceProvider,
		elevenLabsVoiceId: text("elevenLabsVoiceId") || DEFAULT_BUDDY_SETTINGS.elevenLabsVoiceId,
		elevenLabsModel: text("elevenLabsModel") || DEFAULT_BUDDY_SETTINGS.elevenLabsModel,
		systemVoice: text("systemVoice"),
		speak: flag("speak"),
		captions: flag("captions"),
		sounds: flag("sounds"),
		speechLanguages: speech === undefined ? base.speechLanguages : normalizeSpeechLanguages(speech),
		uiLanguage: typeof ui === "string" ? (ui === "" ? "" : (uiLanguageOf(ui) ?? base.uiLanguage)) : base.uiLanguage,
		apps: "apps" in input ? coerceApps(input["apps"]) : base.apps,
	};
}

function coerceApps(value: unknown): Readonly<Record<string, AppConnection>> {
	if (typeof value !== "object" || value === null) return {};
	const apps: Record<string, AppConnection> = {};
	for (const [id, entry] of Object.entries(value)) {
		if (typeof entry !== "object" || entry === null) continue;
		const { baseUrl, model } = entry as Record<string, unknown>;
		if (typeof baseUrl === "string" && typeof model === "string" && /^[a-z0-9-]+$/.test(id)) {
			apps[id] = { baseUrl, model };
		}
	}
	return apps;
}

export function writeBuddySettings(stateDir: string, settings: BuddySettings): void {
	const path = buddySettingsPath(stateDir);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(settings, null, "\t")}\n`, { mode: 0o600 });
	renameSync(temporary, path);
}

/** A secret in the login Keychain: buddy keeps API keys and app tokens there, never in a settings file. */
export interface SecretStore {
	read(service: string): Promise<string | undefined>;
	/** An empty secret deletes it. */
	save(service: string, secret: string, label: string): Promise<void>;
}

const KEYCHAIN_ACCOUNT = "api-key";

export const keychain: SecretStore = {
	async read(service) {
		try {
			const { stdout } = await execFileAsync("security", [
				"find-generic-password",
				"-s",
				service,
				"-a",
				KEYCHAIN_ACCOUNT,
				"-w",
			]);
			const secret = stdout.trim();
			return secret.length > 0 ? secret : undefined;
		} catch {
			return undefined;
		}
	},
	async save(service, secret, label) {
		if (secret.length === 0) {
			await execFileAsync("security", ["delete-generic-password", "-s", service, "-a", KEYCHAIN_ACCOUNT]).catch(
				() => undefined,
			);
			return;
		}
		await execFileAsync("security", [
			"add-generic-password",
			"-U",
			"-s",
			service,
			"-a",
			KEYCHAIN_ACCOUNT,
			"-l",
			label,
			"-w",
			secret,
		]);
	},
};

const ELEVENLABS_SERVICE = "dev.opencua.buddy.elevenlabs";

export async function readElevenLabsKey(): Promise<string | undefined> {
	return process.env["ELEVENLABS_API_KEY"] || (await keychain.read(ELEVENLABS_SERVICE));
}

export async function saveElevenLabsKey(key: string): Promise<void> {
	await keychain.save(ELEVENLABS_SERVICE, key, "opencua buddy ElevenLabs API key");
}

export type AgentKind = "ask" | "job";

export interface AgentProfile {
	readonly id: string;
	readonly label: string;
	readonly executable: string;
	/** Arguments for print mode; the prompt arrives on stdin. */
	readonly args: (kind: AgentKind, model: string) => readonly string[];
	/** Whether it can open the screenshot file named in the prompt. */
	readonly readsImages: boolean;
}

interface AgentSpec {
	readonly id: string;
	readonly label: string;
	readonly names: readonly string[];
	readonly args: AgentProfile["args"];
	readonly readsImages: boolean;
}

const withModel = (model: string): string[] => (model ? ["--model", model] : []);

export const KNOWN_AGENTS: readonly AgentSpec[] = [
	{
		id: "claude",
		label: "Claude Code",
		names: ["claude"],
		readsImages: true,
		args: (kind, model) =>
			kind === "ask"
				? ["-p", "--output-format", "text", ...withModel(model), "--max-turns", "4", "--allowedTools", "Read"]
				: [
						"-p",
						"--output-format",
						"text",
						...withModel(model),
						"--max-turns",
						"80",
						"--permission-mode",
						"acceptEdits",
						"--allowedTools",
						"Read,Write,Edit,Glob,Grep,WebSearch,WebFetch",
					],
	},
	{
		id: "gemini",
		label: "Gemini CLI",
		names: ["gemini"],
		readsImages: true,
		// Headless Gemini refuses folders it has not been told to trust; buddy works in its own scratch folders.
		args: (kind, model) => [
			"--skip-trust",
			...withModel(model),
			...(kind === "job" ? ["--approval-mode", "auto_edit"] : []),
		],
	},
	{
		id: "cursor-agent",
		label: "Cursor Agent",
		names: ["cursor-agent"],
		readsImages: true,
		args: (kind, model) => [
			"-p",
			"--output-format",
			"text",
			...withModel(model),
			...(kind === "job" ? ["--force"] : []),
		],
	},
	{
		id: "omo",
		label: "OmO",
		names: ["omo"],
		readsImages: true,
		args: (_kind, model) => ["--print", "--no-session", ...withModel(model), "-"],
	},
	{
		id: "codex",
		label: "Codex",
		names: ["codex"],
		readsImages: true,
		args: (kind, model) => [
			"exec",
			"--skip-git-repo-check",
			...withModel(model),
			...(kind === "job" ? ["--full-auto"] : []),
			"-",
		],
	},
];

function searchPaths(home: string): string[] {
	return [
		join(home, ".local/bin"),
		join(home, ".bun/bin"),
		join(home, ".npm-global/bin"),
		"/opt/homebrew/bin",
		"/usr/local/bin",
		...(process.env["PATH"] ?? "").split(":").filter((entry) => entry.length > 0),
	];
}

export function detectAgents(
	exists: (path: string) => boolean = existsSync,
	home: string = homedir(),
): readonly AgentProfile[] {
	const found: AgentProfile[] = [];
	for (const spec of KNOWN_AGENTS) {
		const executable = searchPaths(home)
			.flatMap((directory) => spec.names.map((name) => join(directory, name)))
			.find(exists);
		if (executable !== undefined) {
			found.push({ id: spec.id, label: spec.label, executable, args: spec.args, readsImages: spec.readsImages });
		}
	}
	return found;
}

/**
 * The agent buddy runs: OPENCUA_BUDDY_AGENT, then the one chosen in settings, then the first installed in
 * KNOWN_AGENTS order. A path to an unknown CLI runs it in print mode with the prompt on stdin.
 */
export function resolveAgent(
	settings: BuddySettings,
	env: NodeJS.ProcessEnv = process.env,
	exists: (path: string) => boolean = existsSync,
	home: string = homedir(),
): AgentProfile {
	const chosen = env["OPENCUA_BUDDY_AGENT"] || settings.agent;
	const installed = detectAgents(exists, home);
	if (chosen) {
		const byId = installed.find((agent) => agent.id === chosen);
		if (byId) return byId;
		const spec = KNOWN_AGENTS.find((agent) => agent.names.includes(basename(chosen)));
		if (spec)
			return { id: spec.id, label: spec.label, executable: chosen, args: spec.args, readsImages: spec.readsImages };
		return { id: "custom", label: basename(chosen), executable: chosen, args: () => ["-"], readsImages: false };
	}
	const first = installed[0];
	if (first === undefined) {
		throw new Error(
			"No agent CLI found. Install Claude Code, Gemini CLI, Cursor Agent, OmO or Codex, or set one in buddy settings.",
		);
	}
	return first;
}
