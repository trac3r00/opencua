import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HostCapabilities, InputDelivery, StopStatus, StopStatusSource } from "@opencua/core";
import { z } from "zod/v4";
import { type HostInfo, detectHost, spawnGuidance } from "./host-detection.js";
import { SERVER_INFO } from "./server-info.js";
import { toolNamesFor } from "./tool-names.js";
import { textResult } from "./tool-result.js";
import type { ToolUsageSnapshot } from "./tool-timing.js";
import type { ToolsetProfile } from "./toolset.js";

const STOP_CHORD = "Control+Option+Command (hold together)";
const PACKAGE_SKILL_DIR = fileURLToPath(new URL("../skills/opencua/", import.meta.url));
const CHECKOUT_SKILL_DIR = fileURLToPath(new URL("../../../skills/opencua/", import.meta.url));

/** Prefer the skill copied into the package at pack time; fall back to the repository checkout. */
export function resolveSkillDir(
	packageDir: string = PACKAGE_SKILL_DIR,
	checkoutDir: string = CHECKOUT_SKILL_DIR,
	exists: (path: string) => boolean = existsSync,
): string {
	return exists(join(packageDir, "SKILL.md")) ? packageDir : checkoutDir;
}

export const DEFAULT_SKILL_DIR = resolveSkillDir();

export interface CapabilitySources {
	readonly delivery: InputDelivery | undefined;
	readonly probeHost: () => HostCapabilities;
	readonly allowedBundleIds: readonly string[] | undefined;
	readonly stop?: StopStatusSource | undefined;
	/** The registered toolset profile; defaults to the full desktop set. */
	readonly toolset?: ToolsetProfile | undefined;
	/** Names of the tools this server registered; defaults to the full desktop set. */
	readonly toolNames?: readonly string[] | undefined;
	/** Which agent harness is connected, from the client's initialize clientInfo or its environment. */
	readonly host?: (() => HostInfo) | undefined;
	/** This server session's tool-call counts, bytes, and latency quantiles. */
	readonly toolUsage?: (() => ToolUsageSnapshot) | undefined;
}

type SessionMode = "console" | "remote" | "locked" | "unknown";

function sessionMode(host: HostCapabilities): SessionMode {
	if (host.session.screenLocked) {
		return "locked";
	}
	if (host.session.onConsole === undefined) {
		return "unknown";
	}
	return host.session.onConsole ? "console" : "remote";
}

function adviceFor(
	host: HostCapabilities,
	mode: SessionMode,
	allowed: readonly string[] | undefined,
	stop: StopStatus | undefined,
): string[] {
	const advice: string[] = [];
	if (stop?.stopped === true) {
		advice.push(
			"The user stopped computer use. Do not act or retry; tell the user. Only they resume (opencua resume).",
		);
	}
	if (!host.permissions.accessibility) {
		advice.push(
			"Accessibility is not granted to the process that launched this server: no observation or input will work. Ask the user to grant it in System Settings > Privacy & Security > Accessibility, then restart the server.",
		);
	}
	if (!host.permissions.screenRecording) {
		advice.push(
			"Screen Recording is not granted: screenshots are unavailable, but accessibility observation and element actions still work.",
		);
	}
	if (allowed?.length === 0) {
		advice.push("No app is approved for observation or input. The user sets OPENCUA_ALLOWED_BUNDLE_IDS.");
	}
	if (mode === "locked") {
		advice.push("The screen is locked: windows report no content. Use ask_user with reason screen_locked.");
	}
	if (mode === "remote") {
		advice.push(
			"This session is reached remotely while another user owns the console: Save/Open panels and some web content may not render. Prefer accessibility actions and report needs-user for steps that cannot be reached.",
		);
	}
	return advice;
}

