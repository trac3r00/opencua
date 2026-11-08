// `opencua dev link`: every MCP client keeps running the installed, permission-granted helper, but the helper runs a
// developer checkout's server.js. The helper's supervisor restarts the server when that checkout's mcp or core dist
// changes, so `pnpm dev` there (a watch build) puts each saved edit in front of the agent without a reinstall, a
// helper rebuild or a reconnect.

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Layout, canonicalPath } from "./layout.js";

export type DevLinkOutcome =
	| { readonly ok: true; readonly checkout: string }
	| { readonly ok: false; readonly error: string };

/** Records `target` as the checkout whose server.js the registrations run, after checking it can run. */
export function linkDevCheckout(layout: Pick<Layout, "checkout" | "devLinkPath">, target: string): DevLinkOutcome {
	const checkout = canonicalPath(target);
	if (checkout === layout.checkout) {
		return { ok: false, error: `${checkout} is the installed checkout itself; opencua dev unlink returns to it` };
	}
	if (!existsSync(join(checkout, "packages/mcp/package.json"))) {
		return { ok: false, error: `${checkout} is not an opencua checkout (it has no packages/mcp/package.json)` };
	}
	if (!existsSync(join(checkout, "packages/mcp/node_modules"))) {
		return { ok: false, error: `${checkout} has no dependencies installed yet; run: pnpm -C "${checkout}" install` };
	}
	if (!existsSync(join(checkout, "packages/mcp/dist/server.js"))) {
		return {
			ok: false,
			error: `${checkout} has no packages/mcp/dist/server.js yet; start its watch build: pnpm -C "${checkout}" dev`,
		};
	}
	mkdirSync(dirname(layout.devLinkPath), { recursive: true });
	const temporary = `${layout.devLinkPath}.tmp-${process.pid}`;
	writeFileSync(temporary, `${JSON.stringify({ checkout }, null, "\t")}\n`);
	renameSync(temporary, layout.devLinkPath);
	return { ok: true, checkout };
}

export function unlinkDevCheckout(layout: Pick<Layout, "devLinkPath">): boolean {
	const linked = existsSync(layout.devLinkPath);
	rmSync(layout.devLinkPath, { force: true });
	return linked;
}
