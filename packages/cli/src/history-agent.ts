import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const MAX_PROMPT_BYTES = 120_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const TIMEOUT_MILLISECONDS = 120_000;
const FAILURE_DETAIL_CHARACTERS = 300;
const ARGUMENTS = [
	"--print",
	"--no-session",
	"--no-tools",
	"--no-extensions",
	"--no-skills",
	"--no-context-files",
	"--no-approve",
	"--offline",
	"-",
];

export interface HistoryAgentOptions {
	readonly signal?: AbortSignal;
	readonly executable?: string;
	readonly args?: readonly string[];
	readonly timeoutMs?: number;
	/** Names the work in error messages (default "History generation"). */
	readonly label?: string;
	readonly cwd?: string;
	/** Add the child's last output line to a nonzero-exit error. Off by default: history output is private. */
	readonly includeFailureDetail?: boolean;
}

export interface HistoryAgentCommand {
	readonly executable: string;
	readonly args: readonly string[];
}

/**
 * The command that writes short skill descriptions: a small, cheap model (OPENCUA_HISTORY_MODEL, default haiku)
 * through Claude Code when it is installed, else through omo. OPENCUA_HISTORY_AGENT names another executable.
 */
export function skillDescriptionCommand(
	env: NodeJS.ProcessEnv = process.env,
	exists: (path: string) => boolean = existsSync,
	home: string = homedir(),
): HistoryAgentCommand {
	const model = env["OPENCUA_HISTORY_MODEL"] || "haiku";
	const claude = [join(home, ".local/bin/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"].find(exists);
	const executable = env["OPENCUA_HISTORY_AGENT"] || claude || defaultExecutable();
	if (basename(executable) === "claude") {
		return { executable, args: ["-p", "--model", model, "--max-turns", "1", "--output-format", "text"] };
	}
	return { executable, args: [...ARGUMENTS.slice(0, -1), "--model", model, "-"] };
}

type StopReason = "abort" | "timeout" | "oversize";

function defaultExecutable(): string {
	const configured = process.env["OPENCUA_HISTORY_AGENT"];
	if (configured) {
		return configured;
	}

	const installed = join(homedir(), ".bun", "bin", "omo");
	return existsSync(installed) ? installed : "omo";
}

export async function generateHistoryText(prompt: string, options: HistoryAgentOptions = {}): Promise<string> {
	const label = options.label ?? "History generation";
	if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
		throw new Error(`${label} prompt exceeds ${MAX_PROMPT_BYTES} UTF-8 bytes.`);
	}
	if (options.signal?.aborted) {
		throw new Error(`${label} aborted.`);
	}

	const executable = options.executable ?? defaultExecutable();

	return await new Promise<string>((resolve, reject) => {
		const stdoutChunks: Buffer[] = [];
		let stderrTail = "";
		let stderrBytes = 0;
		let stdoutBytes = 0;
		let stopReason: StopReason | undefined;
		let spawnError: Error | undefined;
		let settled = false;
		const child = spawn(executable, [...(options.args ?? ARGUMENTS)], {
			stdio: ["pipe", "pipe", "pipe"],
			...(options.cwd === undefined ? {} : { cwd: options.cwd }),
		});
		const timeoutMs = options.timeoutMs ?? TIMEOUT_MILLISECONDS;
		const timer = setTimeout(() => stop("timeout"), timeoutMs);

		const cleanup = (): void => {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
		};

		const stop = (reason: StopReason): void => {
			if (stopReason !== undefined) {
				return;
			}
			stopReason = reason;
			child.kill("SIGKILL");
		};

		const onAbort = (): void => stop("abort");
		options.signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (chunk: Buffer) => {
			stdoutBytes += chunk.length;
			if (stdoutBytes > MAX_OUTPUT_BYTES) {
				stop("oversize");
				return;
			}
			stdoutChunks.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderrBytes += chunk.length;
			stderrTail = (stderrTail + chunk.toString("utf8")).slice(-FAILURE_DETAIL_CHARACTERS);
			if (stderrBytes > MAX_OUTPUT_BYTES) {
				stop("oversize");
			}
		});
		child.on("error", (error: Error) => {
			spawnError = error;
		});
		child.on("close", (code: number | null) => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			if (stopReason === "abort") {
				reject(new Error(`${label} aborted.`));
			} else if (stopReason === "timeout") {
				reject(new Error(`${label} timed out after ${timeoutMs / 1000} seconds.`));
			} else if (stopReason === "oversize") {
				reject(new Error(`${label} output exceeds ${MAX_OUTPUT_BYTES} bytes.`));
			} else if (spawnError) {
				reject(new Error(`${label} executable is unavailable: ${executable}.`));
			} else if (code !== 0) {
				const said =
					options.includeFailureDetail !== true
						? undefined
						: `${Buffer.concat(stdoutChunks).toString("utf8")}\n${stderrTail}`
								.trim()
								.split("\n")
								.at(-1)
								?.slice(-FAILURE_DETAIL_CHARACTERS);
				reject(new Error(`${label} failed with exit code ${code ?? "unknown"}${said ? `: ${said}` : "."}`));
			} else if (Buffer.concat(stdoutChunks).toString("utf8").trim().length === 0) {
				reject(new Error(`${label} returned empty text.`));
			} else {
				resolve(Buffer.concat(stdoutChunks).toString("utf8").trim());
			}
		});
		child.stdin.on("error", () => {
			// A child that exits before consuming stdin is classified from its close event.
		});
		child.stdin.end(prompt, "utf8");
	});
}
