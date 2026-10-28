import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveLayout } from "./layout.js";

let root = "";
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "apple-cua-layout-")));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("#given a checkout #when layout resolves #then existing checkout paths are preserved", () => {
	it("detects the setup script and does not resolve installed packages", () => {
		mkdirSync(join(root, "scripts"));
		writeFileSync(join(root, "scripts/setup.sh"), "");
		const layout = resolveLayout({ HOME: join(root, "home") }, root, () => {
			throw new Error("must not resolve packages in checkout mode");
		});
		expect(layout.mode).toBe("checkout");
		expect(layout.server).toBe(join(root, "packages/mcp/dist/server.js"));
		expect(layout.helperApp).toBe(join(root, "packages/mcp/dist/apple-cua-mcp.app"));
		expect(layout.skillSource).toBe(join(root, "skills/apple-cua"));
	});
});

describe("#given published packages #when layout resolves #then no resource needs a checkout", () => {
	it("resolves package resources and puts the writable helper under APPLE_CUA_HOME", () => {
		const home = join(root, "home");
		const mcp = join(home, "node_modules/@apple-cua/mcp");
		const core = join(home, "node_modules/@apple-cua/core");
		const layout = resolveLayout(
			{ HOME: home, APPLE_CUA_HOME: join(home, "state"), APPLE_CUA_BIN_DIR: join(home, "bin") },
			root,
			(name) => (name === "@apple-cua/core" ? join(core, "dist/index.js") : join(mcp, "dist/server.js")),
		);
		expect(layout.mode).toBe("installed");
		expect(layout.server).toBe(join(mcp, "dist/server.js"));
		expect(layout.serverPackage).toBe(join(mcp, "package.json"));
		expect(layout.nativeDir).toBe(join(core, "native"));
		expect(layout.skillSource).toBe(join(mcp, "skills/apple-cua"));
		expect(layout.helperApp).toBe(join(home, "state/helper/apple-cua-mcp.app"));
		expect(layout.launcherPath).toBe(join(home, "bin/apple-cua"));
	});
});
