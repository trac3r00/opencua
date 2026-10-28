import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { StopSwitch } from "@apple-cua/core";
import type { AutomationStatus, StopStatus } from "@apple-cua/core";
import { missingSkillLink } from "./client-skills.js";
import { CLIENT_NAMES, type ClientInspection, inspectClient } from "./clients.js";
import { type Environment, type Layout, displayPath, homeDirectory, resolveLayout } from "./layout.js";
import { loadSettings, plannedRegistration } from "./settings.js";

/** The oldest macOS apple-cua supports: the latest major release and the one before it (Tahoe and Sequoia). */
const MINIMUM_MACOS = "15.0";
const MINIMUM_MACOS_NAME = "Sequoia";
const MINIMUM_NODE_MAJOR = 20;
/** How the signed helper app appears in System Settings, and so the name the user grants permissions to. */
export const HELPER_DISPLAY_NAME = "apple-cua-mcp";
/** The System Settings panes `apple-cua doctor --fix` opens for a missing grant. */
export const PRIVACY_PANES = {
	accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
	screenRecording: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
	automation: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
} as const;
/** The command that walks a person through every permission grant. */
export const GRANT_COMMAND = "apple-cua permissions grant";
const AUTOMATION_STATUSES: readonly AutomationStatus[] = [
	"granted",
	"denied",
	"not-determined",
	"not-running",
	"unknown",
];
const APP_NAMES: Readonly<Record<string, string>> = {
	"com.apple.systemevents": "System Events",
	"com.apple.finder": "Finder",
	"com.apple.safari": "Safari",
	"com.google.chrome": "Google Chrome",
	"com.microsoft.edgemac": "Microsoft Edge",
	"company.thebrowser.browser": "Arc",
};

/** How System Settings > Privacy & Security > Automation names an app the helper controls. */
export function automationAppName(bundleId: string): string {
	return APP_NAMES[bundleId.toLowerCase()] ?? bundleId;
}
/** Written into the helper by scripts/build-tcc-helper.sh: the digest of the inputs it was built from. */
export const HELPER_INPUTS_STAMP = "Contents/Resources/helper-inputs.sha256";
const SELF_CHECK_TIMEOUT_MS = 30_000;
const PERMISSION_REQUEST_TIMEOUT_MS = 5 * 60_000;
const NATIVE_INPUTS_FILE = "build-inputs.sha256";

export type MachArchitecture = "arm64" | "x86_64";
export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
	readonly id: string;
	readonly status: CheckStatus;
	readonly summary: string;
	/** What to do about a warning or a failure. */
	readonly fix?: string;
	/** Only a person can do it (a permission grant); the installation itself is complete. */
	readonly manual?: boolean;
}

export interface DoctorReport {
	/** No check failed: apple-cua is installed and holds its permissions. */
	readonly ready: boolean;
	/** Not ready, but every failure is a manual permission grant: setup itself is done. */
	readonly onlyManualStepsRemain: boolean;
	readonly checks: readonly DoctorCheck[];
	readonly nextSteps: readonly string[];
}

export interface NativeBinaryFacts {
	readonly name: string;
	readonly path: string;
	/** Undefined when the file is missing or is not a Mach-O binary. */
	readonly architectures: readonly MachArchitecture[] | undefined;
}

export interface HelperFacts {
	readonly app: string;
	readonly present: boolean;
	readonly signature: { readonly valid: boolean; readonly detail: string };
	readonly bundledNode: { readonly version: string } | { readonly error: string };
	/** The inputs digest the helper was built from and the one this checkout would build now; undefined for a helper built before the stamp existed. */
	readonly inputs?: { readonly built: string; readonly current: string | undefined } | undefined;
}

/** The part of `server.js --doctor` output the doctor reads. */
export interface SelfCheckReport {
	readonly permissions: { readonly accessibility: boolean; readonly screenRecording: boolean };
	readonly sessionMode: string | undefined;
	readonly processArch: MachArchitecture | undefined;
	readonly processNode: string | undefined;
	readonly nativeCapture: { readonly available: boolean; readonly error: string } | undefined;
	/** Automation permission per app the server sends Apple Events to; empty from a server that predates the check. */
	readonly automation: Readonly<Record<string, AutomationStatus>>;
}

export type SelfCheckResult =
	| { readonly ok: true; readonly report: SelfCheckReport }
	| { readonly ok: false; readonly error: string };

