export type HandName = "left" | "right" | "vision";
export type HandResource = "pointer" | "keyboard" | "focus" | "capture" | "ax";
export type HandsPolicy = "auto" | "never" | "always";

export interface HandTask<T> {
	readonly hand: HandName;
	readonly resources: readonly HandResource[];
	readonly run: () => Promise<T>;
}

export interface HandLaneResult<T> {
	readonly index: number;
	readonly hand: HandName;
	readonly startedMs: number;
	readonly finishedMs: number;
	readonly waitMs: number;
	readonly durationMs: number;
	readonly ok: boolean;
	readonly aborted: boolean;
	readonly value?: T;
	readonly error?: unknown;
}

export interface HandsRunResult<T> {
	readonly policy: HandsPolicy;
	readonly aborted: boolean;
	/** Started lanes in input order, including lanes that threw AbortError. */
	readonly lanes: readonly HandLaneResult<T>[];
	/** Input indices of tasks cancelled before their run function was called. */
	readonly notStarted: readonly number[];
	readonly overlapMs: number;
	readonly sequentialEstimateMs: number;
}

export interface HandsRunOptions {
	readonly policy?: HandsPolicy;
	readonly signal?: AbortSignal;
}

interface Waiter {
	readonly resources: readonly HandResource[];
	readonly grant: () => void;
}

function abortError(): Error {
	const error = new Error("Hands run aborted before resource acquisition");
	error.name = "AbortError";
	return error;
}

function isAbort(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

/** Time with at least two lanes active; triple overlap counts once. Lanes from several runs may be measured together. */
export function measureOverlapMs(lanes: readonly Pick<HandLaneResult<unknown>, "startedMs" | "finishedMs">[]): number {
	const edges = lanes.flatMap((lane) => [
		{ time: lane.startedMs, delta: 1 },
		{ time: lane.finishedMs, delta: -1 },
	]);
	edges.sort((a, b) => a.time - b.time);
	let active = 0;
	let previousMs = edges[0]?.time ?? 0;
	let overlapMs = 0;
	for (const edge of edges) {
		if (active > 1) {
			overlapMs += edge.time - previousMs;
		}
		active += edge.delta;
		previousMs = edge.time;
	}
	return overlapMs;
}

/** Resource ownership is shared by auto/never runs on this coordinator. */
export class HandsCoordinator {
	private readonly held = new Set<HandResource>();
	private readonly waiters: Waiter[] = [];
	private readonly now: () => number;

	public constructor(now: () => number = () => performance.now()) {
		this.now = now;
	}

	private drain(): void {
		while (this.waiters.length > 0) {
			const waiter = this.waiters[0];
			if (!waiter || waiter.resources.some((resource) => this.held.has(resource))) {
				return;
			}
			this.waiters.shift();
			for (const resource of waiter.resources) {
				this.held.add(resource);
			}
			waiter.grant();
		}
	}

	private acquire(resources: readonly HandResource[], signal: AbortSignal): Promise<() => void> {
		return new Promise((resolve, reject) => {
			if (signal.aborted) {
				reject(abortError());
				return;
			}
			const cancel = (): void => {
				const index = this.waiters.indexOf(waiter);
				if (index !== -1) {
					this.waiters.splice(index, 1);
					reject(abortError());
					this.drain();
				}
			};
			const waiter: Waiter = {
				resources,
				grant: () => {
					signal.removeEventListener("abort", cancel);
					resolve(() => {
						for (const resource of resources) {
							this.held.delete(resource);
						}
						this.drain();
					});
				},
			};
			signal.addEventListener("abort", cancel, { once: true });
			this.waiters.push(waiter);
			this.drain();
		});
	}

	public async run<T>(tasks: readonly HandTask<T>[], options: HandsRunOptions = {}): Promise<HandsRunResult<T>> {
		const policy = options.policy ?? "auto";
		if (policy === "always") {
			const claimed = new Set<HandResource>();
			for (const task of tasks) {
				const resources = new Set(task.resources);
				for (const resource of resources) {
					if (claimed.has(resource)) {
						throw new Error(`Hands policy "always" requires disjoint resources; conflict: ${resource}`);
					}
					claimed.add(resource);
				}
			}
		}

		const controller = new AbortController();
		const abort = (): void => controller.abort();
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) {
			abort();
		}
		const queuedMs = this.now();
		const lanes: HandLaneResult<T>[] = [];
		const notStarted: number[] = [];
		const execute = async (task: HandTask<T>, index: number): Promise<void> => {
			let release: (() => void) | undefined;
			try {
				if (policy !== "always") {
					release = await this.acquire(task.resources, controller.signal);
				}
				if (controller.signal.aborted) {
					notStarted.push(index);
					return;
				}
				const startedMs = this.now();
				let outcome: Pick<HandLaneResult<T>, "ok" | "aborted" | "value" | "error">;
				try {
					outcome = { ok: true, aborted: false, value: await task.run() };
				} catch (error) {
					const aborted = isAbort(error);
					if (aborted) {
						abort();
					}
					outcome = { ok: false, aborted, error };
				}
				const finishedMs = this.now();
				lanes.push({
					index,
					hand: task.hand,
					startedMs,
					finishedMs,
					waitMs: startedMs - queuedMs,
					durationMs: finishedMs - startedMs,
					...outcome,
				});
			} catch (error) {
				if (!isAbort(error)) {
					throw error;
				}
				notStarted.push(index);
			} finally {
				release?.();
			}
		};

		try {
			if (policy === "never") {
				for (const [index, task] of tasks.entries()) {
					await execute(task, index);
				}
			} else {
				await Promise.all(tasks.map(execute));
			}
		} finally {
			options.signal?.removeEventListener("abort", abort);
		}
		lanes.sort((a, b) => a.index - b.index);
		notStarted.sort((a, b) => a - b);

		return {
			policy,
			aborted: controller.signal.aborted,
			lanes,
			notStarted,
			overlapMs: measureOverlapMs(lanes),
			sequentialEstimateMs: lanes.reduce((sum, lane) => sum + lane.durationMs, 0),
		};
	}
}
