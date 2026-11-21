import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type SpaceRecord, VirtualSpace, listSpaces, sendSpaceCommand } from "@opencua/core";
import { z } from "zod/v4";
import { textResult } from "./tool-result.js";

export interface VirtualSpaceSource {
	start(size: { readonly width: number; readonly height: number }): Promise<SpaceRecord>;
	list(): readonly SpaceRecord[];
	stop(id: string): Promise<void>;
}

export const virtualSpaceSchema = z
	.object({
		op: z.enum(["start", "status", "stop"]),
		id: z.string().min(1).optional(),
		width: z.number().int().min(640).max(7680).optional(),
		height: z.number().int().min(480).max(4320).optional(),
	})
	.strict();

/** Spaces this server starts live as long as it does: the helper's stdin is this process. */
export function nativeVirtualSpaceSource(stateDir: string): VirtualSpaceSource {
	return {
		start: async (size) => {
			if (process.platform !== "darwin") throw new Error("virtual spaces need macOS");
			return (await VirtualSpace.start({ stateDir, ...size })).record;
		},
		list: () => listSpaces(stateDir),
		stop: async (id) => await sendSpaceCommand(stateDir, id, "stop"),
	};
}

function hintFor(record: SpaceRecord): string {
	const { x, y, width, height } = record.bounds;
	if (record.takenOver) {
		return `The person has taken over space ${record.id}; input tools are refused until they press Resume. Wait.`;
	}
	return `Display ${record.displayId} spans x ${x}..${x + width}, y ${y}..${y + height} (global points); the person watches it in a picture-in-picture. Move an app window onto it with set_window_frame inside those bounds, then work there.`;
}

function spaceResult(record: SpaceRecord) {
	return { id: record.id, displayId: record.displayId, bounds: record.bounds, takenOver: record.takenOver };
}

export function registerVirtualSpaceTools(server: McpServer, source: VirtualSpaceSource): void {
	server.registerTool(
		"virtual_space",
		{
			description:
				"Agent-owned virtual display, shown to the person as a bottom-left picture-in-picture. start (width, height) creates one, status lists, stop (id) ends one.",
			inputSchema: virtualSpaceSchema,
			annotations: { readOnlyHint: false, destructiveHint: false },
		},
		async (input) => {
			switch (input.op) {
				case "start": {
					const record = await source.start({ width: input.width ?? 1920, height: input.height ?? 1080 });
					return textResult(JSON.stringify({ ...spaceResult(record), hint: hintFor(record) }));
				}
				case "status": {
					const spaces = source.list();
					return textResult(
						JSON.stringify({
							spaces: spaces.map((record) => ({ ...spaceResult(record), hint: hintFor(record) })),
							...(spaces.length === 0 ? { hint: "No virtual space is running; op start creates one." } : {}),
						}),
					);
				}
				case "stop": {
					const spaces = source.list();
					const target = input.id ?? (spaces.length === 1 ? spaces[0]?.id : undefined);
					if (target === undefined || !spaces.some((space) => space.id === target)) {
						throw new Error(
							`stop needs the id of a running space (running: ${spaces.map((space) => space.id).join(", ") || "none"})`,
						);
					}
					await source.stop(target);
					return textResult(JSON.stringify({ stopped: target }));
				}
				default: {
					const unreachable: never = input.op;
					throw new Error(`unknown op ${String(unreachable)}`);
				}
			}
		},
	);
}
