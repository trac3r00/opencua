import { afterEach, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SpaceRecord } from "@opencua/core";
import { z } from "zod/v4";
import { type VirtualSpaceSource, registerVirtualSpaceTools } from "./virtual-space-tools.js";

const space: SpaceRecord = {
	id: "a1b2c3d4",
	displayId: 7,
	bounds: { x: 3008, y: 0, width: 1920, height: 1080 },
	pid: 4242,
	createdAt: "2026-11-21T09:00:00.000Z",
	takenOver: false,
};
const other: SpaceRecord = { ...space, id: "e5f6a7b8", displayId: 8 };

class FakeSource implements VirtualSpaceSource {
	spaces: readonly SpaceRecord[] = [];
	readonly started: { readonly width: number; readonly height: number }[] = [];
	readonly stopped: string[] = [];

	async start(size: { readonly width: number; readonly height: number }): Promise<SpaceRecord> {
		this.started.push(size);
		return { ...space, bounds: { ...space.bounds, ...size } };
	}

	list(): readonly SpaceRecord[] {
		return this.spaces;
	}

	async stop(id: string): Promise<void> {
		this.stopped.push(id);
	}
}

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});

async function connect(source: VirtualSpaceSource): Promise<Client> {
	const server = new McpServer({ name: "virtual-space-test", version: "0.0.0" });
	registerVirtualSpaceTools(server, source);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	const client = new Client({ name: "virtual-space-client", version: "0.0.0" });
	cleanup.push(async () => {
		await client.close();
		await server.close();
	});
	await client.connect(clientTransport);
	return client;
}

async function call(client: Client, args: Record<string, unknown>) {
	const result = await client.callTool({ name: "virtual_space", arguments: args });
	const content = z.array(z.looseObject({ type: z.string(), text: z.string().optional() })).parse(result.content);
	const text = content.find((item) => item.type === "text")?.text ?? "";
	return { isError: result.isError === true, text };
}

describe("#given the virtual_space tool #when listed #then it advertises its ops", () => {
	it("registers virtual_space with start, status and stop", async () => {
		const client = await connect(new FakeSource());

		const tool = (await client.listTools()).tools.find((candidate) => candidate.name === "virtual_space");

		expect(tool?.inputSchema.properties?.["op"]).toMatchObject({ enum: ["start", "status", "stop"] });
	});
});

describe("#given op start #when called #then a space is started and described", () => {
	it("starts 1920x1080 by default and returns the display id, bounds and a hint", async () => {
		const source = new FakeSource();
		const client = await connect(source);

		const result = await call(client, { op: "start" });

		expect(source.started).toEqual([{ width: 1920, height: 1080 }]);
		const payload: unknown = JSON.parse(result.text);
		expect(payload).toMatchObject({ id: space.id, displayId: 7, bounds: space.bounds, takenOver: false });
		expect(payload).toHaveProperty("hint", expect.any(String));
	});

	it.each([
		["a width below 640", { op: "start", width: 100 }],
		["a fractional height", { op: "start", height: 1080.5 }],
		["an unknown field", { op: "start", display: 2 }],
		["an unknown op", { op: "move_window" }],
	])("refuses %s without starting anything", async (_label, args) => {
		const source = new FakeSource();
		const client = await connect(source);

		expect((await call(client, args)).isError).toBe(true);
		expect(source.started).toEqual([]);
	});
});

describe("#given running spaces #when status or stop is called #then the right space is listed or stopped", () => {
	it("lists every running space", async () => {
		const source = new FakeSource();
		source.spaces = [space, other];
		const client = await connect(source);

		const payload = z
			.object({ spaces: z.array(z.object({ id: z.string() })) })
			.parse(JSON.parse((await call(client, { op: "status" })).text));

		expect(payload.spaces.map((entry) => entry.id)).toEqual([space.id, other.id]);
	});

	it("stops the only running space when no id is given", async () => {
		const source = new FakeSource();
		source.spaces = [space];
		const client = await connect(source);

		expect(JSON.parse((await call(client, { op: "stop" })).text)).toEqual({ stopped: space.id });
		expect(source.stopped).toEqual([space.id]);
	});

	it.each([
		["several run and none is named", [space, other], {}],
		["the named space is not running", [space], { id: "e5f6a7b8" }],
	] as const)("refuses to stop when %s", async (_label, spaces, args) => {
		const source = new FakeSource();
		source.spaces = spaces;
		const client = await connect(source);

		expect((await call(client, { op: "stop", ...args })).isError).toBe(true);
		expect(source.stopped).toEqual([]);
	});
});
