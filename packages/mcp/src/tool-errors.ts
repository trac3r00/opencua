import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

type Retry = "safe" | "unsafe" | "never";

const NEVER_RETRY_REASONS = new Set([
	"user-stopped",
	"worker-stopped",
	"screen-locked",
	"app-not-approved",
	"url-blocked",
]);

function errorMetadata(
	payload: Record<string, unknown>,
	message: string,
): {
	readonly code: string;
	readonly retry: Retry;
	readonly suggestion: string;
} {
	const reason = payload["reason"];
	// Only an explicit false proves nothing was delivered; a missing or "unknown" value does not.
	const notDispatched = payload["actionDispatched"] === false;
	const dispatched = payload["actionDispatched"] === true;
	// A refusal keeps its own code even when input went out first, so its "never" and its
	// ask-the-user guidance are not replaced by the generic post-dispatch envelope.
	if (typeof reason === "string" && NEVER_RETRY_REASONS.has(reason)) {
		return {
			code: reason.toUpperCase().replaceAll("-", "_"),
			retry: "never",
			suggestion: dispatched
				? "Input may already have been delivered. Ask the user to resolve the refusal and verify the outcome; do not retry."
				: "Ask the user to resolve the refusal. Do not retry input automatically.",
		};
	}
	if (dispatched) {
		return {
			code: "POST_ACTION_ERROR",
			retry: "unsafe",
			suggestion: "Input may already have been delivered. Observe and verify the outcome before sending more input.",
		};
	}
	if (
		reason === "stale-observation-token" ||
		reason === "observation-replaced" ||
		reason === "element-not-observed" ||
		reason === "token-observation-mismatch" ||
		message.startsWith("STALE_REF:") ||
		message.includes("observation token is missing, stale") ||
		message.includes("not the observed control")
	) {
		return {
			code: "STALE_REF",
			retry: "safe",
			suggestion: "Observe the app again and use only that snapshot's refs and token.",
		};
	}
	// App resolution fails before any read or input: the app is closed, not unusable. Without this the
	// generic envelope told agents "delivery status unknown" for a read of a closed browser, and they
	// gave up on that browser instead of opening it.
	if (message.startsWith("No running app matched")) {
		return {
			code: "APP_NOT_RUNNING",
			retry: "safe",
			suggestion:
				"Nothing was sent: the app is not running. Open it with open_app (list_apps shows what is installed and running), then observe it again.",
		};
	}
	// The coordinator refuses these before any read or input, so nothing was sent and asking again is safe.
	if (/^(?:app|worker) ".+" is already (?:owned|assigned)/.test(message)) {
		return {
			code: "WORKER_CONFLICT",
			retry: "safe",
			suggestion:
				"Nothing was sent. Pick another app or worker id, or release the worker that holds it, then retry.",
		};
	}
	const worker = /^worker ".+" is (not assigned|busy)$/.exec(message);
	if (worker !== null) {
		return worker[1] === "busy"
			? {
					code: "WORKER_BUSY",
					retry: "safe",
					suggestion: "Nothing was sent. Wait for the worker's current run to finish, then retry.",
				}
			: {
					code: "WORKER_NOT_ASSIGNED",
					retry: "safe",
					suggestion:
						"Nothing was sent. Check manage_workers status for the worker id, or have the coordinator assign it, then retry.",
				};
	}
	if (
		message.includes("Invalid arguments") ||
		message.includes("Invalid params") ||
		message.includes("MCP error -32602")
	) {
		return {
			code: "INVALID_ARGUMENT",
			retry: "never",
			suggestion: "Read the tool schema and correct the arguments before calling again.",
		};
	}
	if (typeof reason === "string") {
		return {
			code: reason.toUpperCase().replaceAll("-", "_"),
			retry: notDispatched ? "safe" : "unsafe",
			suggestion: notDispatched
				? "Observe the target app again and resolve the refusal before retrying."
				: "Delivery is unconfirmed. Observe and verify the target before retrying.",
		};
	}
	return {
		code: "TOOL_ERROR",
		retry: "unsafe",
		suggestion: "Observe and verify the target before retrying; the operation's delivery status is unknown.",
	};
}

/** Add machine-readable failure fields without replacing legacy error, reason, or evidence fields. */
export function normalizeToolError(result: CallToolResult): CallToolResult {
	let payload: Record<string, unknown> = {};
	let payloadIndex = -1;
	let message = "Tool failed without error details.";
	let found = false;
	// A tool can append a report after its error payload, so scan back until the error-bearing one.
	for (let index = result.content.length - 1; index >= 0 && !found; index--) {
		const item = result.content[index];
		if (item?.type !== "text") continue;
		const text = item.text.trim();
		let parsed: unknown;
		try {
			parsed = JSON.parse(item.text);
		} catch {
			// SDK validation errors are plain text rather than JSON.
			if (payloadIndex === -1) message = text || message;
			break;
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			if (payloadIndex === -1) message = text || message;
			continue;
		}
		const candidate = Object.fromEntries(Object.entries(parsed));
		const detail = candidate["error"] ?? candidate["message"];
		found =
			typeof detail === "string" ||
			typeof candidate["reason"] === "string" ||
			candidate["observationStatus"] === "error" ||
			"actionDispatched" in candidate;
		if (found || payloadIndex === -1) {
			payload = candidate;
			payloadIndex = index;
			message = typeof detail === "string" ? detail : text || message;
		}
	}
	if (result.isError !== true && payload["observationStatus"] !== "error") return result;
	const metadata = errorMetadata(payload, message);
	const content = [...result.content];
	const text = {
		type: "text" as const,
		text: JSON.stringify({
			...payload,
			ok: false,
			...(payloadIndex === -1 ? { error: message } : {}),
			...metadata,
			disposition: { retry: metadata.retry },
		}),
	};
	if (payloadIndex === -1) content.push(text);
	else content[payloadIndex] = text;
	return { ...result, isError: true, content };
}

/** Wrap the protocol boundary, including SDK argument validation and unknown-tool errors. */
export function installToolErrorEnvelope(server: McpServer): void {
	const original = server.server.setRequestHandler.bind(server.server);
	server.server.setRequestHandler = (schema, handler) =>
		original(schema, async (request, extra) => {
			const result = await handler(request, extra);
			if (request.method !== "tools/call") return result;
			const parsed = CallToolResultSchema.safeParse(result);
			return parsed.success ? { ...result, ...normalizeToolError(parsed.data) } : result;
		});
}
