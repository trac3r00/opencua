import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEASE_HOLDER_ENV, MacOSHostComputer, type WindowLease, writeLeases } from "@opencua/core";
import { vi } from "@opencua/test-support";
import { type WindowLeaseOptions, windowLeasesFromEnvironment, withWindowLeases } from "./lease-gate.js";
import { createNativeComputer } from "./native-policy.js";
import { createHarness, jsonPayload, observe } from "./protocol-client-harness.js";
import { type Effect, FakeGuardedComputer } from "./protocol-test-harness.js";

// The fake's Finder is process 1234 and its observed window is 71.
const NOW = Date.parse("2026-11-23T10:00:00.000Z");
const STARTED = "1795400000.500";

function lease(overrides: Partial<WindowLease> = {}): WindowLease {
	return {
		id: "L-1",
		holder: "qa",
		target: { bundleId: "com.apple.finder", pid: 1234, startedAt: STARTED, windowId: 71 },
		tools: ["click"],
		grantedAt: new Date(NOW - 60_000).toISOString(),
		expiresAt: new Date(NOW + 30 * 60_000).toISOString(),
		grantedBy: "cli",
		...overrides,
	};
}

let stateDir: string;
let closeHarness: (() => Promise<void>) | undefined;

beforeEach(() => {
	stateDir = mkdtempSync(join(tmpdir(), "opencua-lease-gate-"));
});

afterEach(async () => {
	await closeHarness?.();
	closeHarness = undefined;
	rmSync(stateDir, { recursive: true, force: true });
});

function gate(overrides: Partial<WindowLeaseOptions> = {}): WindowLeaseOptions {
	return {
		holder: "qa",
		stateDir,
		probes: () => ({
			now: NOW,
			startTime: (pid) => (pid === 1234 ? STARTED : undefined),
			windowOwner: (windowId) => (windowId === 71 ? 1234 : undefined),
		}),
		owned: () => false,
		...overrides,
	};
}

/** A server whose computer is gated by `options`, or left as it is when leases are off. */
async function server(options: WindowLeaseOptions | undefined) {
	const computer = new FakeGuardedComputer();
	const harness = await createHarness(withWindowLeases(computer, options));
	closeHarness = harness.close;
	const click = async (extra: Record<string, unknown> = { element_index: "9" }) =>
		await harness.client.callTool({
			name: "click",
			arguments: { app: "Finder", observation_token: await observe(harness), ...extra },
		});
	return { harness, computer, click };
}

const sent = (computer: FakeGuardedComputer): readonly Effect[] =>
	computer.effects.filter((effect) => effect.kind !== "close");

function auditLines(): readonly Record<string, unknown>[] {
	const directory = join(stateDir, "audit");
	if (!existsSync(directory)) return [];
	return readdirSync(directory).flatMap((name) =>
		readFileSync(join(directory, name), "utf8")
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as Record<string, unknown>),
	);
}

