import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Layout, resolveLayout } from "./layout.js";
import { type SetupRunner, runSetup } from "./setup.js";

let root = "";
let layout: Layout;
let node = "";
let calls: { file: string; args: readonly string[] }[] = [];

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "apple-cua-setup-")));
	const cli = join(root, "cli/dist/cli.js");
	const resources = join(root, "cli/resources");
	mkdirSync(resources, { recursive: true });
	writeFileSync(join(resources, "tcc-helper-launcher.c"), "fixture");
	layout = {
		...resolveLayout({ HOME: root }, root, (name) =>
			join(root, name === "@apple-cua/core" ? "core/dist/index.js" : "mcp/dist/server.js"),
		),
		cli,
	};
	mkdirSync(dirname(layout.serverPackage), { recursive: true });
	writeFileSync(layout.serverPackage, '{"version":"0.1.0"}');
	node = join(root, "node");
	writeFileSync(node, "node fixture");
	vi.stubEnv("APPLE_CUA_NODE", node);
	vi.spyOn(process.stdout, "write").mockReturnValue(true);
	vi.spyOn(process.stderr, "write").mockReturnValue(true);
	calls = [];
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

const run: SetupRunner = (file, args) => {
	calls.push({ file, args });
	if (file === node) {
		return args[1] === "process.arch" ? "arm64" : "22";
	}
	if (file.endsWith("/otool")) {
		return "/usr/lib/libSystem.B.dylib";
	}
	if (file.endsWith("/uname")) {
		return "arm64";
	}
	if (file.endsWith("/security") && args[0] === "create-keychain") {
		writeFileSync(join(layout.appleCuaHome, "signing/apple-cua-signing.keychain-db"), "identity fixture");
	}
	return file.endsWith("/security") ? '1) fingerprint "apple-cua dev"' : "";
};

describe("#given installed setup #when run twice #then one identity signs both builds before config and doctor", () => {
	it("reuses the keychain, writes a real plist and forwards the requested closing doctor", () => {
		expect(runSetup(layout, { yes: true, doctor: false }, run)).toBe(0);
		expect(runSetup(layout, { yes: true, doctor: true }, run)).toBe(0);
		expect(
			calls.filter((call) => call.file.endsWith("/security") && call.args[0] === "create-keychain"),
		).toHaveLength(1);
		const signatures = calls.filter((call) => call.file.endsWith("/codesign") && call.args.includes("--sign"));
		expect(signatures).toHaveLength(4);
		expect(
			signatures.every((call) =>
				call.args.includes(join(layout.appleCuaHome, "signing/apple-cua-signing.keychain-db")),
			),
		).toBe(true);
		expect(calls.filter((call) => call.args[0] === layout.cli).map((call) => call.args.slice(1))).toEqual([
			["config", "--apply"],
			["config", "--apply"],
			["--json", "doctor"],
		]);
		expect(readFileSync(join(layout.helperApp, "Contents/Info.plist"), "utf8")).toContain(
			"<string>dev.applecua.mcp</string>",
		);
		expect(readdirSync(join(layout.appleCuaHome, "signing"))).toEqual(["apple-cua-signing.keychain-db"]);
		expect(readdirSync(dirname(layout.helperApp))).toEqual(["apple-cua-mcp.app"]);
	});
});

describe("#given a signing failure #when setup runs #then config and doctor never claim success", () => {
	it("cleans loose private material and returns failure without configuring clients", () => {
		const failing: SetupRunner = (file, args) => {
			if (file.endsWith("/openssl")) {
				writeFileSync(join(layout.appleCuaHome, "signing/signing.key"), "private fixture");
				throw new Error("security: interaction is not allowed");
			}
			return run(file, args);
		};
		expect(runSetup(layout, { yes: true, doctor: true }, failing)).toBe(1);
		expect(calls.some((call) => call.args[0] === layout.cli)).toBe(false);
		expect(readdirSync(join(layout.appleCuaHome, "signing"))).toEqual([]);
	});
});

