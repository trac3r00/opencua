import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

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
	/** Speech recognition locale such as en-US or ko-KR; empty uses the system language. */
	readonly locale: string;
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
	locale: "",
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
		locale: text("locale"),
	};
}

export function writeBuddySettings(stateDir: string, settings: BuddySettings): void {
	const path = buddySettingsPath(stateDir);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(settings, null, "\t")}\n`, { mode: 0o600 });
	renameSync(temporary, path);
}

// The ElevenLabs key lives in the login Keychain, never in a settings file.
const KEYCHAIN_SERVICE = "dev.opencua.buddy.elevenlabs";
const KEYCHAIN_ACCOUNT = "api-key";

export async function readElevenLabsKey(): Promise<string | undefined> {
	if (process.env["ELEVENLABS_API_KEY"]) return process.env["ELEVENLABS_API_KEY"];
	try {
		const { stdout } = await execFileAsync("security", [
			"find-generic-password",
			"-s",
			KEYCHAIN_SERVICE,
			"-a",
			KEYCHAIN_ACCOUNT,
			"-w",
		]);
		const key = stdout.trim();
		return key.length > 0 ? key : undefined;
	} catch {
		return undefined;
	}
}

export async function saveElevenLabsKey(key: string): Promise<void> {
	if (key.length === 0) {
		await execFileAsync("security", [
			"delete-generic-password",
			"-s",
			KEYCHAIN_SERVICE,
			"-a",
			KEYCHAIN_ACCOUNT,
		]).catch(() => undefined);
		return;
	}
	await execFileAsync("security", [
		"add-generic-password",
		"-U",
		"-s",
		KEYCHAIN_SERVICE,
		"-a",
		KEYCHAIN_ACCOUNT,
		"-l",
		"opencua buddy ElevenLabs API key",
		"-w",
		key,
	]);
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
