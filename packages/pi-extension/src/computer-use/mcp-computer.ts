import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { agentToolResult, resultPayload } from "../mcp-result.js";
import { type DisplayConfig, resolveDisplayConfig, unscaleCoord } from "./coords.js";
import {
	type ClickOptions,
	ComputerUseError,
	type ComputerUseResult,
	type KeyEntry,
	type NativeComputer,
	type Point,
} from "./native-computer.js";

export type ToolCaller = (name: string, args: Readonly<Record<string, unknown>>) => Promise<CallToolResult>;

/** The window the native tool acts on: the app last observed through the bridge, its newest token, its pixels. */
export interface ObservedWindow {
	readonly app: string;
	/** The newest one-use observation_token; undefined once an answer about the app came back without one. */
	readonly token: string | undefined;
	/** The screenshot coordinate space of the observation behind the token. */
	readonly display: DisplayConfig | undefined;
}

/**
 * Before anything is observed there is no window, so no size is right: the WXGA size Anthropic recommends is
 * declared until the first screenshot replaces it. No coordinate action can run in that state.
 */
export const UNOBSERVED_DISPLAY: DisplayConfig = {
	logicalWidth: 1280,
	logicalHeight: 800,
	modelWidth: 1280,
	modelHeight: 800,
};

const SUMMARY_KEYS = ["app", "bundleId", "windowTitle", "screenshotWidth", "screenshotHeight"] as const;
/** get_app_state notes that change what a screenshot means; they stay when the element tree is left out. */
const NOTE_KEYS = [
	"note",
	"axNote",
	"screenshotNote",
	"windowContentNote",
	"systemPrompts",
	"systemPromptNote",
] as const;

const NO_TARGET =
	"no app window is targeted yet. Call get_app_state with the app to control (list_apps shows what is running, open_app launches one); computer then acts on that window.";

/**
 * Follows every tools/call answer that names an app: the newest observation_token becomes the native tool's
 * authority and that app becomes its target. An answer without a token (a refusal, a pause, a changed context)
 * withdraws the authority, so the next action needs a fresh screenshot instead of a guess.
 */
export class ObservedTarget {
	private observed: ObservedWindow | undefined;

	current(): ObservedWindow | undefined {
		return this.observed;
	}

	record(args: Readonly<Record<string, unknown>>, result: CallToolResult): void {
		const app = args["app"];
		if (typeof app !== "string" || app.trim() === "") {
			return;
		}
		const current = this.observed;
		const sameApp = current !== undefined && sameAppName(current.app, app);
		const payload = resultPayload(result);
		const token = payload?.["observation_token"];
		if (result.isError === true || typeof token !== "string" || token === "") {
			if (sameApp) {
				this.observed = { ...current, token: undefined };
			}
			return;
		}
		this.observed = { app, token, display: displayOf(payload) ?? (sameApp ? current.display : undefined) };
	}

	/** The server restarted: the tokens it issued are void. */
	forgetToken(): void {
		if (this.observed !== undefined) {
			this.observed = { ...this.observed, token: undefined };
		}
	}
}

/**
 * The native computer-use actions as guarded opencua-mcp calls on the targeted window. Every call goes through
 * the bridge, so the server's token, allowlist, delivery and stop-switch guards apply exactly as for the MCP tools.
 */
export class McpComputer implements NativeComputer {
	constructor(
		private readonly call: ToolCaller,
		private readonly target: ObservedTarget,
		private readonly delay: (milliseconds: number) => Promise<void> = sleep,
	) {}

	/** The display declared to the model: the latest screenshot of the target window. */
	display(): DisplayConfig {
		return this.target.current()?.display ?? UNOBSERVED_DISPLAY;
	}