export interface ConfigFacts {
	readonly path: string;
	/** False when config.json does not exist yet. */
	readonly saved: boolean;
	/** Why config.json could not be read. */
	readonly error?: string | undefined;
	/** Each saved client's registration, compared with the saved settings and this checkout. */
	readonly clients: readonly ClientInspection[];
}

export interface DoctorFacts {
	readonly macos: { readonly version: string; readonly hardwareArch: MachArchitecture };
	readonly node: {
		readonly version: string;
		readonly execPath: string;
		readonly arch: MachArchitecture | undefined;
		/** An Intel build of Node running under Rosetta on Apple Silicon. */
		readonly translated: boolean;
	};
	readonly natives: readonly NativeBinaryFacts[];
	/** Whether the native binaries were built from the sources beside them; undefined when that cannot be told. */
	readonly nativeInputs?: { readonly matches: boolean; readonly detail: string } | undefined;
	readonly server: { readonly path: string; readonly present: boolean };
	readonly helper: HelperFacts;
	/** Undefined when it could not run because the helper app or server.js is missing. */
	readonly selfCheck: SelfCheckResult | undefined;
	readonly stop: StopStatus;
	readonly config: ConfigFacts;
	/** Shortens paths under the home directory in summaries; identity when absent. */
	readonly showPath?: ((path: string) => string) | undefined;
}

const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const MH_MAGIC_64 = 0xfeedfacf;
const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;
const MAX_FAT_ARCHITECTURES = 16;

function architectureFor(cpuType: number): MachArchitecture | undefined {
	if (cpuType === CPU_TYPE_ARM64) {
		return "arm64";
	}
	return cpuType === CPU_TYPE_X86_64 ? "x86_64" : undefined;
}

/**
 * The CPU slices a Mach-O file carries, read from its header: every slice of a universal binary, or the one
 * architecture of a thin one. Undefined for anything that is not a 64-bit Mach-O file, so no `lipo` (and no
 * Command Line Tools) is needed to answer.
 */
export function machOArchitectures(header: Buffer): MachArchitecture[] | undefined {
	if (header.length < 8) {
		return undefined;
	}
	const fatMagic = header.readUInt32BE(0);
	if (fatMagic === FAT_MAGIC || fatMagic === FAT_MAGIC_64) {
		const count = header.readUInt32BE(4);
		const entrySize = fatMagic === FAT_MAGIC ? 20 : 32;
		if (count === 0 || count > MAX_FAT_ARCHITECTURES || 8 + count * entrySize > header.length) {
			return undefined;
		}
		const architectures: MachArchitecture[] = [];
		for (let index = 0; index < count; index += 1) {
			const architecture = architectureFor(header.readUInt32BE(8 + index * entrySize));
			if (architecture !== undefined && !architectures.includes(architecture)) {
				architectures.push(architecture);
			}
		}
		return architectures;
	}
	if (header.readUInt32LE(0) === MH_MAGIC_64) {
		const architecture = architectureFor(header.readUInt32LE(4));
		return architecture === undefined ? [] : [architecture];
	}
	return undefined;
}

function nodeArchitecture(arch: string): MachArchitecture | undefined {
	if (arch === "arm64") {
		return "arm64";
	}
	return arch === "x64" ? "x86_64" : undefined;
}

export interface ArchitectureProbe {
	/** `sysctl -n hw.optional.arm64`: "1" on Apple Silicon even for a process under Rosetta; absent on Intel. */
	readonly hwOptionalArm64: string | undefined;
	/** `sysctl -n sysctl.proc_translated` as a child of this process reports it: "1" under Rosetta. */
	readonly procTranslated: string | undefined;
	/** This Node's `process.arch`. */
	readonly processArch: string;
}

export interface HostArchitecture {
	readonly hardwareArch: MachArchitecture;
	readonly nodeArch: MachArchitecture | undefined;
	/** This Node is an x86_64 build running under Rosetta on Apple Silicon. */
	readonly nodeTranslated: boolean;
}

/**
 * The Mac's CPU and whether this Node runs translated. `uname -m` and `process.arch` both say x86_64 under Rosetta,
 * so the hardware comes from hw.optional.arm64, and an x86_64 Node on arm64 hardware is translated by definition.
 */
