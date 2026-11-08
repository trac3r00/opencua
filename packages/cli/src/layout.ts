import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Environment = Readonly<Record<string, string | undefined>>;

/** Where one installation's pieces live, all derived from the checkout this CLI runs from and the environment. */
export interface Layout {
	/** The opencua checkout, canonical (symlinks resolved). */
	readonly checkout: string;
	readonly nativeDir: string;
	readonly helperApp: string;
	/** The helper's launcher, the command every MCP client registration runs. */
	readonly helperExecutable: string;
	/** The server.js every registration runs: the linked developer checkout's (see `opencua dev link`), else this one's. */
	readonly server: string;
	/** $OPENCUA_HOME/dev-link.json, written by `opencua dev link`. */
	readonly devLinkPath: string;
	/** The developer checkout `opencua dev link` points the server at; undefined when not linked. */
	readonly devCheckout: string | undefined;
	readonly cli: string;
	readonly setupScript: string;
	readonly helperBuildScript: string;
	/** The user's home directory. */
	readonly home: string;
	/** OPENCUA_HOME (default ~/.opencua): config.json, install.json, a downloaded Node.js, the installer's checkout. */
	readonly openCuaHome: string;
	readonly configPath: string;
	/** Written by install.sh: present when the installer created a checkout. */
	readonly installMarkerPath: string;
	/** OPENCUA_BIN_DIR (default ~/.local/bin): where setup puts the `opencua` launcher. */
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
	platform: NodeJS.Platform = process.platform,
): Layout {
	const home = homeDirectory(env);
	const current = join(home, ".opencua");
	const legacy = join(home, ".apple-cua");
	const defaultHome = !existsSync(current) && existsSync(legacy) ? legacy : current;
	const openCuaHome = resolve(nonEmpty(env["OPENCUA_HOME"]) ?? nonEmpty(env["APPLE_CUA_HOME"]) ?? defaultHome);
	const defaultBin =
		platform === "win32" ? join(env["LOCALAPPDATA"] ?? home, "opencua", "bin") : join(home, ".local/bin");
	const binDir = resolve(nonEmpty(env["OPENCUA_BIN_DIR"]) ?? nonEmpty(env["APPLE_CUA_BIN_DIR"]) ?? defaultBin);
	const helperApp = join(checkout, "packages/mcp/dist/opencua-mcp.app");
	const devLinkPath = join(openCuaHome, "dev-link.json");
	const devCheckout = readDevLink(devLinkPath);
	return {
		checkout,
		nativeDir: join(checkout, "packages/core/native"),
		helperApp,
		helperExecutable: platform === "darwin" ? join(helperApp, "Contents/MacOS/opencua-mcp") : process.execPath,
		server: join(devCheckout ?? checkout, "packages/mcp/dist/server.js"),
		devLinkPath,
		devCheckout,
		cli: join(checkout, "packages/cli/dist/cli.js"),
		setupScript: join(checkout, platform === "win32" ? "scripts/install.ps1" : "scripts/setup.sh"),
		helperBuildScript: join(checkout, "scripts/build-tcc-helper.sh"),
		home,
		openCuaHome,
		configPath: join(openCuaHome, "config.json"),
		installMarkerPath: join(openCuaHome, "install.json"),
		binDir,
		launcherPath: join(binDir, platform === "win32" ? "opencua.cmd" : "opencua"),
		bundleDir: join(openCuaHome, "bundle"),
		skillSource: join(checkout, "skills/opencua"),
		serverPackage: join(checkout, "packages/mcp/package.json"),
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

/**
 * The checkout recorded in dev-link.json; undefined when there is no link, it cannot be read, or the checkout is gone
 * (moved or deleted), so the registrations fall back to the installed server instead of a missing one.
 */
export function readDevLink(path: string): string | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || !("checkout" in parsed)) {
		return undefined;
	}
	if (typeof parsed.checkout !== "string" || parsed.checkout === "") {
		return undefined;
	}
	const checkout = canonicalPath(parsed.checkout);
	return existsSync(join(checkout, "packages/mcp/package.json")) ? checkout : undefined;
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
