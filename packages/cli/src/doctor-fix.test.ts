import { describe, expect, it } from "bun:test";
import { type FixDependencies, type FixOptions, planRepairs, runDoctorFix } from "./doctor-fix.js";
import { type DoctorFacts, HELPER_DISPLAY_NAME, PRIVACY_PANES, evaluateDoctor } from "./doctor.js";

function readyFacts(): DoctorFacts {
	return {
		macos: { version: "26.7", hardwareArch: "arm64" },
		node: { version: "v22.23.2", execPath: "/usr/local/bin/node", arch: "arm64", translated: false },
		natives: [
			{ name: "libsckit.dylib", path: "/repo/libsckit.dylib", architectures: ["x86_64", "arm64"] },
			{ name: "cursor-overlay", path: "/repo/cursor-overlay", architectures: ["x86_64", "arm64"] },
		],
		server: { path: "/repo/server.js", present: true },
		helper: {
			app: "/repo/opencua-mcp.app",
			present: true,
			signature: { valid: true, detail: "valid" },
			bundledNode: { version: "v22.23.2" },
		},
		selfCheck: {
			ok: true,
			report: {
				permissions: { accessibility: true, screenRecording: true },
				sessionMode: "console",
				processArch: "arm64",
				processNode: "v22.23.2",
				nativeCapture: { available: true, error: "" },
				automation: {},
			},
		},
		stop: { stopped: false },
		config: {
			path: "/home/.opencua/config.json",
			saved: true,
			clients: [{ client: "omo", state: "current", path: "/home/.omo/agent/mcp.json", detail: "ok" }],
		},
	};
}

/** Everything --fix can repair is broken: a native binary, the helper's inputs, a registration, the stop, both grants. */
function brokenFacts(): DoctorFacts {
	const facts = readyFacts();
	return {
		...facts,
		natives: [
			{ name: "libsckit.dylib", path: "/repo/libsckit.dylib", architectures: undefined },
			...facts.natives.slice(1),
		],
		helper: { ...facts.helper, inputs: { built: "old", current: "new" } },
		selfCheck: {
			ok: true,
			report: {
				permissions: { accessibility: false, screenRecording: false },
				sessionMode: "console",
				processArch: "arm64",
				processNode: "v22.23.2",
				nativeCapture: { available: true, error: "" },
				automation: {},
			},
		},
		stop: { stopped: true, stoppedAt: "2026-10-06T00:00:00.000Z", reason: "lifecycle test", source: "cli" },
		config: {
			...facts.config,
			clients: [{ client: "omo", state: "stale", path: "/home/.omo/agent/mcp.json", detail: "x" }],
		},
	};
}

function fakeMac(answers: readonly boolean[] = []) {
	const calls: string[] = [];
	const printed: string[] = [];
	const queue = [...answers];
	let gathered = 0;
	const deps: FixDependencies = {
		gather: () => {
			gathered += 1;
			return gathered === 1 ? brokenFacts() : readyFacts();
		},
		rebuildNative: () => {
			calls.push("rebuild native");
			return true;
		},
		rebuildHelper: () => {
			calls.push("rebuild helper");
			return true;
		},
		reapplyRegistrations: () => {
			calls.push("reapply registrations");
			return true;
		},
		resume: () => {
			calls.push("resume");
		},
		openUrl: (url) => {
			calls.push(`open ${url}`);
			return true;
		},
		grantPermissions: async () => {
			calls.push("grant permissions");
			return { missing: [] };
		},
		ask: async (question) => {
			calls.push(`ask ${question}`);
			return queue.shift() ?? false;
		},
		print: (text) => {
			printed.push(text);
		},
	};
	return { deps, calls, printed: () => printed.join("\n") };
}

const UNATTENDED: FixOptions = { rebuildHelper: false, openPanes: true, interactive: false, guidePermissions: false };

describe("#given a doctor report #when --fix plans its repairs #then each failure maps to one repair of the right kind", () => {
	it("plans native, helper, registrations, stop and permissions in that order", () => {
		const repairs = planRepairs(evaluateDoctor(brokenFacts()));

		expect(repairs.map((repair) => `${repair.id}:${repair.kind}`)).toEqual([
			"native:auto",
			"helper:consent",
			"registrations:auto",
			"stop:confirm",
			"permissions:guide",
		]);
		expect(planRepairs(evaluateDoctor(readyFacts()))).toEqual([]);
	});
});

describe("#given broken pieces and nobody to ask #when --fix runs #then it repairs what is safe and leaves the rest", () => {
	it("rebuilds the natives and re-registers, but never rebuilds the helper or lifts the stop unasked", async () => {
		const mac = fakeMac();

		const outcome = await runDoctorFix(UNATTENDED, mac.deps);

		expect(mac.calls).toEqual(["rebuild native", "reapply registrations", `open ${PRIVACY_PANES.accessibility}`]);
		expect(outcome.fixed).toEqual([
			"rebuild the universal native binaries",
			"register opencua again with the saved MCP clients",
		]);
		expect(outcome.skipped.join("\n")).toMatch(/needs your consent: opencua doctor --fix --rebuild-helper/);
		expect(outcome.skipped.join("\n")).toMatch(/your call: opencua resume/);
		expect(mac.printed()).toContain(
			`then open Screen & System Audio Recording with: open "${PRIVACY_PANES.screenRecording}"`,
		);
		expect(outcome.report.ready).toBe(true);
	});

	it("rebuilds the helper when consent is given up front, and only prints the panes with --no-open", async () => {
		const mac = fakeMac();

		await runDoctorFix({ ...UNATTENDED, rebuildHelper: true, openPanes: false }, mac.deps);

		expect(mac.calls).toEqual(["rebuild native", "rebuild helper", "reapply registrations"]);
		expect(mac.printed()).toContain(`open Accessibility with: open "${PRIVACY_PANES.accessibility}"`);
	});
});

