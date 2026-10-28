import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Layout } from "./layout.js";
import { DEFAULT_SETTINGS, saveSettings } from "./settings.js";

export interface SetupOptions {
	readonly yes?: boolean;
	readonly doctor: boolean;
}

export type SetupRunner = (file: string, args: readonly string[]) => string;

/** All child processes, including network and signing commands, have a hard deadline. */
function runner(layout: Layout): SetupRunner {
	return (file, args) => {
		const result = spawnSync(file, args, {
			encoding: "utf8",
			timeout: file === "/usr/bin/curl" ? 660_000 : 120_000,
			maxBuffer: 16 * 1024 * 1024,
			env: {
				...process.env,
				HOME: layout.home,
				APPLE_CUA_HOME: layout.appleCuaHome,
				APPLE_CUA_BIN_DIR: layout.binDir,
			},
		});
		if (result.status !== 0) {
			throw new Error(`${file} failed (exit ${result.status}): ${result.error?.message ?? result.stderr.trim()}`);
		}
		return result.stdout.trim();
	};
}

function bundleable(node: string, arch: string, run: SetupRunner): boolean {
	if (!existsSync(node)) {
		return false;
	}
	try {
		const dependencies = run("/usr/bin/otool", ["-L", node]);
		return (
			dependencies !== "" &&
			!/libnode|\/opt\/homebrew|\/usr\/local\/(?:opt|Cellar)/.test(dependencies) &&
			run(node, ["-p", "process.arch"]) === arch &&
			Number(run(node, ["-p", 'process.versions.node.split(".")[0]'])) >= 20
		);
	} catch {
		return false;
	}
}

