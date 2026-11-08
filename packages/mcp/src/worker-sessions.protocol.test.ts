import { describe, expect, it } from "bun:test";
import { currentCursorIdentity, currentInputScope } from "@opencua/core";
import { createHarness, jsonPayload, jsonText } from "./protocol-client-harness.js";
import { Deferred, FakeGuardedComputer } from "./protocol-test-harness.js";

function assignment(result: unknown): { readonly token: string; readonly cursor: string } {
	const parsed: unknown = JSON.parse(jsonText(result));
	if (!Array.isArray(parsed)) throw new Error("expected assignments");
	const first: unknown = parsed[0];
	if (
		typeof first !== "object" ||
		first === null ||
		!("observation_token" in first) ||
		typeof first.observation_token !== "string" ||
		!("cursor_id" in first) ||
		typeof first.cursor_id !== "string"
	) {
		throw new Error("missing worker token or cursor");
	}
	return { token: first.observation_token, cursor: first.cursor_id };
}

describe("worker sessions #given independent tasks #when sessions share worker names #then tokens and cursors remain isolated", () => {
	it("runs both step chains concurrently without crossing session ownership", async () => {
		const computer = new FakeGuardedComputer();
		computer.delivery = "background";
		const harness = await createHarness(computer);
		const entered = new Deferred<void>();
		const finish = new Deferred<void>();
		const inputs: { readonly pid: number | undefined; readonly cursor: string | undefined }[] = [];
		let running: Promise<unknown> | undefined;
		let released = false;
		try {
			const [one, two] = await Promise.all(
				[
					{ session: "one", app: "Finder" },
					{ session: "two", app: "Other" },
				].map(async ({ session, app }) =>
					assignment(
						await harness.client.callTool({
							name: "manage_workers",
							arguments: {
								op: "assign",
								session_id: session,
								assignments: [{ worker_id: "editor", task: "edit", app }],
							},
						}),
					),
				),
			);
			if (one === undefined || two === undefined) throw new Error("missing assignments");
			expect(one.cursor).not.toBe(two.cursor);
			expect(computer.stateOptions.every((options) => options?.includeScreenshot === false)).toBe(true);
			const foreign = await harness.client.callTool({
				name: "run_worker",
				arguments: {
					session_id: "two",
					worker_id: "editor",
					observation_token: one.token,
					steps: [{ type: "type_text", text: "never" }],
				},
			});
			expect(foreign.isError).toBe(true);
			expect(computer.effects).toEqual([]);
			computer.inputGate = async () => {
				inputs.push({ pid: currentInputScope()?.target?.pid, cursor: currentCursorIdentity() });
				if (inputs.length === 2) entered.resolve();
				await finish.promise;
			};
			running = Promise.all(
				[
					{ session: "one", worker: one },
					{ session: "two", worker: two },
				].map(({ session, worker }) =>
					harness.client.callTool({
						name: "run_worker",
						arguments: {
							session_id: session,
							worker_id: "editor",
							observation_token: worker.token,
							steps: [
								{ type: "type_text", text: session },
								{ type: "press_keys", keys: ["return"] },
							],
						},
					}),
				),
			);
			const deadline = AbortSignal.timeout(2_000);
			await Promise.race([
				entered.promise,
				new Promise<never>((_resolve, reject) => {
					deadline.addEventListener("abort", () => reject(new Error("parallel input did not start")), {
						once: true,
					});
				}),
			]);
			const busyRelease = await harness.client.callTool({
				name: "manage_workers",
				arguments: { op: "release_session", session_id: "one" },
			});
			expect(busyRelease.isError).toBe(true);
			expect(inputs).toEqual(
				expect.arrayContaining([
					{ pid: 1234, cursor: one.cursor },
					{ pid: 5678, cursor: two.cursor },
				]),
			);
			finish.resolve();
			released = true;
			const results = await running;
			if (!Array.isArray(results)) throw new Error("missing results");
			expect(results.map((result: unknown) => jsonPayload(result))).toMatchObject([
				{ session_id: "one", runSteps: { completed: 2 } },
				{ session_id: "two", runSteps: { completed: 2 } },
			]);
			expect(inputs.filter(({ pid }) => pid === 1234).every(({ cursor }) => cursor === one.cursor)).toBe(true);
			expect(inputs.filter(({ pid }) => pid === 5678).every(({ cursor }) => cursor === two.cursor)).toBe(true);
		} finally {
			if (!released) finish.resolve();
			try {
				await running;
			} finally {
				await harness.close();
			}
		}
	});

	it("reserves app aliases across sessions and releases only the named session", async () => {
		const harness = await createHarness();
		try {
			const one = assignment(
				await harness.client.callTool({
					name: "manage_workers",
					arguments: {
						op: "assign",
						session_id: "one",
						assignments: [{ worker_id: "editor", task: "edit", app: "Finder" }],
					},
				}),
			);
			const overlap = await harness.client.callTool({
				name: "manage_workers",
				arguments: {
					op: "assign",
					session_id: "two",
					assignments: [{ worker_id: "editor", task: "edit", app: "1234" }],
				},
			});
			expect(overlap.isError).toBe(true);
			const otherStatus = await harness.client.callTool({
				name: "manage_workers",
				arguments: { op: "status", session_id: "two" },
			});
			expect(JSON.parse(jsonText(otherStatus))).toEqual([]);
			const keeper = await harness.client.callTool({
				name: "manage_workers",
				arguments: {
					op: "assign",
					session_id: "two",
					assignments: [{ worker_id: "keeper", task: "keep", app: "Other" }],
				},
			});
			expect(keeper.isError).not.toBe(true);
			await harness.client.callTool({
				name: "manage_workers",
				arguments: { op: "release_session", session_id: "one" },
			});
			const kept = await harness.client.callTool({
				name: "manage_workers",
				arguments: { op: "status", session_id: "two" },
			});
			expect(JSON.parse(jsonText(kept))).toMatchObject([{ session_id: "two", worker_id: "keeper" }]);
			const stale = await harness.client.callTool({
				name: "run_steps",
				arguments: {
					app: "Finder",
					observation_token: one.token,
					steps: [{ type: "type_text", text: "never" }],
				},
			});
			expect(stale.isError).toBe(true);
			expect(harness.computer.effects).toEqual([]);
			const next = assignment(
				await harness.client.callTool({
					name: "manage_workers",
					arguments: {
						op: "assign",
						session_id: "two",
						assignments: [{ worker_id: "editor", task: "edit", app: "Finder" }],
					},
				}),
			);
			expect(next.cursor).not.toBe(one.cursor);
			const refreshed = await harness.client.callTool({
				name: "manage_workers",
				arguments: { op: "observe", session_id: "two", worker_id: "editor", diff_only: true },
			});
			expect(refreshed.isError).not.toBe(true);
			expect(harness.computer.stateOptions.at(-1)).toMatchObject({
				diffOnly: true,
				includeScreenshot: false,
			});
		} finally {
			await harness.close();
		}
	});
});
