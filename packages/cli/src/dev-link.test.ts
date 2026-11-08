import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkDevCheckout, unlinkDevCheckout } from "./dev-link.js";
import { resolveLayout } from "./layout.js";

let root = "";
let installed = "";
let developer = "";
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "opencua-dev-link-")));
	installed = join(root, "installed");
	developer = join(root, "developer");
	mkdirSync(installed);
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function makeCheckout(path: string, parts: { readonly modules: boolean; readonly server: boolean }): void {
	mkdirSync(join(path, "packages/mcp/dist"), { recursive: true });
	writeFileSync(join(path, "packages/mcp/package.json"), "{}\n");
	if (parts.modules) mkdirSync(join(path, "packages/mcp/node_modules"));
	if (parts.server) writeFileSync(join(path, "packages/mcp/dist/server.js"), "\n");
}

function layout() {
	return resolveLayout({ HOME: root, OPENCUA_HOME: join(root, "home") }, installed, "darwin");
}

describe("#given a built developer checkout #when it is linked #then registrations run its server through the installed helper", () => {
	it("switches the server and keeps the helper, and unlink switches back", () => {
		makeCheckout(developer, { modules: true, server: true });

		const outcome = linkDevCheckout(layout(), developer);
		const linked = layout();

		expect(outcome).toEqual({ ok: true, checkout: developer });
		expect(linked.devCheckout).toBe(developer);
		expect(linked.server).toBe(join(developer, "packages/mcp/dist/server.js"));
		expect(linked.helperExecutable).toBe(
			join(installed, "packages/mcp/dist/opencua-mcp.app/Contents/MacOS/opencua-mcp"),
		);
		expect(JSON.parse(readFileSync(linked.devLinkPath, "utf8"))).toEqual({ checkout: developer });

		expect(unlinkDevCheckout(linked)).toBe(true);
		expect(layout().server).toBe(join(installed, "packages/mcp/dist/server.js"));
		expect(unlinkDevCheckout(layout())).toBe(false);
	});
});

describe("#given a checkout that cannot run yet #when it is linked #then the link is refused and nothing is written", () => {
	it.each([
		{
			name: "the installed checkout itself",
			target: () => installed,
			parts: undefined,
			reason: "installed checkout itself",
		},
		{
			name: "a directory without opencua",
			target: () => developer,
			parts: undefined,
			reason: "not an opencua checkout",
		},
		{
			name: "a checkout without dependencies",
			target: () => developer,
			parts: { modules: false, server: true },
			reason: "no dependencies installed",
		},
		{
			name: "a checkout without a built server",
			target: () => developer,
			parts: { modules: true, server: false },
			reason: "start its watch build",
		},
	])("refuses $name", ({ target, parts, reason }) => {
		mkdirSync(developer, { recursive: true });
		if (parts !== undefined) makeCheckout(developer, parts);

		const outcome = linkDevCheckout(layout(), target());

		expect(outcome.ok).toBe(false);
		expect(outcome.ok ? "" : outcome.error).toContain(reason);
		expect(existsSync(layout().devLinkPath)).toBe(false);
	});
});

describe("#given an unreadable dev-link.json #when the layout resolves #then the installed server is used", () => {
	it.each(["not json", "[]", '{"checkout":""}', '{"checkout":7}'])("ignores %s", (content) => {
		mkdirSync(join(root, "home"), { recursive: true });
		writeFileSync(join(root, "home/dev-link.json"), content);

		expect(layout().devCheckout).toBeUndefined();
		expect(layout().server).toBe(join(installed, "packages/mcp/dist/server.js"));
	});
});