export function detectArchitecture(probe: ArchitectureProbe): HostArchitecture {
	const hardwareArch: MachArchitecture = probe.hwOptionalArm64?.trim() === "1" ? "arm64" : "x86_64";
	const nodeArch = nodeArchitecture(probe.processArch);
	const nodeTranslated = (hardwareArch === "arm64" && nodeArch === "x86_64") || probe.procTranslated?.trim() === "1";
	return { hardwareArch, nodeArch, nodeTranslated };
}

function versionAtLeast(version: string, minimum: string): boolean {
	const actual = version.split(".").map((part) => Number.parseInt(part, 10));
	const wanted = minimum.split(".").map((part) => Number.parseInt(part, 10));
	for (let index = 0; index < Math.max(actual.length, wanted.length); index += 1) {
		const left = actual[index] ?? 0;
		const right = wanted[index] ?? 0;
		if (Number.isNaN(left) || Number.isNaN(right)) {
			return false;
		}
		if (left !== right) {
			return left > right;
		}
	}
	return true;
}

/** Whether apple-cua supports this macOS version (15 Sequoia or later). */
export function macosSupported(version: string): boolean {
	return versionAtLeast(version, MINIMUM_MACOS);
}

function nodeMajor(version: string): number {
	return Number.parseInt(version.replace(/^v/, ""), 10);
}

function check(id: string, status: CheckStatus, summary: string, fix?: string, manual?: boolean): DoctorCheck {
	return {
		id,
		status,
		summary,
		...(fix === undefined ? {} : { fix }),
		...(manual === true ? { manual } : {}),
	};
}

function machineName(architecture: MachArchitecture): string {
	return `${architecture === "arm64" ? "Apple Silicon" : "Intel"} (${architecture})`;
}

function macosCheck(facts: DoctorFacts): DoctorCheck {
	const { version, hardwareArch } = facts.macos;
	const summary = `macOS ${version} on ${machineName(hardwareArch)}`;
	return macosSupported(version)
		? check("macos", "ok", summary)
		: check(
				"macos",
				"fail",
				`${summary}: apple-cua needs macOS ${MINIMUM_MACOS} (${MINIMUM_MACOS_NAME}) or later`,
				"Update macOS in System Settings > General > Software Update.",
			);
}

function nodeCheck(facts: DoctorFacts): DoctorCheck {
	const summary = `Node ${facts.node.version} (${facts.node.execPath})`;
	if (nodeMajor(facts.node.version) < MINIMUM_NODE_MAJOR) {
		return check(
			"node",
			"fail",
			`${summary} is older than Node ${MINIMUM_NODE_MAJOR}`,
			`Install Node.js ${MINIMUM_NODE_MAJOR} or later, or run ./scripts/setup.sh, which downloads one when none is found.`,
		);
	}
	if (facts.node.translated) {
		return check(
			"node",
			"warn",
			`${summary} is an Intel (x86_64) build running under Rosetta on this Apple Silicon Mac`,
			"Install the native arm64 Node.js from https://nodejs.org (or remove the Intel one so ./scripts/setup.sh downloads it), then re-run ./scripts/setup.sh. Everything works under Rosetta, only slower.",
		);
	}
	return check("node", "ok", summary);
}

function requiredArchitectures(facts: DoctorFacts): MachArchitecture[] {
	const required: MachArchitecture[] = [facts.macos.hardwareArch];
	const candidates = [facts.node.arch, facts.selfCheck?.ok === true ? facts.selfCheck.report.processArch : undefined];
	for (const architecture of candidates) {
		if (architecture !== undefined && !required.includes(architecture)) {
			required.push(architecture);
		}
	}
	return required;
}

const REBUILD_NATIVE = "Rebuild the native binaries: apple-cua doctor --fix (or ./scripts/setup.sh --rebuild-native).";

function showOf(facts: DoctorFacts): (path: string) => string {
	return facts.showPath ?? ((path: string) => path);
}

