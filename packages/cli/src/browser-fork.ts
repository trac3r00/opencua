import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * OpenCUA Browser is the fork of Tencent/BrowserSkill: a Rust `bsk` CLI with its daemon, and a WXT-built extension.
 * Setup finds the fork, builds what is missing, puts `bsk` on PATH and reads the connection through `bsk browsers`.
 */
export type ForkLayout = {
	readonly root: string;
	readonly bsk: string;
	readonly extension: string;
};

export type ForkDeps = {
	readonly exists: (path: string) => boolean;
	readonly run: (command: string, args: readonly string[], cwd: string, env?: NodeJS.ProcessEnv) => Promise<string>;
	readonly home: string;
	readonly env: NodeJS.ProcessEnv;
};

export const nativeForkDeps: ForkDeps = {
	exists: existsSync,
	run: async (command, args, cwd, env) =>
		(
			await execFileAsync(command, [...args], {
				cwd,
				env: env ?? process.env,
				timeout: 30 * 60_000,
				maxBuffer: 64 * 1024 * 1024,
			})
		).stdout,
	home: homedir(),
	env: process.env,
};

/** OPENCUA_BROWSER_HOME, then ~/.opencua/browser, then ~/Developer/opencua-browser. */
export function locateFork(deps: ForkDeps = nativeForkDeps): ForkLayout | undefined {
	const candidates = [
		deps.env["OPENCUA_BROWSER_HOME"]?.trim(),
		join(deps.home, ".opencua", "browser"),
		join(deps.home, "Developer", "opencua-browser"),
	].filter((path): path is string => path !== undefined && path !== "");
	const root = candidates.find(
		(path) => deps.exists(join(path, "Cargo.toml")) && deps.exists(join(path, "apps", "extension", "package.json")),
	);
	return root === undefined
		? undefined
		: {
				root,
				bsk: join(root, "target", "release", "bsk"),
				extension: join(root, "apps", "extension", "dist", "chrome-mv3"),
			};
}

function buildEnvironment(deps: ForkDeps): NodeJS.ProcessEnv {
	const cargo = join(deps.home, ".cargo", "bin");
	return {
		...deps.env,
		PATH: [cargo, deps.env["PATH"] ?? ""].filter((part) => part !== "").join(delimiter),
		COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
	};
}

/** Build the `bsk` binary and the extension when either is missing; returns what was built. */
export async function buildFork(
	layout: ForkLayout,
	report: (line: string) => void,
	deps: ForkDeps = nativeForkDeps,
): Promise<readonly string[]> {
	const built: string[] = [];
	const env = buildEnvironment(deps);
	if (!deps.exists(layout.bsk)) {
		report("Building the OpenCUA Browser CLI (cargo build --release; the first build takes several minutes)...");
		await deps.run("cargo", ["build", "-p", "bsk", "--release", "--locked"], layout.root, env);
		built.push("bsk");
	}
	if (!deps.exists(join(layout.extension, "manifest.json"))) {
		report("Building the OpenCUA Browser extension...");
		if (!deps.exists(join(layout.root, "node_modules"))) {
			await deps.run("pnpm", ["install", "--frozen-lockfile"], layout.root, env);
		}
		await deps.run("pnpm", ["ext:build"], layout.root, env);
		built.push("extension");
	}
	return built;
}

/** Put `bsk` on PATH as ~/.local/bin/bsk, pointing at the fork's build; an unrelated file there is left alone. */
export function linkBsk(
	layout: ForkLayout,
	home: string = homedir(),
): { readonly path: string; readonly linked: boolean } {
	const directory = join(home, ".local", "bin");
	const path = join(directory, "bsk");
	mkdirSync(directory, { recursive: true });
	let existing: string | undefined;
	try {
		existing = lstatSync(path).isSymbolicLink() ? readlinkSync(path) : "(file)";
	} catch {
		existing = undefined;
	}
	if (existing === layout.bsk) return { path, linked: true };
	if (existing !== undefined && existing !== "(file)") unlinkSync(path);
	if (existing === "(file)") return { path, linked: false };
	symlinkSync(layout.bsk, path);
	return { path, linked: true };
}

/** Connected browser profiles, from `bsk browsers --json`; empty when none or the daemon is not reachable. */
export async function connectedBrowsers(
	layout: ForkLayout,
	deps: ForkDeps = nativeForkDeps,
): Promise<readonly unknown[]> {
	try {
		const output = await deps.run(layout.bsk, ["browsers", "--json"], layout.root);
		const parsed: unknown = JSON.parse(output);
		const list = Array.isArray(parsed)
			? parsed
			: typeof parsed === "object" && parsed !== null && "browsers" in parsed && Array.isArray(parsed.browsers)
				? parsed.browsers
				: [];
		return list;
	} catch {
		return [];
	}
}

/** Install the OpenCUA Browser skill (and MCP entry where supported) into every detected agent harness. */
export async function registerSkill(layout: ForkLayout, deps: ForkDeps = nativeForkDeps): Promise<string> {
	return await deps.run(layout.bsk, ["install-skill", "--yes", "--mcp", "--json"], layout.root);
}
