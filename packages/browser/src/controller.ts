import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { BrowserBridge } from "./bridge.js";
import { BrowserError, expectSchema, httpUrl, limitsSchema, stepSchema, targetQuerySchema } from "./protocol.js";
import { BrowserSession } from "./session.js";

const handoffReasonSchema = z.string().min(1).max(300);
const spaceSchema = z
	.string()
	.regex(/^[a-zA-Z0-9_.-]{1,64}$/)
	.default("default");
const workerSchema = z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/);
const pageSchema = z.string().regex(/^p[1-9][0-9]*$/);
const MAX_PARALLEL_OPEN = 8;
const MAX_PAGES_PER_SPACE = 12;

export const controllerRequestSchema = z.discriminatedUnion("action", [
	z.object({ action: z.literal("status") }),
	z.object({ action: z.literal("handoff"), reason: handoffReasonSchema }),
	z.object({
		action: z.literal("wait_control"),
		timeoutMs: z.number().int().min(1).max(120000).default(30000),
	}),
	z.object({ action: z.literal("create"), space: spaceSchema, worker_id: workerSchema.optional() }),
	z.object({
		action: z.literal("open"),
		space: spaceSchema,
		url: httpUrl,
		worker_id: workerSchema.optional(),
	}),
	z.object({
		action: z.literal("open_many"),
		space: spaceSchema,
		urls: z.array(httpUrl).min(1).max(MAX_PARALLEL_OPEN),
		worker_id: workerSchema.optional(),
	}),
	z.object({
		action: z.literal("observe"),
		space: spaceSchema,
		page: pageSchema,
		limits: limitsSchema.optional(),
		full: z.boolean().default(false),
	}),
	z.object({
		action: z.literal("find"),
		space: spaceSchema,
		page: pageSchema,
		query: targetQuerySchema,
		limit: z.number().int().min(1).max(50).default(10),
	}),
	z.object({
		action: z.literal("read"),
		space: spaceSchema,
		page: pageSchema,
		maxChars: z.number().int().min(200).max(40000).default(8000),
		includeLinks: z.boolean().default(false),
	}),
	z
		.object({
			action: z.literal("wait"),
			space: spaceSchema,
			page: pageSchema,
			text: z.string().min(1).max(500).optional(),
			selector: z.string().min(1).max(500).optional(),
			timeoutMs: z.number().int().min(1).max(10000).default(3000),
			limits: limitsSchema.optional(),
		})
		.refine((input) => input.text !== undefined || input.selector !== undefined, {
			message: "wait needs text or selector",
		}),
	z.object({
		action: z.literal("screenshot"),
		space: spaceSchema,
		page: pageSchema,
		fullPage: z.boolean().default(false),
	}),
	z.object({
		action: z.literal("run"),
		space: spaceSchema,
		page: pageSchema,
		observation_token: z.string().uuid(),
		steps: z.array(stepSchema).min(1).max(20),
		expect: expectSchema.optional(),
		limits: limitsSchema.optional(),
	}),
	z.object({ action: z.literal("close"), space: spaceSchema, page: pageSchema }),
	z.object({ action: z.literal("finish"), space: spaceSchema }),
]);

type SpaceState = {
	readonly session: BrowserSession;
	readonly pages: Map<string, { readonly tabId: number; readonly generation: number }>;
	readonly workerId: string | undefined;
	readonly cursorId: string;
	nextPage: number;
	finishing: boolean;
	opening: number;
};

/** Named spaces and permanent page labels live in the daemon, not a CLI process. */
export class BrowserController {
	private readonly spaces = new Map<string, SpaceState>();

	private readonly bridge: BrowserBridge;

	private readonly buildId: string | undefined;

	constructor(bridge: BrowserBridge, buildId?: string) {
		this.bridge = bridge;
		this.buildId = buildId;
	}