describe("#given a corrupt Node download #when checksums disagree #then nothing is extracted or signed", () => {
	it("rejects the tarball and removes download scratch files", () => {
		vi.stubEnv("APPLE_CUA_NODE", undefined);
		const downloading: SetupRunner = (file, args) => {
			calls.push({ file, args });
			if (file.endsWith("/uname")) {
				return "arm64";
			}
			if (file.endsWith("/otool")) {
				return "/opt/homebrew/lib/libnode.dylib";
			}
			if (file.endsWith("/curl")) {
				const url = args.at(-1) ?? "";
				if (url.endsWith("index.tab")) {
					return "header\nv22.23.2\tdate\tosx-arm64-tar\tx\tx\tx\tx\tx\tx\tJod";
				}
				if (url.endsWith("SHASUMS256.txt")) {
					return `${"0".repeat(64)}  node-v22.23.2-darwin-arm64.tar.gz`;
				}
				const target = args[args.indexOf("-o") + 1];
				if (target === undefined) {
					throw new Error("missing download destination");
				}
				writeFileSync(target, "corrupt archive");
			}
			return "";
		};
		expect(runSetup(layout, { yes: true, doctor: false }, downloading)).toBe(1);
		expect(calls.some((call) => call.file.endsWith("/tar") || call.file.endsWith("/security"))).toBe(false);
		expect(readdirSync(layout.appleCuaHome)).toEqual([]);
	});
});
import { createHash } from "node:crypto";

describe("#given no standalone Node #when the official checksum matches #then setup installs and bundles that runtime", () => {
	it("checks the archive before extraction and removes the download directory", () => {
		vi.stubEnv("APPLE_CUA_NODE", undefined);
		const archive = "verified archive fixture";
		const version = "v22.23.2";
		const filename = `node-${version}-darwin-arm64.tar.gz`;
		const downloading: SetupRunner = (file, args) => {
			if (file.endsWith("/otool")) {
				const candidate = args[1] ?? "";
				calls.push({ file, args });
				return candidate.startsWith(layout.appleCuaHome)
					? "/usr/lib/libSystem.B.dylib"
					: "/opt/homebrew/lib/libnode.dylib";
			}
			if (file.startsWith(layout.appleCuaHome) && file.endsWith("/bin/node")) {
				return args[1] === "process.arch" ? "arm64" : "22";
			}
			if (file.endsWith("/curl")) {
				calls.push({ file, args });
				const url = args.at(-1) ?? "";
				if (url.endsWith("index.tab")) {
					return `header\n${version}\tdate\tosx-arm64-tar\tx\tx\tx\tx\tx\tx\tJod`;
				}
				if (url.endsWith("SHASUMS256.txt")) {
					return `${createHash("sha256").update(archive).digest("hex")}  ${filename}`;
				}
				const destination = args[args.indexOf("-o") + 1];
				if (destination === undefined) {
					throw new Error("missing archive path");
				}
				writeFileSync(destination, archive);
				return "";
			}
			if (file.endsWith("/tar")) {
				calls.push({ file, args });
				const destination = args.at(-1);
				if (destination === undefined) {
					throw new Error("missing extraction path");
				}
				const directory = join(destination, `node-${version}-darwin-arm64/bin`);
				mkdirSync(directory, { recursive: true });
				writeFileSync(join(directory, "node"), "verified runtime fixture");
				return "";
			}
			return run(file, args);
		};
		expect(runSetup(layout, { yes: true, doctor: false }, downloading)).toBe(0);
		expect(readFileSync(join(layout.helperApp, "Contents/Resources/node"), "utf8")).toBe("verified runtime fixture");
		expect(calls.findIndex((call) => call.args.at(-1)?.endsWith("SHASUMS256.txt"))).toBeLessThan(
			calls.findIndex((call) => call.file.endsWith("/tar")),
		);
		expect(readdirSync(layout.appleCuaHome).some((name) => name.startsWith("node-download-"))).toBe(false);
	});
});

describe("#given a checkout #when CLI setup runs #then it delegates the original setup script and flags", () => {
	it("leaves the checkout setup flow in charge", () => {
		const checkout = { ...layout, mode: "checkout" as const };
		expect(runSetup(checkout, { yes: true, doctor: false }, run)).toBe(0);
		expect(calls).toEqual([{ file: "/bin/bash", args: [layout.setupScript, "--yes", "--no-doctor"] }]);
	});
});
