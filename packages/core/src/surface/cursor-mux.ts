/**
 * The shared-surface cursor multiplexer, ported from CursorMux in native/opencua-surface.m so the
 * Windows (WebView2) and Linux (WebKitGTK) surfaces merge many agents' pointers into the page's one
 * pointer the same way macOS does. cursor-mux.conformance.test.ts replays generated scripts through
 * both and requires identical output, so a change to one without the other fails.
 *
 * A cursor holds the pointer for a slice while others' input waits in order; strokes are never cut.
 * The next waiting cursor then takes over: its undone picks (tool and color clicks another cursor
 * replaced) are pressed again, and its waited input replays at the spacing it was sent with.
 */
export type MuxKind = "down" | "drag" | "up" | "move";
export interface MuxPoint {
	readonly x: number;
	readonly y: number;
}
export type MuxEmit = (kind: MuxKind, point: MuxPoint) => void;

const MAX_CONTEXT_CLICKS = 4;
const SLICE = 1.0;
const STUCK = 0.5;
const IDLE = 0.04;
const DOUBLE_CLICK = 1.0;
const SAME_SPOT = 7;

function alternatives(a: MuxPoint, b: MuxPoint): boolean {
	const dx = Math.abs(a.x - b.x);
	const dy = Math.abs(a.y - b.y);
	return dy <= 24 || (dx <= 30 && dy <= 200);
}

interface MuxEvent {
	readonly kind: MuxKind;
	readonly point: MuxPoint;
	readonly context: boolean;
	readonly at: number;
}

interface MuxCursor {
	last: MuxPoint | undefined;
	seen: number;
	context: MuxPoint[];
	pending: MuxEvent[];
	swallowUp: boolean;
	/** How late this cursor's waiting input goes out: each event is due at its arrival plus this delay. */
	shift: number;
}

const distance = (a: MuxPoint, b: MuxPoint) => Math.hypot(a.x - b.x, a.y - b.y);

/** Pure state with explicit times (seconds), like the native one; `paced` mode is not ported. */
export class CursorMux {
	private readonly cursors = new Map<number, MuxCursor>();
	private readonly order: number[] = [];
	private hitPoints: MuxPoint[] = [];
	private hitTimes: number[] = [];
	private picks: MuxPoint[] = [];
	private holder = 0;
	private down = false;
	private sliceStart = 0;

	constructor(private readonly emit: MuxEmit) {}

	private picked(point: MuxPoint): void {
		this.picks.push(point);
		if (this.picks.length > 64) this.picks.shift();
	}

	private undone(pick: MuxPoint): boolean {
		for (let index = this.picks.length - 1; index >= 0; index -= 1) {
			const other = this.picks[index];
			if (other === undefined) continue;
			if (distance(other, pick) < 3) return false;
			if (alternatives(other, pick)) return true;
		}
		return true;
	}

	private undonePicksOf(cursor: MuxCursor): MuxPoint[] {
		return cursor.context.filter((pick) => this.undone(pick));
	}

	private cursorFor(tag: number): MuxCursor {
		let cursor = this.cursors.get(tag);
		if (cursor === undefined) {
			cursor = {
				last: undefined,
				seen: 0,
				context: [],
				pending: [],
				swallowUp: false,
				shift: 0,
			};
			this.cursors.set(tag, cursor);
			this.order.push(tag);
		}
		return cursor;
	}

	private press(kind: MuxKind, point: MuxPoint, now: number): void {
		if (kind === "down") {
			this.hitPoints.push(point);
			this.hitTimes.push(now);
			if (this.hitPoints.length > 64) {
				this.hitPoints.shift();
				this.hitTimes.shift();
			}
		}
		this.emit(kind, point);
	}

	private remember(point: MuxPoint, cursor: MuxCursor): void {
		cursor.context = cursor.context.filter(
			(old) => !(Math.abs(old.x - point.x) < 3 && Math.abs(old.y - point.y) < 3),
		);
		cursor.context.push(point);
		while (cursor.context.length > MAX_CONTEXT_CLICKS) cursor.context.shift();
	}

	cursor(tag: number, kind: MuxKind, point: MuxPoint, context: boolean, now: number): void {
		const cursor = this.cursorFor(tag);
		if (kind === "move" && this.holder !== 0 && this.holder !== tag) return;
		if (cursor.pending.length === 0 && !(this.down && this.holder === tag)) cursor.shift = 0;
		cursor.pending.push({ kind, point, context, at: now });
		cursor.seen = now;
		this.pump(now);
	}

	private hitRecently(point: MuxPoint, now: number): boolean {
		return this.hitPoints.some(
			(hit, index) => distance(hit, point) < SAME_SPOT && now - (this.hitTimes[index] ?? 0) < DOUBLE_CLICK,
		);
	}

