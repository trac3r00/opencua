/**
 * Background delivery must leave the person's app in front, but some apps take the foreground on their own
 * after OpenCUA touches them: Chrome activates itself after launch and again when a page navigates, a second
 * or more after the click that caused it. The keeper remembers the app the person had in front when OpenCUA
 * sent input to (or opened) another app, and for a short while afterwards puts that app back if a touched
 * app took its place. A real keyboard or mouse event since then means the person switched apps themselves,
 * and nothing is restored.
 */
export interface ForegroundKeeperDeps {
	frontmostPid(): number | undefined;
	/** Seconds since the person's last physical keyboard or mouse event. */
	secondsSinceHumanInput(): number;
	/** Bring `pid` back to the front; false when it was not done. */
	restore(pid: number): Promise<boolean>;
	now(): number;
}

export interface ForegroundRestore {
	readonly thief: number;
	readonly restored: number;
	readonly ok: boolean;
}

const DEFAULT_WATCH_MILLISECONDS = 8_000;
const DEFAULT_POLL_MILLISECONDS = 250;

interface Watch {
	readonly personPid: number;
	readonly touched: ReadonlySet<number>;
	readonly since: number;
	readonly until: number;
}

export class ForegroundKeeper {
	private watch: Watch | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;
	private checking = false;

	constructor(
		private readonly deps: ForegroundKeeperDeps,
		private readonly options: { readonly watchMs?: number; readonly pollMs?: number; readonly poll?: boolean } = {},
	) {}

	/**
	 * OpenCUA is about to send input to, or has opened, `pid`. `frontBefore` names the app that was in front
	 * before a launch, which a fast-activating app may already have replaced.
	 */
	noteTouched(pid: number, frontBefore?: number): void {
		const now = this.deps.now();
		const front = frontBefore ?? this.deps.frontmostPid();
		const previous = this.watch !== undefined && now <= this.watch.until ? this.watch : undefined;
		const personPid =
			front !== undefined && front !== pid && previous?.touched.has(front) !== true ? front : previous?.personPid;
		if (personPid === undefined) {
			this.watch = undefined;
			return;
		}
		this.watch = {
			personPid,
			touched: new Set([...(previous?.touched ?? []), pid]),
			since: previous?.since ?? now,
			until: now + (this.options.watchMs ?? DEFAULT_WATCH_MILLISECONDS),
		};
		if (this.options.poll !== false && this.timer === undefined) {
			this.timer = setInterval(() => void this.check(), this.options.pollMs ?? DEFAULT_POLL_MILLISECONDS);
			this.timer.unref?.();
		}
	}

	/** Put the person's app back if a touched app took the front; undefined when nothing was done. */
	async check(): Promise<ForegroundRestore | undefined> {
		const watch = this.watch;
		if (watch === undefined || this.checking) {
			return undefined;
		}
		const now = this.deps.now();
		if (now > watch.until || this.deps.secondsSinceHumanInput() * 1000 < now - watch.since) {
			this.stop();
			return undefined;
		}
		const front = this.deps.frontmostPid();
		if (front === undefined || !watch.touched.has(front)) {
			return undefined;
		}
		this.checking = true;
		try {
			return { thief: front, restored: watch.personPid, ok: await this.deps.restore(watch.personPid) };
		} finally {
			this.checking = false;
		}
	}

	stop(): void {
		this.watch = undefined;
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}
}
