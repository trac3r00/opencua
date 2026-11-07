import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	type GuardedComputerInterface,
	closeOwnedSurface,
	listenToSurface,
	openOwnedSurface,
	readOwnedSurfaces,
} from "@opencua/core";
import { z } from "zod/v4";
import { textResult } from "./tool-result.js";

const WINDOW_WAIT_MS = 8_000;

/**
 * Owned surfaces are windows opencua opens on the person's desktop and alone may drive: the person's own apps, mouse,
 * keyboard focus and Spaces stay untouched. Open one, then observe and act on it by its pid like any app.
 */
export function registerSurfaceTools(server: McpServer, computer: GuardedComputerInterface): void {
	server.registerTool(
		"surface",
		{
			description:
				"Open (url, frame [x,y,w,h]), close (pid) or listen (pid, duration_ms: audio level) to an opencua-owned web window, kept behind the person's windows and never focused. Use its pid as app.",
			inputSchema: z
				.object({
					op: z.enum(["open", "close", "listen"]),
					url: z.string().optional(),
					frame: z.array(z.number().int()).length(4).optional(),
					pid: z.number().int().optional(),
					duration_ms: z.number().int().min(50).max(10_000).optional(),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false },
		},
		async (input) => {
			if (input.op === "listen") {
				if (input.pid === undefined) throw new Error("listen needs pid");
				return textResult(JSON.stringify(await listenToSurface(input.pid, input.duration_ms ?? 1_000)));
			}
			if (input.op === "close") {
				if (input.pid === undefined || !closeOwnedSurface(input.pid)) {
					throw new Error(`pid ${input.pid ?? "(missing)"} is not an open owned surface`);
				}
				return textResult(
					JSON.stringify({ closed: input.pid, open: readOwnedSurfaces().map((surface) => surface.pid) }),
				);
			}
			const [x, y, width, height] = input.frame ?? [];
			if (input.url === undefined || !/^https?:\/\//.test(input.url)) throw new Error("open needs an http(s) url");
			if (
				x === undefined ||
				y === undefined ||
				width === undefined ||
				height === undefined ||
				width < 200 ||
				height < 150
			) {
				throw new Error("open needs frame [x, y, width >= 200, height >= 150]");
			}
			const surface = openOwnedSurface({
				url: input.url,
				title: "opencua",
				frame: { x, y, width, height },
			});
			const deadline = Date.now() + WINDOW_WAIT_MS;
			while (Date.now() < deadline) {
				if ((await computer.listApps()).some((app) => app.pid === surface.pid)) {
					return textResult(JSON.stringify({ pid: surface.pid, app: String(surface.pid), title: surface.title }));
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			closeOwnedSurface(surface.pid);
			throw new Error(`owned surface ${surface.pid} did not show a window within ${WINDOW_WAIT_MS} ms`);
		},
	);
}
