import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { appNotRunning } from "@opencua/core";
import { failurePayload, installToolErrorEnvelope, normalizeToolError } from "./tool-errors.js";
import { ToolUsageRegistry, installToolTiming } from "./tool-timing.js";

/** The server stack mcp-server installs: the error envelope, then timing, which turns a throw into a payload. */
async function callThrowing(error: Error): Promise<Record<string, unknown>> {
	const server = new McpServer({ name: "test", version: "0.0.0" });
	installToolErrorEnvelope(server);
	installToolTiming(server, new ToolUsageRegistry());
	server.registerTool("fails", { description: "throws" }, () => {
		throw error;
	});
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test-client", version: "0.0.0" });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	try {
		const result = await client.callTool({ name: "fails", arguments: {} });
		const texts = Array.isArray(result.content)
			? result.content.flatMap((item) => (item.type === "text" ? [String(item.text)] : []))
			: [];
		const envelope = texts.map((text) => JSON.parse(text)).find((parsed) => "code" in parsed);
		return envelope ?? {};
	} finally {
		await client.close();
	}
}

describe("tool error normalization", () => {
	it("#given a successful payload #when normalizing #then its object and fields are unchanged", () => {
		const result = { content: [{ type: "text" as const, text: '{"verified":false}' }] };
		expect(normalizeToolError(result)).toBe(result);
	});

	it("#given a post-dispatch observation failure #when normalizing #then retry is unsafe and evidence survives", () => {
		const result = normalizeToolError({
			content: [
				{ type: "text", text: '{"actionDispatched":true,"observationStatus":"error","error":"read failed"}' },
			],
		});
		const text = result.content[0];
		expect(result.isError).toBe(true);
		expect(text?.type === "text" && JSON.parse(text.text)).toMatchObject({
			ok: false,
			error: "read failed",
			actionDispatched: true,
			code: "POST_ACTION_ERROR",
			retry: "unsafe",
			disposition: { retry: "unsafe" },
		});
	});

	it("#given a stop refusal after input went out #when normalizing #then it keeps the refusal code and never retries", () => {
		const result = normalizeToolError({
			isError: true,
			content: [{ type: "text", text: '{"reason":"user-stopped","actionDispatched":true,"error":"stopped"}' }],
		});
		const text = result.content[0];
		expect(text?.type === "text" && JSON.parse(text.text)).toMatchObject({
			code: "USER_STOPPED",
			retry: "never",
			disposition: { retry: "never" },
		});
		expect(text?.type === "text" && JSON.parse(text.text).suggestion).toContain("may already have been delivered");
	});

	it.each(["shell-refused", "raw-event-refused", "script-loading-refused"])(
		"#given a %s refusal from the AppleScript guard #when normalizing #then it is never retried",
		(reason) => {
			const result = normalizeToolError({
				isError: true,
				content: [{ type: "text", text: JSON.stringify({ reason, actionDispatched: false, error: "refused" }) }],
			});
			const text = result.content[0];
			expect(text?.type === "text" && JSON.parse(text.text)).toMatchObject({ retry: "never" });
		},
	);

	it("#given an unconfirmed delivery #when normalizing #then only an explicit actionDispatched false is safe", () => {
		const retryFor = (payload: string): unknown => {
			const result = normalizeToolError({ isError: true, content: [{ type: "text", text: payload }] });
			const text = result.content[0];
			return text?.type === "text" ? JSON.parse(text.text).retry : undefined;
		};
		expect(retryFor('{"reason":"window-missing","actionDispatched":false}')).toBe("safe");
		expect(retryFor('{"reason":"window-missing","actionDispatched":"unknown"}')).toBe("unsafe");
		expect(retryFor('{"reason":"window-missing"}')).toBe("unsafe");
	});

	const normalized = (text: string, readOnly = false): Record<string, unknown> => {
		const item = normalizeToolError({ isError: true, content: [{ type: "text", text }] }, readOnly).content[0];
		return item?.type === "text" ? JSON.parse(item.text) : {};
	};

	it("#given a thrown app-not-running failure #when it crosses the tool boundary #then its typed fields decide the envelope", async () => {
		const closed = await callThrowing(appNotRunning('No running app matched "Aside"'));
		expect(closed).toMatchObject({
			ok: false,
			error: 'No running app matched "Aside"',
			code: "APP_NOT_RUNNING",
			retry: "safe",
			disposition: { retry: "safe", delivery: "not_sent" },
		});
		expect(String(closed["suggestion"])).toContain("open_app");
		expect(closed["disposition"]).toMatchObject({ hint: closed["suggestion"] });
		expect(closed).not.toHaveProperty("failure");
	});

	it("#given a plain error worded like a known failure #when normalizing #then no code is guessed from its text", () => {
		expect(normalized('{"error":"No running app matched pid 58374"}')).toMatchObject({
			code: "TOOL_ERROR",
			retry: "unsafe",
			disposition: { retry: "unsafe", delivery: "unknown" },
		});
		expect(normalized('{"error":"worker \\"w\\" is busy"}')["code"]).toBe("TOOL_ERROR");
	});

	it("#given a typed failure after input went out #when normalizing #then the post-dispatch envelope still wins", () => {
		const text = JSON.stringify({
			actionDispatched: true,
			error: "No running app matched pid 42",
			...failurePayload(appNotRunning("No running app matched pid 42")),
		});
		expect(normalized(text)).toMatchObject({
			code: "POST_ACTION_ERROR",
			retry: "unsafe",
			disposition: { retry: "unsafe", delivery: "sent" },
		});
		// Input that already went out keeps the post-dispatch envelope even when the app then vanished.
		expect(normalized('{"actionDispatched":true,"error":"No running app matched pid 42"}')["code"]).toBe(
			"POST_ACTION_ERROR",
		);
	});

	it("#given a subtree of an observation that is gone #when normalizing #then it is a stale ref, safe to re-observe", () => {
		expect(
			normalized(
				'{"error":"element 89 is not part of the current observation of pid 30926; observe the app again before drilling into a subtree"}',
			),
		).toMatchObject({ code: "STALE_REF", retry: "safe" });
	});

	it("#given a read-only tool's unexplained failure #when normalizing #then nothing was sent and retry is safe", () => {
		expect(normalized('{"error":"window list unreadable"}', true)).toMatchObject({
			code: "TOOL_ERROR",
			retry: "safe",
		});
		expect(normalized('{"error":"window list unreadable"}')).toMatchObject({ code: "TOOL_ERROR", retry: "unsafe" });
	});

	it("#given a report appended after the failure #when normalizing #then the error payload is the one annotated", () => {
		const result = normalizeToolError({
			isError: true,
			content: [
				{ type: "text", text: '{"reason":"window-missing","actionDispatched":false,"error":"no window"}' },
				{ type: "text", text: '{"clipboardClear":{"bytes":0}}' },
			],
		});
		const first = result.content[0];
		const second = result.content[1];
		expect(first?.type === "text" && JSON.parse(first.text)).toMatchObject({
			ok: false,
			code: "WINDOW_MISSING",
			retry: "safe",
			error: "no window",
		});
		expect(second?.type === "text" && JSON.parse(second.text)).toEqual({ clipboardClear: { bytes: 0 } });
	});
});
