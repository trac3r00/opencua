import { afterEach, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CursorOwner, StopStatusSource } from "@opencua/core/isolated";
import { vi } from "@opencua/test-support";
import { z } from "zod/v4";
import type { IsolatedDesktopSource } from "./isolated-server.js";

vi.mock("node:child_process", () => ({
	spawn: () => {
		throw new Error("An isolated protocol test attempted to start a process.");
	},
}));
vi.mock("node:net", () => ({
	Socket: class {
		constructor() {
			throw new Error("An isolated protocol test attempted to create a socket.");
		}
	},
}));

const { currentCursorOwner } = await import("@opencua/core/isolated");
const { createIsolatedMcpServer } = await import("./isolated-server.js");

const owner = { agentName: "OmO", sessionId: "fixture-session" };
const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3l8AAAAASUVORK5CYII=",
	"base64",
);
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function body(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
	const content = result.content;
	if (!Array.isArray(content) || content[0]?.type !== "text") throw new Error("Missing protocol text.");
	return z.record(z.string(), z.unknown()).parse(JSON.parse(String(content[0].text)));
}

function token(result: Awaited<ReturnType<Client["callTool"]>>): string {
	const value = body(result)["observation_token"];
	if (typeof value !== "string") throw new Error("Missing observation token.");
	return value;
}

async function fixture() {
	let stopped = false;
	let running = true;
	const size = { width: 1, height: 1 };
	const seenOwners: (CursorOwner | undefined)[] = [];
	const click = vi.fn(async (_x: number, _y: number) => {
		seenOwners.push(currentCursorOwner());
	});
	const move = vi.fn(async (_x: number, _y: number) => undefined);
	const refresh = vi.fn(async () => undefined);
	const screenshot = vi.fn(async () => ({ data: png, mimeType: "image/png" as const, width: 1, height: 1 }));
	const paste = vi.fn(async (_value: string) => undefined);
	const chord = vi.fn(async (_keysyms: readonly number[]) => undefined);
	const flush = vi.fn(async () => undefined);
	const accessibility = vi.fn(async (_image: { width: number; height: number }) => ({
		app: "TextEdit",
		elements: [{ role: "AXTextArea", depth: 1, value: "Agent 1:", frame: [0, 0, 1, 1] as const }],
	}));
	const close = vi.fn(async () => {
		running = false;
	});
	const source: IsolatedDesktopSource = {
		supervisor: {
			status: () => ({
				owner,
				running,
				closing: !running,
				inputAvailable: running,
				display: { ...size },
				cursors: [],
			}),
			refreshDisplay: refresh,
			move,
			click,
			scroll: async () => undefined,
			drag: async () => undefined,
			chord,
			close,
		},
		screenshot,
		paste,
		flush,
		accessibility,
		close,
	};
	const start = vi.fn(async () => source);
	const stop: StopStatusSource = {
		status: () =>
			stopped
				? { stopped: true, stoppedAt: "2026-10-30T00:00:00Z", reason: "fixture", source: "api" }
				: { stopped: false },
	};
	const server = createIsolatedMcpServer({ directory: "/fixture/owned-desktop", owner, stop, start });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	const client = new Client({ name: "isolated-test", version: "0.0.0" });
	await client.connect(clientTransport);
	cleanups.push(async () => {
		await client.close();
		await server.close();
	});
	const call = (args: Record<string, unknown>) => client.callTool({ name: "virtual_desktop", arguments: args });
	return {
		client,
		call,
		start,
		click,
		move,
		refresh,
		screenshot,
		paste,
		chord,
		flush,
		accessibility,
		close,
		seenOwners,
		size,
		stop: () => {
			stopped = true;
		},
	};
}