describe("#given a server started without a lease holder #when it acts on the person's apps #then host control is as it was", () => {
	it("#given no holder in the environment, or a blank one #then there is no gate", () => {
		expect(windowLeasesFromEnvironment({})).toBeUndefined();
		expect(windowLeasesFromEnvironment({ [LEASE_HOLDER_ENV]: "" })).toBeUndefined();
		expect(windowLeasesFromEnvironment({ [LEASE_HOLDER_ENV]: "  " })).toBeUndefined();
	});

	it("#given no gate #then the computer is the very same object, not a wrapper around it", () => {
		const computer = new FakeGuardedComputer();

		expect(withWindowLeases(computer, undefined)).toBe(computer);
	});

	it("#given no holder in this process's environment #then the native computer is the plain host computer", async () => {
		vi.stubEnv(LEASE_HOLDER_ENV, "");
		vi.stubEnv("OPENCUA_STATE_DIR", stateDir);
		try {
			const computer = createNativeComputer("darwin");
			// A gated computer answers every method through one generated function; the plain one has its own.
			expect(computer.preflightInput).toBe(MacOSHostComputer.prototype.preflightInput);
			await computer.close();
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("#given leases on disk for nobody this server is #when it clicks an unleased window #then the click goes out and nothing is audited", async () => {
		writeLeases(stateDir, [lease({ holder: "someone-else", target: { ...lease().target, windowId: 999 } })]);
		const { computer, click } = await server(undefined);

		const result = await click();

		expect(result.isError).not.toBe(true);
		expect(jsonPayload(result)).toMatchObject({ actionDispatched: true });
		expect(sent(computer)).toEqual([{ kind: "performAction", pid: 1234, id: 9, action: "AXPress" }]);
		expect(auditLines()).toEqual([]);
	});
});

describe("#given a server with a lease holder #when the holder has no lease on the window #then input is refused with the way to grant one", () => {
	it("#when an element click is asked #then nothing is sent and the refusal names the grant command", async () => {
		const { computer, click } = await server(gate());

		const result = await click();
		const payload = jsonPayload(result);

		expect(result.isError).toBe(true);
		expect(payload).toMatchObject({
			actionDispatched: false,
			reason: "lease-required",
			code: "LEASE_REQUIRED",
			retry: "never",
			escalation: { target: "human" },
		});
		expect(String(payload["message"])).toContain('opencua lease grant --holder "qa" --app 1234 --window 71');
		expect(sent(computer)).toEqual([]);
	});

	it("#when a point click is asked #then nothing is sent", async () => {
		const { computer, click } = await server(gate());

		const result = await click({ x: 20, y: 30 });

		expect(jsonPayload(result)).toMatchObject({ actionDispatched: false, reason: "lease-required" });
		expect(sent(computer)).toEqual([]);
	});

	it("#then the refusal is written to the lease audit log", async () => {
		const { click } = await server(gate());

		await click();

		expect(auditLines()).toEqual([
			expect.objectContaining({
				event: "refuse",
				code: "lease-required",
				holder: "qa",
				pid: 1234,
				windowId: 71,
				bundleId: "com.apple.finder",
				by: "server",
			}),
		]);
	});

	it.each([
		["granted to another holder", lease({ holder: "codex" }), "lease-required"],
		["on another window of the app", lease({ target: { ...lease().target, windowId: 72 } }), "lease-required"],
		["that expired", lease({ expiresAt: new Date(NOW - 1).toISOString() }), "lease-expired"],
		[
			"for a process whose pid was reused",
			lease({ target: { ...lease().target, startedAt: "1795300000.100" } }),
			"lease-window-gone",
		],
		[
			"confined to a region",
			lease({ target: { ...lease().target, region: { x: 0, y: 0, width: 10, height: 10 } } }),
			"lease-region-exceeded",
		],
	])("#given only a lease %s #then the click is refused", async (_, granted, reason) => {
		writeLeases(stateDir, [granted]);
		const { computer, click } = await server(gate());

		const result = await click();

		expect(jsonPayload(result)).toMatchObject({ actionDispatched: false, reason });
		expect(sent(computer)).toEqual([]);
	});

	it("#given the computer itself refuses the input #then its own reason is given and no lease is asked for", async () => {
		const { computer, click } = await server(gate());
		computer.preflightResult = { ok: false, reason: "window-missing" };

		const result = await click();

		expect(jsonPayload(result)).toMatchObject({ actionDispatched: false, reason: "window-missing" });
		expect(auditLines()).toEqual([]);
	});
});

describe("#given a server with a lease holder #when the person leased the window #then the leased tools work on it", () => {
	it("#given a click lease #when an element click and a point click are asked #then both go out", async () => {
		writeLeases(stateDir, [lease()]);
		const { computer, click } = await server(gate());

		const element = await click();
		const point = await click({ x: 20, y: 30 });

		expect(element.isError).not.toBe(true);
		expect(point.isError).not.toBe(true);
		expect(sent(computer).map((effect) => effect.kind)).toEqual(["performAction", "click"]);
		expect(auditLines()).toEqual([]);
	});

	it("#given a lease that lists only type #when a click is asked #then it is refused as a forbidden tool and nothing is sent", async () => {
		writeLeases(stateDir, [lease({ tools: ["type"] })]);
		const { computer, click } = await server(gate());

		const result = await click();

		expect(result.isError).toBe(true);
		expect(jsonPayload(result)).toMatchObject({ code: "LEASE_TOOL_FORBIDDEN", retry: "never" });
		expect(sent(computer)).toEqual([]);
		expect(auditLines()).toEqual([expect.objectContaining({ code: "lease-tool-forbidden", tool: "click" })]);
	});

	it("#given a click lease #when a batch clicks and then types #then the click goes out and the typing does not", async () => {
		writeLeases(stateDir, [lease()]);
		const { harness, computer } = await server(gate());

		const result = await harness.client.callTool({
			name: "run_steps",
			arguments: {
				app: "Finder",
				observation_token: await observe(harness),
				steps: [
					{ type: "click", element_index: "9" },
					{ type: "type_text", text: "hello" },
				],
			},
		});

		expect(jsonPayload(result)["runSteps"]).toMatchObject({
			completed: 1,
			stoppedEarly: true,
			steps: [
				{ step: 0, type: "click", input_dispatched: true, status: "dispatched" },
				{ step: 1, type: "type_text", input_dispatched: false, status: "failed" },
			],
		});
		expect(sent(computer)).toEqual([{ kind: "performAction", pid: 1234, id: 9, action: "AXPress" }]);
		expect(auditLines()).toEqual([expect.objectContaining({ code: "lease-tool-forbidden", tool: "type" })]);
	});

	it("#given the person revokes the lease #when the next click is asked #then it is refused", async () => {
		writeLeases(stateDir, [lease()]);
		const { computer, click } = await server(gate());
		expect((await click()).isError).not.toBe(true);

		writeLeases(stateDir, []);
		const afterRevoke = await click();

		expect(jsonPayload(afterRevoke)).toMatchObject({ actionDispatched: false, reason: "lease-required" });
		expect(sent(computer)).toHaveLength(1);
	});

	it("#given a window opencua launched itself #when it is clicked with no lease #then the click goes out", async () => {
		const { computer, click } = await server(gate({ owned: (pid) => pid === 1234 }));

		const result = await click();

		expect(result.isError).not.toBe(true);
		expect(sent(computer)).toHaveLength(1);
	});
});
