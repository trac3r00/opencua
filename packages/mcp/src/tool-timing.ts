import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { resolveSnapshotRefs, withSnapshotRefs } from "./snapshot-refs.js";
import { failurePayload } from "./tool-errors.js";
import type { ToolResult } from "./tool-result.js";

const MAX_SAMPLES = 512;

type ToolStats = {
	calls: number;
	errors: number;
	bytes: number;
	samples: number[];
	sampleIndex: number;
};

type ToolSnapshot = {
	calls: number;
	errors: number;
	p50_ms: number;
	max_ms: number;
	bytes: number;
};

function quantile(samples: readonly number[], percentile: number): number {
	if (samples.length === 0) return 0;
	const sorted = [...samples].sort((left, right) => left - right);
	return sorted[Math.ceil(percentile * sorted.length) - 1] ?? 0;
}

function addSample(stats: ToolStats, durationMs: number): void {
	const duration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
	if (stats.samples.length < MAX_SAMPLES) {
		stats.samples.push(duration);
		return;
	}
	stats.samples[stats.sampleIndex] = duration;
	stats.sampleIndex = (stats.sampleIndex + 1) % MAX_SAMPLES;
}

function snapshotTool(stats: ToolStats): ToolSnapshot {
	return {
		calls: stats.calls,
		errors: stats.errors,
		p50_ms: quantile(stats.samples, 0.5),
		max_ms: stats.samples.length === 0 ? 0 : Math.max(...stats.samples),
		bytes: stats.bytes,
	};
}

export class ToolUsageRegistry {
	private readonly startedAt: number;
	private readonly tools = new Map<string, ToolStats>();
	private calls = 0;
	private errors = 0;
	private totalBytes = 0;
	private readonly samples: number[] = [];
	private sampleIndex = 0;

	constructor(now: () => number = Date.now) {
		this.startedAt = now();
	}

	record(name: string, durationMs: number, isError: boolean, bytes: number): void {
		const duration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
		const byteCount = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
		const stats = this.tools.get(name) ?? {
			calls: 0,
			errors: 0,
			bytes: 0,
			samples: [],
			sampleIndex: 0,
		};
		stats.calls++;
		stats.errors += Number(isError);
		stats.bytes += byteCount;
		this.tools.set(name, stats);
		this.calls++;
		this.errors += Number(isError);
		this.totalBytes += byteCount;
		addSample(stats, duration);
		const overall: ToolStats = {
			calls: this.calls,
			errors: this.errors,
			bytes: this.totalBytes,
			samples: this.samples,
			sampleIndex: this.sampleIndex,
		};
		addSample(overall, duration);
		this.sampleIndex = overall.sampleIndex;
	}

	snapshot(): {
		since: number;
		calls: number;
		errors: number;
		total_bytes: number;
		p50_ms: number;
		p95_ms: number;
		max_ms: number;
		slowest_ms: number;
		by_tool: Record<string, ToolSnapshot>;
	} {
		const byTool = Object.fromEntries([...this.tools].map(([name, stats]) => [name, snapshotTool(stats)]));
		const samples = [...this.samples];
		const max = samples.length === 0 ? 0 : Math.max(...samples);
		return {
			since: this.startedAt,
			calls: this.calls,
			errors: this.errors,
			total_bytes: this.totalBytes,
			p50_ms: quantile(samples, 0.5),
			p95_ms: quantile(samples, 0.95),
			max_ms: max,
			slowest_ms: max,
			by_tool: byTool,
		};
	}
}

export function mergeTiming(
	result: ToolResult,
	timing: {
		total: number;
		handler?: number;
		bytes?: number;
		[key: string]: number | undefined;
	},
): ToolResult {
	const content = [...result.content];
	let hasText = false;
	for (let index = content.length - 1; index >= 0; index--) {
		const item = content[index];
		if (item?.type !== "text") continue;
		hasText = true;
		try {
			const parsed: unknown = JSON.parse(item.text);
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
			const existing = parsed as Record<string, unknown>;
			content[index] = {
				type: "text",
				text: JSON.stringify({
					...existing,
					timing_ms: {
						...(typeof existing["timing_ms"] === "object" && existing["timing_ms"] !== null
							? existing["timing_ms"]
							: {}),
						...timing,
					},
				}),
			};
			return { content, ...(result.isError === undefined ? {} : { isError: result.isError }) };
		} catch {
			// Continue to earlier text content until a JSON object is found.
		}
	}
	const timingText = { type: "text" as const, text: JSON.stringify({ timing_ms: timing }) };
	// Keep the original last text item last: clients that select the final text block still see the payload.
	if (hasText) content.unshift(timingText);
	else content.push(timingText);
	return { content, ...(result.isError === undefined ? {} : { isError: result.isError }) };
}

export type HeartbeatTimer = { unref?: () => void };
export type HeartbeatNotification = {
	method: "notifications/progress";
	params: { progressToken: string | number; progress: number };
};
export type HeartbeatSend = (notification: HeartbeatNotification) => void | Promise<void>;
export type HeartbeatScheduler = (callback: () => void, delayMs: number) => HeartbeatTimer;
export type HeartbeatCanceller = (timer: HeartbeatTimer) => void;
export type TimingHeartbeatOptions = {
	progressToken: string | number | undefined;
	send: HeartbeatSend;
	now?: () => number;
	schedule?: HeartbeatScheduler;
	cancel?: HeartbeatCanceller;
};

