import type { ActivityFeed, ActivityState } from "@opencua/core/light";

// Buddy's own line on the status pill (see activity-feed in @opencua/core). Every press gets a visible answer, so a
// question that was not heard, or is still being worked out, never looks like buddy is broken.

export interface StatusUpdate {
	readonly state: ActivityState;
	readonly text?: string;
	/** Seconds until buddy's line drops off the pill, unless another update comes first. */
	readonly ttl?: number;
}

export const BUDDY_SOURCE = "buddy";

export class BuddyStatus {
	private last: StatusUpdate = { state: "idle" };
	private readonly feed: ActivityFeed;

	// Plain fields, not parameter properties: the CLI also runs from source under Node's strip-only TypeScript.
	constructor(feed: ActivityFeed) {
		this.feed = feed;
	}

	get current(): StatusUpdate {
		return this.last;
	}

	set(update: StatusUpdate): void {
		this.last = update;
		try {
			this.feed.write({ source: BUDDY_SOURCE, agent: "buddy", pid: process.pid, ...update });
		} catch (error: unknown) {
			// The pill is a courtesy; a full disk or a removed folder must not stop buddy answering.
			process.stderr.write(`buddy: status pill: ${error instanceof Error ? error.message : String(error)}\n`);
		}
	}

	close(): void {
		this.last = { state: "idle" };
		try {
			this.feed.clear(BUDDY_SOURCE);
		} catch {}
	}
}
