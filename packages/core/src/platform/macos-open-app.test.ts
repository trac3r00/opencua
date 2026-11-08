import { describe, expect, it } from "bun:test";

import type { AppInfo } from "../accessibility/types.js";
import { type AppLister, type AppOpenLauncher, openApplication, openArguments } from "./macos-open-app.js";

function app(name: string, bundleId: string, pid: number): AppInfo {
	return { name, bundleId, pid, isRunning: true };
}

class FakeLister {
	apps: AppInfo[] = [];
	onCall: ((call: number) => void) | undefined;
	listAppsCalls = 0;
	identityCalls = 0;

	async listApps(): Promise<AppInfo[]> {
		this.listAppsCalls += 1;
		this.onCall?.(this.identityCalls + this.listAppsCalls);
		return [...this.apps];
	}

	async listAppIdentities(): Promise<AppInfo[]> {
		this.identityCalls += 1;
		this.onCall?.(this.identityCalls);
		return [...this.apps];
	}
}

function recordingLauncher(): { readonly launcher: AppOpenLauncher; readonly targets: string[] } {
	const targets: string[] = [];
	return {
		targets,
		launcher: {
			async launch(target: string): Promise<void> {
				targets.push(target);
			},
		},
	};
}

describe("#given an app that is already running #when opened #then it is activated without waiting for it to appear", () => {
	it("activates by bundle id and answers immediately", async () => {
		const lister = new FakeLister();
		lister.apps = [app("Finder", "com.apple.finder", 1234)];
		const { launcher, targets } = recordingLauncher();

		const result = await openApplication(lister, "finder", { launcher: { ...launcher, background: false } });

		expect(result).toEqual({
			name: "Finder",
			bundleId: "com.apple.finder",
			pid: 1234,
			launched: false,
			activated: true,
		});
		expect(targets).toEqual(["com.apple.finder"]);
		expect(lister.identityCalls).toBe(1);
		expect(lister.listAppsCalls).toBe(0);
	});

	it("uses identity-only inventory when the lister supports it", async () => {
		const lister = new FakeLister();
		lister.apps = [app("Finder", "com.apple.finder", 1234)];

		await openApplication(lister, "Finder", {
			launcher: { ...recordingLauncher().launcher, background: true },
		});

		expect(lister.identityCalls).toBe(1);
		expect(lister.listAppsCalls).toBe(0);
	});

	it("falls back to enriched inventory when identity inventory is unavailable", async () => {
		const lister: AppLister = {
			listApps: async () => [app("Finder", "com.apple.finder", 1234)],
		};

		const result = await openApplication(lister, "Finder", {
			launcher: { ...recordingLauncher().launcher, background: true },
		});

		expect(result.pid).toBe(1234);
	});
});

describe("#given the default launcher #when launching an app #then it stays in the background", () => {
	it("builds background open arguments by default", () => {
		expect(openArguments("Finder")).toEqual(["-g", "-j", "-a", "Finder"]);
	});

	it("#given a background launcher #when opening a running app #then leaves its windows alone", async () => {
		const lister = new FakeLister();
		lister.apps = [app("Finder", "com.apple.finder", 1234)];
		const { launcher, targets } = recordingLauncher();

		await openApplication(lister, "Finder", { launcher: { ...launcher, background: true } });

		expect(targets).toEqual([]);
	});
});

describe("#given an app that is not running #when opening it makes it appear on a later poll #then the answer waits and reports the launch", () => {
	it("polls until the app shows up and answers with its pid", async () => {
		const lister = new FakeLister();
		lister.onCall = (call) => {
			if (call >= 2) {
				lister.apps = [app("Safari", "com.apple.Safari", 4321)];
			}
		};
		const { launcher, targets } = recordingLauncher();

		const result = await openApplication(lister, "Safari", { launcher, timeoutMs: 1_000, pollIntervalMs: 1 });

		expect(result).toEqual({
			name: "Safari",
			bundleId: "com.apple.Safari",
			pid: 4321,
			launched: true,
			activated: false,
		});
		expect(targets).toEqual(["Safari"]);
		expect(lister.identityCalls).toBeGreaterThanOrEqual(2);
	});
});

describe("#given a launch that never becomes observable #when the deadline passes #then the answer is a bounded, honest error", () => {
	it("stops polling and reports what was not seen", async () => {
		const lister = new FakeLister();
		const { launcher } = recordingLauncher();

		await expect(
			openApplication(lister, "Ghost App", { launcher, timeoutMs: 60, pollIntervalMs: 10 }),
		).rejects.toThrow(/Ghost App.*did not appear/);
	});
});