	async screenshot(): Promise<ComputerUseResult> {
		const app = this.target.current()?.app;
		if (app === undefined) {
			throw new ComputerUseError("needs_observation", `computer screenshot: ${NO_TARGET}`, { action: "screenshot" });
		}
		const result = await this.call("get_app_state", { app, element_format: "table" });
		const image = agentToolResult(result).content.find((item) => item.type === "image");
		const payload = resultPayload(result) ?? {};
		const summary = { ...pick(payload, SUMMARY_KEYS), ...pick(payload, NOTE_KEYS) };
		if (image === undefined) {
			throw new ComputerUseError(
				"execution_failed",
				`computer screenshot: get_app_state returned no image of ${app}: ${JSON.stringify(summary)}`,
				{ action: "screenshot" },
			);
		}
		return { content: [image, { type: "text", text: JSON.stringify(summary) }], details: undefined };
	}

	async click(point: Point, options: ClickOptions): Promise<ComputerUseResult> {
		const { app, token, display } = this.observedWindow("click");
		const at = unscaleCoord(point, display);
		return await this.act("click", {
			app,
			observation_token: token,
			x: at.x,
			y: at.y,
			...(options.count === 1 ? {} : { click_count: options.count }),
			...(options.button === "left" ? {} : { mouse_button: options.button }),
			...(options.modifiers.length === 0 ? {} : { modifiers: [...options.modifiers] }),
		});
	}

	async drag(from: Point, to: Point): Promise<ComputerUseResult> {
		const { app, token, display } = this.observedWindow("drag");
		const start = unscaleCoord(from, display);
		const end = unscaleCoord(to, display);
		return await this.act("drag", {
			app,
			observation_token: token,
			from_x: start.x,
			from_y: start.y,
			to_x: end.x,
			to_y: end.y,
		});
	}

	async typeText(text: string): Promise<ComputerUseResult> {
		const { app, token } = this.authority("type");
		return await this.act("type_text", { app, observation_token: token, text });
	}

	async pressKeys(keys: readonly KeyEntry[]): Promise<ComputerUseResult> {
		const { app, token } = this.authority("key");
		return await this.act("press_keys", { app, observation_token: token, keys: [...keys] });
	}

	async wait(milliseconds: number): Promise<void> {
		await this.delay(milliseconds);
	}

	private async act(name: string, args: Readonly<Record<string, unknown>>): Promise<ComputerUseResult> {
		return agentToolResult(await this.call(name, args));
	}

	private authority(action: string): { readonly app: string; readonly token: string } {
		const observed = this.target.current();
		if (observed === undefined) {
			throw new ComputerUseError("needs_observation", `computer ${action}: ${NO_TARGET}`, { action });
		}
		if (observed.token === undefined) {
			throw new ComputerUseError(
				"needs_observation",
				`computer ${action}: ${observed.app} has no current observation (the last answer about it carried no observation_token, or the server restarted). Take a screenshot to observe it again before acting.`,
				{ action },
			);
		}
		return { app: observed.app, token: observed.token };
	}

	private observedWindow(action: string): {
		readonly app: string;
		readonly token: string;
		readonly display: DisplayConfig;
	} {
		const { app, token } = this.authority(action);
		const display = this.target.current()?.display;
		if (display === undefined) {
			throw new ComputerUseError(
				"needs_observation",
				`computer ${action}: there is no screenshot of ${app} to aim at. Take a screenshot first.`,
				{ action },
			);
		}
		return { app, token, display };
	}
}

/**
 * get_app_state caps the window image at the same 2560 px long edge resolveDisplayConfig applies, so for every
 * image the server sends the declared display is the image itself and model coordinates map 1:1 onto the
 * server's screenshot coordinates.
 */
function displayOf(payload: Readonly<Record<string, unknown>> | undefined): DisplayConfig | undefined {
	const width = payload?.["screenshotWidth"];
	const height = payload?.["screenshotHeight"];
	if (typeof width !== "number" || typeof height !== "number" || !(width > 0 && height > 0)) {
		return undefined;
	}
	return Number.isFinite(width) && Number.isFinite(height) ? resolveDisplayConfig({ width, height }) : undefined;
}

function sameAppName(left: string, right: string): boolean {
	return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function pick(payload: Readonly<Record<string, unknown>>, keys: readonly string[]): Record<string, unknown> {
	return Object.fromEntries(keys.flatMap((key): [string, unknown][] => (key in payload ? [[key, payload[key]]] : [])));
}

async function sleep(milliseconds: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
