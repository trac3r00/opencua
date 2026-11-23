import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * OpenCUA Browser (the bsk daemon and extension) reached from run_script: one `bsk mcp` child per server process,
 * started on first use, so a script drives the browser with the same calls an agent would make, in one chunk.
 */
export interface BrowserCaller {
	call(tool: string, args: Record<string, unknown>): Promise<unknown>;
	close(): Promise<void>;
}

export const BROWSER_TOOLS = new Set([
	"bsk_session",
	"bsk_page",
	"bsk_inspect",
	"bsk_interact",
	"bsk_plan",
	"bsk_tabs",
	"bsk_assist",
]);

/** The bsk binary: OPENCUA_BROWSER_BSK, then ~/.local/bin/bsk, then PATH. */
export function resolveBsk(environment: NodeJS.ProcessEnv = process.env): string | undefined {
	const configured = environment["OPENCUA_BROWSER_BSK"]?.trim();
	if (configured) return existsSync(configured) ? configured : undefined;
	const local = join(homedir(), ".local", "bin", "bsk");
	if (existsSync(local)) return local;
	for (const directory of (environment["PATH"] ?? "").split(delimiter)) {
		const candidate = join(directory, "bsk");
		if (directory !== "" && existsSync(candidate)) return candidate;
	}
	return undefined;
}

function parseContent(content: unknown): unknown {
	const items: unknown[] = Array.isArray(content) ? content : [];
	const texts = items.flatMap((item: unknown) =>
		typeof item === "object" && item !== null && "text" in item && typeof item.text === "string" ? [item.text] : [],
	);
	const parsed = texts.map((text) => {
		try {
			return JSON.parse(text) as unknown;
		} catch {
			return text;
		}
	});
	return parsed.length === 1 ? parsed[0] : parsed;
}

export class BrowserCallError extends Error {
	constructor(
		message: string,
		readonly payload: unknown,
	) {
		super(message);
		this.name = "BrowserCallError";
	}
}

export function bskBrowserCaller(binary: string): BrowserCaller {
	let client: Promise<Client> | undefined;
	const connect = async (): Promise<Client> => {
		const created = new Client({ name: "opencua", version: "0" });
		await created.connect(new StdioClientTransport({ command: binary, args: ["mcp"], stderr: "ignore" }));
		created.onclose = () => {
			client = undefined;
		};
		return created;
	};
	return {
		async call(tool, args) {
			client ??= connect().catch((error: unknown) => {
				client = undefined;
				throw error;
			});
			const result = await (await client).callTool({ name: tool, arguments: args }, undefined, {
				timeout: 120_000,
			});
			const payload = parseContent(result["content"]);
			if (result.isError === true) {
				const message =
					typeof payload === "object" && payload !== null && "message" in payload
						? String(payload.message)
						: typeof payload === "string"
							? payload
							: `${tool} failed`;
				throw new BrowserCallError(message, payload);
			}
			return payload;
		},
		async close() {
			const current = client;
			client = undefined;
			await (await current?.catch(() => undefined))?.close();
		},
	};
}