function standaloneNode(layout: Layout, yes: boolean, arch: string, run: SetupRunner): string {
	const managed = join(layout.appleCuaHome, "node");
	const explicit = process.env["APPLE_CUA_NODE"];
	if (explicit !== undefined) {
		if (!bundleable(explicit, arch, run)) {
			throw new Error("APPLE_CUA_NODE must be a standalone Node 20+ for this Mac, not Homebrew's node.");
		}
		return explicit;
	}
	const candidates = [
		join(managed, "bin/node"),
		process.execPath,
		...(process.env["PATH"] ?? "")
			.split(":")
			.filter((directory) => directory !== "")
			.map((directory) => join(directory, "node")),
	];
	for (const candidate of candidates) {
		if (bundleable(candidate, arch, run)) {
			return candidate;
		}
	}
	if (!yes) {
		throw new Error("Standalone Node LTS download requires --yes; or set APPLE_CUA_NODE to a standalone Node.");
	}
	const curl = ["--fail", "--silent", "--show-error", "--location", "--connect-timeout", "10", "--max-time", "600"];
	const index = run("/usr/bin/curl", [...curl, "https://nodejs.org/dist/index.tab"]);
	const version = index
		.split("\n")
		.slice(1)
		.map((line) => line.split("\t"))
		.find(
			(columns) => columns[9] !== undefined && columns[9] !== "-" && columns[2]?.includes(`osx-${arch}-tar`),
		)?.[0];
	if (version === undefined || !/^v\d+\.\d+\.\d+$/.test(version)) {
		throw new Error(`No official Node LTS release found for darwin-${arch}.`);
	}
	const archive = `node-${version}-darwin-${arch}.tar.gz`;
	const base = `https://nodejs.org/dist/${version}`;
	const scratch = mkdtempSync(join(layout.appleCuaHome, "node-download-"));
	try {
		const tarball = join(scratch, archive);
		run("/usr/bin/curl", [...curl, "-o", tarball, `${base}/${archive}`]);
		const sums = run("/usr/bin/curl", [...curl, `${base}/SHASUMS256.txt`]);
		const expected = sums
			.split("\n")
			.map((line) => line.trim().split(/\s+/))
			.find((parts) => parts[1] === archive)?.[0];
		const actual = createHash("sha256").update(readFileSync(tarball)).digest("hex");
		if (expected !== actual) {
			throw new Error(`${archive} failed SHASUMS256 verification.`);
		}
		run("/usr/bin/tar", ["-xzf", tarball, "-C", scratch]);
		const extracted = join(scratch, `node-${version}-darwin-${arch}`);
		if (!bundleable(join(extracted, "bin/node"), arch, run)) {
			throw new Error("Downloaded Node is not a usable standalone runtime for this Mac.");
		}
		rmSync(managed, { recursive: true, force: true });
		renameSync(extracted, managed);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
	return join(managed, "bin/node");
}

/** Same identity and keychain logic as create-signing-identity.sh, without its unused OpenSSL 3 PKCS12 export. */
function signingIdentity(layout: Layout, run: SetupRunner): string {
	const signing = join(layout.appleCuaHome, "signing");
	mkdirSync(signing, { recursive: true, mode: 0o700 });
	const keychain = join(signing, "apple-cua-signing.keychain-db");
	const password = "apple-cua-local-signing";
	if (!existsSync(keychain)) {
		const key = join(signing, "signing.key");
		const certificate = join(signing, "signing.crt");
		try {
			run("/usr/bin/openssl", [
				"req",
				"-x509",
				"-newkey",
				"rsa:3072",
				"-nodes",
				"-days",
				"3650",
				"-subj",
				"/CN=apple-cua dev/O=apple-cua local",
				"-addext",
				"keyUsage=digitalSignature",
				"-addext",
				"extendedKeyUsage=codeSigning",
				"-keyout",
				key,
				"-out",
				certificate,
			]);
			run("/usr/bin/security", ["create-keychain", "-p", password, keychain]);
			run("/usr/bin/security", ["import", key, "-k", keychain, "-T", "/usr/bin/codesign", "-P", ""]);
			run("/usr/bin/security", ["import", certificate, "-k", keychain, "-T", "/usr/bin/codesign"]);
			run("/usr/bin/security", ["add-trusted-cert", "-r", "trustRoot", "-k", keychain, certificate]);
			run("/usr/bin/security", [
				"set-key-partition-list",
				"-S",
				"apple-tool:,apple:",
				"-s",
				"-k",
				password,
				keychain,
			]);
		} finally {
			rmSync(key, { force: true });
		}
	}
	run("/usr/bin/security", ["unlock-keychain", "-p", password, keychain]);
	const identities = run("/usr/bin/security", ["find-identity", "-p", "codesigning", "-v", keychain]);
	if (!identities.includes('"apple-cua dev"')) {
		throw new Error(`No usable per-machine signing identity in ${keychain}; setup cannot sign the helper.`);
	}
	return keychain;
}

function buildHelper(
	layout: Layout,
	node: string,
	resources: string,
	keychain: string,
	arch: string,
	run: SetupRunner,
): void {
	const contents = join(layout.helperApp, "Contents");
	const macos = join(contents, "MacOS");
	const target = join(contents, "Resources");
	mkdirSync(macos, { recursive: true });
	mkdirSync(target, { recursive: true });
	const bundledNode = join(target, "node");
	copyFileSync(node, bundledNode);
	chmodSync(bundledNode, 0o755);
	run("/usr/bin/cc", [
		"-O2",
		"-Wall",
		"-arch",
		arch === "arm64" ? "arm64" : "x86_64",
		"-mmacosx-version-min=15.0",
		"-o",
		layout.helperExecutable,
		join(resources, "tcc-helper-launcher.c"),
	]);
	const iconset = mkdtempSync(join(dirname(layout.helperApp), "icons-"));
	try {
		const folder = join(iconset, "appicon.iconset");
		mkdirSync(folder);
		const icon = join(dirname(layout.serverPackage), "assets/appicon.png");
		for (const size of [16, 32, 128, 256, 512]) {
			for (const scale of [1, 2]) {
				run("/usr/bin/sips", [
					"-z",
					String(size * scale),
					String(size * scale),
					icon,
					"--out",
					join(folder, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`),
				]);
			}
		}
		run("/usr/bin/iconutil", ["-c", "icns", folder, "-o", join(target, "appicon.icns")]);
	} finally {
		rmSync(iconset, { recursive: true, force: true });
	}
	const metadata: unknown = JSON.parse(readFileSync(layout.serverPackage, "utf8"));
	const version =
		typeof metadata === "object" && metadata !== null && "version" in metadata ? metadata.version : undefined;
	if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) {
		throw new Error("Installed MCP package has no valid version.");
	}
	const values = {
		CFBundleDevelopmentRegion: "en",
		CFBundleDisplayName: "apple-cua-mcp",
		CFBundleExecutable: "apple-cua-mcp",
		CFBundleIdentifier: "dev.applecua.mcp",
		CFBundleIconFile: "appicon",
		CFBundleInfoDictionaryVersion: "6.0",
		CFBundleName: "apple-cua-mcp",
		CFBundlePackageType: "APPL",
		CFBundleShortVersionString: version,
		CFBundleVersion: version,
		LSMinimumSystemVersion: "15.0",
		NSAppleEventsUsageDescription: "apple-cua drives the apps and the iPhone Mirroring window you approve.",
	};
	writeFileSync(
		join(contents, "Info.plist"),
		`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>${Object.entries(values)
			.map(([key, value]) => `<key>${key}</key><string>${value}</string>`)
			.join("")}</dict></plist>\n`,
	);
	for (const path of [bundledNode, layout.helperApp]) {
		run("/usr/bin/codesign", [
			"--force",
			"--keychain",
			keychain,
			"--sign",
			"apple-cua dev",
			"--identifier",
			"dev.applecua.mcp",
			path,
		]);
	}
	run("/usr/bin/codesign", ["--verify", "--deep", "--strict", layout.helperApp]);
	run("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", [
		"-f",
		layout.helperApp,
	]);
}

export function runSetup(layout: Layout, options: SetupOptions, run: SetupRunner = runner(layout)): number {
	try {
		if (layout.mode === "checkout") {
			const args = [
				layout.setupScript,
				...(options.yes === true ? ["--yes"] : []),
				...(!options.doctor ? ["--no-doctor"] : []),
			];
			process.stdout.write(`${run("/bin/bash", args)}\n`);
			return 0;
		}
		if (process.platform !== "darwin") {
			throw new Error("Installed setup requires macOS.");
		}
		mkdirSync(layout.appleCuaHome, { recursive: true });
		let arch = run("/usr/bin/uname", ["-m"]) === "arm64" ? "arm64" : "x64";
		try {
			if (run("/usr/sbin/sysctl", ["-n", "hw.optional.arm64"]) === "1") {
				arch = "arm64";
			}
		} catch {
			// Intel Macs do not expose hw.optional.arm64; uname already identified their CPU.
		}
		const node = standaloneNode(layout, options.yes === true, arch, run);
		const resources = join(dirname(layout.cli), "../resources");
		const keychain = signingIdentity(layout, run);
		buildHelper(layout, node, resources, keychain, arch, run);
		if (!existsSync(layout.configPath)) {
			saveSettings(layout.configPath, DEFAULT_SETTINGS);
		}
		process.stdout.write(`${run(process.execPath, [layout.cli, "config", "--apply"])}\n`);
		if (options.doctor) {
			process.stdout.write(`${run(process.execPath, [layout.cli, "--json", "doctor"])}\n`);
		}
		return 0;
	} catch (error) {
		process.stderr.write(`apple-cua setup: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}
