import { Worker } from "node:worker_threads";
import type { Size } from "../types/index.js";
import { resolveWindowScreenshotSize } from "./viewport.js";

const DEFAULT_WORKER_URL = new URL("./hot-frames-worker.js", import.meta.url);
const DEFAULT_MAX_AGE_MS = 300;
const DEFAULT_IDLE_STOP_MS = 2_000;
const DEFAULT_QUALITY = 72;

export interface HotFrame {
	readonly data: Buffer;
	readonly mimeType: "image/jpeg";
	readonly width: number;
	readonly height: number;
	readonly capturedAt: number;
	readonly hash: string;
}

export interface HotFrameWorker {
	postMessage(message: unknown, transfer?: readonly unknown[]): void;
	on(event: "message", listener: (message: unknown) => void): void;
	on(event: "error" | "exit", listener: (payload?: unknown) => void): void;
	terminate(): Promise<unknown>;
}

export type HotFrameWorkerSpawner = (url: URL) => HotFrameWorker | undefined;

export interface HotFrameSourceOptions {
	/** Frames older than this answer the live capture instead. */
	readonly maxAgeMs?: number;
	/** The refresher stops itself after this long without a call touching it. */
	readonly idleStopMs?: number;
	readonly quality?: number;
	readonly workerUrl?: URL;
	readonly spawnWorker?: HotFrameWorkerSpawner;
}

interface FrameMessage {
	readonly type: "frame";
	readonly bytes: Uint8Array;
	readonly width: number;
	readonly height: number;
	readonly capturedAt: number;
	readonly hash: string;
}

/**
 * Speculative capture for an engaged session: a worker thread re-captures the bound window in a
 * loop while the session keeps touching it, so a vision call answers from the latest warm frame
 * instead of paying a one-shot capture on the main thread. A stale or missing frame falls back to
 * the live capture; nothing here is ever presented as fresher than its age.
 */
export class HotFrameSource {
	private readonly options: HotFrameSourceOptions;
	private worker: HotFrameWorker | undefined;
	private latest: HotFrame | undefined;
	/** Whether the refresher delivered any frame for its current target; until then it is still starting up. */
	private delivered = false;
	private targetKey = "";
	private idleTimer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;

	constructor(options: HotFrameSourceOptions = {}) {
		this.options = options;
	}

	/** Begin (or retarget) the refresher for one bound window. Cheap to repeat. */
	start(pid: number, windowId: number, windowSize: Size): void {
		if (this.disposed) {
			return;
		}
		this.touchIdleTimer();
		const size = resolveWindowScreenshotSize(windowSize);
		const key = `${pid}:${windowId}:${size.width}x${size.height}`;
		if (this.worker !== undefined) {
			if (key !== this.targetKey) {
				this.targetKey = key;
				this.latest = undefined;
				this.delivered = false;
				this.worker.postMessage({
					type: "target",
					windowId,
					width: size.width,
					height: size.height,
					quality: this.options.quality ?? DEFAULT_QUALITY,
				});
			}
			return;
		}
		this.targetKey = key;
		this.delivered = false;
		this.spawnWorker(windowId, size);
	}

	/** The freshest frame for this window, or undefined when none is young enough to trust. */
	latestFor(pid: number, windowId: number): HotFrame | undefined {
		this.touchIdleTimer();
		const frame = this.latest;
		if (frame === undefined) {
			return undefined;
		}
		const ageMs = Date.now() - frame.capturedAt;
		if (ageMs > (this.options.maxAgeMs ?? DEFAULT_MAX_AGE_MS)) {
			return undefined;
		}
		const currentKey = `${pid}:${windowId}`;
		if (!this.targetKey.startsWith(`${currentKey}:`)) {
			return undefined;
		}
		return frame;
	}

	/** True while a refresher is live for this window, so callers prefer waiting over competing with it. */
	engaged(pid: number, windowId: number): boolean {
		return this.worker !== undefined && this.targetKey.startsWith(`${pid}:${windowId}:`);
	}

