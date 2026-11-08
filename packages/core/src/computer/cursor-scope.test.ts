import { describe, expect, it } from "bun:test";

import { currentCursorIdentity, currentCursorOwner, withCursorIdentity } from "./cursor-scope.js";

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
	let resolvePromise: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve(): void {
			resolvePromise?.();
		},
	};
}

describe("#given cursor identity context #when callbacks run #then identity follows sync and async flow", () => {
	it("preserves synchronous return types and restores the enclosing identity", () => {
		const value = withCursorIdentity("outer", () => {
			expect(currentCursorIdentity()).toBe("outer");
			const nested = withCursorIdentity("inner", () => currentCursorIdentity());
			expect(currentCursorIdentity()).toBe("outer");
			return nested;
		});

		expect(value).toBe("inner");
		expect(currentCursorIdentity()).toBeUndefined();
	});

	it("keeps overlapping async callbacks isolated until each completes", async () => {
		const firstStarted = deferred();
		const resumeFirst = deferred();
		const first = withCursorIdentity("first", async () => {
			firstStarted.resolve();
			await resumeFirst.promise;
			return currentCursorIdentity();
		});
		await firstStarted.promise;

		const second = await withCursorIdentity("second", async () => {
			await Promise.resolve();
			return currentCursorIdentity();
		});
		resumeFirst.resolve();

		expect(await first).toBe("first");
		expect(second).toBe("second");
		expect(currentCursorIdentity()).toBeUndefined();
	});
});

describe("#given named agent cursors #when scopes overlap #then ownership follows the correct agent", () => {
	it("keeps parent and subagent names distinct from opaque cursor IDs", () => {
		const owner = { agentName: "Researcher", parentAgentName: "Coordinator", sessionId: "session-one" };
		const observed = withCursorIdentity("opaque-cursor", () => currentCursorOwner(), owner);
		expect(observed).toEqual(owner);
		expect(currentCursorOwner()).toBeUndefined();
	});

	it("snapshots owner metadata and preserves it across interleaved asynchronous scopes", async () => {
		const owner = { agentName: "Researcher", sessionId: "session-one" };
		const started = deferred();
		const finish = deferred();
		const first = withCursorIdentity(
			"one",
			async () => {
				started.resolve();
				await finish.promise;
				return currentCursorOwner();
			},
			owner,
		);
		await started.promise;
		owner.agentName = "Changed outside the scope";
		const second = withCursorIdentity("two", () => currentCursorOwner(), {
			agentName: "Writer",
			parentAgentName: "Coordinator",
			sessionId: "session-one",
		});
		finish.resolve();
		expect(await first).toEqual({ agentName: "Researcher", sessionId: "session-one" });
		expect(second).toEqual({ agentName: "Writer", parentAgentName: "Coordinator", sessionId: "session-one" });
		expect(currentCursorOwner()).toBeUndefined();
	});

	it("rejects generated invalid labels before entering the callback", () => {
		let entered = 0;
		for (const agentName of ["", " ", "\n", "\u0000", "x".repeat(129)]) {
			expect(() => withCursorIdentity("one", () => entered++, { agentName, sessionId: "session-one" })).toThrow(
				TypeError,
			);
		}
		expect(entered).toBe(0);
	});
});

describe("#given a worker's purpose #when its cursor owner is set #then the purpose is a short single-line label", () => {
	it("keeps a short purpose, flattens control characters and ends a long one with an ellipsis", () => {
		const owner = (purpose: string) =>
			withCursorIdentity("worker", () => currentCursorOwner(), { agentName: "painter", sessionId: "s", purpose });

		expect(owner("draw row 7")?.purpose).toBe("draw row 7");
		expect(owner("draw\nrow\t7")?.purpose).toBe("draw row 7");
		const long = owner("x".repeat(80))?.purpose ?? "";
		expect(Array.from(long).length).toBe(48);
		expect(long.endsWith("\u2026")).toBe(true);
		expect(owner("   ")?.purpose).toBeUndefined();
	});
});