function nativeChecks(facts: DoctorFacts): DoctorCheck[] {
	const required = requiredArchitectures(facts);
	const checks = facts.natives.map((binary) => {
		const id = `native:${binary.name}`;
		if (binary.architectures === undefined) {
			return check(id, "fail", `${binary.name} is missing or unreadable (${binary.path})`, REBUILD_NATIVE);
		}
		const missing = required.filter((architecture) => !binary.architectures?.includes(architecture));
		const slices = binary.architectures.length === 0 ? "no known slice" : binary.architectures.join(" + ");
		if (missing.length > 0) {
			return check(
				id,
				"fail",
				`${binary.name} has ${slices} but this Mac needs ${missing.join(" + ")}`,
				REBUILD_NATIVE,
			);
		}
		return check(id, "ok", `${binary.name}: ${slices}`);
	});
	if (facts.nativeInputs !== undefined && !facts.nativeInputs.matches) {
		checks.push(
			check(
				"native-inputs",
				"warn",
				`the native binaries were not built from the sources beside them (${facts.nativeInputs.detail})`,
				REBUILD_NATIVE,
			),
		);
	}
	return checks;
}

function serverCheck(facts: DoctorFacts): DoctorCheck {
	const server = showOf(facts)(facts.server.path);
	return facts.server.present
		? check("server", "ok", `MCP server built (${server})`)
		: check(
				"server",
				"fail",
				`MCP server not built (${server} is missing)`,
				"Build it: ./scripts/setup.sh in the checkout (or apple-cua update).",
			);
}

const REBUILD_HELPER =
	"Rebuild the helper app: apple-cua doctor --fix --rebuild-helper (macOS then asks for Screen Recording and Accessibility again).";

function helperChecks(facts: DoctorFacts): DoctorCheck[] {
	const { helper } = facts;
	const app = showOf(facts)(helper.app);
	if (!helper.present) {
		return [check("helper", "fail", `helper app missing (${app})`, REBUILD_HELPER)];
	}
	if (!helper.signature.valid) {
		return [
			check("helper", "fail", `helper app signature does not verify: ${helper.signature.detail}`, REBUILD_HELPER),
		];
	}
	if ("error" in helper.bundledNode) {
		return [
			check("helper", "fail", `the helper's bundled node does not run: ${helper.bundledNode.error}`, REBUILD_HELPER),
		];
	}
	if (nodeMajor(helper.bundledNode.version) < MINIMUM_NODE_MAJOR) {
		return [
			check(
				"helper",
				"fail",
				`the helper bundles Node ${helper.bundledNode.version}, older than Node ${MINIMUM_NODE_MAJOR}`,
				REBUILD_HELPER,
			),
		];
	}
	const checks = [
		check("helper", "ok", `helper app ${app} (signature valid, bundled Node ${helper.bundledNode.version})`),
	];
	if (
		helper.inputs !== undefined &&
		helper.inputs.current !== undefined &&
		helper.inputs.built !== helper.inputs.current
	) {
		checks.push(
			check(
				"helper-inputs",
				"warn",
				"the helper was built from an older launcher or Info.plist than this checkout has",
				REBUILD_HELPER,
			),
		);
	}
	return checks;
}

function permissionFix(grant: string, pane: string): string {
	return `Grant ${grant} to "${HELPER_DISPLAY_NAME}": run ${GRANT_COMMAND}, which shows macOS's dialog, opens System Settings > Privacy & Security > ${pane} and waits until it is on. Restart your MCP client afterwards.`;
}

function automationChecks(automation: SelfCheckReport["automation"]): DoctorCheck[] {
	return Object.entries(automation).map(([bundleId, status]) => {
		const id = `permission:automation:${bundleId}`;
		const app = automationAppName(bundleId);
		switch (status) {
			case "granted":
				return check(id, "ok", `Automation: "${HELPER_DISPLAY_NAME}" may control ${app}`);
			case "not-determined":
				return check(
					id,
					"warn",
					`Automation of ${app} not answered yet, so macOS would ask in the middle of an agent's task`,
					`Answer it now: run ${GRANT_COMMAND} and choose Allow when macOS asks about ${app}.`,
				);
			case "denied":
				return check(
					id,
					"warn",
					`Automation of ${app} refused, so apple-cua falls back to slower or less exact ways`,
					`Switch on ${app} under "${HELPER_DISPLAY_NAME}" in System Settings > Privacy & Security > Automation (${GRANT_COMMAND} opens it).`,
				);
			case "not-running":
			case "unknown":
				return check(id, "ok", `Automation of ${app}: not checked (${app} is not running)`);
		}
	});
}