	/**
	 * True while the refresher for this window has not delivered its first frame. Its first capture holds the window's
	 * one native capture slot, so a live capture started now fails; waiting for that frame is the faster answer.
	 */
	warming(pid: number, windowId: number): boolean {
		return this.engaged(pid, windowId) && !this.delivered;
	}

	/** Bounded wait for the refresher's next frame; undefined when none lands inside the budget. */
	async waitForFrame(pid: number, windowId: number, budgetMs: number): Promise<HotFrame | undefined> {
		const started = Date.now();
		while (true) {
			const frame = this.latestFor(pid, windowId);
			if (frame !== undefined) {
				return frame;
			}
			const remaining = budgetMs - (Date.now() - started);
			if (remaining <= 0) {
				return undefined;
			}
			await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(8, remaining)));
		}
	}

	/** Drop a refresher that stopped delivering, so the next start() spawns a fresh one. */
	drop(): void {
		if (this.worker !== undefined) {
			this.worker.postMessage({ type: "stop" });
		}
		this.worker = undefined;
		this.latest = undefined;
	}

	stop(): void {
		if (this.idleTimer !== undefined) {
			clearTimeout(this.idleTimer);
			this.idleTimer = undefined;
		}
		const worker = this.worker;
		this.worker = undefined;
		this.latest = undefined;
		this.targetKey = "";
		if (worker === undefined) {
			return;
		}
		// The worker exits itself between captures; a native capture must never be torn down mid-call.
		worker.postMessage({ type: "stop" });
		const terminateFallback = setTimeout(() => {
			worker.terminate().catch(() => undefined);
		}, 2_000);
		const exits = worker as { once?: (event: string, listener: () => void) => void };
		exits.once?.("exit", () => {
			clearTimeout(terminateFallback);
		});
	}

	dispose(): void {
		this.disposed = true;
		this.stop();
	}

	private touchIdleTimer(): void {
		if (this.idleTimer !== undefined) {
			clearTimeout(this.idleTimer);
		}
		this.idleTimer = setTimeout(() => {
			this.stop();
		}, this.options.idleStopMs ?? DEFAULT_IDLE_STOP_MS);
	}

	private spawnWorker(windowId: number, size: Size): void {
		const url = this.options.workerUrl ?? DEFAULT_WORKER_URL;
		const spawn = this.options.spawnWorker ?? defaultSpawner;
		let worker: HotFrameWorker | undefined;
		try {
			worker = spawn(url);
		} catch {
			worker = undefined;
		}
		if (worker === undefined) {
			return;
		}
		this.worker = worker;
		worker.on("message", (message: unknown) => {
			if (typeof message !== "object" || message === null) {
				return;
			}
			const frame = message as Partial<FrameMessage>;
			if (frame.type !== "frame" || !(frame.bytes instanceof Uint8Array) || typeof frame.hash !== "string") {
				return;
			}
			this.delivered = true;
			this.latest = {
				data: Buffer.from(frame.bytes),
				mimeType: "image/jpeg",
				width: frame.width ?? size.width,
				height: frame.height ?? size.height,
				capturedAt: typeof frame.capturedAt === "number" ? frame.capturedAt : Date.now(),
				hash: frame.hash,
			};
		});
		// A dead refresher must not pin the slot: the next start() respawns a fresh worker.
		const dropWorker = (): void => {
			if (this.worker === worker) {
				this.worker = undefined;
				this.latest = undefined;
			}
		};
		worker.on("error", () => {
			process.stderr.write("[hot-frames] refresher worker errored; it will respawn on the next call\n");
			dropWorker();
		});
		worker.on("exit", () => {
			dropWorker();
		});
		worker.postMessage({
			type: "target",
			windowId,
			width: size.width,
			height: size.height,
			quality: this.options.quality ?? DEFAULT_QUALITY,
		});
	}
}

function defaultSpawner(url: URL): HotFrameWorker | undefined {
	try {
		return new Worker(url);
	} catch {
		return undefined;
	}
}
