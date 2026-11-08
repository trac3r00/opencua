import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	LEASE_FILE,
	type LeaseProbes,
	MAX_AUDIT_LINE_BYTES,
	MAX_LEASE_MS,
	type WindowLease,
	appendLeaseAudit,
	currentLease,
	findLiveLease,
	leaseAuditPath,
	leaseLiveness,
	leasedHere,
	parseLeaseFile,
	readLeases,
	withLease,
	writeLeases,
} from "./window-lease.js";

const GRANTED = Date.parse("2026-11-08T05:00:00.000Z");

function lease(overrides: Partial<WindowLease> = {}): WindowLease {
	return {
		id: "L-1",
		holder: "claude-code",
		target: { bundleId: "com.apple.TextEdit", pid: 4242, startedAt: "Sat Nov  8 04:00:00 2026", windowId: 77 },
		tools: ["click", "type"],
		grantedAt: new Date(GRANTED).toISOString(),
		expiresAt: new Date(GRANTED + 30 * 60 * 1000).toISOString(),
		grantedBy: "cli",
		...overrides,
	};
}

function probes(overrides: Partial<LeaseProbes> = {}): LeaseProbes {
	return {
		now: GRANTED + 60_000,
		startTime: (pid) => (pid === 4242 ? "Sat Nov  8 04:00:00 2026" : undefined),
		windowOwner: (windowId) => (windowId === 77 ? 4242 : windowId === 78 ? 4242 : undefined),
		...overrides,
	};
}

let stateDir: string;

beforeEach(() => {
	stateDir = mkdtempSync(join(tmpdir(), "opencua-lease-"));
});

afterEach(() => {
	rmSync(stateDir, { recursive: true, force: true });
});

describe("#given the lease file", () => {
	it("#when leases are written and read back #then they round-trip and the file is 0600", () => {
		const written = [
			lease(),
			lease({ id: "L-2", target: { ...lease().target, region: { x: 0, y: 0, width: 10, height: 5 } } }),
		];
		writeLeases(stateDir, written);
		expect(readLeases(stateDir)).toEqual(written);
		expect(statSync(join(stateDir, LEASE_FILE)).mode & 0o777).toBe(0o600);
	});

	it("#when the file is missing, not JSON, or not version 1 #then there are no leases", () => {
		expect(readLeases(stateDir)).toEqual([]);
		for (const text of [
			"",
			"{",
			"[]",
			JSON.stringify({ leases: [lease()] }),
			JSON.stringify({ version: 2, leases: [lease()] }),
		]) {
			expect(parseLeaseFile(text)).toEqual([]);
			writeFileSync(join(stateDir, LEASE_FILE), text);
			expect(readLeases(stateDir)).toEqual([]);
		}
	});

	it.skipIf(process.getuid?.() === 0)(
		"#when a read file is made unreadable #then the cached grants are dropped",
		() => {
			writeLeases(stateDir, [lease()]);
			expect(readLeases(stateDir)).toHaveLength(1);
			chmodSync(join(stateDir, LEASE_FILE), 0o000);
			expect(readLeases(stateDir)).toEqual([]);
		},
	);

	it("#when leases are read #then neither the list nor a lease can be widened in place", () => {
		writeLeases(stateDir, [lease()]);
		const leases = readLeases(stateDir);
		const first = leases[0];
		expect(first).toBeDefined();
		if (first === undefined) return;
		expect([leases, first, first.target, first.tools].every((value) => Object.isFrozen(value))).toBe(true);
		expect(Reflect.set(first.tools, "1", "drag")).toBe(false);
		expect(readLeases(stateDir)[0]?.tools).toEqual(["click", "type"]);
	});

	it("#when a timestamp is not canonical UTC ISO 8601 #then the lease is dropped", () => {
		for (const grantedAt of ["Nov 8 2026 05:00:00 GMT", "2026-11-08 05:00:00Z", "2026-11-08T05:00:00+09:00"]) {
			expect(parseLeaseFile(JSON.stringify({ version: 1, leases: [lease({ grantedAt })] }))).toEqual([]);
		}
	});

	it("#when the state directory and files already exist with loose modes #then writes tighten them", () => {
		chmodSync(stateDir, 0o755);
		const stale = `${join(stateDir, LEASE_FILE)}.${process.pid}.tmp`;
		writeFileSync(stale, "old", { mode: 0o644 });
		chmodSync(stale, 0o644);
		writeLeases(stateDir, [lease()]);
		expect(statSync(stateDir).mode & 0o777).toBe(0o700);
		expect(statSync(join(stateDir, LEASE_FILE)).mode & 0o777).toBe(0o600);
		const at = new Date("2026-11-08T05:00:00.000Z");
		mkdirSync(join(stateDir, "audit"), { mode: 0o755 });
		chmodSync(join(stateDir, "audit"), 0o755);
		writeFileSync(leaseAuditPath(stateDir, at), "", { mode: 0o644 });
		chmodSync(leaseAuditPath(stateDir, at), 0o644);
		appendLeaseAudit(stateDir, { event: "grant", by: "cli" }, at);
		expect(statSync(join(stateDir, "audit")).mode & 0o777).toBe(0o700);
		expect(statSync(leaseAuditPath(stateDir, at)).mode & 0o777).toBe(0o600);
	});

	it("#when the file is rewritten #then the next read sees the new contents", () => {
		writeLeases(stateDir, [lease()]);
		expect(readLeases(stateDir).map((entry) => entry.id)).toEqual(["L-1"]);
		writeLeases(stateDir, []);
		expect(readLeases(stateDir)).toEqual([]);
	});

	it("#when two entries share an id #then only the first is kept", () => {
		const text = JSON.stringify({ version: 1, leases: [lease(), lease({ holder: "other" })] });
		expect(parseLeaseFile(text).map((entry) => entry.holder)).toEqual(["claude-code"]);
	});
});