describe("#given a launcher that refuses #when opening #then the refusal surfaces and nothing is polled", () => {
	it("propagates the launcher error with the app still unobserved", async () => {
		const lister = new FakeLister();
		const launcher: AppOpenLauncher = {
			async launch(): Promise<void> {
				throw new Error('The application "No Such" can\'t be opened.');
			},
		};

		await expect(openApplication(lister, "No Such", { launcher, timeoutMs: 100 })).rejects.toThrow(/can't be opened/);
		expect(lister.identityCalls).toBe(1);
	});
});

describe("#given a bundle id and an app name #when the open arguments are built #then a bundle id goes to -b and a name to -a", () => {
	it("picks the flag that matches the target shape", () => {
		expect(openArguments("com.apple.Safari")).toEqual(["-g", "-j", "-b", "com.apple.Safari"]);
		expect(openArguments("Finder")).toEqual(["-g", "-j", "-a", "Finder"]);
		expect(openArguments("Visual Studio Code")).toEqual(["-g", "-j", "-a", "Visual Studio Code"]);
		expect(openArguments("Finder", true)).toEqual(["-g", "-j", "-a", "Finder"]);
		expect(openArguments("Finder", false)).toEqual(["-a", "Finder"]);
		expect(openArguments("com.apple.Safari", false)).toEqual(["-b", "com.apple.Safari"]);
	});
});

describe("#given a background open #when the opened app takes the foreground anyway #then the person's front app is put back", () => {
	function frontLauncher(restored: number[], result = true): AppOpenLauncher {
		return {
			background: true,
			async launch(): Promise<void> {},
			restoreFrontmost(pid: number): boolean {
				restored.push(pid);
				return result;
			},
		};
	}

	it("reactivates the previous front app when a launched app stole the foreground", async () => {
		const lister = new FakeLister();
		const editor = { ...app("Editor", "com.example.editor", 10), isFrontmost: true };
		lister.apps = [editor];
		lister.onCall = (call) => {
			if (call >= 2) {
				lister.apps = [
					{ ...editor, isFrontmost: false },
					{ ...app("Safari", "com.apple.Safari", 20), isFrontmost: true },
				];
			}
		};
		const restored: number[] = [];

		const result = await openApplication(lister, "Safari", { launcher: frontLauncher(restored), pollIntervalMs: 1 });

		expect(result.frontmostRestored).toBe(true);
		expect(restored).toEqual([10]);
	});

	it("leaves the foreground alone when the launched app stayed behind", async () => {
		const lister = new FakeLister();
		const editor = { ...app("Editor", "com.example.editor", 10), isFrontmost: true };
		lister.apps = [editor];
		lister.onCall = (call) => {
			if (call >= 2) {
				lister.apps = [editor, app("Safari", "com.apple.Safari", 20)];
			}
		};
		const restored: number[] = [];

		const result = await openApplication(lister, "Safari", { launcher: frontLauncher(restored), pollIntervalMs: 1 });

		expect(result.frontmostRestored).toBeUndefined();
		expect(restored).toEqual([]);
	});

	it("never restores for an attended open, which may bring the app forward on purpose", async () => {
		const lister = new FakeLister();
		lister.apps = [
			{ ...app("Editor", "com.example.editor", 10), isFrontmost: false },
			{ ...app("Safari", "com.apple.Safari", 20), isFrontmost: true },
		];
		const restored: number[] = [];

		const result = await openApplication(lister, "Safari", {
			launcher: { ...frontLauncher(restored), background: false },
		});

		expect(result.frontmostRestored).toBeUndefined();
		expect(restored).toEqual([]);
	});

	it("reports an honest false when the previous app refuses to come back", async () => {
		const lister = new FakeLister();
		const editor = { ...app("Editor", "com.example.editor", 10), isFrontmost: true };
		lister.apps = [editor];
		lister.onCall = (call) => {
			if (call >= 2) {
				lister.apps = [
					{ ...editor, isFrontmost: false },
					{ ...app("Safari", "com.apple.Safari", 20), isFrontmost: true },
				];
			}
		};
		const restored: number[] = [];

		const result = await openApplication(lister, "Safari", {
			launcher: frontLauncher(restored, false),
			pollIntervalMs: 1,
		});

		expect(result.frontmostRestored).toBe(false);
		expect(result.launched).toBe(true);
	});

	it("leaves the front app alone when the target was already running, because nothing was launched", async () => {
		const lister = new FakeLister();
		const editor = { ...app("Editor", "com.example.editor", 10), isFrontmost: true };
		lister.apps = [editor, app("Safari", "com.apple.Safari", 20)];
		lister.onCall = (call) => {
			if (call >= 2) {
				lister.apps = [
					{ ...editor, isFrontmost: false },
					{ ...app("Safari", "com.apple.Safari", 20), isFrontmost: true },
				];
			}
		};
		const restored: number[] = [];

		const result = await openApplication(lister, "Safari", { launcher: frontLauncher(restored) });

		expect(result.frontmostRestored).toBeUndefined();
		expect(restored).toEqual([]);
	});
});
