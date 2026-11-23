import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type FailureDelivery, type FailureRetry, ToolFailure, type ToolFailureFields } from "@opencua/core";

type Retry = FailureRetry;

interface ErrorMetadata {
	readonly code: string;
	readonly retry: Retry;
	readonly delivery: FailureDelivery;
	readonly suggestion: string;
	readonly evidence?: Readonly<Record<string, unknown>> | undefined;
}

const NEVER_RETRY_REASONS = new Set([
	"user-stopped",
	"worker-stopped",
	"screen-locked",
	"app-not-approved",
	"url-blocked",
	"foreground-refused",
	"shell-refused",
	"raw-event-refused",
	"script-loading-refused",
	"jxa-refused",
	"lease-required",
	"lease-expired",
	"lease-window-gone",
	"lease-region-exceeded",
	"lease-tool-forbidden",
]);

const DELIVERIES: ReadonlySet<string> = new Set<FailureDelivery>(["not_sent", "sent", "unknown"]);
const RETRIES: ReadonlySet<string> = new Set<Retry>(["safe", "unsafe", "never"]);

function isDelivery(value: unknown): value is FailureDelivery {
	return typeof value === "string" && DELIVERIES.has(value);
}

function isRetry(value: unknown): value is Retry {
	return typeof value === "string" && RETRIES.has(value);
}

/** The typed fields a thrown {@link ToolFailure} carries onto the wire; the envelope reads them back. */
export function failurePayload(error: unknown): { readonly failure?: ToolFailureFields } {
	if (!(error instanceof ToolFailure)) return {};
	return {
		failure: {
			code: error.code,
			delivery: error.delivery,
			retry: error.retry,
			hint: error.hint,
			...(error.evidence === undefined ? {} : { evidence: error.evidence }),
		},
	};
}

function typedFailure(payload: Record<string, unknown>): ErrorMetadata | undefined {
	const failure = payload["failure"];
	if (typeof failure !== "object" || failure === null || Array.isArray(failure)) return undefined;
	const fields = Object.fromEntries(Object.entries(failure));
	const { code, delivery, retry, hint, evidence } = fields;
	if (typeof code !== "string" || !isDelivery(delivery) || !isRetry(retry) || typeof hint !== "string") {
		return undefined;
	}
	const evidenceRecord =
		typeof evidence === "object" && evidence !== null && !Array.isArray(evidence)
			? Object.fromEntries(Object.entries(evidence))
			: undefined;
	return { code, delivery, retry, suggestion: hint, evidence: evidenceRecord };
}

function errorMetadata(payload: Record<string, unknown>, message: string, readOnly: boolean): ErrorMetadata {
	const reason = payload["reason"];
	// Only an explicit false proves nothing was delivered; a missing or "unknown" value does not.
	const notDispatched = payload["actionDispatched"] === false;
	const dispatched = payload["actionDispatched"] === true;
	const reported: FailureDelivery = dispatched ? "sent" : notDispatched ? "not_sent" : "unknown";
	// A refusal keeps its own code even when input went out first, so its "never" and its
	// ask-the-user guidance are not replaced by the generic post-dispatch envelope.
	if (typeof reason === "string" && NEVER_RETRY_REASONS.has(reason)) {
		return {
			code: reason.toUpperCase().replaceAll("-", "_"),
			retry: "never",
			delivery: reported,
			suggestion: dispatched
				? "Input may already have been delivered. Ask the user to resolve the refusal and verify the outcome; do not retry."
				: "Ask the user to resolve the refusal. Do not retry input automatically.",
		};
	}
	if (dispatched) {
		return {
			code: "POST_ACTION_ERROR",
			retry: "unsafe",
			delivery: "sent",
			suggestion: "Input may already have been delivered. Observe and verify the outcome before sending more input.",
		};
	}
	const typed = typedFailure(payload);
	if (typed !== undefined) return typed;
	if (
		reason === "stale-observation-token" ||
		reason === "observation-replaced" ||
		reason === "element-not-observed" ||
		reason === "token-observation-mismatch" ||
		// Thrown by core accessibility (an element id that now names another control, or a subtree of an observation
		// that is gone); that module raises plain errors, so these two are still recognised by their wording.
		message.includes("not the observed control") ||
		message.includes("is not part of the current observation")
	) {
		return {
			code: "STALE_REF",
			retry: "safe",
			delivery: "not_sent",
			suggestion: "Observe the app again and use only that snapshot's refs and token.",
		};
	}
	// The MCP SDK words its own argument validation failures; there is no throw site of ours to type.
	if (
		message.includes("Invalid arguments") ||
		message.includes("Invalid params") ||
		message.includes("MCP error -32602")
	) {
		return {
			code: "INVALID_ARGUMENT",
			retry: "never",
			delivery: "not_sent",
			suggestion: "Read the tool schema and correct the arguments before calling again.",
		};
	}
	if (typeof reason === "string") {
		return {
			code: reason.toUpperCase().replaceAll("-", "_"),
			retry: notDispatched ? "safe" : "unsafe",
			delivery: reported,
			suggestion: notDispatched
				? "Observe the target app again and resolve the refusal before retrying."
				: "Delivery is unconfirmed. Observe and verify the target before retrying.",
		};
	}
	return readOnly
		? {
				code: "TOOL_ERROR",
				retry: "safe",
				delivery: "not_sent",
				suggestion: "Nothing was sent: this tool only reads. Correct the arguments or the app state, then retry.",
			}
		: {
				code: "TOOL_ERROR",
				retry: "unsafe",
				delivery: "unknown",
				suggestion: "Observe and verify the target before retrying; the operation's delivery status is unknown.",
			};
}

/** Add machine-readable failure fields without replacing legacy error, reason, or evidence fields. */
export function normalizeToolError(result: CallToolResult, readOnly = false): CallToolResult {
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
	const { code, retry, delivery, suggestion, evidence } = errorMetadata(payload, message, readOnly);
	const { failure: _transported, ...legacy } = payload;
	const content = [...result.content];
	const text = {
		type: "text" as const,
		text: JSON.stringify({
			...legacy,
			ok: false,
			...(payloadIndex === -1 ? { error: message } : {}),
			code,
			retry,
			suggestion,
			disposition: { retry, delivery, hint: suggestion, ...(evidence === undefined ? {} : { evidence }) },
		}),
	};
	if (payloadIndex === -1) content.push(text);
	else content[payloadIndex] = text;
	return { ...result, isError: true, content };
}

/** Wrap the protocol boundary, including SDK argument validation and unknown-tool errors. */
export function installToolErrorEnvelope(server: McpServer): void {
	// Tools registered as read-only cannot have sent input, so their generic failures are safe to retry.
	const readOnlyTools = new Set<string>();
	const register = server.registerTool.bind(server);
	server.registerTool = (name, config, callback) => {
		if (config.annotations?.readOnlyHint === true) readOnlyTools.add(name);
		return register(name, config, callback);
	};
	const original = server.server.setRequestHandler.bind(server.server);
	server.server.setRequestHandler = (schema, handler) =>
		original(schema, async (request, extra) => {
			const result = await handler(request, extra);
			if (request.method !== "tools/call") return result;
			const parsed = CallToolResultSchema.safeParse(result);
			const readOnly = readOnlyTools.has(String(request.params["name"]));
			return parsed.success ? { ...result, ...normalizeToolError(parsed.data, readOnly) } : result;
		});
}
