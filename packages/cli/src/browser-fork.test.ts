import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ForkDeps, buildFork, connectedBrowsers, linkBsk, locateFork } from "./browser-fork.js";

function deps(files: readonly string[], outputs: Record<string, string> = {}): ForkDeps & { readonly ran: string[] } {
	const ran: string[] = [];
	return {
		ran,
		exists: (path) => files.some((file) => path === file || file.startsWith(`${path}/`)),
		run: async (command, args) => {
			const line = [command, ...args].join(" ");
			ran.push(line);
			if (outputs[line] === undefined && line.endsWith("--json")) throw new Error("daemon not running");
			return outputs[line] ?? "";
		},
		home: "/home",
		env: {},
	};
}

const FORK = "/home/Developer/opencua-browser";
const FORK_FILES = [`${FORK}/Cargo.toml`, `${FORK}/apps/extension/package.json`];

describe("locateFork", () => {
	it("#given OPENCUA_BROWSER_HOME and the default checkout #when locating #then the configured one wins", () => {
		const configured = "/opt/ocb";
		const fake = {
			...deps([...FORK_FILES, `${configured}/Cargo.toml`, `${configured}/apps/extension/package.json`]),
			env: { OPENCUA_BROWSER_HOME: configured },
		};

		expect(locateFork(fake)?.root).toBe(configured);
		expect(locateFork(deps(FORK_FILES))?.root).toBe(FORK);
		expect(locateFork(deps([]))).toBeUndefined();
	});
});

describe("buildFork", () => {
	it("#given a fork with nothing built #when building #then it builds the CLI and the extension", async () => {
		const fake = deps(FORK_FILES);
		const layout = locateFork(fake);
		if (layout === undefined) throw new Error("fork not found");

		expect(await buildFork(layout, () => undefined, fake)).toEqual(["bsk", "extension"]);
		expect(fake.ran).toEqual([
			"cargo build -p bsk --release --locked",
			"pnpm install --frozen-lockfile",
			"pnpm ext:build",
		]);
	});

	it("#given both already built #when building #then nothing runs", async () => {
		const fake = deps([
			...FORK_FILES,
			`${FORK}/target/release/bsk`,
			`${FORK}/apps/extension/dist/chrome-mv3/manifest.json`,
		]);
		const layout = locateFork(fake);
		if (layout === undefined) throw new Error("fork not found");

		expect(await buildFork(layout, () => undefined, fake)).toEqual([]);
		expect(fake.ran).toEqual([]);
	});
});

describe("connectedBrowsers", () => {
	it("#given bsk lists one profile #when asked #then it is connected, and a stopped daemon reads as none", async () => {
		const layout = { root: FORK, bsk: `${FORK}/target/release/bsk`, extension: "x" };
		const listed = deps(FORK_FILES, {
			[`${layout.bsk} browsers --json`]: JSON.stringify([{ instance_id: "a1b2c3d4", label: "Brave" }]),
		});

		expect(await connectedBrowsers(layout, listed)).toHaveLength(1);
		expect(await connectedBrowsers(layout, deps(FORK_FILES))).toEqual([]);
	});
});

describe("linkBsk", () => {
	const homes: string[] = [];
	afterEach(() => {
		for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
	});

	it("#given no bsk on PATH #when linking #then ~/.local/bin/bsk points at the fork, and a foreign file is kept", () => {
		const home = mkdtempSync(join(tmpdir(), "ocb-link-"));
		homes.push(home);
		const layout = { root: FORK, bsk: `${FORK}/target/release/bsk`, extension: "x" };

		expect(linkBsk(layout, home)).toEqual({ path: join(home, ".local/bin/bsk"), linked: true });
		expect(readlinkSync(join(home, ".local/bin/bsk"))).toBe(layout.bsk);
		expect(linkBsk(layout, home).linked).toBe(true);

		rmSync(join(home, ".local/bin/bsk"));
		writeFileSync(join(home, ".local/bin/bsk"), "#!/bin/sh\n");
		expect(linkBsk(layout, home).linked).toBe(false);
	});
});