export type ToolUsageSnapshot = ReturnType<ToolUsageRegistry["snapshot"]>;

export class TimingHeartbeat {
	private timer: HeartbeatTimer | undefined;
	private stopped = false;
	private sending = false;
	private progress = 0;
	private readonly progressToken: string | number | undefined;
	private readonly send: HeartbeatSend;
	private readonly now: () => number;
	private readonly schedule: HeartbeatScheduler;
	private readonly cancel: HeartbeatCanceller;

	constructor(options: TimingHeartbeatOptions) {
		this.progressToken = options.progressToken;
		this.send = options.send;
		this.now = options.now ?? Date.now;
		this.schedule =
			options.schedule ??
			((callback, delayMs) => {
				const timer = setInterval(callback, delayMs);
				return timer as unknown as HeartbeatTimer;
			});
		this.cancel = options.cancel ?? ((timer) => clearInterval(timer as unknown as ReturnType<typeof setInterval>));
	}

	start(): void {
		if (this.progressToken === undefined || this.timer !== undefined || this.stopped) return;
		const progressToken = this.progressToken;
		const startedAt = this.now();
		this.timer = this.schedule(() => {
			if (this.stopped || this.sending) return;
			this.sending = true;
			this.progress = Math.max(this.progress + 1, Math.floor((this.now() - startedAt) / 1000));
			void Promise.resolve(
				this.send({
					method: "notifications/progress",
					params: { progressToken, progress: this.progress },
				}),
			).finally(() => {
				this.sending = false;
			});
		}, 1000);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		if (this.timer !== undefined) {
			this.cancel(this.timer);
			this.timer = undefined;
		}
	}
}

interface ToolRegistrationConfig {
	readonly inputSchema?: unknown;
}

type ToolHandler = (...args: unknown[]) => CallToolResult | Promise<CallToolResult>;
type RegisterToolLike = (name: string, config: ToolRegistrationConfig, callback: ToolHandler) => unknown;

type ToolInvocationExtra = RequestHandlerExtra<ServerRequest, ServerNotification> | undefined;

function progressTokenFrom(extra: ToolInvocationExtra): string | number | undefined {
	const token = extra?._meta?.progressToken;
	return typeof token === "string" || typeof token === "number" ? token : undefined;
}

function resultBytes(result: CallToolResult): number {
	return result.content.reduce((total, item) => {
		if (item.type === "text") return total + Buffer.byteLength(item.text);
		if (item.type === "image") return total + Buffer.byteLength(item.data);
		return total;
	}, 0);
}

/**
 * Install always-on timing and a progress heartbeat on every tool this server registers. The wrapper
 * measures the handler, records bounded usage, merges `timing_ms` into the model-visible JSON, and
 * emits progress only when the client supplied a token. Invalid-params errors keep their JSON-RPC
 * shape; ordinary handler failures are recorded but not rewritten.
 */
export function installToolTiming(server: McpServer, usage: ToolUsageRegistry): void {
	const original = server.registerTool.bind(server) as unknown as RegisterToolLike;
	server.registerTool = ((name: string, config: ToolRegistrationConfig, callback: ToolHandler) => {
		const wrapped: ToolHandler = async (...invocation: unknown[]): Promise<CallToolResult> => {
			const hasInputSchema = config.inputSchema !== undefined;
			const input = hasInputSchema ? invocation[0] : undefined;
			const extra = (hasInputSchema ? invocation[1] : invocation[0]) as ToolInvocationExtra;
			const token = progressTokenFrom(extra);
			const heartbeat = new TimingHeartbeat({
				progressToken: token,
				send: async (notification) => {
					if (extra === undefined) return;
					try {
						await extra.sendNotification(notification);
					} catch (error: unknown) {
						const details = error instanceof Error ? error.message : String(error);
						process.stderr.write(`Failed to send ${name} heartbeat: ${details}\n`);
					}
				},
			});
			heartbeat.start();
			const startedAt = performance.now();
			try {
				const callbackArgs = hasInputSchema ? [resolveSnapshotRefs(input), extra] : [extra];
				const result = (await Reflect.apply(callback, undefined, callbackArgs)) as CallToolResult;
				const durationMs = performance.now() - startedAt;
				const bytes = resultBytes(result);
				usage.record(name, durationMs, result.isError === true, bytes);
				return withSnapshotRefs(
					mergeTiming(result as ToolResult, {
						total: Math.round(durationMs * 10) / 10,
						handler: Math.round(durationMs * 10) / 10,
						bytes,
					}),
				);
			} catch (error: unknown) {
				const durationMs = performance.now() - startedAt;
				usage.record(name, durationMs, true, 0);
				if (error instanceof McpError) {
					throw error;
				}
				const message = error instanceof Error ? error.message : String(error);
				return mergeTiming(
					{
						isError: true,
						content: [
							{
								type: "text",
								text: JSON.stringify({
									error:
										message.trim().length === 0
											? "tool failed without error details; observe the app before retrying"
											: message,
									...failurePayload(error),
								}),
							},
						],
					},
					{ total: Math.round(durationMs * 10) / 10, handler: Math.round(durationMs * 10) / 10, bytes: 0 },
				);
			} finally {
				heartbeat.stop();
			}
		};
		return original(name, config, wrapped);
	}) as unknown as McpServer["registerTool"];
}
