import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import type { StopStatusSource } from "@opencua/core";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { type BrowserCommand, BrowserError, type HandoffRequest, replySchema } from "./protocol.js";

export const extensionDirectory = fileURLToPath(new URL("../extension", import.meta.url));
export const NOT_CONNECTED = `The opencua browser extension is not connected. Ask the user to run \`opencua browser setup\` and load the unpacked extension from ${extensionDirectory} in Brave (chrome://extensions, Developer mode, Load unpacked), then call browser_status.`;

const helloSchema = z.object({ token: z.string().max(128) });
const eventSchema = z.discriminatedUnion("event", [
	z.object({ event: z.literal("heartbeat") }),
	z.object({ event: z.literal("stop") }),
	z.object({
		event: z.literal("control"),
		owner: z.enum(["human", "agent"]),
		reason: z.enum(["taken_over", "window_revealed", "stopped"]).optional(),
	}),
	z.object({ event: z.literal("checkpoint"), id: z.string(), step: z.number().int().nonnegative() }),
]);

export interface BrowserTransport {
	readonly generation: number;
	request(command: BrowserCommand): Promise<unknown>;
}

/** A single paired extension. Commands are never replayed after uncertain outcomes. */
export class BrowserBridge extends EventEmitter implements BrowserTransport {
	readonly token: string;
	private readonly http = createServer((request, response) => {
		void this.handleHttp(request, response);
	});
	private rpcHandler: ((value: unknown, signal: AbortSignal) => Promise<unknown>) | undefined;
	private readonly cancellation = new AsyncLocalStorage<AbortSignal>();
	private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
	private socket: WebSocket | undefined;
	private stopped = false;
	private everConnected = false;
	/** Sent with every pairing, so an extension loaded from older files reloads itself. */
	buildId: string | undefined;
	/** Set once a reconnect wait ran out, so later calls fail fast until the extension is back. */
	private reconnectWaitSpent = false;
	/** How long a call waits for a dropped extension to reconnect: its reconnect alarm fires every 30 s. */
	reconnectWaitMs = 35_000;
	private controlOwner: "agent" | "human" = "agent";
	private reason: "taken_over" | "window_revealed" | "stopped" | undefined;
	private handoff: HandoffRequest | undefined;
	private epoch = 0;
	private inFlight = 0;
	private draining = false;
	private readonly pending = new Map<
		string,
		{
			readonly command: BrowserCommand;
			readonly resolve: (value: unknown) => void;
			readonly reject: (error: BrowserError) => void;
			readonly timer: ReturnType<typeof setTimeout>;
			readonly cleanup: () => void;
		}
	>();

	constructor(
		private readonly stopSource: StopStatusSource,
		private readonly timeoutMs = 15000,
		token = randomBytes(32).toString("hex"),
	) {
		super();
		this.token = token;
		this.http.on("upgrade", (request, socket, head) => {
			const origin = request.headers.origin;
			if (
				request.url !== "/" ||
				origin === undefined ||
				!/^chrome-extension:\/\/[a-p]{32}$/.test(origin) ||
				this.socket !== undefined
			) {
				socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
				return;
			}
			this.wss.handleUpgrade(request, socket, head, (ws) => this.accept(ws));
		});
	}

	get generation(): number {
		return this.epoch;
	}

	get connected(): boolean {
		return this.socket?.readyState === WebSocket.OPEN;
	}

	get control(): "agent" | "human" {
		return this.controlOwner;
	}

	get controlReason(): "taken_over" | "window_revealed" | "stopped" | undefined {
		return this.reason;
	}

	get handoffRequest(): HandoffRequest | undefined {
		return this.handoff;
	}

	get paused(): boolean {
		return this.controlOwner === "human" || this.stopped || this.stopSource.status().stopped;
	}

	setRpcHandler(handler: (value: unknown, signal: AbortSignal) => Promise<unknown>): void {
		this.rpcHandler = handler;
	}