function selfCheckChecks(facts: DoctorFacts): DoctorCheck[] {
	const result = facts.selfCheck;
	if (result === undefined) {
		// The missing helper or server.js fails its own check, whose fix is the way forward.
		return [check("self-check", "fail", "permissions not checked: the helper app or server.js is missing")];
	}
	if (!result.ok) {
		return [
			check(
				"self-check",
				"fail",
				`the server did not answer through the helper: ${result.error}`,
				`Run "${join(facts.helper.app, "Contents/MacOS/apple-cua-mcp")}" "${facts.server.path}" --doctor to see the error; ${REBUILD_HELPER}`,
			),
		];
	}
	const { report } = result;
	const checks: DoctorCheck[] = [
		check(
			"self-check",
			"ok",
			`server.js answered through the helper (Node ${report.processNode ?? "unknown"}, ${report.processArch ?? "unknown arch"})`,
		),
	];
	if (report.processArch !== undefined && report.processArch !== facts.macos.hardwareArch) {
		checks.push(
			check(
				"helper-arch",
				"warn",
				`the helper's bundled Node is ${report.processArch} on this ${machineName(facts.macos.hardwareArch)} Mac, so it runs under Rosetta`,
				REBUILD_HELPER,
			),
		);
	}
	checks.push(
		report.permissions.accessibility
			? check("permission:accessibility", "ok", `Accessibility granted to "${HELPER_DISPLAY_NAME}"`)
			: check(
					"permission:accessibility",
					"fail",
					`Accessibility not granted to "${HELPER_DISPLAY_NAME}" (needed to observe apps and send input)`,
					permissionFix("Accessibility", "Accessibility"),
					true,
				),
		report.permissions.screenRecording
			? check("permission:screen-recording", "ok", `Screen Recording granted to "${HELPER_DISPLAY_NAME}"`)
			: check(
					"permission:screen-recording",
					"fail",
					`Screen Recording not granted to "${HELPER_DISPLAY_NAME}" (needed for screenshots)`,
					permissionFix("Screen Recording", "Screen & System Audio Recording"),
					true,
				),
		...automationChecks(report.automation),
	);
	if (report.nativeCapture !== undefined) {
		checks.push(
			report.nativeCapture.available
				? check("native-capture", "ok", "ScreenCaptureKit capture loads in the helper")
				: check(
						"native-capture",
						"warn",
						`ScreenCaptureKit capture unavailable (${report.nativeCapture.error}); screenshots use the CoreGraphics and screencapture fallbacks`,
						`Screenshots still work. If libsckit.dylib is missing or lacks this Mac's architecture, ${REBUILD_NATIVE}`,
					),
		);
	}
	if (report.sessionMode === "locked") {
		checks.push(check("session", "warn", "the screen is locked; apps report no content until it is unlocked"));
	} else if (report.sessionMode === "remote") {
		checks.push(
			check(
				"session",
				"warn",
				"this session is reached remotely while another user owns the console; some UI may not render",
			),
		);
	}
	return checks;
}

const REAPPLY = "Register apple-cua again: apple-cua doctor --fix (the config file is backed up first).";

function clientChecks(facts: DoctorFacts): DoctorCheck[] {
	const { config } = facts;
	const show = showOf(facts);
	if (config.error !== undefined) {
		return [
			check(
				"config",
				"fail",
				`cannot read ${show(config.path)}: ${config.error}`,
				`Fix or delete ${show(config.path)}, then run apple-cua config.`,
			),
		];
	}
	if (config.clients.length === 0) {
		return [
			check(
				"clients",
				"warn",
				"no MCP client is registered, so no agent can use apple-cua yet",
				`Register it and allow an app: apple-cua config --register ${CLIENT_NAMES.join("|")} --allow TextEdit`,
			),
		];
	}
	return config.clients.map((inspection) => {
		const id = `client:${inspection.client}`;
		const where = inspection.path === undefined ? "" : show(inspection.path);
		switch (inspection.state) {
			case "current":
				return check(
					id,
					"ok",
					`${inspection.client}: ${where === "" ? inspection.detail : `registered in ${where}`}`,
				);
			case "disabled":
				return check(
					id,
					"warn",
					`${inspection.client}: ${inspection.detail}`,
					`Switch it back on: apple-cua config --register ${inspection.client} (or in the client's plugin settings).`,
				);
			case "conflict":
				return check(id, "fail", `${inspection.client}: conflicting registration`, inspection.detail);
			case "manual":
				return check(
					id,
					"ok",
					`${inspection.client}: ${inspection.detail} (apple-cua config --register ${inspection.client} prints it again)`,
				);
			case "unreadable":
				return check(
					id,
					"fail",
					`${inspection.client}: cannot read ${where}: ${inspection.detail}`,
					`Fix ${where} by hand; apple-cua never rewrites a file it cannot parse.`,
				);
			case "missing":
				return check(
					id,
					"fail",
					`${inspection.client}: ${where === "" ? inspection.detail : `${where} has no apple-cua entry`}`,
					REAPPLY,
				);
			case "stale":
				return check(
					id,
					"fail",
					`${inspection.client}: ${where === "" ? inspection.detail : `the entry in ${where} ${inspection.detail}`}`,
					REAPPLY,
				);
		}
	});
}

