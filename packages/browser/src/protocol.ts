import { z } from "zod";

export const httpUrl = z
	.string()
	.max(8192)
	.url()
	.refine((url) => /^https?:\/\//.test(url), "Only HTTP(S) URLs are supported");

/**
 * `interactive` is the agent default: controls and short visible text. `content`
 * returns reading-order content roles. `all` is the compatibility profile with
 * full-length names.
 */
export const observationProfileSchema = z.enum(["interactive", "content", "all"]).default("interactive");

export const limitsSchema = z.object({
	maxChars: z.number().int().min(256).max(20000).default(6000),
	maxElements: z.number().int().min(1).max(200).default(80),
	fullPage: z.boolean().default(false),
	profile: observationProfileSchema,
	maxNameChars: z.number().int().min(40).max(500).default(120),
	query: z.string().max(200).optional(),
});

export const targetQuerySchema = z
	.object({
		role: z.string().min(1).max(60).optional(),
		name: z.string().min(1).max(500).optional(),
		text: z.string().min(1).max(500).optional(),
	})
	.refine((query) => query.role !== undefined || query.name !== undefined || query.text !== undefined, {
		message: "A target query needs role, name, or text",
	});

const positiveRef = z.number().int().positive();
const pressKeys = z.enum(["Enter", "Tab", "Escape", "ArrowDown", "ArrowUp"]);
const selectChoice = z
	.object({
		value: z.string().max(2000).optional(),
		label: z.string().max(2000).optional(),
		index: z.number().int().min(0).max(100000).optional(),
	})
	.strict()
	.refine((choice) => [choice.value, choice.label, choice.index].filter((item) => item !== undefined).length === 1, {
		message: "A select step needs exactly one of value, label, or index",
	});

export const stepSchema = z.union([
	z.object({ action: z.literal("click"), ref: positiveRef }).strict(),
	z.object({ action: z.literal("click"), target: targetQuerySchema }).strict(),
	z.object({ action: z.literal("fill"), ref: positiveRef, text: z.string().max(10000) }).strict(),
	z.object({ action: z.literal("fill"), target: targetQuerySchema, text: z.string().max(10000) }).strict(),
	z.object({ action: z.literal("press"), ref: positiveRef, key: pressKeys }).strict(),
	z.object({ action: z.literal("press"), target: targetQuerySchema, key: pressKeys }).strict(),
	z.object({ action: z.literal("select"), ref: positiveRef, choice: selectChoice }).strict(),
	z.object({ action: z.literal("select"), target: targetQuerySchema, choice: selectChoice }).strict(),
	z.object({ action: z.literal("scroll"), deltaY: z.number().min(-5000).max(5000) }).strict(),
	z
		.object({
			action: z.literal("wait"),
			text: z.string().min(1).max(500).optional(),
			selector: z.string().min(1).max(500).optional(),
			timeoutMs: z.number().int().min(1).max(10000).default(3000),
		})
		.strict()
		.refine((step) => step.text !== undefined || step.selector !== undefined, {
			message: "A wait step needs text or selector",
		}),
]);

export const expectSchema = z.object({
	text: z.string().min(1).max(500),
	timeoutMs: z.number().int().min(1).max(10000).default(3000),
});

export const observationSchema = z.object({
	url: z.string().max(8192),
	title: z.string().max(500),
	revision: z.string(),
	rows: z
		.array(
			z.object({
				ref: z.number().int().positive(),
				role: z.string().max(60),
				name: z.string().max(500),
			}),
		)
		.max(200),
	truncated: z.boolean(),
});

export const findResultSchema = z.object({
	url: z.string().max(8192),
	title: z.string().max(500),
	revision: z.string(),
	matches: z
		.array(
			z.object({
				ref: z.number().int().positive(),
				role: z.string().max(60),
				name: z.string().max(500),
			}),
		)
		.max(50),
	truncated: z.boolean(),
});

export const readResultSchema = z.object({
	url: z.string().max(8192),
	title: z.string().max(500),
	revision: z.string(),
	text: z.string().max(40000),
	links: z
		.array(z.object({ ref: z.number().int().positive(), name: z.string().max(500) }))
		.max(200)
		.optional(),
	truncated: z.boolean(),
});

export const waitResultSchema = z.object({
	matched: z.boolean(),
	reason: z.enum(["matched", "timeout"]),
	revision: z.string(),
});

export const screenshotResultSchema = z.object({
	data: z.string().min(1).max(8_000_000),
	mimeType: z.enum(["image/jpeg", "image/png"]),
	width: z.number().int().positive().optional(),
	height: z.number().int().positive().optional(),
});

export type BrowserObservation = z.infer<typeof observationSchema>;
export type BrowserFindResult = z.infer<typeof findResultSchema>;
export type BrowserReadResult = z.infer<typeof readResultSchema>;
export type BrowserWaitResult = z.infer<typeof waitResultSchema>;
export type BrowserScreenshot = z.infer<typeof screenshotResultSchema>;
export type BrowserStep = z.infer<typeof stepSchema>;
export type ObservationLimits = z.infer<typeof limitsSchema>;
export type BrowserExpectation = z.infer<typeof expectSchema>;
export type TargetQuery = z.infer<typeof targetQuerySchema>;

export interface HandoffRequest {
	readonly reason: string;
	readonly requestedAt: string;
}

export interface RunCommand {
	readonly method: "run";
	readonly tabId: number;
	readonly revision: string;
	readonly steps: readonly BrowserStep[];
	readonly expect: BrowserExpectation | undefined;
	readonly limits: ObservationLimits;
}

export type BrowserCommand =
	| { readonly method: "open"; readonly url: string }
	| { readonly method: "observe"; readonly tabId: number; readonly limits: ObservationLimits }
	| {
			readonly method: "find";
			readonly tabId: number;
			readonly query: TargetQuery;
			readonly limit: number;
	  }
	| {
			readonly method: "read";
			readonly tabId: number;
			readonly maxChars: number;
			readonly includeLinks: boolean;
	  }
	| {
			readonly method: "wait";
			readonly tabId: number;
			readonly text: string | undefined;
			readonly selector: string | undefined;
			readonly timeoutMs: number;
	  }
	| { readonly method: "screenshot"; readonly tabId: number; readonly fullPage: boolean }
	| RunCommand
	| { readonly method: "close"; readonly tabId: number }
	| { readonly method: "handoff"; readonly reason: string }
	| { readonly method: "stop" }
	| { readonly method: "cancel" };

export const replySchema = z.discriminatedUnion("ok", [
	z.object({ id: z.string(), ok: z.literal(true), value: z.unknown() }),
	z.object({ id: z.string(), ok: z.literal(false), error: z.string().max(2000) }),
]);

export type BrowserErrorCode =
	| "disconnected"
	| "timeout"
	| "stopped"
	| "human_control"
	| "stale"
	| "extension"
	| "busy"
	| "not-found"
	| "unsupported";

export class BrowserError extends Error {
	constructor(
		readonly code: BrowserErrorCode,
		message: string,
	) {
		super(message);
		this.name = "BrowserError";
	}
}
