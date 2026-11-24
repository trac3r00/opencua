import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type DoctorFacts,
	detectArchitecture,
	evaluateDoctor,
	formatDoctorReport,
	machOArchitectures,
	macosSupported,
	parseSelfCheckOutput,
	readNativeInputs,
	readRtk,
	rtkVersionOutput,
} from "./doctor.js";

const nativeDir = join(dirname(fileURLToPath(import.meta.url)), "../../core/native");

function fatHeader(cpuTypes: readonly number[]): Buffer {
	const header = Buffer.alloc(8 + cpuTypes.length * 20);
	header.writeUInt32BE(0xcafebabe, 0);
	header.writeUInt32BE(cpuTypes.length, 4);
	cpuTypes.forEach((cpuType, index) => {
		header.writeUInt32BE(cpuType, 8 + index * 20);
	});
	return header;
}

function thinHeader(cpuType: number): Buffer {
	const header = Buffer.alloc(32);
	header.writeUInt32LE(0xfeedfacf, 0);
	header.writeUInt32LE(cpuType, 4);
	return header;
}

const ARM64 = 0x0100000c;
const X86_64 = 0x01000007;

function readyFacts(): DoctorFacts {
	return {
		macos: { version: "26.7", hardwareArch: "arm64" },
		node: { version: "v22.23.2", execPath: "/usr/local/bin/node", arch: "arm64", translated: false },
		natives: [
			{ name: "libsckit.dylib", path: "/repo/libsckit.dylib", architectures: ["x86_64", "arm64"] },
			{ name: "cursor-overlay", path: "/repo/cursor-overlay", architectures: ["x86_64", "arm64"] },
		],
		nativeInputs: { matches: true, detail: "build-inputs.sha256 matches" },
		server: { path: "/repo/server.js", present: true },
		helper: {
			app: "/repo/opencua-mcp.app",
			present: true,
			signature: { valid: true, detail: "valid" },
			bundledNode: { version: "v22.23.2" },
			inputs: { built: "abc", current: "abc" },
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
			clients: [
				{ client: "omo", state: "current", path: "/home/.omo/agent/mcp.json", detail: "registered, up to date" },
			],
		},
	};
}

function statusOf(facts: DoctorFacts, id: string): string | undefined {
	return evaluateDoctor(facts).checks.find((item) => item.id === id)?.status;
}

describe("#given Mach-O headers #when their architectures are read #then every slice is named without lipo", () => {
	it("names both slices of a universal binary and the one slice of a thin binary", () => {
		expect(machOArchitectures(fatHeader([X86_64, ARM64]))).toEqual(["x86_64", "arm64"]);
		expect(machOArchitectures(thinHeader(ARM64))).toEqual(["arm64"]);
		expect(machOArchitectures(thinHeader(X86_64))).toEqual(["x86_64"]);
	});

	it("answers undefined for a file that is not a Mach-O binary", () => {
		expect(machOArchitectures(Buffer.from("#!/usr/bin/env bash\necho hi\n"))).toBeUndefined();
		expect(machOArchitectures(Buffer.alloc(4))).toBeUndefined();
	});

	it("finds both an Apple Silicon and an Intel slice in the committed native binaries, built from the sources beside them", () => {
		for (const name of ["libsckit.dylib", "cursor-overlay"]) {
			const architectures = machOArchitectures(readFileSync(join(nativeDir, name)).subarray(0, 4096));
			expect(architectures).toEqual(expect.arrayContaining(["arm64", "x86_64"]));
		}
		expect(readNativeInputs(nativeDir)).toEqual({ matches: true, detail: "build-inputs.sha256 matches" });
	});
});

describe("#given the CPU and this Node #when the architecture is detected #then Rosetta is told apart from Intel", () => {
	it("calls an Intel Node on Apple Silicon translated, and native builds on either CPU not", () => {
		expect(detectArchitecture({ hwOptionalArm64: "1", procTranslated: "0", processArch: "arm64" })).toEqual({
			hardwareArch: "arm64",
			nodeArch: "arm64",
			nodeTranslated: false,
		});
		expect(detectArchitecture({ hwOptionalArm64: "1", procTranslated: undefined, processArch: "x64" })).toEqual({
			hardwareArch: "arm64",
			nodeArch: "x86_64",
			nodeTranslated: true,
		});
		expect(detectArchitecture({ hwOptionalArm64: undefined, procTranslated: undefined, processArch: "x64" })).toEqual(
			{
				hardwareArch: "x86_64",
				nodeArch: "x86_64",
				nodeTranslated: false,
			},
		);
		expect(detectArchitecture({ hwOptionalArm64: "1", procTranslated: "1", processArch: "x64" }).nodeTranslated).toBe(
			true,
		);
	});

	it("warns about a translated Node and a translated helper without blocking readiness", () => {
		const facts = readyFacts();
		const report = evaluateDoctor({
			...facts,
			node: { ...facts.node, arch: "x86_64", translated: true },
			selfCheck:
				facts.selfCheck?.ok === true
					? { ok: true, report: { ...facts.selfCheck.report, processArch: "x86_64" } }
					: facts.selfCheck,
		});

		expect(report.ready).toBe(true);
		expect(report.checks.find((item) => item.id === "node")).toMatchObject({
			status: "warn",
			fix: expect.stringContaining("native arm64 Node.js"),
		});
		expect(report.checks.find((item) => item.id === "helper-arch")).toMatchObject({
			status: "warn",
			fix: expect.stringContaining("--rebuild-helper"),
		});
	});
});