function stopCheck(facts: DoctorFacts): DoctorCheck {
	if (!facts.stop.stopped) {
		return check(
			"stop-switch",
			"ok",
			"stop switch: not stopped (Control+Option+Command or `apple-cua stop` stops every agent)",
		);
	}
	return check(
		"stop-switch",
		"warn",
		`computer use is stopped (${facts.stop.source} at ${facts.stop.stoppedAt}: ${facts.stop.reason}); agents may read but not act`,
		"Run `apple-cua resume` when agents may act again (apple-cua doctor --fix asks first).",
	);
}

/** Turns gathered facts into a verdict. Pure, so every outcome is testable without touching the Mac. */
export function evaluateDoctor(facts: DoctorFacts): DoctorReport {
	const checks: DoctorCheck[] = [
		macosCheck(facts),
		nodeCheck(facts),
		...nativeChecks(facts),
		serverCheck(facts),
		...helperChecks(facts),
		...selfCheckChecks(facts),
		...clientChecks(facts),
		stopCheck(facts),
	];
	const failures = checks.filter((item) => item.status === "fail");
	const warnings = checks.filter((item) => item.status === "warn");
	const nextSteps = [...failures, ...warnings].flatMap((item) => (item.fix === undefined ? [] : [item.fix]));
	return {
		ready: failures.length === 0,
		onlyManualStepsRemain: failures.length > 0 && failures.every((item) => item.manual === true),
		checks,
		nextSteps: [...new Set(nextSteps)],
	};
}

const STATUS_LABELS: Readonly<Record<CheckStatus, string>> = { ok: "ok  ", warn: "warn", fail: "FAIL" };

export function formatDoctorReport(report: DoctorReport): string {
	const lines = [
		"apple-cua doctor",
		...report.checks.map((item) => `  ${STATUS_LABELS[item.status]}  ${item.summary}`),
		"",
	];
	const fixesOf = (status: CheckStatus) => [
		...new Set(report.checks.flatMap((item) => (item.status === status && item.fix !== undefined ? [item.fix] : []))),
	];
	const required = fixesOf("fail");
	const suggested = fixesOf("warn").filter((fix) => !required.includes(fix));
	const list = (steps: readonly string[]) => {
		steps.forEach((step, index) => {
			lines.push(`  ${index + 1}. ${step}`);
		});
	};
	if (report.ready) {
		lines.push("Ready: apple-cua is installed and holds its permissions.");
	} else if (report.onlyManualStepsRemain) {
		lines.push(`Installed. One manual step remains, granting permissions to "${HELPER_DISPLAY_NAME}":`);
		list(required);
	} else {
		lines.push("Not ready. Next steps:");
		list([...required, ...suggested]);
		return lines.join("\n");
	}
	if (suggested.length > 0) {
		lines.push(report.ready ? "Suggestions:" : "Also:");
		list(suggested);
	}
	return lines.join("\n");
}

function readHeader(path: string): Buffer | undefined {
	if (!existsSync(path)) {
		return undefined;
	}
	const descriptor = openSync(path, "r");
	try {
		const header = Buffer.alloc(4096);
		const length = readSync(descriptor, header, 0, header.length, 0);
		return header.subarray(0, length);
	} finally {
		closeSync(descriptor);
	}
}

function commandOutput(file: string, args: readonly string[]): string | undefined {
	try {
		return execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return undefined;
	}
}

