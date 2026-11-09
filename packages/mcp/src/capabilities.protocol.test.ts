import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HostCapabilities, StopStatus } from "@opencua/core";
import { z } from "zod/v4";
import {
	type CapabilitySources,
	DEFAULT_SKILL_DIR,
	registerCapabilityTools,
	registerSkillResources,
} from "./capability-tools.js";

const GRANTED_HOST: HostCapabilities = {
	permissions: { accessibility: true, screenRecording: true },
	session: { screenLocked: false, onConsole: true },
	mainDisplay: { logical: { width: 1512, height: 982 }, pixels: { width: 3024, height: 1964 } },
};

async function connect(register: (server: McpServer) => void): Promise<Client> {
	const server = new McpServer({ name: "capabilities-test", version: "0.0.0" });
	register(server);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	const client = new Client({ name: "capabilities-test-client", version: "0.0.0" });
	await client.connect(clientTransport);
	return client;
}

const reportSchema = z.object({
	host: z.object({ workers: z.object({ concurrent: z.boolean() }) }),
	backend: z.string(),
	input: z.object({ supported: z.boolean(), scope: z.string(), route: z.string() }),
	capture: z.object({ supported: z.boolean(), scope: z.string() }),
	permissions: z.unknown(),
	session: z.unknown(),
	delivery: z.unknown(),
	approval: z.unknown(),
	stop: z.unknown(),
	advice: z.array(z.string()),
});

async function report(sources: CapabilitySources): Promise<z.infer<typeof reportSchema>> {
	const client = await connect((server) => registerCapabilityTools(server, sources));
	const result = await client.callTool({ name: "get_capabilities", arguments: {} });
	const content = result.content;
	if (!Array.isArray(content) || content[0]?.type !== "text") {
		throw new Error("get_capabilities answered without text");
	}
	return reportSchema.parse(JSON.parse(String(content[0].text)));
}

const temporaryDirs: string[] = [];

afterEach(() => {
	for (const dir of temporaryDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("#given a fully permitted console session #when capabilities are read #then allowed host apps take background input", () => {
	it("reports per-process background input and capture with no blocker", async () => {
		const body = await report({
			delivery: "background",
			probeHost: () => GRANTED_HOST,
			allowedBundleIds: undefined,
		});

		expect(body.approval).toEqual({ allowedBundleIds: null });
		expect(body.backend).toBe("macos-native");
		expect(body.input).toEqual({ supported: true, scope: "allowed-apps", route: "per-process-background" });
		expect(body.capture).toEqual({ supported: true, scope: "allowed-apps" });
		expect(body.advice).toEqual([]);
	});

	it("reports permissions, console mode, delivery and approval", async () => {
		const body = await report({
			delivery: "background",
			probeHost: () => GRANTED_HOST,
			allowedBundleIds: ["com.apple.calculator"],
			stop: { status: (): StopStatus => ({ stopped: false }) },
		});
		expect(body.permissions).toEqual({ accessibility: true, screenRecording: true });
		expect(body.session).toMatchObject({ mode: "console", screenLocked: false });
		expect(body.delivery).toMatchObject({ mode: "background" });
		expect(body.approval).toEqual({ allowedBundleIds: ["com.apple.calculator"] });
		expect(body.stop).toMatchObject({ stopped: false, armed: true });
		expect(body.input.supported).toBe(true);
		expect(body.host.workers.concurrent).toBe(true);
		expect(body.advice).toEqual([]);
	});

	it("advertises attended input through the global HID tap when attended is chosen", async () => {
		const body = await report({
			delivery: "attended",
			probeHost: () => GRANTED_HOST,
			allowedBundleIds: undefined,
		});
		expect(body.delivery).toMatchObject({
			mode: "attended",
			requestedMode: "attended",
			modes: ["background", "attended"],
		});
		expect(body.input.route).toBe("global-hid-attended");
		expect(body.host.workers.concurrent).toBe(false);
	});
});

describe("#given missing permissions, a remote session and a user stop #when get_capabilities is called #then advice names each blocker", () => {
	it("explains every blocker", async () => {
		const body = await report({
			delivery: undefined,
			probeHost: () => ({
				...GRANTED_HOST,
				permissions: { accessibility: false, screenRecording: false },
				session: { screenLocked: false, onConsole: false },
			}),
			allowedBundleIds: [],
			stop: {
				status: (): StopStatus => ({
					stopped: true,
					stoppedAt: "2026-10-05T12:00:00.000Z",
					reason: "test",
					source: "cli",
				}),
			},
		});
		expect(body.session).toMatchObject({ mode: "remote" });
		expect(body.delivery).toMatchObject({ mode: "background" });
		expect(body.stop).toMatchObject({ stopped: true, source: "cli" });
		expect(body.advice).toHaveLength(5);
	});
});

describe("#given a locked screen and no stop switch #when get_capabilities is called #then mode is locked and the switch is unarmed", () => {
	it("reports locked", async () => {
		const body = await report({
			delivery: "background",
			probeHost: () => ({ ...GRANTED_HOST, session: { screenLocked: true, onConsole: true } }),
			allowedBundleIds: ["com.apple.TextEdit"],
		});
		expect(body.session).toMatchObject({ mode: "locked" });
		expect(body.stop).toMatchObject({ stopped: false, armed: false });
	});
});

describe("#given the repository skill #when resources are listed and read #then SKILL.md is served byte-equal", () => {
	it("serves SKILL.md and its references", async () => {
		const client = await connect((server) => {
			registerSkillResources(server);
		});
		const listed = await client.listResources();
		const uris = listed.resources.map((resource) => resource.uri);
		expect(uris).toContain("skill://opencua/SKILL.md");
		expect(uris.some((uri) => uri.startsWith("skill://opencua/references/"))).toBe(true);
		const read = await client.readResource({ uri: "skill://opencua/SKILL.md" });
		const first = read.contents[0];
		expect(first !== undefined && "text" in first ? first.text : undefined).toBe(
			readFileSync(join(DEFAULT_SKILL_DIR, "SKILL.md"), "utf8"),
		);
	});
});

describe("#given a skill directory without SKILL.md #when resources are registered #then nothing is served", () => {
	it("registers no resource", () => {
		const dir = mkdtempSync(join(tmpdir(), "opencua-skill-"));
		temporaryDirs.push(dir);
		mkdirSync(join(dir, "references"));
		writeFileSync(join(dir, "references", "usage.md"), "# usage\n");
		const server = new McpServer({ name: "capabilities-test", version: "0.0.0" });
		expect(registerSkillResources(server, dir)).toEqual([]);
	});
});
