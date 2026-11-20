import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CreateMessageRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type {
	ClientCapabilities,
	CreateMessageRequest,
	CreateMessageResult,
	ElicitRequest,
	ElicitResult,
	JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import type { AppOpenLauncher, StopStatusSource, SystemPrompt, TopLevelWindow } from "@opencua/core";
import { HotFrameSource } from "@opencua/core";
import { type McpServerOptions, createMcpServer } from "./mcp-server.js";
import type { PhoneToolSource } from "./phone-session.js";
import { FakeGuardedComputer } from "./protocol-test-harness.js";

class InMemoryTransport implements Transport {
	peer: InMemoryTransport | undefined;
	onclose?: () => void;
	onerror?: (error: Error) => void;
	onmessage?: <T extends JSONRPCMessage>(message: T) => void;

	async start(): Promise<void> {}

	async send(message: JSONRPCMessage): Promise<void> {
		const peer = this.peer;
		if (peer === undefined) {
			throw new Error("transport peer is not connected");
		}
		queueMicrotask(() => peer.onmessage?.(message));
	}

	async close(): Promise<void> {
		this.onclose?.();
	}
}

export async function createHarness(
	computer = new FakeGuardedComputer(),
	windowProbe?: () => Promise<readonly TopLevelWindow[]>,
	appLauncher?: AppOpenLauncher,
	clientOptions?: {
		readonly capabilities?: ClientCapabilities;
		readonly onElicit?: (request: ElicitRequest) => ElicitResult | Promise<ElicitResult>;
		readonly onSample?: (request: CreateMessageRequest) => CreateMessageResult | Promise<CreateMessageResult>;
		readonly systemPromptProbe?: () => readonly SystemPrompt[];
		readonly stopSwitch?: StopStatusSource;
		readonly phoneSource?: PhoneToolSource;
		/** Toolset profile and iPhone opt-in; omitted fields come from the environment. */
		readonly serverOptions?: McpServerOptions;
		/** The clientInfo the test client sends in initialize. */
		readonly clientInfo?: { readonly name: string; readonly version: string };
	},
) {
	const server = createMcpServer(
		computer,
		windowProbe,
		clientOptions?.phoneSource,
		appLauncher,
		clientOptions?.systemPromptProbe,
		clientOptions?.stopSwitch,
		{
			// A fake computer has no real windows: a refresher would spawn a worker that captures the host screen and
			// never delivers. Tests of the refresher pass their own source.
			hotFramesSource: new HotFrameSource({ spawnWorker: () => undefined }),
			...clientOptions?.serverOptions,
		},
	);
	const client = new Client(
		clientOptions?.clientInfo ?? { name: "context-first-test", version: "0.1.0" },
		clientOptions?.capabilities === undefined ? {} : { capabilities: clientOptions.capabilities },
	);
	if (clientOptions?.onElicit !== undefined) {
		client.setRequestHandler(ElicitRequestSchema, clientOptions.onElicit);
	}
	if (clientOptions?.onSample !== undefined) {
		client.setRequestHandler(CreateMessageRequestSchema, clientOptions.onSample);
	}
	const clientTransport = new InMemoryTransport();
	const serverTransport = new InMemoryTransport();
	clientTransport.peer = serverTransport;
	serverTransport.peer = clientTransport;
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return { client, computer, server, close: async () => await server.close() };
}

export function jsonText(result: unknown): string {
	if (typeof result !== "object" || result === null || !("content" in result) || !Array.isArray(result.content)) {
		throw new Error("tool result content must be an array");
	}
	const text = [...result.content]
		.reverse()
		.find(
			(item): item is { readonly type: "text"; readonly text: string } =>
				typeof item === "object" && item !== null && "type" in item && item.type === "text" && "text" in item,
		);
	if (text === undefined) {
		throw new Error("tool result must contain JSON text");
	}
	return text.text;
}

export function jsonPayload(result: unknown): Record<string, unknown> {
	const parsed: unknown = JSON.parse(jsonText(result));
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("tool JSON payload must be an object");
	}
	return Object.fromEntries(Object.entries(parsed));
}

export async function observe(harness: Awaited<ReturnType<typeof createHarness>>, app = "Finder"): Promise<string> {
	const result = await harness.client.callTool({ name: "get_app_state", arguments: { app } });
	const token = jsonPayload(result)["observation_token"];
	if (typeof token !== "string") {
		throw new Error("observation did not return a token");
	}
	return token;
}