describe("#given a fully installed and permitted Mac #when the doctor evaluates it #then it is ready", () => {
	it("passes every check and has no next step", () => {
		const report = evaluateDoctor(readyFacts());

		expect(report.ready).toBe(true);
		expect(report.onlyManualStepsRemain).toBe(false);
		expect(report.nextSteps).toEqual([]);
		expect(report.checks.every((item) => item.status === "ok")).toBe(true);
	});
});

describe("#given a fresh helper identity without grants #when the doctor evaluates it #then the grants are the one manual step left", () => {
	it("fails only the two manual permission checks, each with a fix that names the System Settings pane", () => {
		const facts = readyFacts();
		const report = evaluateDoctor({
			...facts,
			selfCheck: {
				ok: true,
				report: {
					permissions: { accessibility: false, screenRecording: false },
					sessionMode: "console",
					processArch: "arm64",
					processNode: "v24.11.0",
					nativeCapture: { available: true, error: "" },
					automation: {},
				},
			},
		});

		const failures = report.checks.filter((item) => item.status === "fail");
		expect(report.ready).toBe(false);
		expect(report.onlyManualStepsRemain).toBe(true);
		expect(failures.map((item) => item.id)).toEqual(["permission:accessibility", "permission:screen-recording"]);
		expect(failures.every((item) => item.manual === true && item.fix !== undefined)).toBe(true);
		expect(failures[1]?.fix).toContain("Screen & System Audio Recording");
		expect(report.nextSteps).toHaveLength(2);
	});
});

describe("#given a permission check that threw in the helper #when the doctor reports it #then it prints the error, not a missing grant", () => {
	it("fails Accessibility with the binding error and a rebuild fix instead of a manual grant", () => {
		const report = parseSelfCheckOutput(
			JSON.stringify({
				permissions: {
					accessibility: false,
					screenRecording: true,
					errors: { accessibility: "AXIsProcessTrusted: symbol not found" },
				},
				session: { mode: "console" },
				process: { node: "v22.23.2", arch: "arm64" },
				automation: {},
			}),
		);
		if (report === undefined) throw new Error("the self-check line should parse");

		const doctor = evaluateDoctor({ ...readyFacts(), selfCheck: { ok: true, report } });

		const accessibility = doctor.checks.find((item) => item.id === "permission:accessibility");
		expect(accessibility?.status).toBe("fail");
		expect(accessibility?.manual).not.toBe(true);
		expect(doctor.onlyManualStepsRemain).toBe(false);
		expect(formatDoctorReport(doctor)).toContain("AXIsProcessTrusted: symbol not found");
	});
});

describe("#given an Intel Mac and thin Apple Silicon binaries #when the doctor evaluates it #then the missing slice is a failure to rebuild", () => {
	it("fails the native check and does not call it a manual step", () => {
		const facts = readyFacts();
		const report = evaluateDoctor({
			...facts,
			macos: { ...facts.macos, hardwareArch: "x86_64" },
			node: { ...facts.node, arch: "x86_64" },
			natives: facts.natives.map((binary) => ({ ...binary, architectures: ["arm64"] as const })),
		});

		expect(report.checks.find((item) => item.id === "native:libsckit.dylib")).toMatchObject({
			status: "fail",
			fix: expect.stringContaining("--rebuild-native"),
		});
		expect(report.ready).toBe(false);
		expect(report.onlyManualStepsRemain).toBe(false);
	});
});