describe("#given a person at the terminal #when --fix needs consent #then it asks, and a no is respected", () => {
	it("asks before rebuilding the helper and before lifting the stop, and does only what was agreed", async () => {
		const mac = fakeMac([false, true]);

		const outcome = await runDoctorFix(
			{ ...UNATTENDED, interactive: true, guidePermissions: true, openPanes: false },
			mac.deps,
		);

		const asked = mac.calls.filter((call) => call.startsWith("ask "));
		expect(asked).toHaveLength(2);
		expect(asked[0]).toMatch(
			/^ask Rebuild the helper app now \(.*asks for Screen Recording and Accessibility again\)$/,
		);
		expect(asked[1]).toMatch(/^ask Computer use is stopped \(cli at .*: lifecycle test\)/);
		expect(mac.calls).not.toContain("rebuild helper");
		expect(mac.calls).toContain("resume");
		expect(outcome.fixed).toContain("lift the stop switch");
		expect(mac.calls.at(-1)).toBe("grant permissions");
		expect(outcome.fixed).toContain(`grant the missing permissions to "${HELPER_DISPLAY_NAME}"`);
	});
});

describe("#given an agent running --fix with no terminal #when a person is at the Mac #then the permission guide runs", () => {
	it("hands the missing permissions to the guide instead of only opening a pane", async () => {
		const mac = fakeMac();

		const outcome = await runDoctorFix({ ...UNATTENDED, guidePermissions: true }, mac.deps);

		expect(mac.calls).toEqual(["rebuild native", "reapply registrations", "grant permissions"]);
		expect(mac.calls.some((call) => call.startsWith("ask "))).toBe(false);
		expect(outcome.fixed).toContain(`grant the missing permissions to "${HELPER_DISPLAY_NAME}"`);
	});
});

describe("#given nothing to repair #when --fix runs #then it says so and changes nothing", () => {
	it("reports that nothing needs repairing", async () => {
		const mac = fakeMac();
		const deps: FixDependencies = { ...mac.deps, gather: readyFacts };

		const outcome = await runDoctorFix(UNATTENDED, deps);

		expect(mac.calls).toEqual([]);
		expect(mac.printed()).toContain("Nothing for --fix to repair.");
		expect(outcome.report.ready).toBe(true);
	});
});

describe("#given an ad-hoc signed helper that holds grants #when --fix would rebuild it #then it warns and rebuilds only with --rebuild-helper", () => {
	/** Stale helper inputs call for a rebuild; the ad-hoc helper holds Accessibility and Screen Recording. */
	function adHocFacts(): DoctorFacts {
		const facts = readyFacts();
		return {
			...facts,
			helper: {
				...facts.helper,
				signature: { valid: true, detail: "valid", adHoc: true },
				inputs: { built: "old", current: "new" },
			},
		};
	}
	const warning = `warning: "${HELPER_DISPLAY_NAME}" is signed ad hoc and holds Accessibility, Screen Recording now.`;

	it("names the grants a rebuild drops, does not take a yes at the terminal as consent, and skips the rebuild", async () => {
		const mac = fakeMac([true]);

		const outcome = await runDoctorFix({ ...UNATTENDED, interactive: true }, { ...mac.deps, gather: adHocFacts });

		expect(mac.calls).toEqual([]);
		expect(mac.printed()).toContain(warning);
		expect(mac.printed()).toContain("runs only with --rebuild-helper");
		expect(outcome.skipped).toEqual([
			"rebuild the signed helper app (needs your consent: opencua doctor --fix --rebuild-helper)",
		]);
	});

	it("prints the warning before it rebuilds with --rebuild-helper", async () => {
		const mac = fakeMac();
		let warnedFirst = false;

		await runDoctorFix(
			{ ...UNATTENDED, rebuildHelper: true },
			{
				...mac.deps,
				gather: adHocFacts,
				rebuildHelper: () => {
					warnedFirst = mac.printed().includes(warning);
					mac.calls.push("rebuild helper");
					return true;
				},
			},
		);

		expect(mac.calls).toEqual(["rebuild helper"]);
		expect(warnedFirst).toBe(true);
	});

	it("still asks at the terminal when the ad-hoc helper holds nothing a rebuild could drop", async () => {
		const mac = fakeMac([false]);
		const facts = adHocFacts();
		const bare: DoctorFacts = {
			...facts,
			selfCheck: {
				ok: true,
				report: {
					permissions: { accessibility: false, screenRecording: false },
					sessionMode: "console",
					processArch: "arm64",
					processNode: "v22.23.2",
					nativeCapture: { available: true, error: "" },
					automation: {},
				},
			},
		};

		await runDoctorFix({ ...UNATTENDED, interactive: true }, { ...mac.deps, gather: () => bare });

		expect(mac.calls.filter((call) => call.startsWith("ask Rebuild the helper"))).toHaveLength(1);
		expect(mac.printed()).not.toContain("is signed ad hoc and holds");
	});
});
