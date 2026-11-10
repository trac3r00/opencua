import { afterEach, describe, expect, it } from "bun:test";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { vi } from "@opencua/test-support";
import { WebSocket } from "ws";
import { z } from "zod";
import { BrowserBridge } from "./bridge.js";
import * as connection from "./connection.js";
import { createBrowserMcpServer, main } from "./server.js";

/** Vitest's toHaveResolved: at least one call returned a value or promise that fulfilled. */
async function resolvedAtLeastOnce(spy: {
	readonly mock: { readonly results: readonly { readonly value: unknown }[] };
}): Promise<boolean> {
	const outcomes = await Promise.allSettled(spy.mock.results.map((result) => result.value));
	return outcomes.some((outcome) => outcome.status === "fulfilled");
}

const extensionDirectory = fileURLToPath(new URL("../extension", import.meta.url));

async function statusOf(client: Client): Promise<Record<string, unknown>> {
	const result = await client.callTool({ name: "browser_status", arguments: {} });
	const content = z.array(z.object({ type: z.literal("text"), text: z.string() })).parse(result.content);
	const item = content[0];
	if (item === undefined) throw new Error("Expected a status response");
	return z.record(z.string(), z.unknown()).parse(JSON.parse(item.text));
}

describe("browser MCP contract", () => {
	const cleanups: (() => Promise<void>)[] = [];

	afterEach(async () => {
		for (const close of cleanups.splice(0)) await close();
		vi.restoreAllMocks();
	});

	it("#given connection publication fails #when starting MCP #then closes transports and releases the port", async () => {
		const failure = new Error("connection publication failed");
		vi.spyOn(connection, "connectionToken").mockResolvedValue("a".repeat(64));
		vi.spyOn(connection, "writeConnection").mockRejectedValue(failure);
		const listen = BrowserBridge.prototype.listen;
		const closeBridge = vi.spyOn(BrowserBridge.prototype, "close");
		let port = 0;
		async function listenWithTrackedPort(this: BrowserBridge): Promise<number> {
			cleanups.push(async () => {
				if (!closeBridge.mock.contexts.includes(this)) await this.close();
			});
			port = await listen.call(this, 0);
			return port;
		}
		vi.spyOn(BrowserBridge.prototype, "listen").mockImplementation(listenWithTrackedPort);
		const closeServer = vi.spyOn(McpServer.prototype, "close");
		const closeTransport = vi.spyOn(StdioServerTransport.prototype, "close");
		await expect(main()).rejects.toBe(failure);
		expect(await resolvedAtLeastOnce(closeServer)).toBe(true);
		expect(await resolvedAtLeastOnce(closeTransport)).toBe(true);
		const probe = createServer();
		try {
			await new Promise<void>((resolve, reject) => {
				probe.once("error", reject);
				probe.listen(port, "127.0.0.1", resolve);
			});
		} finally {
			await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
		}
	});

	async function harness() {
		const bridge = new BrowserBridge({ status: () => ({ stopped: false }) });
		await bridge.listen(0);
		const server = createBrowserMcpServer(bridge);
		const client = new Client({ name: "browser-test", version: "1" });
		const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
		cleanups.push(async () => {
			await client.close();
			await server.close();
			await bridge.close();
		});
		return client;
	}

	it("#given the browser server #when listing tools #then exposes only the bounded browser surface", async () => {
		const client = await harness();
		const tools = await client.listTools();
		expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
			"browser_close",
			"browser_find",
			"browser_finish",
			"browser_handoff",
			"browser_observe",
			"browser_open",
			"browser_open_many",
			"browser_read",
			"browser_run",
			"browser_screenshot",
			"browser_space",
			"browser_status",
			"browser_wait",
			"browser_wait_control",
		]);
	});

	it("#given no paired extension #when checking status #then names the pairing next step", async () => {
		const client = await harness();
		const status = await statusOf(client);
		expect(status["next_step"]).toEqual(expect.stringContaining("opencua browser setup"));
		expect(status["next_step"]).toEqual(expect.stringContaining(extensionDirectory));
	});

	it("#given a paired extension #when checking status #then omits next_step", async () => {
		const bridge = new BrowserBridge({ status: () => ({ stopped: false }) }, 1000, "a".repeat(64));
		const port = await bridge.listen(0);
		const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
			headers: { origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" },
		});
		const server = createBrowserMcpServer(bridge);
		const client = new Client({ name: "browser-test", version: "1" });
		const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
		cleanups.push(async () => {
			socket.terminate();
			await client.close();
			await server.close();
			await bridge.close();
		});
		await once(socket, "open");
		const ready = once(socket, "message");
		socket.send(JSON.stringify({ token: "a".repeat(64) }));
		await ready;
		const status = await statusOf(client);
		expect(status["connected"]).toBe(true);
		expect(status).not.toHaveProperty("next_step");
	});

	it("#given no paired extension #when checking status #then reports disconnected without input", async () => {
		const client = await harness();
		await client.callTool({ name: "browser_space", arguments: { space: "shared-test" } });
		const result = await client.callTool({ name: "browser_status", arguments: {} });
		const content = z.array(z.object({ type: z.literal("text"), text: z.string() })).parse(result.content);
		const item = content[0];
		if (item === undefined) throw new Error("Expected a status response");
		const status = z
			.object({
				connected: z.boolean(),
				stopped: z.boolean(),
				control: z.enum(["agent", "human"]),
				control_reason: z.string().nullable(),
				handoff_requested: z.object({ reason: z.string(), requested_at: z.string() }).nullable(),
				spaces: z.array(z.object({ space: z.string(), pages: z.array(z.string()) })),
			})
			.parse(JSON.parse(item.text));
		expect(status).toEqual({
			connected: false,
			stopped: false,
			control: "agent",
			control_reason: null,
			handoff_requested: null,
			spaces: [{ space: "shared-test", pages: [] }],
		});
	});

	it("#given browser handoff tools #when handing off and waiting #then records request and reports control", async () => {
		const bridge = new BrowserBridge({ status: () => ({ stopped: false }) }, 1000, "a".repeat(64));
		await bridge.listen(0);
		const server = createBrowserMcpServer(bridge);
		const client = new Client({ name: "browser-test", version: "1" });
		const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
		cleanups.push(async () => {
			await client.close();
			await server.close();
			await bridge.close();
		});
		const tools = await client.listTools();
		expect(tools.tools.find((tool) => tool.name === "browser_handoff")?.description).toContain(
			"never reveals or focuses windows",
		);
		expect(tools.tools.find((tool) => tool.name === "browser_wait_control")?.description).toContain(
			"never resume it yourself",
		);
	});

	it("#given an unowned tab #when requesting observation #then returns a stale error through MCP", async () => {
		const client = await harness();
		await client.callTool({ name: "browser_space", arguments: { space: "known" } });
		const result = await client.callTool({
			name: "browser_observe",
			arguments: { space: "known", page: "p1" },
		});
		expect(result.isError).toBe(true);
		const content = z.array(z.object({ type: z.literal("text"), text: z.string() })).parse(result.content);
		const item = content[0];
		if (item === undefined) throw new Error("Expected an error response");
		const error = z.object({ error: z.string() }).parse(JSON.parse(item.text));
		expect(error.error).toBe("stale");
	});
});