function processFailure(result: ReturnType<typeof spawnSync>): string {
	if (result.error !== undefined) {
		return result.error.message;
	}
	const stderr = String(result.stderr ?? "").trim();
	const signal = result.signal === null ? "" : ` (signal ${result.signal})`;
	return `exit ${result.status ?? "unknown"}${signal}${stderr === "" ? "" : `: ${stderr.split("\n").slice(-3).join(" | ")}`}`;
}

/** The fields the doctor reads from `server.js --doctor`, validated; undefined for anything else. */
export function parseSelfCheckOutput(stdout: string): SelfCheckReport | undefined {
	const line = stdout
		.trim()
		.split("\n")
		.filter((entry) => entry.trim() !== "")
		.pop();
	if (line === undefined) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) {
		return undefined;
	}
	const record = parsed as Record<string, unknown>;
	const permissions = record["permissions"] as Record<string, unknown> | undefined;
	if (
		typeof permissions !== "object" ||
		permissions === null ||
		typeof permissions["accessibility"] !== "boolean" ||
		typeof permissions["screenRecording"] !== "boolean"
	) {
		return undefined;
	}
	const session = record["session"] as Record<string, unknown> | undefined;
	const processInfo = record["process"] as Record<string, unknown> | undefined;
	const nativeCapture = record["nativeCapture"] as Record<string, unknown> | undefined;
	const automation = record["automation"];
	return {
		permissions: { accessibility: permissions["accessibility"], screenRecording: permissions["screenRecording"] },
		sessionMode: typeof session?.["mode"] === "string" ? session["mode"] : undefined,
		processArch: typeof processInfo?.["arch"] === "string" ? nodeArchitecture(processInfo["arch"]) : undefined,
		processNode: typeof processInfo?.["node"] === "string" ? processInfo["node"] : undefined,
		nativeCapture:
			typeof nativeCapture?.["available"] === "boolean"
				? {
						available: nativeCapture["available"],
						error: typeof nativeCapture["error"] === "string" ? nativeCapture["error"] : "",
					}
				: undefined,
		automation:
			typeof automation === "object" && automation !== null
				? Object.fromEntries(
						Object.entries(automation).flatMap(([bundleId, status]) => {
							const known = AUTOMATION_STATUSES.find((candidate) => candidate === status);
							return known === undefined ? [] : [[bundleId, known]];
						}),
					)
				: {},
	};
}

function sha256(path: string): string | undefined {
	try {
		return createHash("sha256").update(readFileSync(path)).digest("hex");
	} catch {
		return undefined;
	}
}

/** Compares packages/core/native/build-inputs.sha256 (written by build.sh) with the sources it names. */
export function readNativeInputs(nativeDir: string): DoctorFacts["nativeInputs"] {
	let recorded: string;
	try {
		recorded = readFileSync(join(nativeDir, NATIVE_INPUTS_FILE), "utf8");
	} catch {
		return undefined;
	}
	const changed: string[] = [];
	for (const line of recorded.split("\n")) {
		const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
		if (match?.[1] !== undefined && match[2] !== undefined && sha256(join(nativeDir, match[2])) !== match[1]) {
			changed.push(match[2]);
		}
	}
	return changed.length === 0
		? { matches: true, detail: "build-inputs.sha256 matches" }
		: { matches: false, detail: `changed since the last build: ${changed.join(", ")}` };
}

/** The helper's inputs stamp and the digest this checkout's build script computes now. */
function readHelperInputs(layout: Pick<Layout, "helperApp" | "helperBuildScript">): HelperFacts["inputs"] {
	let built: string;
	try {
		built = readFileSync(join(layout.helperApp, HELPER_INPUTS_STAMP), "utf8").trim();
	} catch {
		return undefined;
	}
	const current = spawnSync("/bin/bash", [layout.helperBuildScript, "--inputs-digest"], { encoding: "utf8" });
	return { built, current: current.status === 0 ? current.stdout.trim() || undefined : undefined };
}

function readConfigFacts(layout: Layout, env: Environment): ConfigFacts {
	try {
		const { settings, saved } = loadSettings(layout.configPath);
		const desired = plannedRegistration(layout, settings);
		const context = { home: layout.home, env, now: new Date() };
		return {
			path: layout.configPath,
			saved,
			clients: settings.clients.map((client) => {
				const inspection = inspectClient(client, desired, context);
				const folder =
					inspection.state === "current" ? missingSkillLink(client, layout.bundleDir, context) : undefined;
				return folder === undefined
					? inspection
					: { client, state: "stale", detail: `the apple-cua skill is not linked in ${folder}` };
			}),
		};
	} catch (error) {
		return {
			path: layout.configPath,
			saved: true,
			error: error instanceof Error ? error.message : String(error),
			clients: [],
		};
	}
}