	withCancellation<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
		return this.cancellation.run(signal, action);
	}

	private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (request.method !== "POST" || request.url !== "/rpc" || this.rpcHandler === undefined) {
			response.writeHead(404).end();
			return;
		}
		const authorization = request.headers.authorization;
		const supplied = Buffer.from(authorization?.startsWith("Bearer ") ? authorization.slice(7) : "");
		const expected = Buffer.from(this.token);
		if (
			request.headers.origin !== undefined ||
			supplied.length !== expected.length ||
			!timingSafeEqual(supplied, expected)
		) {
			response.writeHead(403, { "content-type": "application/json" }).end(
				JSON.stringify({
					error: "unauthorized",
					message: "The local connection key is invalid or the request has a browser origin.",
				}),
			);
			return;
		}
		if (this.draining) {
			response.writeHead(503, { "content-type": "application/json" }).end(
				JSON.stringify({
					error: "disconnected",
					message: "The browser daemon is restarting to load an update. Retry in a few seconds.",
				}),
			);
			return;
		}
		this.inFlight++;
		try {
			await this.answerRpc(request, response);
		} finally {
			this.inFlight--;
			if (this.inFlight === 0) this.emit("idle");
		}
	}

	private async answerRpc(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (this.rpcHandler === undefined) return;
		try {
			const cancellation = new AbortController();
			response.once("close", () => {
				if (!response.writableEnded) cancellation.abort();
			});
			const chunks: Buffer[] = [];
			let bytes = 0;
			for await (const chunk of request) {
				if (!Buffer.isBuffer(chunk)) throw new BrowserError("extension", "Invalid RPC body");
				bytes += chunk.length;
				if (bytes > 256000) {
					response.writeHead(413).end();
					return;
				}
				chunks.push(chunk);
			}
			const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			const value = await this.rpcHandler(input, cancellation.signal);
			response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
		} catch (error: unknown) {
			const known = error instanceof BrowserError || error instanceof z.ZodError || error instanceof SyntaxError;
			const code = error instanceof BrowserError ? error.code : "invalid_request";
			const message = known && error instanceof Error ? error.message : "Internal browser RPC error";
			response
				.writeHead(known ? 400 : 500, { "content-type": "application/json" })
				.end(JSON.stringify({ error: code, message }));
			if (!known) process.stderr.write(`${message}\n`);
		}
	}

	async listen(port = 47953): Promise<number> {
		await new Promise<void>((resolve, reject) => {
			this.http.once("error", reject);
			this.http.listen(port, "127.0.0.1", () => {
				this.http.removeListener("error", reject);
				resolve();
			});
		});
		const address = this.http.address();
		if (address === null || typeof address === "string") throw new BrowserError("extension", "No loopback address");
		return address.port;
	}

	private accept(ws: WebSocket): void {
		let authenticated = false;
		const helloTimer = setTimeout(() => ws.close(1008, "Pairing required"), 3000);
		ws.on("message", (raw) => {
			let value: unknown;
			try {
				value = JSON.parse(raw.toString());
			} catch {
				ws.close(1008, "Invalid JSON");
				return;
			}
			if (!authenticated) {
				const hello = helloSchema.safeParse(value);
				const candidate = Buffer.from(hello.success ? hello.data.token : "");
				const expected = Buffer.from(this.token);
				if (
					this.socket !== undefined ||
					candidate.length !== expected.length ||
					!timingSafeEqual(candidate, expected)
				) {
					ws.close(1008, "Invalid pairing");
					return;
				}
				clearTimeout(helloTimer);
				authenticated = true;
				this.socket = ws;
				this.stopped = false;
				this.controlOwner = "agent";
				this.reason = undefined;
				this.handoff = undefined;
				this.epoch++;
				ws.send(JSON.stringify({ ready: true, ...(this.buildId === undefined ? {} : { build: this.buildId }) }));
				this.everConnected = true;
				this.reconnectWaitSpent = false;
				this.emit("connected");
				return;
			}
			const event = eventSchema.safeParse(value);
			if (event.success) {
				switch (event.data.event) {
					case "heartbeat":
						return;
					case "stop":
						this.setHumanControl("stopped");
						return;
					case "control":
						if (event.data.owner === "human") this.setHumanControl(event.data.reason);
						else {
							this.stopped = false;
							this.controlOwner = "agent";
							this.reason = undefined;
							this.handoff = undefined;
							this.emit("control");
						}
						return;
					case "checkpoint": {
						const pending = this.pending.get(event.data.id);
						ws.send(
							JSON.stringify({
								checkpoint: event.data.id,
								allowed: pending?.command.method === "run" && !this.paused,
							}),
						);
						return;
					}
				}
			}
			const reply = replySchema.safeParse(value);
			if (!reply.success) {
				ws.close(1008, "Invalid reply");
				return;
			}
			const call = this.pending.get(reply.data.id);
			if (call === undefined) return;
			clearTimeout(call.timer);
			call.cleanup();
			this.pending.delete(reply.data.id);
			if (reply.data.ok) call.resolve(reply.data.value);
			else call.reject(new BrowserError("extension", reply.data.error));
		});
		ws.on("error", () => ws.close());
		ws.on("close", () => {
			clearTimeout(helloTimer);
			if (this.socket !== ws) return;
			this.socket = undefined;
			this.epoch++;
			this.emit("disconnected");
			this.failPending(
				new BrowserError("disconnected", "Extension disconnected; outcome may be uncertain. Do not replay input."),
			);
		});
	}

	private waitForConnection(timeoutMs: number, signal: AbortSignal | undefined): Promise<boolean> {
		return new Promise((resolve) => {
			const done = (connected: boolean) => {
				clearTimeout(timer);
				this.off("connected", onConnected);
				signal?.removeEventListener("abort", onAbort);
				resolve(connected);
			};
			const onConnected = () => done(true);
			const onAbort = () => done(false);
			const timer = setTimeout(() => done(false), timeoutMs);
			timer.unref();
			this.once("connected", onConnected);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	request(command: BrowserCommand): Promise<unknown> {
		const signal = this.cancellation.getStore();
		if (signal?.aborted)
			return Promise.reject(new BrowserError("stopped", "Browser request was cancelled. Do not replay input."));
		const socket = this.socket;
		if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
			// An extension that was connected and dropped (its service worker slept, the browser restarted) comes back
			// on its own within its reconnect alarm, so the call waits for it instead of failing the agent at once.
			// One that never connected needs setup, which waiting cannot fix.
			if (this.everConnected && !this.reconnectWaitSpent) {
				return this.waitForConnection(this.reconnectWaitMs, signal).then((connected) => {
					if (!connected) {
						this.reconnectWaitSpent = true;
						return Promise.reject(new BrowserError("disconnected", NOT_CONNECTED));
					}
					return this.request(command);
				});
			}
			return Promise.reject(new BrowserError("disconnected", NOT_CONNECTED));
		}
		if ((command.method === "open" || command.method === "run") && this.controlOwner === "human") {
			return Promise.reject(this.humanControlError());
		}
		if (
			(command.method === "open" || command.method === "run") &&
			(this.stopped || this.stopSource.status().stopped)
		) {
			return Promise.reject(
				new BrowserError("stopped", "The user stopped opencua. Do not retry or resume it yourself."),
			);
		}
		const id = randomUUID();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				cleanup();
				// A slow page ends this one action, not the session: the extension cancels what is in flight, and the next
				// call is accepted. A stop here used to keep refusing every open and run, blaming the person, until they
				// handed control back.
				socket.send(JSON.stringify({ id: randomUUID(), command: { method: "cancel" } }));
				reject(
					new BrowserError(
						"timeout",
						`Browser ${command.method} timed out and was cancelled; input may have occurred. Observe again, never replay it.`,
					),
				);
			}, this.timeoutMs);
			let stopMonitor: NodeJS.Timeout | undefined;
			const cleanup = () => {
				signal?.removeEventListener("abort", cancelled);
				if (stopMonitor !== undefined) clearInterval(stopMonitor);
			};
			const cancelled = () => {
				clearTimeout(timer);
				this.pending.delete(id);
				cleanup();
				reject(
					new BrowserError("stopped", "Browser request was cancelled; input may have occurred. Do not replay it."),
				);
			};
			signal?.addEventListener("abort", cancelled, { once: true });
			this.pending.set(id, { command, resolve, reject, timer, cleanup });
			if (command.method === "run") {
				stopMonitor = setInterval(() => {
					if (!this.paused) return;
					this.stopped = true;
					if (stopMonitor !== undefined) clearInterval(stopMonitor);
					if (socket.readyState === WebSocket.OPEN)
						socket.send(JSON.stringify({ id: randomUUID(), command: { method: "stop" } }));
				}, 25);
				stopMonitor.unref();
			}
			socket.send(JSON.stringify({ id, command }));
		});
	}

	async requestHandoff(reason: string): Promise<HandoffRequest> {
		await this.request({ method: "handoff", reason });
		const handoffRequest = { reason, requestedAt: new Date().toISOString() };
		this.handoff = handoffRequest;
		return handoffRequest;
	}

	waitForAgentControl(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
		if (this.connected && this.controlOwner === "agent" && !this.stopSource.status().stopped) {
			return Promise.resolve(true);
		}
		if (signal?.aborted) return Promise.resolve(false);
		return new Promise((resolve) => {
			let settled = false;
			const cleanup = () => {
				clearTimeout(timer);
				this.removeListener("control", onControl);
				signal?.removeEventListener("abort", onAbort);
			};
			const finish = (result: boolean) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(result);
			};
			const onControl = () => {
				if (this.controlOwner === "agent") finish(true);
			};
			const onAbort = () => finish(false);
			const timer = setTimeout(() => finish(false), timeoutMs);
			this.on("control", onControl);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	private humanControlError(): BrowserError {
		return new BrowserError(
			"human_control",
			"The person has taken over the browser. Call browser_wait_control or ask them; never resume it yourself.",
		);
	}

	private setHumanControl(reason: "taken_over" | "window_revealed" | "stopped" | undefined): void {
		this.controlOwner = "human";
		this.reason = reason;
		this.stopped = true;
		this.failPending(this.humanControlError());
		this.emit("control");
	}

	private failPending(error: BrowserError): void {
		for (const call of this.pending.values()) {
			clearTimeout(call.timer);
			call.cleanup();
			call.reject(error);
		}
		this.pending.clear();
	}

	/** Refuses new RPCs, lets in-flight ones finish for up to `timeoutMs`, then closes. */
	async drain(timeoutMs: number): Promise<void> {
		this.draining = true;
		if (this.inFlight > 0) {
			await new Promise<void>((resolve) => {
				const finish = () => {
					clearTimeout(timer);
					this.removeListener("idle", finish);
					resolve();
				};
				const timer = setTimeout(finish, timeoutMs);
				this.once("idle", finish);
			});
		}
		await this.close();
	}

	async close(): Promise<void> {
		this.failPending(new BrowserError("disconnected", "Browser bridge closed"));
		for (const client of this.wss.clients) client.terminate();
		this.http.closeAllConnections();
		await new Promise<void>((resolve) => this.wss.close(() => resolve()));
		await new Promise<void>((resolve, reject) => this.http.close((error) => (error ? reject(error) : resolve())));
	}
}
