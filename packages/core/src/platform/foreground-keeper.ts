/**
 * Background delivery must leave the person's app in front, but some apps take the foreground on their own
 * after OpenCUA touches them: Chrome activates itself after launch (measured 8 s after a launch on a busy Mac) and
 * again when a page navigates. The keeper remembers the app the person had in front when OpenCUA sent input to (or
 * opened) another app, and for a while afterwards puts that app back if a touched app took its place. Only a switch
 * the person made themselves is left alone: a mouse press or the Command key just before the touched app came
 * forward (a click on it or its Dock icon, Command-Tab). Typing, or clicking inside their own app, is not a switch;
 * a person typing in their app while another takes the front is exactly the case the keeper exists for. A press
 * counts as a switch unless the pointer is over the person's own app, so a click in their app is told from one on
 * the touched app.
 */
export interface ForegroundKeeperDeps {
	frontmostPid(): number | undefined;
	/** Seconds since the person's last physical mouse button press. */
	secondsSinceMouseDown(): number;
	/** Whether the physical Command key is down right now. */
	commandHeld(): boolean;
	/** The app owning the topmost normal window under the physical pointer; undefined when unknown. */
	pidUnderPointer(): number | undefined;
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
/** How long after a launch the launched app is watched: slow apps finish launching and activate late. */
export const LAUNCH_WATCH_MILLISECONDS = 30_000;
const DEFAULT_POLL_MILLISECONDS = 50;
/** A press this long before the front was last seen held by another app still counts as the switch. */
const SWITCH_SLACK_MILLISECONDS = 300;

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
	/** When the front was last seen held by an app OpenCUA did not touch, and when Command was last seen down. */
	private lastOtherFrontAt = 0;
	private lastCommandAt = Number.NEGATIVE_INFINITY;

	constructor(
		private readonly deps: ForegroundKeeperDeps,
		private readonly options: { readonly watchMs?: number; readonly pollMs?: number; readonly poll?: boolean } = {},
	) {}

	/**
	 * OpenCUA is about to send input to, or has opened, `pid`. `frontBefore` names the app that was in front
	 * before a launch, which a fast-activating app may already have replaced.
	 */
	noteTouched(pid: number, frontBefore?: number, watchMs?: number): void {
		const now = this.deps.now();
		const front = frontBefore ?? this.deps.frontmostPid();
		const previous = this.watch !== undefined && now <= this.watch.until ? this.watch : undefined;
		const personPid =
			front !== undefined && front !== pid && previous?.touched.has(front) !== true ? front : previous?.personPid;
		if (personPid === undefined) {
			this.watch = undefined;
			return;
		}
		const until = now + (watchMs ?? this.options.watchMs ?? DEFAULT_WATCH_MILLISECONDS);
		this.watch = {
			personPid,
			touched: new Set([...(previous?.touched ?? []), pid]),
			since: previous?.since ?? now,
			until: Math.max(until, previous?.until ?? until),
		};
		if (previous === undefined) {
			this.lastOtherFrontAt = now;
		}
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
		if (now > watch.until) {
			this.stop();
			return undefined;
		}
		if (this.deps.commandHeld()) {
			this.lastCommandAt = now;
		}
		const front = this.deps.frontmostPid();
		if (front === undefined || !watch.touched.has(front)) {
			this.lastOtherFrontAt = now;
			return undefined;
		}
		const switchWindow = now - this.lastOtherFrontAt + SWITCH_SLACK_MILLISECONDS;
		const pressedOutsidePersonApp =
			this.deps.secondsSinceMouseDown() * 1000 < switchWindow && this.deps.pidUnderPointer() !== watch.personPid;
		if (pressedOutsidePersonApp || this.lastCommandAt >= this.lastOtherFrontAt - SWITCH_SLACK_MILLISECONDS) {
			this.stop();
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