describe("#given the isolated MCP entrypoint #when used #then only the owned guest is exposed", () => {
	it("reports unavailable input before start and registers no native host tools", async () => {
		const test = await fixture();
		const names = (await test.client.listTools()).tools.map((tool) => tool.name).sort();
		expect(names).toEqual(["get_capabilities", "virtual_desktop"]);
		const status = body(await test.client.callTool({ name: "get_capabilities", arguments: {} }));
		expect(status).toMatchObject({
			backend: "isolated-macos",
			humanDesktopInput: false,
			hostClipboardSharing: false,
			guest: { running: false, inputAvailable: false },
		});
		expect(test.start).not.toHaveBeenCalled();
	});

	it("binds observation and action to the named child and returns the guest image", async () => {
		const test = await fixture();
		await test.call({ op: "start" });
		const actor = { id: "reader-1", name: "Reader" };
		const observed = await test.call({ op: "observe", actor });
		expect(body(observed)["actor"]).toEqual({
			agentName: "Reader",
			parentAgentName: "OmO",
			sessionId: "fixture-session",
		});
		expect(observed.content).toContainEqual({ type: "image", mimeType: "image/png", data: png.toString("base64") });
		const acted = await test.call({
			op: "act",
			actor,
			observation_token: token(observed),
			action: { type: "click", x: 0, y: 0 },
		});
		expect(acted.isError).not.toBe(true);
		expect(body(acted)["dispatched"]).toBe(true);
		expect(test.seenOwners).toEqual([
			{
				agentName: "Reader",
				parentAgentName: "OmO",
				sessionId: "fixture-session",
			},
		]);
		expect(currentCursorOwner()).toBeUndefined();
	});

	it("refuses another actor's token before any input", async () => {
		const test = await fixture();
		await test.call({ op: "start" });
		const observed = await test.call({ op: "observe", actor: { id: "reader", name: "Reader" } });
		const result = await test.call({
			op: "act",
			actor: { id: "writer", name: "Writer" },
			observation_token: token(observed),
			action: { type: "click", x: 0, y: 0 },
		});
		expect(result.isError).toBe(true);
		expect(body(result)["effect"]).toBe("refused");
		expect(test.click).not.toHaveBeenCalled();
	});

	it("consumes an observation token and refuses replay", async () => {
		const test = await fixture();
		await test.call({ op: "start" });
		const observed = await test.call({ op: "observe" });
		const request = { op: "act", observation_token: token(observed), action: { type: "move", x: 0, y: 0 } };
		const first = await test.call(request);
		expect(first.isError).not.toBe(true);
		expect(token(first)).not.toBe(token(observed));
		expect((await test.call(request)).isError).toBe(true);
		expect(test.move).toHaveBeenCalledTimes(1);
	});

	it("rejects a display change detected before dispatch", async () => {
		const test = await fixture();
		await test.call({ op: "start" });
		const observed = await test.call({ op: "observe" });
		test.refresh.mockImplementationOnce(async () => {
			test.size.width = 2;
			return undefined;
		});
		const result = await test.call({
			op: "act",
			observation_token: token(observed),
			action: { type: "click", x: 0, y: 0 },
		});
		expect(body(result)["message"]).toBe("guest-display-changed");
		expect(test.click).not.toHaveBeenCalled();
	});

	it("honors the human stop but still permits owned runtime cleanup", async () => {
		const test = await fixture();
		await test.call({ op: "start" });
		const observed = await test.call({ op: "observe" });
		test.stop();
		const result = await test.call({
			op: "act",
			observation_token: token(observed),
			action: { type: "type", text: "must not be pasted" },
		});
		expect(body(result)["error"]).toBe("user-stopped");
		expect(test.paste).not.toHaveBeenCalled();
		await test.call({ op: "close" });
		expect(test.close).toHaveBeenCalledTimes(1);
	});

	it("does not describe a failed dispatch as proof that nothing happened", async () => {
		const test = await fixture();
		await test.call({ op: "start" });
		const observed = await test.call({ op: "observe" });
		test.click.mockRejectedValueOnce(new Error("synthetic transport failure"));
		const result = await test.call({
			op: "act",
			observation_token: token(observed),
			action: { type: "click", x: 0, y: 0 },
		});
		expect(result.isError).toBe(true);
		expect(body(result)).toMatchObject({ error: "guest-action-unverified", effect: "unverifiable" });
	});

	it("keeps an actor ID bound to its original declared name", async () => {
		const test = await fixture();
		await test.call({ op: "start" });
		await test.call({ op: "observe", actor: { id: "reader", name: "Reader" } });
		const result = await test.call({ op: "observe", actor: { id: "reader", name: "Other" } });
		expect(body(result)["message"]).toBe("actor-name-changed");
		expect(test.screenshot).toHaveBeenCalledTimes(1);
	});

	it("does not register an actor that acts without observing", async () => {
		const test = await fixture();
		await test.call({ op: "start" });
		const forged = await test.call({
			op: "act",
			actor: { id: "ghost", name: "Ghost" },
			observation_token: "forged",
			action: { type: "move", x: 0, y: 0 },
		});
		expect(body(forged)["message"]).toBe("observation-required");
		expect(test.move).not.toHaveBeenCalled();
		const observed = await test.call({ op: "observe", actor: { id: "ghost", name: "Renamed" } });
		expect(observed.isError).not.toBe(true);
		expect(body(observed)["actor"]).toEqual({
			agentName: "Renamed",
			parentAgentName: "OmO",
			sessionId: "fixture-session",
		});
	});

	it("lets interleaved children act on their own tokens and tells each how many others acted since it observed", async () => {
		const test = await fixture();
		await test.call({ op: "start" });
		const reader = { id: "reader", name: "Reader" };
		const writer = { id: "writer", name: "Writer" };
		const readerSeen = await test.call({ op: "observe", actor: reader });
		const writerSeen = await test.call({ op: "observe", actor: writer });

		const readerActed = await test.call({
			op: "act",
			actor: reader,
			observation_token: token(readerSeen),
			action: { type: "click", x: 0, y: 0 },
		});
		const writerActed = await test.call({
			op: "act",
			actor: writer,
			observation_token: token(writerSeen),
			action: { type: "move", x: 0, y: 0 },
		});

		expect([readerActed.isError, writerActed.isError]).toEqual([undefined, undefined]);
		expect(body(readerActed)["others_acted_since_observation"]).toBe(0);
		expect(body(writerActed)["others_acted_since_observation"]).toBe(1);
		expect([test.click.mock.calls.length, test.move.mock.calls.length]).toEqual([1, 1]);
	});

	it("sends keys named like cmd and S as RFB keysyms, and keeps the token when a name is unknown", async () => {
		const test = await fixture();
		await test.call({ op: "start" });
		const observed = await test.call({ op: "observe" });

		const unknown = await test.call({
			op: "act",
			observation_token: token(observed),
			action: { type: "key", keys: ["cmd", "hyper"] },
		});
		const saved = await test.call({
			op: "act",
			observation_token: token(observed),
			action: { type: "key", keys: ["cmd", "S"] },
		});

		expect(body(unknown)).toMatchObject({ message: "unknown-key-name: hyper", effect: "refused" });
		expect(saved.isError).not.toBe(true);
		expect(test.chord.mock.calls).toEqual([[[0xffe7, 0x73]]]);
	});

	it("refuses an act that requires an unchanged desktop after another actor acted, and hands back a fresh observation", async () => {
		const test = await fixture();
		await test.call({ op: "start" });
		const editor = { id: "editor", name: "Editor" };
		const other = { id: "other", name: "Other" };
		const editorSeen = await test.call({ op: "observe", actor: editor });
		const otherSeen = await test.call({ op: "observe", actor: other });
		await test.call({
			op: "act",
			actor: other,
			observation_token: token(otherSeen),
			action: { type: "move", x: 0, y: 0 },
		});

		const stale = await test.call({
			op: "act",
			actor: editor,
			observation_token: token(editorSeen),
			require_unchanged: true,
			action: { type: "type", text: "must wait for a fresh look" },
		});
		const retried = await test.call({
			op: "act",
			actor: editor,
			observation_token: token(stale),
			require_unchanged: true,
			action: { type: "type", text: "typed after a fresh look" },
		});

		expect(stale.isError).not.toBe(true);
		expect(body(stale)).toMatchObject({
			dispatched: false,
			refused: "stale-observation",
			others_acted_since_observation: 1,
		});
		expect(stale.content).toContainEqual({ type: "image", mimeType: "image/png", data: png.toString("base64") });
		expect(body(retried)).toMatchObject({ dispatched: true, others_acted_since_observation: 0 });
		expect(test.paste.mock.calls).toEqual([["typed after a fresh look"]]);
	});

	it("returns the guest's accessibility elements with the screenshot only when asked", async () => {
		const test = await fixture();
		await test.call({ op: "start" });

		const plain = await test.call({ op: "observe" });
		const rich = await test.call({ op: "observe", accessibility: true });

		expect(body(plain)["accessibility"]).toBeUndefined();
		expect(body(rich)["accessibility"]).toEqual({
			app: "TextEdit",
			elements: [{ role: "AXTextArea", depth: 1, value: "Agent 1:", frame: [0, 0, 1, 1] }],
		});
		expect(test.accessibility.mock.calls).toEqual([[{ width: 1, height: 1 }]]);
		expect(rich.content).toContainEqual({ type: "image", mimeType: "image/png", data: png.toString("base64") });
	});

	it("still returns the screenshot and token when the accessibility read fails, naming the failure", async () => {
		const test = await fixture();
		await test.call({ op: "start" });
		test.accessibility.mockRejectedValueOnce(new Error("The guest has no accessibility permission for its agent."));

		const observed = await test.call({ op: "observe", accessibility: true });

		expect(observed.isError).not.toBe(true);
		expect(body(observed)["accessibility_error"]).toContain("no accessibility permission");
		expect(typeof body(observed)["observation_token"]).toBe("string");
		expect(observed.content).toContainEqual({ type: "image", mimeType: "image/png", data: png.toString("base64") });
	});

	it("flushes guest writes right after keys or typing, so a save survives an abrupt guest power-off", async () => {
		const test = await fixture();
		await test.call({ op: "start" });
		const order: string[] = [];
		test.chord.mockImplementation(async () => {
			order.push("key");
		});
		test.flush.mockImplementation(async () => {
			order.push("flush");
		});
		const observed = await test.call({ op: "observe" });

		const saved = await test.call({
			op: "act",
			observation_token: token(observed),
			action: { type: "key", keys: ["cmd", "s"] },
		});
		const clicked = await test.call({
			op: "act",
			observation_token: token(saved),
			action: { type: "click", x: 0, y: 0 },
		});

		expect(order).toEqual(["key", "flush"]);
		expect(body(saved)["flushed"]).toBe(true);
		expect(body(clicked)["flushed"]).toBeUndefined();
	});

	it("reports a failed flush without calling the dispatched input unverified", async () => {
		const test = await fixture();
		await test.call({ op: "start" });
		test.flush.mockRejectedValueOnce(new Error("guest agent busy"));
		const observed = await test.call({ op: "observe" });

		const typed = await test.call({
			op: "act",
			observation_token: token(observed),
			action: { type: "type", text: "saved text" },
		});

		expect(typed.isError).not.toBe(true);
		expect(body(typed)).toMatchObject({ dispatched: true, flushed: false });
	});

	it("runs an actor's batch of steps without another actor's input landing in between", async () => {
		const test = await fixture();
		await test.call({ op: "start" });
		const order: string[] = [];
		test.click.mockImplementation(async (x: number) => {
			order.push(`click ${x}`);
			await Promise.resolve();
		});
		test.chord.mockImplementation(async (keysyms: readonly number[]) => {
			order.push(`key ${keysyms.join("+")}`);
		});
		test.paste.mockImplementation(async (value: string) => {
			order.push(`type ${value}`);
		});
		const renamer = { id: "renamer", name: "Renamer" };
		const other = { id: "other", name: "Other" };
		const renamerSeen = await test.call({ op: "observe", actor: renamer });
		const otherSeen = await test.call({ op: "observe", actor: other });

		const [batch, single] = await Promise.all([
			test.call({
				op: "act",
				actor: renamer,
				observation_token: token(renamerSeen),
				actions: [
					{ type: "click", x: 0, y: 0 },
					{ type: "key", keys: ["return"] },
					{ type: "type", text: "report-1-done.txt" },
					{ type: "key", keys: ["return"] },
				],
			}),
			test.call({
				op: "act",
				actor: other,
				observation_token: token(otherSeen),
				action: { type: "click", x: 0, y: 0 },
			}),
		]);

		expect([batch.isError, single.isError]).toEqual([undefined, undefined]);
		expect(order).toEqual(["click 0", "key 65293", "type report-1-done.txt", "key 65293", "click 0"]);
		expect(body(batch)["steps"]).toBe(4);
	});

	it("refuses an act that gives both action and actions before any input", async () => {
		const test = await fixture();
		await test.call({ op: "start" });
		const observed = await test.call({ op: "observe" });
		const result = await test.call({
			op: "act",
			observation_token: token(observed),
			action: { type: "click", x: 0, y: 0 },
			actions: [{ type: "click", x: 0, y: 0 }],
		});
		expect(result.isError).toBe(true);
		expect(test.click).not.toHaveBeenCalled();
	});

	it("presses a key the requested number of times in one action", async () => {
		const test = await fixture();
		await test.call({ op: "start" });
		const observed = await test.call({ op: "observe" });

		const result = await test.call({
			op: "act",
			observation_token: token(observed),
			action: { type: "key", keys: ["backspace"], repeat: 8 },
		});

		expect(result.isError).not.toBe(true);
		expect(test.chord.mock.calls).toEqual(Array.from({ length: 8 }, () => [[0xff08]]));
	});

	it("refuses a chord that names one key twice, points to repeat, and keeps the token", async () => {
		const test = await fixture();
		await test.call({ op: "start" });
		const observed = await test.call({ op: "observe" });

		const doubled = await test.call({
			op: "act",
			observation_token: token(observed),
			action: { type: "key", keysyms: [0xff08, 0xff08] },
		});
		const single = await test.call({
			op: "act",
			observation_token: token(observed),
			action: { type: "key", keysyms: [0xff08] },
		});

		expect(body(doubled)).toMatchObject({ effect: "refused" });
		expect(String(body(doubled)["message"])).toContain("repeat");
		expect(single.isError).not.toBe(true);
		expect(test.chord.mock.calls).toEqual([[[0xff08]]]);
	});

	it("refuses a key action that gives both keysyms and keys before any input", async () => {
		const test = await fixture();
		await test.call({ op: "start" });
		const observed = await test.call({ op: "observe" });
		const result = await test.call({
			op: "act",
			observation_token: token(observed),
			action: { type: "key", keysyms: [0xffe7], keys: ["cmd"] },
		});
		expect(result.isError).toBe(true);
		expect(test.chord).not.toHaveBeenCalled();
	});

	it("refuses a new actor once the server holds its limit of 64", async () => {
		const test = await fixture();
		await test.call({ op: "start" });
		// The coordinator itself holds one of the 64 places.
		for (let index = 1; index < 64; index += 1) {
			const observed = await test.call({ op: "observe", actor: { id: `worker-${index}`, name: `Worker ${index}` } });
			expect(observed.isError).not.toBe(true);
		}
		const refused = await test.call({ op: "observe", actor: { id: "worker-64", name: "Worker 64" } });
		expect(body(refused)["message"]).toBe("too-many-actors");
		const known = await test.call({ op: "observe", actor: { id: "worker-1", name: "Worker 1" } });
		expect(known.isError).not.toBe(true);
	});
});
