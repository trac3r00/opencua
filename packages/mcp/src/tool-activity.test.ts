import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ActivityFeed } from "@opencua/core/light";
import { activityReporter, agentLabel, describeToolCall, installToolActivity } from "./tool-activity.js";

describe("describeToolCall #given a tool call", () => {
	it("#when it names an app #then the person reads what the agent does there", () => {
		expect(describeToolCall("click", { app: "Safari" })).toBe("clicking in Safari");
		expect(describeToolCall("type_text", { app: "Notes" })).toBe("typing in Notes");
		expect(describeToolCall("get_app_state", { app: "Preview" })).toBe("looking at Preview");
		expect(describeToolCall("run_steps", { app: "Mail" })).toBe("working in Mail");
		expect(describeToolCall("list_windows", { app: "Finder" })).toBe("looking at Finder");
	});

	it("#when no app is given #then the verb stands alone", () => {
		expect(describeToolCall("list_displays", {})).toBe("looking around");
		expect(describeToolCall("scroll", undefined)).toBe("scrolling");
		expect(describeToolCall("click", {})).toBe("clicking");
	});

	it("#when it is bookkeeping #then nothing is shown", () => {
		expect(describeToolCall("get_capabilities", {})).toBeUndefined();
	});
});

describe("agentLabel #given the connected harness", () => {
	it("#when it is known or only has a client name #then the person sees its name", () => {
		expect(agentLabel({ name: "claude-code", source: "client_info" })).toBe("Claude Code");
		expect(agentLabel({ name: "unknown", source: "client_info", clientName: "my-bot" })).toBe("my-bot");
		expect(agentLabel({ name: "unknown", source: "none" })).toBe("An agent");
	});
});

describe("installToolActivity #given a server whose tools are wrapped", () => {
	let root = "";
	afterEach(() => {
		if (root !== "") rmSync(root, { recursive: true, force: true });
	});

	it("#when a tool is called #then its line lands in the feed and the result is untouched; clear removes it", async () => {
		root = mkdtempSync(join(tmpdir(), "tool-activity-"));
		const dir = join(root, "hud");
		const registered = new Map<string, (...args: unknown[]) => unknown>();
		const server = {
			registerTool: (name: string, _config: unknown, callback: (...args: unknown[]) => unknown) => {
				registered.set(name, callback);
			},
		};
		const reporter = activityReporter(new ActivityFeed(dir), () => "Claude Code", 4242);
		installToolActivity(server as unknown as McpServer, reporter);
		server.registerTool("click", { inputSchema: {} }, async (input: unknown) => ({ echoed: input }));
		const result = await registered.get("click")?.({ app: "Safari" }, {});
		expect(result).toEqual({ echoed: { app: "Safari" } });
		expect(JSON.parse(readFileSync(join(dir, "mcp-4242.json"), "utf8"))).toMatchObject({
			agent: "Claude Code",
			state: "working",
			text: "clicking in Safari",
			ttl: 20,
			pid: 4242,
		});
		reporter.clear();
		expect(JSON.parse(readFileSync(join(dir, "current.json"), "utf8"))).toEqual({ state: "idle" });
	});
});