	private canReplay(picks: readonly MuxPoint[], now: number): boolean {
		return picks.every((pick) => !this.hitRecently(pick, now));
	}

	private takeOver(tag: number, now: number): boolean {
		const cursor = this.cursorFor(tag);
		const replay = this.undonePicksOf(cursor);
		if (!this.canReplay(replay, now)) return false;
		if (this.down) {
			this.emit("up", this.cursorFor(this.holder).last ?? { x: 0, y: 0 });
			this.down = false;
		}
		for (const pick of replay) {
			this.press("down", pick, now);
			this.emit("up", pick);
			this.picked(pick);
		}
		this.holder = tag;
		this.sliceStart = now;
		// Input that waited keeps its spacing: it goes out as late as it waited for the mouse.
		cursor.shift = Math.max(0, now - (cursor.pending[0]?.at ?? now));
		return true;
	}

	private deliver(event: MuxEvent, tag: number, now: number): void {
		const cursor = this.cursorFor(tag);
		if (event.kind === "down" && event.context && !this.undone(event.point)) {
			this.remember(event.point, cursor);
			cursor.swallowUp = true;
			cursor.last = event.point;
			return;
		}
		if (event.kind === "up" && cursor.swallowUp) {
			cursor.swallowUp = false;
			cursor.last = event.point;
			return;
		}
		if (event.kind === "down" || event.kind === "drag") {
			if (!this.down && event.kind === "drag") this.press("down", cursor.last ?? event.point, now);
			this.down = true;
			if (event.kind === "down") this.press("down", event.point, now);
			else this.emit("drag", event.point);
			if (event.kind === "down" && event.context) {
				this.remember(event.point, cursor);
				this.picked(event.point);
			}
		} else if (event.kind === "up") {
			if (this.down) {
				this.emit("up", event.point);
				this.down = false;
			}
		} else {
			this.emit("move", event.point);
		}
		cursor.last = event.point;
	}

	private mustWait(cursor: MuxCursor, now: number): boolean {
		const event = cursor.pending[0];
		if (event === undefined || event.kind !== "down" || !event.context || !this.undone(event.point)) return false;
		return this.hitRecently(event.point, now);
	}

	private due(cursor: MuxCursor, now: number): boolean {
		const event = cursor.pending[0];
		return event !== undefined && event.at + cursor.shift <= now + 1e-9;
	}

	private deliverDue(holder: MuxCursor, now: number): void {
		const event = holder.pending.shift();
		if (event === undefined) return;
		this.deliver(event, this.holder, now);
	}

	private othersWaitingBesides(tag: number): boolean {
		return this.order.some((key) => key !== tag && (this.cursors.get(key)?.pending.length ?? 0) > 0);
	}

	private absorbPicksInEffect(now: number): void {
		for (const key of this.order) {
			if (key === this.holder) continue;
			const cursor = this.cursors.get(key);
			if (cursor === undefined) continue;
			for (;;) {
				const event = cursor.pending[0];
				const inEffect = event !== undefined && event.kind === "down" && event.context && !this.undone(event.point);
				const release = event !== undefined && event.kind === "up" && cursor.swallowUp;
				if (event === undefined || (!inEffect && !release)) break;
				cursor.pending.shift();
				this.deliver(event, key, now);
			}
		}
	}

	pump(now: number): void {
		this.absorbPicksInEffect(now);
		for (;;) {
			const holder = this.holder === 0 ? undefined : this.cursors.get(this.holder);
			const others = this.othersWaitingBesides(this.holder);
			const keep =
				holder !== undefined &&
				(!others ||
					(this.down && holder.pending.length > 0) ||
					(this.down && now - holder.seen < STUCK) ||
					(now - this.sliceStart < SLICE && (holder.pending.length > 0 || now - holder.seen < IDLE)));
			const holderWaits = holder !== undefined && this.mustWait(holder, now);
			if (keep && !holderWaits && holder !== undefined) {
				if (!this.due(holder, now)) return;
				this.deliverDue(holder, now);
				continue;
			}
			let start = 0;
			if (this.holder !== 0) {
				const index = this.order.indexOf(this.holder);
				start = index < 0 ? 0 : index + 1;
			}
			let switched = false;
			for (let step = 0; step < this.order.length; step += 1) {
				const key = this.order[(start + step) % this.order.length];
				const cursor = key === undefined ? undefined : this.cursors.get(key);
				if (key === undefined || cursor === undefined) continue;
				if (key === this.holder || cursor.pending.length === 0 || this.mustWait(cursor, now)) continue;
				if (this.takeOver(key, now)) {
					switched = true;
					break;
				}
			}
			if (!switched) {
				if (holder !== undefined && !holderWaits && this.due(holder, now)) {
					this.deliverDue(holder, now);
					continue;
				}
				return;
			}
		}
	}
}