export function capabilityReport(sources: CapabilitySources): Record<string, unknown> {
	const host = sources.probeHost();
	const mode = sessionMode(host);
	const stop = sources.stop?.status();
	const delivery = "background";
	const toolNames = sources.toolNames ?? toolNamesFor("full", false);
	const agentHost = sources.host?.() ?? detectHost(undefined, process.env);
	return {
		server: {
			name: SERVER_INFO.name,
			version: SERVER_INFO.version,
			toolset: sources.toolset ?? "full",
			tools: toolNames.length,
		},
		host: { ...agentHost, workers: spawnGuidance(agentHost.name, delivery) },
		platform: process.platform,
		backend: "macos-native",
		input: { supported: true, scope: "allowed-apps", route: "per-process-background" },
		capture: { supported: true, scope: "allowed-apps" },
		permissions: host.permissions,
		session: { ...host.session, mode },
		mainDisplay: host.mainDisplay,
		delivery: {
			mode: delivery,
			requestedMode: sources.delivery ?? "background",
			modes: ["background"],
			focusGuard:
				"input goes to the target app's process in the background; the front app, window stacking and the physical pointer are never changed (global HID input, pointer warps and focus or raise primitives are refused)",
		},
		approval: { allowedBundleIds: sources.allowedBundleIds ?? null },
		stop: {
			...(stop ?? { stopped: false }),
			armed: sources.stop !== undefined,
			chord: STOP_CHORD,
			resume: "opencua resume",
		},
		advice: adviceFor(host, mode, sources.allowedBundleIds, stop),
	};
}

const EMPTY_USAGE: ToolUsageSnapshot = {
	since: 0,
	calls: 0,
	errors: 0,
	total_bytes: 0,
	p50_ms: 0,
	p95_ms: 0,
	max_ms: 0,
	slowest_ms: 0,
	by_tool: {},
};

export function registerCapabilityTools(server: McpServer, sources: CapabilitySources): void {
	server.registerTool(
		"get_tool_usage",
		{
			description:
				"Read-only session usage: tool calls, errors, bytes, p50/p95/max latency, and per-tool counts. The current call is counted after this answer is built. No observation token is needed.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, destructiveHint: false },
		},
		async () => textResult(JSON.stringify(sources.toolUsage?.() ?? EMPTY_USAGE)),
	);

	server.registerTool(
		"get_capabilities",
		{
			description:
				"Read-only, one call: what this server can do on this Mac right now, without raising a permission prompt. Reports Accessibility and Screen Recording permission, whether the screen is locked and whether the session owns the console or is reached remotely, the main display size, the input delivery mode and its focus guarantee, which apps are approved, and whether the user has pressed the stop switch. advice lists what blocks work and what to tell the user. Call it first when a task fails for an unclear reason, before retrying.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, destructiveHint: false },
		},
		async () => textResult(JSON.stringify(capabilityReport(sources))),
	);
}

export function registerSkillResources(server: McpServer, skillDir: string = DEFAULT_SKILL_DIR): readonly string[] {
	const skillPath = join(skillDir, "SKILL.md");
	if (!existsSync(skillPath)) {
		return [];
	}
	const files: { readonly uri: string; readonly path: string; readonly name: string }[] = [
		{ uri: "skill://opencua/SKILL.md", path: skillPath, name: "opencua-skill" },
	];
	const referencesDir = join(skillDir, "references");
	const references = existsSync(referencesDir) ? readdirSync(referencesDir).sort() : [];
	for (const entry of references.filter((name) => name.endsWith(".md"))) {
		files.push({
			uri: `skill://opencua/references/${entry}`,
			path: join(referencesDir, entry),
			name: `opencua-reference-${entry.slice(0, -3)}`,
		});
	}
	for (const file of files) {
		server.registerResource(
			file.name,
			file.uri,
			{ mimeType: "text/markdown", description: `opencua operating guide: ${file.uri.slice("skill://".length)}` },
			async (uri) => ({
				contents: [{ uri: uri.href, mimeType: "text/markdown", text: readFileSync(file.path, "utf8") }],
			}),
		);
	}
	return files.map((file) => file.uri);
}
