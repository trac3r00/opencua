import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Environment = Readonly<Record<string, string | undefined>>;

/** Where one installation's pieces live, all derived from the checkout this CLI runs from and the environment. */
export interface Layout {
	readonly mode: "checkout" | "installed";
	/** The apple-cua checkout, canonical (symlinks resolved). */
	readonly checkout: string;
	readonly nativeDir: string;
	readonly helperApp: string;
	/** The helper's launcher, the command every MCP client registration runs. */
	readonly helperExecutable: string;
	readonly server: string;
	readonly cli: string;
	readonly setupScript: string;
	readonly helperBuildScript: string;
	/** The user's home directory. */
	readonly home: string;
	/** APPLE_CUA_HOME (default ~/.apple-cua): config.json, install.json, a downloaded Node.js, the installer's checkout. */
	readonly appleCuaHome: string;
	readonly configPath: string;
	/** Written by install.sh: present when the installer created a checkout. */
	readonly installMarkerPath: string;
	/** APPLE_CUA_BIN_DIR (default ~/.local/bin): where setup puts the `apple-cua` launcher. */
	readonly binDir: string;
	readonly launcherPath: string;
	/** The per-Mac integration bundle every agent client is wired to (see bundle.ts). */
	readonly bundleDir: string;
	/** The skill in the checkout, which the bundle copies. */
	readonly skillSource: string;
	/** packages/mcp/package.json, whose version the bundle's version starts with. */
	readonly serverPackage: string;
}

/** What install.sh records about the checkout it cloned. */
export interface InstallMarker {
	readonly checkout: string;
	readonly repo: string;
	readonly ref: string;
}

/**
 * `path` with symlinks resolved (/tmp becomes /private/tmp). A path that does not exist (yet, or any more) is
 * resolved through its longest existing ancestor, so it still compares equal to the paths around it.
 */
export function canonicalPath(path: string): string {
	const absolute = resolve(path);
	const rest: string[] = [];
	let existing = absolute;
	while (!existsSync(existing)) {
		const parent = dirname(existing);
		if (parent === existing) {
			return absolute;
		}
		rest.unshift(basename(existing));
		existing = parent;
	}
	try {
		return join(realpathSync(existing), ...rest);
	} catch {
		return absolute;
	}
}

/** The checkout that contains this module (packages/cli/src or packages/cli/dist). */
function defaultCheckout(): string {
	return canonicalPath(resolve(dirname(fileURLToPath(import.meta.url)), "../../.."));
}

function nonEmpty(value: string | undefined): string | undefined {
	return value === undefined || value.trim() === "" ? undefined : value;
}

export function homeDirectory(env: Environment = process.env): string {
	return nonEmpty(env["HOME"]) ?? homedir();
}

export function resolveLayout(
	env: Environment = process.env,
	checkout: string = defaultCheckout(),
	resolvePackage: (name: string) => string = (name) =>
		name === "@apple-cua/core"
			? fileURLToPath(import.meta.resolve(name))
			: createRequire(import.meta.url).resolve(name),
): Layout {
	const home = homeDirectory(env);
	const appleCuaHome = resolve(nonEmpty(env["APPLE_CUA_HOME"]) ?? join(home, ".apple-cua"));
	const binDir = resolve(nonEmpty(env["APPLE_CUA_BIN_DIR"]) ?? join(home, ".local/bin"));
	const installed = !existsSync(join(checkout, "scripts/setup.sh"));
	const server = installed
		? resolvePackage("@apple-cua/mcp/dist/server.js")
		: join(checkout, "packages/mcp/dist/server.js");
	const mcp = dirname(dirname(server));
	const helperApp = installed ? join(appleCuaHome, "helper/apple-cua-mcp.app") : join(mcp, "dist/apple-cua-mcp.app");
	return {
		mode: installed ? "installed" : "checkout",
		checkout,
		nativeDir: installed
			? join(dirname(dirname(resolvePackage("@apple-cua/core"))), "native")
			: join(checkout, "packages/core/native"),
		helperApp,
		helperExecutable: join(helperApp, "Contents/MacOS/apple-cua-mcp"),
		server,
		cli: installed
			? join(dirname(fileURLToPath(import.meta.url)), "cli.js")
			: join(checkout, "packages/cli/dist/cli.js"),
		setupScript: join(checkout, "scripts/setup.sh"),
		helperBuildScript: join(checkout, "scripts/build-tcc-helper.sh"),
		home,
		appleCuaHome,
		configPath: join(appleCuaHome, "config.json"),
		installMarkerPath: join(appleCuaHome, "install.json"),
		binDir,
		launcherPath: join(binDir, "apple-cua"),
		bundleDir: join(appleCuaHome, "bundle"),
		skillSource: installed ? join(mcp, "skills/apple-cua") : join(checkout, "skills/apple-cua"),
		serverPackage: join(mcp, "package.json"),
	};
}

/** True when `path` is `root` itself or lies inside it. */
export function isInside(path: string, root: string): boolean {
	const prefix = root.endsWith("/") ? root : `${root}/`;
	return path === root || path.startsWith(prefix);
}

/** `~/...` for a path under the home directory (as given or with symlinks resolved), so output stays short. */
export function displayPath(path: string, home: string): string {
	for (const root of new Set([home, canonicalPath(home)])) {
		if (root !== "/" && isInside(path, root)) {
			return path === root ? "~" : `~${path.slice(root.length)}`;
		}
	}
	return path;
}

export function readInstallMarker(path: string): InstallMarker | undefined {
	if (!existsSync(path)) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) {
		return undefined;
	}
	const { checkout, repo, ref } = Object.fromEntries(Object.entries(parsed));
	if (typeof checkout !== "string" || typeof repo !== "string" || typeof ref !== "string") {
		return undefined;
	}
	return { checkout: canonicalPath(checkout), repo, ref };
}