describe("#given broken or missing pieces #when the doctor evaluates them #then each one fails its own check", () => {
	it("fails the helper and skips permissions when the helper app is missing", () => {
		const facts = readyFacts();
		const report = evaluateDoctor({
			...facts,
			helper: { ...facts.helper, present: false, bundledNode: { error: "not checked" } },
			selfCheck: undefined,
		});

		expect(report.checks.find((item) => item.id === "helper")?.status).toBe("fail");
		expect(report.checks.find((item) => item.id === "self-check")?.status).toBe("fail");
		expect(report.checks.some((item) => item.id.startsWith("permission:"))).toBe(false);
		expect(report.onlyManualStepsRemain).toBe(false);
	});

	it("refuses every macOS older than 15 and accepts Sequoia and Tahoe", () => {
		const facts = readyFacts();

		for (const version of ["14.7.1", "13.6.9", "unknown"]) {
			expect(macosSupported(version)).toBe(false);
			expect(statusOf({ ...facts, macos: { ...facts.macos, version } }, "macos")).toBe("fail");
		}
		for (const version of ["15.0", "15.7.2", "26.0", "26.7"]) {
			expect(macosSupported(version)).toBe(true);
			expect(statusOf({ ...facts, macos: { ...facts.macos, version } }, "macos")).toBe("ok");
		}
		expect(evaluateDoctor({ ...facts, macos: { ...facts.macos, version: "14.7.1" } }).checks[0]?.summary).toMatch(
			/needs macOS 15\.0 \(Sequoia\) or later/,
		);
	});

	it("fails a Node older than 20 and a server that does not answer through the helper", () => {
		const facts = readyFacts();

		expect(statusOf({ ...facts, node: { ...facts.node, version: "v18.20.4" } }, "node")).toBe("fail");
		expect(statusOf({ ...facts, selfCheck: { ok: false, error: "exit 1" } }, "self-check")).toBe("fail");
	});
});

describe("#given binaries or a helper built from other inputs than this checkout's #when the doctor evaluates them #then it warns", () => {
	it("warns about stale native inputs and a helper built from another launcher, and not about a helper without a stamp", () => {
		const facts = readyFacts();

		expect(
			statusOf({ ...facts, nativeInputs: { matches: false, detail: "changed: sckit.m" } }, "native-inputs"),
		).toBe("warn");
		expect(
			statusOf({ ...facts, helper: { ...facts.helper, inputs: { built: "old", current: "new" } } }, "helper-inputs"),
		).toBe("warn");
		expect(statusOf({ ...facts, helper: { ...facts.helper, inputs: undefined } }, "helper-inputs")).toBeUndefined();
	});
});

describe("#given MCP client registrations #when the doctor evaluates them #then stale ones fail with the --fix repair", () => {
	it("fails a stale or missing registration, accepts a printed block, and only warns when none is registered", () => {
		const facts = readyFacts();
		const withClient = (state: "stale" | "missing" | "manual" | "not-installed" | "unreadable") =>
			evaluateDoctor({
				...facts,
				config: {
					...facts.config,
					clients: [{ client: "omo", state, path: "/home/.omo/agent/mcp.json", detail: "x" }],
				},
			}).checks.find((item) => item.id === "client:omo");

		expect(withClient("stale")).toMatchObject({
			status: "fail",
			fix: expect.stringContaining("opencua doctor --fix"),
		});
		expect(withClient("missing")?.status).toBe("fail");
		expect(withClient("unreadable")).toMatchObject({ status: "fail", fix: expect.stringContaining("by hand") });
		expect(withClient("manual")?.status).toBe("ok");
		expect(withClient("not-installed")).toMatchObject({ status: "warn", fix: "x" });
		const none = evaluateDoctor({ ...facts, config: { ...facts.config, clients: [] } });
		expect(none.ready).toBe(true);
		expect(none.checks.find((item) => item.id === "clients")).toMatchObject({
			status: "warn",
			fix: expect.stringContaining("opencua config --register"),
		});
		expect(
			statusOf(
				{ ...facts, config: { path: "/c.json", saved: true, error: "not valid JSON", clients: [] } },
				"config",
			),
		).toBe("fail");
	});
});

describe("#given conditions that leave the install working #when the doctor evaluates them #then they warn without blocking readiness", () => {
	it("warns about a pressed stop switch and a missing native capture, and stays ready", () => {
		const facts = readyFacts();
		const report = evaluateDoctor({
			...facts,
			stop: { stopped: true, stoppedAt: "2026-10-06T00:00:00.000Z", reason: "stopped by user", source: "cli" },
			selfCheck: {
				ok: true,
				report: {
					permissions: { accessibility: true, screenRecording: true },
					sessionMode: "console",
					processArch: "arm64",
					processNode: "v22.23.2",
					nativeCapture: { available: false, error: "libsckit.dylib not found" },
					automation: {},
				},
			},
		});

		expect(report.ready).toBe(true);
		expect(report.checks.find((item) => item.id === "stop-switch")?.status).toBe("warn");
		expect(report.checks.find((item) => item.id === "native-capture")?.status).toBe("warn");
		expect(report.nextSteps).toHaveLength(2);
	});
});

