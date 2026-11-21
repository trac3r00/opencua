import type { DisplaySpaceEntry, GuardedComputerInterface } from "@opencua/core";
import { type ToolResult, textResult } from "./tool-result.js";

export interface DisplayListSources {
	/** Undefined when this host has no display listing, or when it could not be read. */
	readonly displays: (() => readonly DisplaySpaceEntry[] | undefined) | undefined;
	readonly computer: Pick<GuardedComputerInterface, "getCursorPosition" | "listApps">;
	/** The person's own pointer; without it the computer's cursor (in background mode, the agent's) is used. */
	readonly personPointer?: () => { readonly x: number; readonly y: number };
}

/** Every online display, which one holds the cursor, and the app in front. Reading them posts no input. */
export async function listDisplaysResult(sources: DisplayListSources): Promise<ToolResult> {
	const displays = sources.displays?.();
	if (displays === undefined) {
		throw new Error("The display layout could not be read on this host.");
	}
	const cursor = sources.personPointer?.() ?? (await sources.computer.getCursorPosition());
	const frontmost = (await sources.computer.listApps()).find((app) => app.isFrontmost === true);
	return textResult(
		JSON.stringify({
			displays: displays.map((display) => ({
				id: display.id,
				main: display.isMain === true,
				x: display.x,
				y: display.y,
				width: display.width,
				height: display.height,
				scale_factor: display.scaleFactor,
				...(display.activeSpaceId === undefined ? {} : { active_space_id: display.activeSpaceId }),
				has_cursor:
					cursor.x >= display.x &&
					cursor.x < display.x + display.width &&
					cursor.y >= display.y &&
					cursor.y < display.y + display.height,
			})),
			...(frontmost === undefined
				? {}
				: { frontmost_app: { name: frontmost.name, pid: frontmost.pid, bundle_id: frontmost.bundleId } }),
		}),
	);
}
