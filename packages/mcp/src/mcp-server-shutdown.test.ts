import { describe, expect, it } from "bun:test";
import { gracefulShutdown } from "./mcp-server.js";
import { createHarness, observe } from "./protocol-client-harness.js";
import { Deferred, FakeGuardedComputer } from "./protocol-test-harness.js";

async function gatedDrag(computer: FakeGuardedComputer) {
	const harness = await createHarness(computer);
	const entered = new Deferred<void>();
	const release = new Deferred<void>();
	computer.inputGate = async (effect) => {
		if (effect.kind !== "drag") return;
		entered.resolve();
		await release.promise;
	};
	const token = await observe(harness);
	// The call's answer is lost with the transport once the server closes; its effect on the fake computer is what counts.
	void harness.client.callTool({
		name: "run_steps",
		arguments: {
			observation_token: token,
			app: "Finder",
			steps: [{ type: "drag", from_x: 10, from_y: 10, to_x: 50, to_y: 50 }],
		},
	});
	await entered.promise;
	return { harness, open: () => release.resolve() };
}

const dragSent = (computer: FakeGuardedComputer): boolean => computer.effects.some((effect) => effect.kind === "drag");

describe("#given a drag in flight #when the process is told to terminate #then the drag finishes before exit", () => {
	it("exits only after the in-flight call drained, with its input released", async () => {
		const computer = new FakeGuardedComputer();
		computer.delivery = "background";
		const { harness, open } = await gatedDrag(computer);
		const exits: number[] = [];
		const shutdown = gracefulShutdown(harness.server, 10_000, (code) => exits.push(code));

		const done = shutdown(143);
		await Promise.resolve();
		expect(exits).toEqual([]);
		expect(dragSent(computer)).toBe(false);

		open();
		await done;
		expect(exits).toEqual([143]);
		expect(dragSent(computer)).toBe(true);
		await shutdown(0);
		expect(exits).toEqual([143]);
	});

	it("#given a call that never finishes #when the grace runs out #then it exits anyway", async () => {
		const computer = new FakeGuardedComputer();
		computer.delivery = "background";
		const { harness, open } = await gatedDrag(computer);
		const exits: number[] = [];
		const shutdown = gracefulShutdown(harness.server, 20, (code) => exits.push(code));

		await shutdown(143);

		expect(exits).toEqual([143]);
		expect(dragSent(computer)).toBe(false);
		open();
		await harness.close();
		expect(dragSent(computer)).toBe(true);
	});
});