	async dispatch(value: unknown, signal?: AbortSignal): Promise<unknown> {
		const input = controllerRequestSchema.parse(value);
		if (
			signal !== undefined &&
			input.action !== "open" &&
			input.action !== "open_many" &&
			input.action !== "wait_control"
		)
			return this.bridge.withCancellation(signal, () => this.dispatch(value));
		switch (input.action) {
			case "status": {
				const handoff = this.bridge.handoffRequest;
				return {
					...(this.buildId === undefined ? {} : { build_id: this.buildId }),
					connected: this.bridge.connected,
					stopped: this.bridge.paused,
					control: this.bridge.control,
					control_reason: this.bridge.controlReason ?? null,
					handoff_requested:
						handoff === undefined ? null : { reason: handoff.reason, requested_at: handoff.requestedAt },
					spaces: [...this.spaces].map(([space, state]) => ({
						space,
						pages: [...state.pages.keys()],
						...(state.workerId === undefined ? {} : { worker_id: state.workerId }),
						cursor_id: state.cursorId,
					})),
				};
			}
			case "handoff": {
				const handoff = await this.bridge.requestHandoff(input.reason);
				return {
					handoff_requested: { reason: handoff.reason, requested_at: handoff.requestedAt },
					control: this.bridge.control,
				};
			}
			case "wait_control": {
				const started = Date.now();
				const agentHasControl = await this.bridge.waitForAgentControl(input.timeoutMs, signal);
				return {
					control: agentHasControl ? "agent" : this.bridge.control,
					waited_ms: Date.now() - started,
				};
			}
			case "create": {
				const state = this.create(input.space, input.worker_id);
				return {
					space: input.space,
					pages: [...state.pages.keys()],
					...(state.workerId === undefined ? {} : { worker_id: state.workerId }),
					cursor_id: state.cursorId,
				};
			}
			case "open": {
				const state = this.create(input.space, input.worker_id);
				this.reservePages(state, 1);
				state.opening++;
				try {
					const opened = await state.session.open(input.url, signal);
					const page = `p${state.nextPage++}`;
					state.pages.set(page, { tabId: opened.tabId, generation: this.bridge.generation });
					return { space: input.space, page, ...attribution(state) };
				} finally {
					state.opening--;
				}
			}
			case "open_many": {
				const state = this.create(input.space, input.worker_id);
				this.reservePages(state, input.urls.length);
				state.opening += input.urls.length;
				try {
					const outcomes = await Promise.all(
						input.urls.map(async (url) => {
							try {
								return { url, opened: await state.session.open(url, signal) };
							} catch (error: unknown) {
								return { url, error: error instanceof Error ? error.message : String(error) };
							}
						}),
					);
					const pages: { page: string; url: string; tab_id: number }[] = [];
					const failed: { url: string; error: string }[] = [];
					for (const outcome of outcomes) {
						if ("opened" in outcome) {
							const page = `p${state.nextPage++}`;
							state.pages.set(page, { tabId: outcome.opened.tabId, generation: this.bridge.generation });
							pages.push({ page, url: outcome.url, tab_id: outcome.opened.tabId });
						} else failed.push({ url: outcome.url, error: outcome.error });
					}
					return { space: input.space, pages, failed, ...attribution(state) };
				} finally {
					state.opening -= input.urls.length;
				}
			}
			case "observe": {
				const { state, tabId } = this.target(input.space, input.page);
				return {
					space: input.space,
					page: input.page,
					...attribution(state),
					...(await state.session.observe(tabId, input.limits, input.full)),
				};
			}
			case "find": {
				const { state, tabId } = this.target(input.space, input.page);
				return {
					space: input.space,
					page: input.page,
					...attribution(state),
					...(await state.session.find(tabId, input.query, input.limit)),
				};
			}
			case "read": {
				const { state, tabId } = this.target(input.space, input.page);
				return {
					space: input.space,
					page: input.page,
					...attribution(state),
					...(await state.session.read(tabId, input.maxChars, input.includeLinks)),
				};
			}
			case "wait": {
				const { state, tabId } = this.target(input.space, input.page);
				return {
					space: input.space,
					page: input.page,
					...attribution(state),
					...(await state.session.wait(
						tabId,
						{
							...(input.text === undefined ? {} : { text: input.text }),
							...(input.selector === undefined ? {} : { selector: input.selector }),
							timeoutMs: input.timeoutMs,
						},
						input.limits,
					)),
				};
			}
			case "screenshot": {
				const { state, tabId } = this.target(input.space, input.page);
				return {
					space: input.space,
					page: input.page,
					...attribution(state),
					...(await state.session.screenshot(tabId, input.fullPage)),
				};
			}
			case "run": {
				const { state, tabId } = this.target(input.space, input.page);
				return {
					space: input.space,
					page: input.page,
					...attribution(state),
					...(await state.session.run(tabId, input.observation_token, input.steps, input.expect, input.limits)),
				};
			}
			case "close": {
				const { state, tabId } = this.target(input.space, input.page);
				await state.session.close(tabId);
				state.pages.delete(input.page);
				return { space: input.space, closed: input.page, ...attribution(state) };
			}
			case "finish": {
				const state = this.spaces.get(input.space);
				if (state === undefined) throw new BrowserError("stale", "Unknown task space");
				if (state.finishing || state.opening > 0)
					throw new BrowserError("busy", "Task space is opening or finishing");
				state.finishing = true;
				const abandoned: string[] = [];
				try {
					for (const [page, owned] of state.pages) {
						if (owned.generation !== this.bridge.generation) abandoned.push(page);
						else await state.session.close(owned.tabId);
						state.pages.delete(page);
					}
					this.spaces.delete(input.space);
				} finally {
					state.finishing = false;
				}
				return abandoned.length === 0
					? { finished: input.space, ...attribution(state) }
					: { finished: input.space, abandoned, ...attribution(state) };
			}
		}
	}

	private create(space: string, workerId?: string): SpaceState {
		const existing = this.spaces.get(space);
		if (existing !== undefined) {
			if (existing.finishing) throw new BrowserError("busy", "Task space is finishing");
			if (workerId !== undefined && existing.workerId !== undefined && existing.workerId !== workerId)
				throw new BrowserError("busy", `Task space ${space} is owned by worker ${existing.workerId}`);
			return existing;
		}
		if (workerId !== undefined) {
			const owned = [...this.spaces].find(([, state]) => state.workerId === workerId);
			if (owned !== undefined)
				throw new BrowserError("busy", `Worker ${workerId} already owns browser space ${owned[0]}`);
		}
		const state: SpaceState = {
			session: new BrowserSession(this.bridge),
			pages: new Map<string, { readonly tabId: number; readonly generation: number }>(),
			workerId,
			cursorId: randomUUID(),
			nextPage: 1,
			finishing: false,
			opening: 0,
		};
		this.spaces.set(space, state);
		return state;
	}

	private reservePages(state: SpaceState, count: number): void {
		if (state.pages.size + state.opening + count > MAX_PAGES_PER_SPACE)
			throw new BrowserError(
				"busy",
				`A browser space holds at most ${MAX_PAGES_PER_SPACE} pages. Close pages before opening more.`,
			);
	}

	private target(space: string, page: string) {
		const state = this.spaces.get(space);
		const owned = state?.pages.get(page);
		if (state === undefined || owned === undefined) throw new BrowserError("stale", "Unknown task space or page");
		if (state.finishing) throw new BrowserError("busy", "Task space is finishing");
		return { state, tabId: owned.tabId };
	}
}

function attribution(state: SpaceState) {
	return {
		...(state.workerId === undefined ? {} : { worker_id: state.workerId }),
		cursor_id: state.cursorId,
	};
}
