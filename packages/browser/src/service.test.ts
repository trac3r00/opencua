import { afterEach, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { createHash, createPublicKey } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { readConnection, writeConnection } from "./connection.js";
import {
	DEFAULT_PORT,
	EXTENSION_ID,
	NATIVE_HOST_NAME,
	SERVICE_LABEL,
	doctorBrowserService,
	initializeConnectionMetadata,
	installBrowserService,
	renderLaunchAgent,
	renderNativeHostLauncher,
	renderNativeHostManifest,
	uninstallBrowserService,
} from "./service.js";

const nativeManifestSchema = z
	.object({
		name: z.string(),
		description: z.string(),
		path: z.string(),
		type: z.literal("stdio"),
		allowed_origins: z.array(z.string()),
	})
	.strict();

describe("browser service artifacts", () => {
	const directories: string[] = [];

	afterEach(async () => {
		await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
	});

	it("#given the bundled public key #when deriving the unpacked extension identity #then matches default registration", async () => {
		const manifest = z
			.object({ key: z.string() })
			.parse(JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8")));
		const publicKey = Buffer.from(manifest.key, "base64");
		expect(createPublicKey({ key: publicKey, format: "der", type: "spki" }).type).toBe("public");
		const extensionId = createHash("sha256")
			.update(publicKey)
			.digest("hex")
			.slice(0, 32)
			.replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)));

		expect(extensionId).toBe(EXTENSION_ID);
	});

	it("#given a relative state directory #when installing #then all persisted state references are absolute", async () => {
		const homeDirectory = await mkdtemp(join(tmpdir(), "browser-relative-state-"));
		directories.push(homeDirectory);
		const stateDirectory = join(homeDirectory, "state");
		const paths = await installBrowserService({
			extensionId: EXTENSION_ID,
			homeDirectory,
			systemApplicationsDirectory: join(homeDirectory, "SystemApplications"),
			packageRoot: join(homeDirectory, "package"),
			platform: "darwin",
			stateDirectory: relative(process.cwd(), stateDirectory),
			isPortListening: async () => false,
			launchctl: async (args) => ({ code: args[0] === "print" ? 113 : 0, stderr: "" }),
		});

		expect(paths.stateDirectory).toBe(stateDirectory);
		expect(paths.nativeHostLauncher).toBe(join(stateDirectory, "browser-native-host"));
		expect(await readFile(paths.launchAgent, "utf8")).toContain(`<string>${stateDirectory}</string>`);
		expect(await readFile(paths.nativeHostLauncher, "utf8")).toContain(`OPENCUA_STATE_DIR='${stateDirectory}'`);
		const registration = nativeManifestSchema.parse(JSON.parse(await readFile(paths.nativeHostManifest, "utf8")));
		expect(registration.path).toBe(paths.nativeHostLauncher);
		expect(await readConnection(stateDirectory)).toMatchObject({ port: DEFAULT_PORT });
	});

	it.each(["none", "all", "mixed"])(
		"#given %s existing artifacts #when bootstrap fails #then removes new files and restores existing bytes and modes",
		async (existing) => {
			const homeDirectory = await mkdtemp(join(tmpdir(), "browser-bootstrap-rollback-"));
			directories.push(homeDirectory);
			const stateDirectory = join(homeDirectory, "state");
			const artifacts = [
				join(homeDirectory, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`),
				join(stateDirectory, "browser-native-host"),
				join(
					homeDirectory,
					"Library",
					"Application Support",
					"BraveSoftware",
					"Brave-Browser",
					"NativeMessagingHosts",
					`${NATIVE_HOST_NAME}.json`,
				),
			];
			const preserved = existing === "all" ? artifacts : existing === "mixed" ? artifacts.slice(0, 1) : [];
			for (const path of preserved) {
				await mkdir(dirname(path), { recursive: true });
				await writeFile(path, `existing:${path}`);
				await chmod(path, 0o640);
			}
			await mkdir(stateDirectory, { recursive: true });
			const unrelated = join(stateDirectory, "unrelated");
			await writeFile(unrelated, "keep");
			await expect(
				installBrowserService({
					homeDirectory,
					systemApplicationsDirectory: join(homeDirectory, "SystemApplications"),
					packageRoot: join(homeDirectory, "package"),
					stateDirectory,
					platform: "darwin",
					isPortListening: async () => false,
					launchctl: async (args) => ({ code: args[0] === "print" ? 113 : 5, stderr: "bootstrap failed" }),
				}),
			).rejects.toThrow();

			for (const path of artifacts) {
				if (preserved.includes(path)) {
					expect(await readFile(path, "utf8")).toBe(`existing:${path}`);
					expect((await stat(path)).mode & 0o777).toBe(0o640);
				} else {
					await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
				}
			}
			expect(await readFile(unrelated, "utf8")).toBe("keep");
		},
	);

	it("#given installed service artifacts #when uninstalling #then removes the launcher but preserves connection and logs", async () => {
		const homeDirectory = await mkdtemp(join(tmpdir(), "browser-uninstall-"));
		directories.push(homeDirectory);
		const options = {
			homeDirectory,
			systemApplicationsDirectory: join(homeDirectory, "SystemApplications"),
			packageRoot: join(homeDirectory, "package"),
			stateDirectory: join(homeDirectory, "state"),
			platform: "darwin",
			isPortListening: async () => false,
			launchctl: async (args: readonly string[]) => ({ code: args[0] === "print" ? 113 : 0, stderr: "" }),
		} satisfies Parameters<typeof installBrowserService>[0];
		const paths = await installBrowserService(options);
		const connection = await readConnection(options.stateDirectory);
		await writeFile(paths.stdoutLog, "existing log");

		await uninstallBrowserService(options);

		for (const path of [paths.launchAgent, paths.nativeHostManifest, paths.nativeHostLauncher]) {
			await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
		}
		expect(await readConnection(options.stateDirectory)).toEqual(connection);
		expect(await readFile(paths.stdoutLog, "utf8")).toBe("existing log");
		expect(await readFile(paths.stderrLog, "utf8")).toBe("");
	});

	it("#given a registration without its launcher #when doctor runs #then reports installation incomplete", async () => {
		const homeDirectory = await mkdtemp(join(tmpdir(), "browser-doctor-"));
		directories.push(homeDirectory);
		const options = {
			homeDirectory,
			systemApplicationsDirectory: join(homeDirectory, "SystemApplications"),
			packageRoot: join(homeDirectory, "package"),
			stateDirectory: join(homeDirectory, "state"),
			platform: "darwin",
			isPortListening: async () => false,
			launchctl: async (args: readonly string[]) => ({ code: args[0] === "print" ? 113 : 0, stderr: "" }),
		} satisfies Parameters<typeof installBrowserService>[0];
		const paths = await installBrowserService(options);
		expect((await doctorBrowserService(options)).installed).toBe(true);
		await rm(paths.nativeHostLauncher);

		const result = await doctorBrowserService(options);

		expect(result.installed).toBe(false);
		expect(result.connectionReady).toBe(true);
	});

	it("#given a directory at the native manifest path #when doctor runs #then reports installation incomplete", async () => {
		const homeDirectory = await mkdtemp(join(tmpdir(), "browser-doctor-directory-"));
		directories.push(homeDirectory);
		const options = {
			homeDirectory,
			systemApplicationsDirectory: join(homeDirectory, "SystemApplications"),
			packageRoot: join(homeDirectory, "package"),
			stateDirectory: join(homeDirectory, "state"),
			platform: "darwin",
			isPortListening: async () => false,
			launchctl: async (args: readonly string[]) => ({ code: args[0] === "print" ? 113 : 0, stderr: "" }),
		} satisfies Parameters<typeof installBrowserService>[0];
		const paths = await installBrowserService(options);
		expect((await doctorBrowserService(options)).installed).toBe(true);
		await rm(paths.nativeHostManifest);
		await mkdir(paths.nativeHostManifest);

		const result = await doctorBrowserService(options);

		expect(result.installed).toBe(false);
	});

	it("#given an empty state directory #when initializing service metadata #then persists a private reusable key", async () => {
		const stateDirectory = await mkdtemp(join(tmpdir(), "browser-service-"));
		directories.push(stateDirectory);

		const first = await initializeConnectionMetadata(stateDirectory);
		const second = await initializeConnectionMetadata(stateDirectory);

		expect(first.port).toBe(DEFAULT_PORT);
		expect(first.token).toMatch(/^[0-9a-f]{64}$/);
		expect(second).toEqual(first);
		expect(await readConnection(stateDirectory)).toEqual(first);
		expect((await stat(join(stateDirectory, "browser-connection.json"))).mode & 0o777).toBe(0o600);
	});

	it("#given absolute runtime paths #when rendering LaunchAgent #then configures persistent direct Node startup", () => {
		const paths = {
			launchAgent: "/tmp/home/Library/LaunchAgents/service.plist",
			nativeHostManifest: "/tmp/home/Library/Application Support/Brave/host.json",
			nativeHostManifests: ["/tmp/home/Library/Application Support/Brave/host.json"],
			nativeHostProgram: "/tmp/package/dist/native-host.js",
			nativeHostLauncher: "/tmp/home/state/browser-native-host",
			stateDirectory: "/tmp/home/state",
			cliProgram: "/tmp/package/dist/cli.js",
			logDirectory: "/tmp/home/Library/Logs/Browser-Skill-OmO",
			stdoutLog: "/tmp/home/Library/Logs/Browser-Skill-OmO/stdout.log",
			stderrLog: "/tmp/home/Library/Logs/Browser-Skill-OmO/stderr.log",
		};
		const plist = renderLaunchAgent(paths, "/opt/node/bin/node");

		expect(plist).toContain(`<string>${SERVICE_LABEL}</string>`);
		expect(plist).toContain("<string>/opt/node/bin/node</string>");
		expect(plist).toContain("<string>/tmp/package/dist/cli.js</string>");
		expect(plist).toContain("<string>serve</string>");
		expect(plist).toContain("<key>RunAtLoad</key>\n\t<true/>");
		expect(plist).toContain("<key>KeepAlive</key>\n\t<true/>");
		expect(plist).toContain(paths.stdoutLog);
		expect(plist).toContain(paths.stderrLog);
	});

	it("#given an unused browser port #when installing #then registers native messaging before bootstrapping the agent", async () => {
		const homeDirectory = await mkdtemp(join(tmpdir(), "browser-service-install-"));
		directories.push(homeDirectory);
		const packageRoot = join(homeDirectory, "package");
		const stateDirectory = join(homeDirectory, "state");
		const manifestPath = join(
			homeDirectory,
			"Library",
			"Application Support",
			"BraveSoftware",
			"Brave-Browser",
			"NativeMessagingHosts",
			`${NATIVE_HOST_NAME}.json`,
		);
		const calls: string[][] = [];
		const launchctl = async (arguments_: readonly string[]) => {
			calls.push([...arguments_]);
			if (arguments_[0] === "bootstrap") {
				const registration = await readFile(manifestPath, "utf8");
				expect(registration).toContain(`chrome-extension://${EXTENSION_ID}/`);
				return { code: 0, stderr: "" };
			}
			return { code: 113, stderr: "" };
		};

		const paths = await installBrowserService({
			homeDirectory,
			systemApplicationsDirectory: join(homeDirectory, "SystemApplications"),
			packageRoot,
			nodePath: "/opt/node/bin/node",
			platform: "darwin",
			uid: 501,
			stateDirectory,
			extensionId: EXTENSION_ID,
			isPortListening: async () => false,
			launchctl,
		});

		expect(calls).toEqual([
			["print", `gui/501/${SERVICE_LABEL}`],
			["bootstrap", "gui/501", paths.launchAgent],
		]);
		expect((await stat(paths.stdoutLog)).mode & 0o777).toBe(0o600);
		expect((await stat(paths.stderrLog)).mode & 0o777).toBe(0o600);
		expect((await stat(paths.logDirectory)).mode & 0o777).toBe(0o700);
		expect((await stat(paths.nativeHostLauncher)).mode & 0o777).toBe(0o700);
		expect(await readConnection(stateDirectory)).toMatchObject({ port: DEFAULT_PORT });
	});

	it("#given Chrome and Edge support directories #when installing #then registers the manifest only in those browsers", async () => {
		const homeDirectory = await mkdtemp(join(tmpdir(), "browser-multi-host-"));
		directories.push(homeDirectory);
		const support = join(homeDirectory, "Library", "Application Support");
		await mkdir(join(support, "Google", "Chrome"), { recursive: true });
		await mkdir(join(support, "Microsoft Edge"), { recursive: true });
		const paths = await installBrowserService({
			homeDirectory,
			systemApplicationsDirectory: join(homeDirectory, "SystemApplications"),
			packageRoot: join(homeDirectory, "package"),
			stateDirectory: join(homeDirectory, "state"),
			platform: "darwin",
			isPortListening: async () => false,
			launchctl: async (args) => ({ code: args[0] === "print" ? 113 : 0, stderr: "" }),
		});

		for (const browser of ["Google/Chrome", "Microsoft Edge"]) {
			const manifest = join(support, browser, "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`);
			expect(nativeManifestSchema.parse(JSON.parse(await readFile(manifest, "utf8"))).path).toBe(
				paths.nativeHostLauncher,
			);
		}
		const otherBrowsers = [
			"BraveSoftware/Brave-Browser",
			"Google/Chrome Beta",
			"Google/Chrome Canary",
			"Chromium",
			"Arc/User Data",
			"Vivaldi",
		];
		for (const browser of otherBrowsers) {
			const manifest = join(support, browser, "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`);
			await expect(stat(manifest)).rejects.toMatchObject({ code: "ENOENT" });
		}
	});

	it("#given no browser support directories #when installing #then falls back to the Brave manifest path", async () => {
		const homeDirectory = await mkdtemp(join(tmpdir(), "browser-brave-fallback-"));
		directories.push(homeDirectory);
		const paths = await installBrowserService({
			homeDirectory,
			systemApplicationsDirectory: join(homeDirectory, "SystemApplications"),
			packageRoot: join(homeDirectory, "package"),
			stateDirectory: join(homeDirectory, "state"),
			platform: "darwin",
			isPortListening: async () => false,
			launchctl: async (args) => ({ code: args[0] === "print" ? 113 : 0, stderr: "" }),
		});

		expect(paths.nativeHostManifest).toContain(join("BraveSoftware", "Brave-Browser", "NativeMessagingHosts"));
		const registration = nativeManifestSchema.parse(JSON.parse(await readFile(paths.nativeHostManifest, "utf8")));
		expect(registration.path).toBe(paths.nativeHostLauncher);
	});

	it("#given the Google Chrome app bundle and no support directory #when installing #then writes the Chrome manifest", async () => {
		const homeDirectory = await mkdtemp(join(tmpdir(), "browser-app-bundle-"));
		directories.push(homeDirectory);
		const systemApplications = join(homeDirectory, "SystemApplications");
		await mkdir(join(systemApplications, "Google Chrome.app"), { recursive: true });
		const support = join(homeDirectory, "Library", "Application Support");
		const paths = await installBrowserService({
			homeDirectory,
			systemApplicationsDirectory: systemApplications,
			packageRoot: join(homeDirectory, "package"),
			stateDirectory: join(homeDirectory, "state"),
			platform: "darwin",
			isPortListening: async () => false,
			launchctl: async (args) => ({ code: args[0] === "print" ? 113 : 0, stderr: "" }),
		});

		const chromeManifest = join(support, "Google", "Chrome", "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`);
		expect(nativeManifestSchema.parse(JSON.parse(await readFile(chromeManifest, "utf8"))).path).toBe(
			paths.nativeHostLauncher,
		);
		expect(paths.nativeHostManifest).toBe(chromeManifest);
		const braveManifest = join(support, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts");
		await expect(stat(braveManifest)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("#given manifests registered in several browsers #when uninstalling #then removes every registered manifest", async () => {
		const homeDirectory = await mkdtemp(join(tmpdir(), "browser-multi-uninstall-"));
		directories.push(homeDirectory);
		const support = join(homeDirectory, "Library", "Application Support");
		await mkdir(join(support, "Google", "Chrome"), { recursive: true });
		await mkdir(join(support, "Chromium"), { recursive: true });
		const options = {
			homeDirectory,
			systemApplicationsDirectory: join(homeDirectory, "SystemApplications"),
			packageRoot: join(homeDirectory, "package"),
			stateDirectory: join(homeDirectory, "state"),
			platform: "darwin",
			isPortListening: async () => false,
			launchctl: async (args: readonly string[]) => ({ code: args[0] === "print" ? 113 : 0, stderr: "" }),
		} satisfies Parameters<typeof installBrowserService>[0];
		const paths = await installBrowserService(options);
		const chromeManifest = join(support, "Google", "Chrome", "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`);
		const chromiumManifest = join(support, "Chromium", "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`);
		expect((await stat(chromeManifest)).isFile()).toBe(true);
		expect((await stat(chromiumManifest)).isFile()).toBe(true);
		expect((await doctorBrowserService(options)).installed).toBe(true);

		await uninstallBrowserService(options);

		for (const manifest of paths.nativeHostManifests) {
			await expect(stat(manifest)).rejects.toMatchObject({ code: "ENOENT" });
		}
		expect((await doctorBrowserService(options)).installed).toBe(false);
	});

	it("#given a port owned by an existing stdio daemon #when installing #then refuses to bootstrap a duplicate", async () => {
		const homeDirectory = await mkdtemp(join(tmpdir(), "browser-service-conflict-"));
		directories.push(homeDirectory);
		const calls: string[][] = [];
		const launchctl = async (arguments_: readonly string[]) => {
			calls.push([...arguments_]);
			return { code: 113, stderr: "" };
		};

		await expect(
			installBrowserService({
				homeDirectory,
				systemApplicationsDirectory: join(homeDirectory, "SystemApplications"),
				packageRoot: join(homeDirectory, "package"),
				platform: "darwin",
				uid: 501,
				stateDirectory: join(homeDirectory, "state"),
				isPortListening: async () => true,
				launchctl,
			}),
		).rejects.toThrow();

		expect(calls).toEqual([["print", `gui/501/${SERVICE_LABEL}`]]);
	});

	it("#given the Brave extension registration #when rendering the native host manifest #then restricts it to the expected extension", () => {
		const paths = {
			launchAgent: "/tmp/home/agent.plist",
			nativeHostManifest: "/tmp/home/host.json",
			nativeHostManifests: ["/tmp/home/host.json"],
			nativeHostProgram: "/tmp/package/dist/native-host.js",
			nativeHostLauncher: "/tmp/home/state/browser-native-host",
			stateDirectory: "/tmp/home/state",
			cliProgram: "/tmp/package/dist/cli.js",
			logDirectory: "/tmp/home/logs",
			stdoutLog: "/tmp/home/logs/stdout.log",
			stderrLog: "/tmp/home/logs/stderr.log",
		};
		const manifest = nativeManifestSchema.parse(JSON.parse(renderNativeHostManifest(paths)));

		expect(manifest.name).toBe(NATIVE_HOST_NAME);
		expect(manifest.description.length).toBeGreaterThan(0);
		expect(manifest.path).toBe(paths.nativeHostLauncher);
		expect(manifest.type).toBe("stdio");
		expect(manifest.allowed_origins).toEqual([`chrome-extension://${EXTENSION_ID}/`]);
	});

	it("#given existing custom connection metadata #when initializing #then preserves port and key", async () => {
		const stateDirectory = await mkdtemp(join(tmpdir(), "browser-service-existing-"));
		directories.push(stateDirectory);
		const connection = { port: 48999, token: "a".repeat(64) };
		await writeConnection(connection, stateDirectory);
		expect(await initializeConnectionMetadata(stateDirectory)).toEqual(connection);
	});

	it.each([EXTENSION_ID, "p".repeat(32)])(
		"#given a native launcher for %s with spaced paths #when Chrome supplies origin #then forwards origin and private state",
		async (extensionId) => {
			const homeDirectory = await mkdtemp(join(tmpdir(), "browser host's state-"));
			directories.push(homeDirectory);
			const hostProgram = join(homeDirectory, "native host.js");
			const paths = {
				launchAgent: join(homeDirectory, "agent.plist"),
				nativeHostManifest: join(homeDirectory, "manifest.json"),
				nativeHostManifests: [join(homeDirectory, "manifest.json")],
				nativeHostProgram: hostProgram,
				nativeHostLauncher: join(homeDirectory, "launcher"),
				stateDirectory: join(homeDirectory, "state"),
				cliProgram: join(homeDirectory, "cli.js"),
				logDirectory: homeDirectory,
				stdoutLog: join(homeDirectory, "stdout"),
				stderrLog: join(homeDirectory, "stderr"),
			};
			await mkdir(paths.stateDirectory);
			await writeFile(
				hostProgram,
				"process.stdout.write(JSON.stringify({origin:process.argv[2],state:process.env.OPENCUA_STATE_DIR,extensionId:process.env.OPENCUA_BROWSER_EXTENSION_ID}));",
			);
			await writeFile(paths.nativeHostLauncher, renderNativeHostLauncher(paths, process.execPath, extensionId));
			await chmod(paths.nativeHostLauncher, 0o700);
			const origin = `chrome-extension://${extensionId}/`;
			const result = await promisify(execFile)(paths.nativeHostLauncher, [origin], { timeout: 3000 });
			const parsed = z
				.object({ origin: z.string(), state: z.string(), extensionId: z.string() })
				.parse(JSON.parse(result.stdout));
			expect(parsed).toEqual({ origin, state: paths.stateDirectory, extensionId });
			const manifest = nativeManifestSchema.parse(JSON.parse(renderNativeHostManifest(paths, extensionId)));
			expect(manifest.allowed_origins).toEqual([origin]);
		},
	);
});
