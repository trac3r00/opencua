import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ActivityFeed } from "@opencua/core/light";
import type { HostInfo } from "./host-detection.js";

// Puts "Claude Code · clicking in Safari" on the person's status pill while an agent drives their Mac through this
// server, so work happening in the background is never invisible.

const HOST_LABELS: Record<HostInfo["name"], string> = {
	omo: "OmO",
	"claude-code": "Claude Code",
	codex: "Codex",
	pi: "Pi",
	openclaw: "OpenClaw",
	hermes: "Hermes",
	gemini: "Gemini",
	cursor: "Cursor",
	unknown: "An agent",
};

/** Seconds an agent's line stays up after its last call. */
export const ACTIVITY_TTL_S = 20;

/** Bookkeeping calls say nothing about work on screen. */
const QUIET_TOOLS = new Set(["get_capabilities", "tool_usage", "ask_user"]);

export function agentLabel(host: HostInfo): string {
	if (host.name === "unknown" && host.clientName !== undefined && host.clientName.trim().length > 0) {
		return host.clientName.trim();
	}
	return HOST_LABELS[host.name];
}

function appOf(input: unknown): string | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const app = (input as Record<string, unknown>)["app"];
	return typeof app === "string" && app.trim().length > 0 ? app.trim() : undefined;
}

const VERBS: readonly (readonly [RegExp, string])[] = [
	[/^(get_app_state|find_elements|analyze_screen|verify_state|read_|get_)/, "looking at"],
	[/^list_/, "looking around"],
	[/click|tap|press_button/, "clicking in"],
	[/type|set_value|key|paste/, "typing in"],
	[/scroll/, "scrolling"],
	[/drag/, "dragging in"],
	[/^open_/, "opening"],
	[/^run_|worker|steps|hands|script/, "working in"],
];

export function describeToolCall(name: string, input: unknown): string | undefined {
	if (QUIET_TOOLS.has(name)) return undefined;
	const app = appOf(input);
	const verb = VERBS.find(([pattern]) => pattern.test(name))?.[1];
	if (verb === "looking around") return app === undefined ? verb : `looking at ${app}`;
	if (verb !== undefined) return app === undefined ? verb.replace(/ (in|at)$/, "") : `${verb} ${app}`;
	const words = name.replace(/_/g, " ");
	return app === undefined ? words : `${words} · ${app}`;
}

export interface ActivityReporter {
	readonly report: (name: string, input: unknown) => void;
	readonly clear: () => void;
}

export function activityReporter(feed: ActivityFeed, agent: () => string, pid: number = process.pid): ActivityReporter {
	const source = `mcp-${pid}`;
	return {
		report: (name, input) => {
			const text = describeToolCall(name, input);
			if (text === undefined) return;
			try {
				feed.write({ source, agent: agent(), state: "working", text, ttl: ACTIVITY_TTL_S, pid });
			} catch {}
		},
		clear: () => {
			try {
				feed.clear(source);
			} catch {}
		},
	};
}

type ToolHandler = (...args: unknown[]) => unknown;
type RegisterToolLike = (name: string, config: { readonly inputSchema?: unknown }, callback: ToolHandler) => unknown;

export function installToolActivity(server: McpServer, reporter: ActivityReporter): void {
	const original = server.registerTool.bind(server) as unknown as RegisterToolLike;
	server.registerTool = ((name: string, config: { readonly inputSchema?: unknown }, callback: ToolHandler) => {
		const wrapped: ToolHandler = (...invocation: unknown[]) => {
			reporter.report(name, config.inputSchema === undefined ? undefined : invocation[0]);
			return Reflect.apply(callback, undefined, invocation);
		};
		return original(name, config, wrapped);
	}) as unknown as McpServer["registerTool"];
}
