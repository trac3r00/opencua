import { afterEach, describe, expect, it } from "bun:test";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import type { StopStatusSource } from "@opencua/core";
import { vi, whenSettled } from "@opencua/test-support";
import { WebSocket } from "ws";
import { z } from "zod";
import { BrowserBridge } from "./bridge.js";
import { type BrowserCommand, BrowserError } from "./protocol.js";

const origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const packetSchema = z.object({
	id: z.string().optional(),
	command: z.unknown().optional(),
	ready: z.boolean().optional(),
	checkpoint: z.string().optional(),
	allowed: z.boolean().optional(),
});

function stopSource(stopped = false): StopStatusSource {
	return {
		status: () =>
			stopped ? { stopped: true, stoppedAt: "2026-10-09", reason: "test stop", source: "api" } : { stopped: false },
	};
}

async function connect(port: number, requestOrigin = origin): Promise<WebSocket> {
	const socket = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin: requestOrigin } });
	await once(socket, "open");
	return socket;
}

async function nextJson(socket: WebSocket): Promise<z.infer<typeof packetSchema>> {
	const [raw] = await once(socket, "message");
	return packetSchema.parse(JSON.parse(raw.toString()));
}

describe("BrowserBridge", () => {
	const bridges: BrowserBridge[] = [];
	const clients: WebSocket[] = [];

	afterEach(async () => {
		for (const client of clients.splice(0)) client.terminate();
		await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
		vi.useRealTimers();
	});

	it("#given a non-extension origin #when pairing #then rejects the websocket upgrade", async () => {
		const bridge = new BrowserBridge(stopSource(), 1000, "secret");
		bridges.push(bridge);
		const port = await bridge.listen(0);
		const socket = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin: "https://example.com" } });
		const [error] = await once(socket, "error");
		expect(error).toBeInstanceOf(Error);
		expect(bridge.connected).toBe(false);
	});

	it("#given a valid origin #when pairing with wrong auth #then refuses pairing", async () => {
		const bridge = new BrowserBridge(stopSource(), 1000, "secret");
		bridges.push(bridge);
		const socket = await connect(await bridge.listen(0));
		clients.push(socket);
		const closed = once(socket, "close");
		socket.send(JSON.stringify({ token: "wrong" }));
		expect(await closed).toBeDefined();
		expect(bridge.connected).toBe(false);
	});

	it("#given an authenticated extension #when requesting #then pairs and replies over the wire", async () => {
		const bridge = new BrowserBridge(stopSource(), 1000, "secret");
		bridges.push(bridge);
		const socket = await connect(await bridge.listen(0));
		clients.push(socket);
		socket.send(JSON.stringify({ token: "secret" }));
		expect(await nextJson(socket)).toEqual({ ready: true });
		const request = bridge.request({ method: "open", url: "https://example.com" });
		const packet = await nextJson(socket);
		expect(packet.command).toEqual({ method: "open", url: "https://example.com" });
		socket.send(JSON.stringify({ id: packet.id, ok: true, value: { tabId: 1 } }));
		await whenSettled(request, (settled) => expect(settled).resolves.toEqual({ tabId: 1 }));
	});

	it("#given human control #when opening and running #then rejects input but permits observation", async () => {
		const bridge = new BrowserBridge(stopSource(), 1000, "secret");
		bridges.push(bridge);
		const socket = await connect(await bridge.listen(0));
		clients.push(socket);
		socket.send(JSON.stringify({ token: "secret" }));
		await nextJson(socket);
		const changed = once(bridge, "control");
		socket.send(JSON.stringify({ event: "control", owner: "human", reason: "taken_over" }));
		await changed;
		expect(bridge.control).toBe("human");
		expect(bridge.controlReason).toBe("taken_over");
		expect(bridge.paused).toBe(true);
		await expect(bridge.request({ method: "open", url: "https://example.com" })).rejects.toMatchObject({
			code: "human_control",
			message:
				"The person has taken over the browser. Call browser_wait_control or ask them; never resume it yourself.",
		});
		await expect(
			bridge.request({
				method: "run",
				tabId: 1,
				revision: "r1",
				steps: [],
				expect: undefined,
				limits: { maxChars: 6000, maxElements: 80, fullPage: false, profile: "interactive", maxNameChars: 120 },
			}),
		).rejects.toMatchObject({ code: "human_control" });
		const observed = bridge.request({
			method: "observe",
			tabId: 1,
			limits: { maxChars: 6000, maxElements: 80, fullPage: false, profile: "interactive", maxNameChars: 120 },
		});
		const packet = await nextJson(socket);
		expect(packet.command).toMatchObject({ method: "observe" });
		const returned = once(bridge, "control");
		socket.send(JSON.stringify({ event: "control", owner: "agent" }));
		await returned;
		expect(bridge.control).toBe("agent");
		socket.send(JSON.stringify({ id: packet.id, ok: true, value: {} }));
		await whenSettled(observed, (settled) => expect(settled).resolves.toEqual({}));
	});

	it("#given a pending run #when human control begins #then rejects it with human control", async () => {
		const bridge = new BrowserBridge(stopSource(), 1000, "secret");
		bridges.push(bridge);
		const socket = await connect(await bridge.listen(0));
		clients.push(socket);
		socket.send(JSON.stringify({ token: "secret" }));
		await nextJson(socket);
		const request = bridge.request({
			method: "run",
			tabId: 1,
			revision: "r1",
			steps: [],
			expect: undefined,
			limits: { maxChars: 6000, maxElements: 80, fullPage: false, profile: "interactive", maxNameChars: 120 },
		});
		await nextJson(socket);
		const rejected = whenSettled(request, (settled) =>
			expect(settled).rejects.toMatchObject({ code: "human_control" }),
		);
		const changed = once(bridge, "control");
		socket.send(JSON.stringify({ event: "control", owner: "human", reason: "window_revealed" }));
		await changed;
		await rejected;
		expect(bridge.control).toBe("human");
	});

	it("#given a stopped request #when legacy stop arrives #then records human stopped control", async () => {
		const bridge = new BrowserBridge(stopSource(), 1000, "secret");
		bridges.push(bridge);
		const socket = await connect(await bridge.listen(0));
		clients.push(socket);
		socket.send(JSON.stringify({ token: "secret" }));
		await nextJson(socket);
		const changed = once(bridge, "control");
		socket.send(JSON.stringify({ event: "stop" }));
		await changed;
		expect(bridge.control).toBe("human");
		expect(bridge.controlReason).toBe("stopped");
		await expect(
			bridge.request({
				method: "run",
				tabId: 1,
				revision: "r",
				steps: [],
				expect: undefined,
				limits: {
					maxChars: 6000,
					maxElements: 80,
					fullPage: false,
					profile: "interactive",
					maxNameChars: 120,
				},
			}),
		).rejects.toMatchObject({ code: "human_control" });
	});

	it("#given a human owner #when extension gives control back #then allows the next run", async () => {
		const bridge = new BrowserBridge(stopSource(), 1000, "secret");
		bridges.push(bridge);
		const socket = await connect(await bridge.listen(0));
		clients.push(socket);
		socket.send(JSON.stringify({ token: "secret" }));
		await nextJson(socket);
		const takenOver = once(bridge, "control");
		socket.send(JSON.stringify({ event: "control", owner: "human", reason: "taken_over" }));
		await takenOver;
		const waiting = bridge.waitForAgentControl(1000);
		const returned = once(bridge, "control");
		socket.send(JSON.stringify({ event: "control", owner: "agent" }));
		await returned;
		await whenSettled(waiting, (settled) => expect(settled).resolves.toBe(true));
		const request = bridge.request({
			method: "run",
			tabId: 1,
			revision: "r1",
			steps: [],
			expect: undefined,
			limits: { maxChars: 6000, maxElements: 80, fullPage: false, profile: "interactive", maxNameChars: 120 },
		});
		const packet = await nextJson(socket);
		socket.send(JSON.stringify({ id: packet.id, ok: true, value: {} }));
		await whenSettled(request, (settled) => expect(settled).resolves.toEqual({}));
	});

	it("#given an authenticated extension #when handoff is requested #then sends its reason and records it", async () => {
		const bridge = new BrowserBridge(stopSource(), 1000, "secret");
		bridges.push(bridge);
		const socket = await connect(await bridge.listen(0));
		clients.push(socket);
		socket.send(JSON.stringify({ token: "secret" }));
		await nextJson(socket);
		const handoff = bridge.requestHandoff("Please complete sign-in");
		const packet = await nextJson(socket);
		expect(packet.command).toEqual({ method: "handoff", reason: "Please complete sign-in" });
		socket.send(JSON.stringify({ id: packet.id, ok: true, value: null }));
		const recorded = await handoff;
		expect(recorded).toMatchObject({ reason: "Please complete sign-in" });
		expect(Number.isNaN(Date.parse(recorded.requestedAt))).toBe(false);
		expect(bridge.handoffRequest).toEqual(recorded);
		const takenOver = once(bridge, "control");
		socket.send(JSON.stringify({ event: "control", owner: "human" }));
		await takenOver;
		const returned = once(bridge, "control");
		socket.send(JSON.stringify({ event: "control", owner: "agent" }));
		await returned;
		expect(bridge.handoffRequest).toBeUndefined();
	});

	it("#given human control #when waiting for agent control #then resolves on give-back", async () => {
		const bridge = new BrowserBridge(stopSource(), 1000, "secret");
		bridges.push(bridge);
		const socket = await connect(await bridge.listen(0));
		clients.push(socket);
		socket.send(JSON.stringify({ token: "secret" }));
		await nextJson(socket);
		const takenOver = once(bridge, "control");
		socket.send(JSON.stringify({ event: "control", owner: "human" }));
		await takenOver;
		const waiting = bridge.waitForAgentControl(1000);
		const returned = once(bridge, "control");
		socket.send(JSON.stringify({ event: "control", owner: "agent" }));
		await returned;
		await whenSettled(waiting, (settled) => expect(settled).resolves.toBe(true));
	});

	it("#given human control #when waiting times out #then returns false", async () => {
		const bridge = new BrowserBridge(stopSource(), 1000, "secret");
		bridges.push(bridge);
		const socket = await connect(await bridge.listen(0));
		clients.push(socket);
		socket.send(JSON.stringify({ token: "secret" }));
		await nextJson(socket);
		const takenOver = once(bridge, "control");
		socket.send(JSON.stringify({ event: "control", owner: "human" }));
		await takenOver;
		await expect(bridge.waitForAgentControl(20)).resolves.toBe(false);
	});

	it("#given human control #when the wait is aborted #then returns false", async () => {
		const bridge = new BrowserBridge(stopSource(), 1000, "secret");
		bridges.push(bridge);
		const socket = await connect(await bridge.listen(0));
		clients.push(socket);
		socket.send(JSON.stringify({ token: "secret" }));
		await nextJson(socket);
		const takenOver = once(bridge, "control");
		socket.send(JSON.stringify({ event: "control", owner: "human" }));
		await takenOver;
		const cancellation = new AbortController();
		const waiting = bridge.waitForAgentControl(1000, cancellation.signal);
		cancellation.abort();
		await whenSettled(waiting, (settled) => expect(settled).resolves.toBe(false));
	});

	it("#given no paired extension #when a request arrives #then rejects with the pairing steps and extension path", async () => {
		const bridge = new BrowserBridge(stopSource(), 1000, "secret");
		bridges.push(bridge);
		await bridge.listen(0);
		const extensionDirectory = fileURLToPath(new URL("../extension", import.meta.url));
		const failure = await bridge.request({ method: "handoff", reason: "login" }).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(BrowserError);
		if (!(failure instanceof BrowserError)) throw new Error("Expected a BrowserError");
		expect(failure.code).toBe("disconnected");
		expect(failure.message).toContain("opencua browser setup");
		expect(failure.message).toContain(extensionDirectory);
	});

	it("#given a pending request #when the extension disconnects #then rejects without replay", async () => {
		const bridge = new BrowserBridge(stopSource(), 1000, "secret");
		bridges.push(bridge);
		const socket = await connect(await bridge.listen(0));
		clients.push(socket);
		socket.send(JSON.stringify({ token: "secret" }));
		await nextJson(socket);
		const request = bridge.request({
			method: "run",
			tabId: 1,
			revision: "r1",
			steps: [],
			expect: undefined,
			limits: { maxChars: 6000, maxElements: 80, fullPage: false, profile: "interactive", maxNameChars: 120 },
		});
		expect((await nextJson(socket)).command).toMatchObject({ method: "run" });
		const rejected = whenSettled(request, (settled) =>
			expect(settled).rejects.toMatchObject({ code: "disconnected" }),
		);
		socket.terminate();
		await rejected;
		expect(socket.readyState).not.toBe(WebSocket.OPEN);
	});

	it("#given a shared stop state #when opening or running #then refuses but allows observation", async () => {
		let stopped = false;
		const bridge = new BrowserBridge({ status: () => stopSource(stopped).status() }, 1000, "secret");
		bridges.push(bridge);
		const socket = await connect(await bridge.listen(0));
		clients.push(socket);
		socket.send(JSON.stringify({ token: "secret" }));
		await nextJson(socket);
		const run: BrowserCommand = {
			method: "run",
			tabId: 1,
			revision: "r1",
			steps: [],
			expect: undefined,
			limits: { maxChars: 6000, maxElements: 80, fullPage: false, profile: "interactive", maxNameChars: 120 },
		};
		stopped = true;
		await expect(bridge.request({ method: "open", url: "https://example.com" })).rejects.toMatchObject({
			code: "stopped",
		});
		await expect(bridge.request(run)).rejects.toMatchObject({ code: "stopped" });
		const observation = bridge.request({
			method: "observe",
			tabId: 1,
			limits: { maxChars: 6000, maxElements: 80, fullPage: false, profile: "interactive", maxNameChars: 120 },
		});
		const packet = await nextJson(socket);
		expect(packet.command).toMatchObject({ method: "observe" });
		socket.send(JSON.stringify({ id: packet.id, ok: true, value: {} }));
		await whenSettled(observation, (settled) => expect(settled).resolves.toEqual({}));
	});

	it("#given a shared stop state #when a checkpoint arrives #then denies it", async () => {
		let stopped = false;
		const bridge = new BrowserBridge({ status: () => stopSource(stopped).status() }, 1000, "secret");
		bridges.push(bridge);
		const socket = await connect(await bridge.listen(0));
		clients.push(socket);
		socket.send(JSON.stringify({ token: "secret" }));
		await nextJson(socket);
		const run = bridge.request({
			method: "run",
			tabId: 1,
			revision: "r1",
			steps: [],
			expect: undefined,
			limits: { maxChars: 6000, maxElements: 80, fullPage: false, profile: "interactive", maxNameChars: 120 },
		});
		const packet = await nextJson(socket);
		stopped = true;
		socket.send(JSON.stringify({ event: "checkpoint", id: String(packet.id), step: 0 }));
		expect(await nextJson(socket)).toEqual({ checkpoint: packet.id, allowed: false });
		socket.send(JSON.stringify({ id: packet.id, ok: true, value: {} }));
		await whenSettled(run, (settled) => expect(settled).resolves.toEqual({}));
	});

	it("#given a short command timeout #when a reply never arrives #then rejects and signals stop", async () => {
		const bridge = new BrowserBridge(stopSource(), 25, "secret");
		bridges.push(bridge);
		const socket = await connect(await bridge.listen(0));
		clients.push(socket);
		socket.send(JSON.stringify({ token: "secret" }));
		await nextJson(socket);
		vi.useFakeTimers();
		const incoming = nextJson(socket);
		const request = bridge.request({
			method: "observe",
			tabId: 1,
			limits: { maxChars: 6000, maxElements: 80, fullPage: false, profile: "interactive", maxNameChars: 120 },
		});
		const packet = await incoming;
		const rejected = whenSettled(request, (settled) => expect(settled).rejects.toMatchObject({ code: "timeout" }));
		const stopPacket = nextJson(socket);
		await vi.advanceTimersByTimeAsync(25);
		await rejected;
		expect((await stopPacket).command).toEqual({ method: "stop" });
		expect(packet.command).toMatchObject({ method: "observe" });
	});

	it("#given an active request #when its scope is cancelled #then rejects and denies further input checkpoints", async () => {
		const bridge = new BrowserBridge(stopSource(), 1000, "secret");
		bridges.push(bridge);
		const socket = await connect(await bridge.listen(0));
		clients.push(socket);
		const paired = nextJson(socket);
		socket.send(JSON.stringify({ token: "secret" }));
		await paired;
		const cancellation = new AbortController();
		const incoming = nextJson(socket);
		const request = bridge.withCancellation(cancellation.signal, () =>
			bridge.request({
				method: "run",
				tabId: 1,
				revision: "r1",
				steps: [{ action: "click", ref: 1 }],
				expect: undefined,
				limits: { maxChars: 6000, maxElements: 80, fullPage: false, profile: "interactive", maxNameChars: 120 },
			}),
		);
		const packet = await incoming;
		const rejected = whenSettled(request, (settled) => expect(settled).rejects.toMatchObject({ code: "stopped" }));
		cancellation.abort();
		await rejected;
		const denied = nextJson(socket);
		socket.send(JSON.stringify({ event: "checkpoint", id: packet.id, step: 1 }));
		expect(await denied).toEqual({ checkpoint: packet.id, allowed: false });
		expect(bridge.paused).toBe(false);
	});

	function rpc(port: number, body: unknown): Promise<Response> {
		return fetch(`http://127.0.0.1:${port}/rpc`, {
			method: "POST",
			headers: { authorization: "Bearer secret", "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	it("#given an rpc in flight #when draining for a reload #then it finishes that rpc, refuses new ones, then closes", async () => {
		const bridge = new BrowserBridge(stopSource(), 1000, "secret");
		let entered: () => void = () => undefined;
		const handling = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release: (value: unknown) => void = () => undefined;
		bridge.setRpcHandler(
			() =>
				new Promise((resolve) => {
					release = resolve;
					entered();
				}),
		);
		const port = await bridge.listen(0);
		const first = rpc(port, { action: "status" });
		await handling;
		let drained = false;
		const draining = bridge.drain(10_000).then(() => {
			drained = true;
		});
		const refused = await rpc(port, { action: "status" });
		expect(refused.status).toBe(503);
		expect(await refused.json()).toMatchObject({ error: "disconnected" });
		expect(drained).toBe(false);
		release({ finished: true });
		const reply = await first;
		expect(reply.status).toBe(200);
		expect(await reply.json()).toEqual({ finished: true });
		await draining;
		await expect(rpc(port, { action: "status" })).rejects.toBeInstanceOf(Error);
	});

	it("#given an rpc that never settles #when draining #then closes once the bound passes", async () => {
		const bridge = new BrowserBridge(stopSource(), 1000, "secret");
		let entered: () => void = () => undefined;
		const handling = new Promise<void>((resolve) => {
			entered = resolve;
		});
		bridge.setRpcHandler(() => {
			entered();
			return new Promise(() => undefined);
		});
		const port = await bridge.listen(0);
		const stuck = rpc(port, { action: "status" }).then(
			() => "answered",
			() => "cut",
		);
		await handling;
		await bridge.drain(50);
		expect(await stuck).toBe("cut");
	});
});