/** Runs server.js --doctor through the helper, so the answers describe the helper's permissions. */
export function runSelfCheck(layout: Pick<Layout, "helperExecutable" | "server">): SelfCheckResult {
	const run = spawnSync(layout.helperExecutable, [layout.server, "--doctor"], {
		encoding: "utf8",
		timeout: SELF_CHECK_TIMEOUT_MS,
	});
	const report = run.status === 0 ? parseSelfCheckOutput(run.stdout) : undefined;
	return report === undefined
		? { ok: false, error: run.status === 0 ? "its --doctor output was not a capability report" : processFailure(run) }
		: { ok: true, report };
}

/**
 * Runs server.js --request-permissions through the helper, which shows macOS's dialogs under the helper's name. An
 * Automation dialog blocks until it is answered, hence the long timeout. Undefined when the helper gave no answer.
 */
export function requestHelperPermissions(
	layout: Pick<Layout, "helperExecutable" | "server">,
	kinds: readonly string[],
): Record<string, unknown> | undefined {
	const run = spawnSync(layout.helperExecutable, [layout.server, "--request-permissions", kinds.join(",")], {
		encoding: "utf8",
		timeout: PERMISSION_REQUEST_TIMEOUT_MS,
	});
	const line = run.status === 0 ? run.stdout.trim().split("\n").pop() : undefined;
	try {
		const parsed: unknown = line === undefined ? undefined : JSON.parse(line);
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Reads the Mac without changing it and without raising a permission prompt. Permissions are read inside the
 * signed helper (server.js --doctor through its launcher), because macOS keys them to the helper's identity, not
 * to the terminal running this command.
 */
export function gatherDoctorFacts(layout: Layout = resolveLayout(), env: Environment = process.env): DoctorFacts {
	const architecture = detectArchitecture({
		hwOptionalArm64: commandOutput("/usr/sbin/sysctl", ["-n", "hw.optional.arm64"]),
		procTranslated: commandOutput("/usr/sbin/sysctl", ["-n", "sysctl.proc_translated"]),
		processArch: process.arch,
	});
	const natives = ["libsckit.dylib", "cursor-overlay"].map((name) => {
		const path = join(layout.nativeDir, name);
		const header = readHeader(path);
		return { name, path, architectures: header === undefined ? undefined : machOArchitectures(header) };
	});

	const launcher = layout.helperExecutable;
	const bundledNodePath = join(layout.helperApp, "Contents/Resources/node");
	const present = existsSync(launcher) && existsSync(bundledNodePath);
	let signature = { valid: false, detail: "not checked" };
	let bundledNode: HelperFacts["bundledNode"] = { error: "not checked" };
	if (present) {
		const verify = spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", layout.helperApp], {
			encoding: "utf8",
		});
		signature = { valid: verify.status === 0, detail: verify.status === 0 ? "valid" : processFailure(verify) };
		const version = spawnSync(bundledNodePath, ["--version"], { encoding: "utf8", timeout: SELF_CHECK_TIMEOUT_MS });
		bundledNode = version.status === 0 ? { version: version.stdout.trim() } : { error: processFailure(version) };
	}

	const serverPresent = existsSync(layout.server);
	const selfCheck = present && serverPresent ? runSelfCheck(layout) : undefined;

	const home = homeDirectory(env);
	return {
		macos: {
			version: commandOutput("/usr/bin/sw_vers", ["-productVersion"]) ?? "unknown",
			hardwareArch: architecture.hardwareArch,
		},
		node: {
			version: process.version,
			execPath: process.execPath,
			arch: architecture.nodeArch,
			translated: architecture.nodeTranslated,
		},
		natives,
		nativeInputs: readNativeInputs(layout.nativeDir),
		server: { path: layout.server, present: serverPresent },
		helper: {
			app: layout.helperApp,
			present,
			signature,
			bundledNode,
			inputs: present && layout.mode === "checkout" ? readHelperInputs(layout) : undefined,
		},
		selfCheck,
		stop: new StopSwitch().status(),
		config: readConfigFacts(layout, env),
		showPath: (path) => displayPath(path, home),
	};
}