describe("#given a lease #when its liveness is checked", () => {
	it("#then it is live inside its window of time with the same process and window owner", () => {
		expect(leaseLiveness(lease(), probes())).toEqual({ live: true });
	});

	it("#then it is expired before it was granted and from its expiry on", () => {
		expect(leaseLiveness(lease(), probes({ now: GRANTED - 1 }))).toEqual({ live: false, code: "lease-expired" });
		expect(leaseLiveness(lease(), probes({ now: GRANTED + 30 * 60 * 1000 }))).toEqual({
			live: false,
			code: "lease-expired",
		});
	});

	it("#then a reused pid or a window now owned by someone else voids it", () => {
		expect(leaseLiveness(lease(), probes({ startTime: () => "Sat Nov  8 05:30:00 2026" }))).toEqual({
			live: false,
			code: "lease-window-gone",
		});
		expect(leaseLiveness(lease(), probes({ windowOwner: () => 9999 }))).toEqual({
			live: false,
			code: "lease-window-gone",
		});
		expect(leaseLiveness(lease(), probes({ windowOwner: () => undefined }))).toEqual({
			live: false,
			code: "lease-window-gone",
		});
	});
});

describe("#given leases on disk #when one is looked up for a holder and target", () => {
	it("#then only the exact holder, pid and window match", () => {
		const leases = [lease()];
		expect(findLiveLease(leases, "claude-code", { pid: 4242, windowId: 77 }, probes())?.id).toBe("L-1");
		expect(findLiveLease(leases, "codex", { pid: 4242, windowId: 77 }, probes())).toBeUndefined();
		expect(findLiveLease(leases, "claude-code", { pid: 4242, windowId: 78 }, probes())).toBeUndefined();
		expect(findLiveLease(leases, "claude-code", { pid: 4243, windowId: 77 }, probes())).toBeUndefined();
	});

	it("#then no holder or a blank holder matches nothing", () => {
		expect(findLiveLease([lease()], undefined, { pid: 4242, windowId: 77 }, probes())).toBeUndefined();
		expect(findLiveLease([lease({ holder: " " })], " ", { pid: 4242, windowId: 77 }, probes())).toBeUndefined();
	});

	it("#then an expired lease is skipped in favour of a live one for the same window", () => {
		const expired = lease({ id: "L-old", expiresAt: new Date(GRANTED + 1).toISOString() });
		expect(findLiveLease([expired, lease()], "claude-code", { pid: 4242, windowId: 77 }, probes())?.id).toBe("L-1");
	});
});

describe("#given a lease context", () => {
	it("#when work runs inside it #then the lease is visible across awaits and gone outside", async () => {
		expect(currentLease()).toBeUndefined();
		const seen = await withLease(lease(), async () => {
			await Promise.resolve();
			await new Promise<void>((resolve) => queueMicrotask(resolve));
			return { lease: currentLease()?.id, here: leasedHere(4242, 77), otherWindow: leasedHere(4242, 78) };
		});
		expect(seen).toEqual({ lease: "L-1", here: true, otherWindow: false });
		expect(currentLease()).toBeUndefined();
		expect(leasedHere(4242)).toBe(false);
	});
});

describe("#given the audit log", () => {
	it("#when events are appended #then each is one JSON line in the day's 0600 file", () => {
		const at = new Date("2026-11-08T05:01:02.003Z");
		const path = appendLeaseAudit(stateDir, { event: "grant", leaseId: "L-1", holder: "claude-code", by: "cli" }, at);
		appendLeaseAudit(
			stateDir,
			{ event: "refuse", leaseId: "L-1", code: "lease-tool-forbidden", tool: "drag", by: "server" },
			at,
		);
		expect(path).toBe(leaseAuditPath(stateDir, at));
		expect(path.endsWith("lease-2026-11-08.jsonl")).toBe(true);
		const lines = readFileSync(path, "utf8").trimEnd().split("\n");
		expect(lines.map((line) => JSON.parse(line))).toEqual([
			{ at: "2026-11-08T05:01:02.003Z", event: "grant", leaseId: "L-1", holder: "claude-code", by: "cli" },
			{
				at: "2026-11-08T05:01:02.003Z",
				event: "refuse",
				leaseId: "L-1",
				code: "lease-tool-forbidden",
				tool: "drag",
				by: "server",
			},
		]);
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("#when a reason is very long #then the line is cut below the limit instead of split", () => {
		const path = appendLeaseAudit(stateDir, { event: "refuse", reason: "x".repeat(20_000), by: "server" });
		const line = readFileSync(path, "utf8");
		expect(line.split("\n").length).toBe(2);
		expect(Buffer.byteLength(line, "utf8")).toBeLessThan(MAX_AUDIT_LINE_BYTES);
	});
});

describe("#given the person edits the file by hand #when an entry is malformed #then that whole entry is dropped", () => {
	it("keeps the valid neighbour", () => {
		const bad = { ...lease({ id: "L-bad" }), tools: ["click", "rm -rf"] };
		writeFileSync(join(stateDir, LEASE_FILE), JSON.stringify({ version: 1, leases: [bad, lease()] }));
		expect(readLeases(stateDir).map((entry) => entry.id)).toEqual(["L-1"]);
	});

	it("refuses a lease longer than the hard maximum", () => {
		const long = lease({ expiresAt: new Date(GRANTED + MAX_LEASE_MS + 1).toISOString() });
		expect(parseLeaseFile(JSON.stringify({ version: 1, leases: [long] }))).toEqual([]);
	});
});