describe("#given rtk on PATH or not #when the doctor evaluates it #then a missing rtk is a suggestion, never a failure", () => {
	it("reports the rtk version when it is installed", () => {
		const report = evaluateDoctor({ ...readyFacts(), rtk: { version: "1.2.1" } });

		const rtk = report.checks.find((item) => item.id === "rtk");
		expect(rtk?.status).toBe("ok");
		expect(rtk?.summary).toContain("rtk 1.2.1 on PATH");
		expect(report.ready).toBe(true);
	});

	it("warns with the install command when rtk is missing, and stays ready", () => {
		const report = evaluateDoctor({ ...readyFacts(), rtk: { version: undefined } });

		const rtk = report.checks.find((item) => item.id === "rtk");
		expect(rtk?.status).toBe("warn");
		expect(rtk?.fix).toContain("brew install rtk && rtk init -g");
		expect(report.ready).toBe(true);
		expect(report.nextSteps).toHaveLength(1);
		expect(report.nextSteps[0]).toBe(rtk?.fix);
	});

	it("looks rtk up by running rtk --version and keeps only the version", () => {
		const calls: string[] = [];
		const found = readRtk((file, args) => {
			calls.push([file, ...args].join(" "));
			return "rtk 1.2.1";
		});

		expect(calls).toEqual(["rtk --version"]);
		expect(found).toEqual({ version: "1.2.1" });
		expect(readRtk(() => undefined)).toEqual({ version: undefined });
		expect(readRtk(() => "")).toEqual({ version: undefined });
	});

	it("reads the version from an rtk on PATH and gives up on one that hangs", () => {
		const bin = mkdtempSync(join(tmpdir(), "opencua-doctor-rtk-"));
		try {
			const rtk = join(bin, "rtk");
			writeFileSync(rtk, "#!/bin/sh\necho 'rtk 9.9.9'\n", { mode: 0o755 });
			expect(rtkVersionOutput({ PATH: bin })).toBe("rtk 9.9.9");

			writeFileSync(rtk, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
			const started = Date.now();
			expect(rtkVersionOutput({ PATH: `${bin}:/bin:/usr/bin` }, 200)).toBeUndefined();
			expect(Date.now() - started).toBeLessThan(5_000);

			expect(rtkVersionOutput({ PATH: join(bin, "missing") })).toBeUndefined();
		} finally {
			rmSync(bin, { recursive: true, force: true });
		}
	});

	it("adds no rtk check when rtk was not looked up", () => {
		const report = evaluateDoctor(readyFacts());

		expect(report.checks.some((item) => item.id === "rtk")).toBe(false);
	});
});

describe("#given server.js --doctor output #when it is parsed #then only a capability report is accepted", () => {
	it("reads permissions, process and native capture from the last JSON line", () => {
		const line = JSON.stringify({
			permissions: { accessibility: false, screenRecording: true },
			session: { mode: "console" },
			process: { node: "v24.11.0", arch: "x64" },
			nativeCapture: { available: true, error: "" },
			automation: {},
		});

		expect(parseSelfCheckOutput(`warning: something\n${line}\n`)).toEqual({
			permissions: { accessibility: false, screenRecording: true },
			sessionMode: "console",
			processArch: "x86_64",
			processNode: "v24.11.0",
			nativeCapture: { available: true, error: "" },
			automation: {},
		});
	});

	it("rejects output that is not JSON or lacks the permission booleans", () => {
		expect(parseSelfCheckOutput("Fatal error: boom")).toBeUndefined();
		expect(parseSelfCheckOutput(JSON.stringify({ permissions: { accessibility: "yes" } }))).toBeUndefined();
		expect(parseSelfCheckOutput("")).toBeUndefined();
	});
});

describe("#given the cua-history watcher #when the doctor reads Input Monitoring #then it is checked only once history is installed", () => {
	const evaluate = (historyInstalled: boolean, inputMonitoring: boolean | undefined) => {
		const facts = readyFacts();
		if (facts.selfCheck?.ok !== true) {
			throw new Error("readyFacts has no self-check report");
		}
		const report = facts.selfCheck.report;
		return evaluateDoctor({
			...facts,
			historyInstalled,
			selfCheck: { ok: true, report: { ...report, permissions: { ...report.permissions, inputMonitoring } } },
		});
	};
	const row = (doctor: ReturnType<typeof evaluateDoctor>) =>
		doctor.checks.find((item) => item.id === "permission:input-monitoring");

	it("skips it without history, fails it as a manual step when missing, and passes it when granted", () => {
		const withoutHistory = evaluate(false, false);
		expect(row(withoutHistory)).toBeUndefined();
		expect(withoutHistory.ready).toBe(true);

		const missing = evaluate(true, false);
		expect(row(missing)).toMatchObject({ status: "fail", manual: true });
		expect(missing.ready).toBe(false);
		expect(missing.onlyManualStepsRemain).toBe(true);

		expect(row(evaluate(true, true))?.status).toBe("ok");
		expect(row(evaluate(true, undefined))?.status).toBe("warn");
	});
});
