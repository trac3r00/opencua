import { describe, expect, it } from "bun:test";
import { watchBuild } from "./reload.js";

function harness(ids: readonly string[]) {
	const remaining = [...ids];
	const listeners: ((filename: string | null) => void)[] = [];
	const pending = new Set<() => void>();
	const delays: number[] = [];
	const changes: string[] = [];
	let reads = 0;
	let closed = 0;
	let notify: (id: string) => void = () => undefined;
	const changed = new Promise<string>((resolve) => {
		notify = resolve;
	});
	const stop = watchBuild({
		directories: ["/app/packages/browser/dist", "/app/packages/core/dist"],
		initialId: "old",
		onChange: (id) => {
			changes.push(id);
			notify(id);
		},
		readId: async () => {
			reads++;
			return remaining.shift() ?? "old";
		},
		watch: (_directory, listener) => {
			listeners.push(listener);
			return {
				close: () => {
					closed++;
				},
			};
		},
		schedule: (action, delayMs) => {
			delays.push(delayMs);
			pending.add(action);
			return () => pending.delete(action);
		},
	});
	const emit = (filename: string | null) => {
		for (const listener of listeners) listener(filename);
	};
	const flush = () => {
		const actions = [...pending];
		pending.clear();
		for (const action of actions) action();
	};
	return {
		stop,
		emit,
		flush,
		changed,
		changes,
		delays,
		pending,
		listeners,
		reads: () => reads,
		closed: () => closed,
	};
}

describe("watchBuild", () => {
	it("#given a running daemon #when its build output is rewritten #then one debounced check reports the new build id", async () => {
		const build = harness(["new"]);
		expect(build.listeners).toHaveLength(2);
		build.emit("bridge.js.map");
		expect(build.pending.size).toBe(0);
		build.emit("bridge.js");
		build.emit("cli.js");
		build.emit("server.js");
		expect(build.pending.size).toBe(1);
		expect(build.delays.every((delay) => delay > 0)).toBe(true);
		build.flush();
		expect(await build.changed).toBe("new");
		expect(build.changes).toEqual(["new"]);
		expect(build.reads()).toBe(1);
		build.stop();
		expect(build.closed()).toBe(2);
	});

	it("#given a rewrite with identical content #when a later build differs #then only the differing build reloads", async () => {
		const build = harness(["old", "new"]);
		build.emit("cli.js");
		build.flush();
		build.emit("cli.js");
		build.flush();
		expect(await build.changed).toBe("new");
		expect(build.changes).toEqual(["new"]);
		expect(build.reads()).toBe(2);
		build.stop();
	});
});
