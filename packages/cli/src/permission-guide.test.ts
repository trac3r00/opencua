import { describe, expect, it } from "bun:test";
import type { AutomationStatus } from "@opencua/core";
import { PRIVACY_PANES } from "./doctor.js";
import type { DragPanelLauncher } from "./permission-drag.js";
import { type GrantDependencies, type HelperPermissions, grantPermissions } from "./permission-guide.js";

interface FakeMac {
	state: {
		accessibility: boolean;
		screenRecording: boolean;
		inputMonitoring?: boolean;
		automation: Record<string, AutomationStatus>;
	};
	/** What the person does when a dialog or pane shows up for a kind. */
	readonly onRequest: Record<string, () => void>;
	/** Whether the person switches it on while the guide waits, per wait. */
	readonly switchesOn: boolean[];
}

/** A drag panel launcher that records what it shows; `available: false` acts as a missing native binary. */
function fakeDragPanel(calls: string[], available: boolean): DragPanelLauncher {
	return {
		show: (app) => {
			if (!available) {
				return undefined;
			}
			calls.push(`show panel ${app}`);
			return {
				close: () => {
					calls.push("close panel");
				},
			};
		},
		reveal: (app) => {
			calls.push(`reveal ${app}`);
		},
	};
}

function fake(mac: FakeMac) {
	const calls: string[] = [];
	const printed: string[] = [];
	const read = (): HelperPermissions => ({ ...mac.state, automation: { ...mac.state.automation } });
	const deps: GrantDependencies = {
		read,
		request: (kinds) => {
			calls.push(`request ${kinds.join(",")}`);
			for (const kind of kinds) {
				mac.onRequest[kind]?.();
			}
			const automation = Object.fromEntries(
				kinds
					.filter((kind) => kind.startsWith("automation"))
					.map((kind) => {
						const bundleId = kind.slice(kind.indexOf(":") + 1);
						return [bundleId, mac.state.automation[bundleId] ?? "not-running"];
					}),
			);
			return { accessibility: mac.state.accessibility, screenRecording: mac.state.screenRecording, automation };
		},
		openUrl: async (url) => {
			calls.push(`open ${url}`);
			return true;
		},
		waitFor: async (granted) => {
			calls.push("wait");
			if (mac.switchesOn.shift() === true) {
				mac.onRequest["switch-on"]?.();
			}
			return granted();
		},
		print: (text) => {
			printed.push(text);
		},
	};
	return { deps, calls, printed: () => printed.join("\n") };
}

describe("#given a fresh helper with nothing granted #when a person runs the guide #then each macOS dialog is shown and the guide waits for the switch", () => {
	it("asks Accessibility, then Screen Recording, then each Automation target, and reports what is granted", async () => {
		let pending: "accessibility" | "screenRecording" | undefined;
		const mac: FakeMac = {
			state: {
				accessibility: false,
				screenRecording: false,
				automation: { "com.apple.systemevents": "not-determined", "com.apple.finder": "denied" },
			},
			onRequest: {
				accessibility: () => {
					pending = "accessibility";
				},
				"screen-recording": () => {
					pending = "screenRecording";
				},
				"automation:com.apple.systemevents": () => {
					mac.state.automation["com.apple.systemevents"] = "granted";
				},
				"switch-on": () => {
					if (pending !== undefined) {
						mac.state[pending] = true;
						pending = undefined;
					} else {
						mac.state.automation["com.apple.finder"] = "granted";
					}
				},
			},
			switchesOn: [true, true, true],
		};
		const { deps, calls, printed } = fake(mac);

		const outcome = await grantPermissions(
			{ mode: "terminal", openPanes: true, extraAutomationTargets: ["com.apple.Safari"] },
			deps,
		);

		expect(calls).toEqual([
			"request accessibility",
			`open ${PRIVACY_PANES.accessibility}`,
			"wait",
			"request screen-recording",
			`open ${PRIVACY_PANES.screenRecording}`,
			"wait",
			"request automation:com.apple.systemevents",
			"request automation:com.apple.finder",
			`open ${PRIVACY_PANES.automation}`,
			"wait",
			"request automation-status:com.apple.finder",
			"request automation:com.apple.safari",
		]);
		expect(outcome).toEqual({
			granted: ["Accessibility", "Screen Recording", "Automation of System Events", "Automation of Finder"],
			missing: [],
			notAsked: ["Automation of Safari"],
		});
		expect(printed()).toContain("Restart your MCP clients");
	});

	it("records a skipped grant as missing and points at the command that finishes it", async () => {
		const mac: FakeMac = {
			state: { accessibility: true, screenRecording: false, automation: {} },
			onRequest: {},
			switchesOn: [false],
		};
		const { deps, printed } = fake(mac);

		const outcome = await grantPermissions({ mode: "terminal", openPanes: false, extraAutomationTargets: [] }, deps);

		expect(outcome.missing).toEqual(["Screen Recording"]);
		expect(printed()).toContain(`open "${PRIVACY_PANES.screenRecording}"`);
		expect(printed()).toContain("opencua permissions grant");
		expect(printed()).toContain("tccutil reset ScreenCapture dev.opencua.mcp");
	});
});

describe("#given an Automation dialog closed without an answer #when the guide asks #then it neither waits nor asks again", () => {
	it("reports the app as missing and points at the command that asks again", async () => {
		const mac: FakeMac = {
			state: {
				accessibility: true,
				screenRecording: true,
				automation: { "com.apple.systemevents": "not-determined" },
			},
			onRequest: {},
			switchesOn: [],
		};
		const { deps, calls, printed } = fake(mac);

		const outcome = await grantPermissions({ mode: "terminal", openPanes: true, extraAutomationTargets: [] }, deps);

		expect(calls).toEqual(["request automation:com.apple.systemevents"]);
		expect(outcome.missing).toEqual(["Automation of System Events"]);
		expect(printed()).toContain("macOS recorded no answer");
	});
});

describe("#given nobody who can switch anything on #when the guide reports #then it shows no dialog and lists what is missing", () => {
	it("never asks macOS and reports every missing grant", async () => {
		const mac: FakeMac = {
			state: {
				accessibility: false,
				screenRecording: true,
				automation: { "com.apple.systemevents": "not-determined" },
			},
			onRequest: {},
			switchesOn: [],
		};
		const { deps, calls } = fake(mac);

		const outcome = await grantPermissions({ mode: "report", openPanes: true, extraAutomationTargets: [] }, deps);

		expect(calls).toEqual([]);
		expect(outcome.missing).toEqual(["Accessibility", "Automation of System Events"]);
	});
});

describe("#given an agent running the guide with no terminal #when a person is at the Mac #then it watches each switch and moves on", () => {
	it("shows each dialog, opens each pane and watches, and names a switch left off as not switched on in time", async () => {
		let pending: "accessibility" | "screenRecording" | undefined;
		const mac: FakeMac = {
			state: { accessibility: false, screenRecording: false, automation: {} },
			onRequest: {
				accessibility: () => {
					pending = "accessibility";
				},
				"screen-recording": () => {
					pending = "screenRecording";
				},
				"switch-on": () => {
					if (pending !== undefined) {
						mac.state[pending] = true;
					}
				},
			},
			switchesOn: [true, false],
		};
		const { deps, calls, printed } = fake(mac);

		const outcome = await grantPermissions({ mode: "watch", openPanes: true, extraAutomationTargets: [] }, deps);

		expect(calls).toEqual([
			"request accessibility",
			`open ${PRIVACY_PANES.accessibility}`,
			"wait",
			"request screen-recording",
			`open ${PRIVACY_PANES.screenRecording}`,
			"wait",
		]);
		expect(outcome.granted).toEqual(["Accessibility"]);
		expect(outcome.missing).toEqual(["Screen Recording"]);
		expect(printed()).toContain("moves on by itself");
		expect(printed()).toContain("not switched on in time");
		expect(printed()).not.toContain("type s");
	});
});

describe("#given the cua-history watcher is installed #when a person runs the guide #then Input Monitoring is walked through too", () => {
	it("asks Input Monitoring and opens its pane only when the option is on", async () => {
		const mac: FakeMac = {
			state: { accessibility: true, screenRecording: true, inputMonitoring: false, automation: {} },
			onRequest: {
				"switch-on": () => {
					mac.state.inputMonitoring = true;
				},
			},
			switchesOn: [true],
		};
		const withHistory = fake(mac);
		const outcome = await grantPermissions(
			{ mode: "terminal", openPanes: true, extraAutomationTargets: [], inputMonitoring: true },
			withHistory.deps,
		);
		expect(outcome).toEqual({ granted: ["Input Monitoring"], missing: [], notAsked: [] });
		expect(withHistory.calls).toEqual(["request input-monitoring", `open ${PRIVACY_PANES.inputMonitoring}`, "wait"]);

		const without = fake({
			state: { accessibility: true, screenRecording: true, inputMonitoring: false, automation: {} },
			onRequest: {},
			switchesOn: [],
		});
		const skipped = await grantPermissions(
			{ mode: "terminal", openPanes: true, extraAutomationTargets: [] },
			without.deps,
		);
		expect(skipped).toEqual({ granted: [], missing: [], notAsked: [] });
		expect(without.calls).toEqual([]);
	});
});

describe("#given a permission changes while the guide is open #when the next pane is considered #then it uses a fresh helper report", () => {
	it("does not prompt for Screen Recording after a fresh report says it was granted during Accessibility", async () => {
		const mac: FakeMac = {
			state: { accessibility: false, screenRecording: false, inputMonitoring: false, automation: {} },
			onRequest: {
				accessibility: () => {
					mac.state.accessibility = true;
					mac.state.screenRecording = true;
				},
			},
			switchesOn: [true],
		};
		const { deps, calls } = fake(mac);

		const outcome = await grantPermissions({ mode: "terminal", openPanes: true, extraAutomationTargets: [] }, deps);

		expect(calls).toEqual(["request accessibility", `open ${PRIVACY_PANES.accessibility}`, "wait"]);
		expect(outcome).toEqual({ granted: ["Accessibility"], missing: [], notAsked: [] });
	});

	it("reports an unreadable final check separately from a permission still reported off", async () => {
		const mac = fake({
			state: { accessibility: false, screenRecording: true, automation: {} },
			onRequest: {},
			switchesOn: [],
		});
		let reads = 0;
		const deps: GrantDependencies = {
			...mac.deps,
			read: () => {
				reads += 1;
				return reads === 3 ? undefined : mac.deps.read();
			},
			waitFor: async () => false,
		};

		const outcome = await grantPermissions({ mode: "terminal", openPanes: false, extraAutomationTargets: [] }, deps);

		expect(outcome.missing).toEqual(["Accessibility"]);
		expect(mac.printed()).toContain(
			"Could not verify Accessibility: the helper did not return a fresh permission report.",
		);
		expect(mac.printed()).not.toContain("latest check from");
	});

	it("uses the final fresh report when a grant lands just after the wait expires", async () => {
		const state = { accessibility: false, screenRecording: true, automation: {} };
		const mac = fake({
			state,
			onRequest: {},
			switchesOn: [],
		});
		const deps: GrantDependencies = {
			...mac.deps,
			waitFor: async () => {
				state.accessibility = true;
				mac.deps.read();
				return false;
			},
		};
		const outcome = await grantPermissions({ mode: "terminal", openPanes: false, extraAutomationTargets: [] }, deps);

		expect(outcome).toEqual({ granted: ["Accessibility"], missing: [], notAsked: [] });
	});
});

describe("#given an earlier Screen Recording decision on record #when the guide asks #then it clears that decision first so macOS shows its dialog", () => {
	function staleMac() {
		let stale = true;
		let pending = false;
		const mac: FakeMac = {
			state: { accessibility: true, screenRecording: false, automation: {} },
			onRequest: {
				// macOS answers without a dialog, and adds nothing to switch on, while the old decision stands.
				"screen-recording": () => {
					pending = !stale;
				},
				"switch-on": () => {
					if (pending) {
						mac.state.screenRecording = true;
					}
				},
			},
			switchesOn: [true],
		};
		const clear = (): void => {
			stale = false;
		};
		return { mac, clear };
	}

	it("resets ScreenCapture before the request and ends with Screen Recording granted", async () => {
		const { mac, clear } = staleMac();
		const { deps, calls } = fake(mac);
		const reset: GrantDependencies = {
			...deps,
			resetDecision: (service) => {
				calls.push(`reset ${service}`);
				clear();
			},
		};

		const outcome = await grantPermissions({ mode: "terminal", openPanes: true, extraAutomationTargets: [] }, reset);

		expect(calls.slice(0, 2)).toEqual(["reset ScreenCapture", "request screen-recording"]);
		expect(outcome.granted).toEqual(["Screen Recording"]);
	});

	it("tells how to add the helper with + when macOS leaves it out of the list and there is no drag panel", async () => {
		const { mac } = staleMac();
		const { deps, calls, printed } = fake(mac);
		const helperApp = "/Users/someone/.opencua/app/packages/mcp/dist/opencua-mcp.app";

		await grantPermissions(
			{ mode: "terminal", openPanes: true, extraAutomationTargets: [], helperApp },
			{ ...deps, dragPanel: fakeDragPanel(calls, false) },
		);

		expect(printed()).toContain(`paste ${helperApp}, choose Open`);
	});

	it("never resets a permission that is already granted", async () => {
		const { mac } = staleMac();
		mac.state.screenRecording = true;
		const { deps, calls } = fake(mac);

		await grantPermissions(
			{ mode: "terminal", openPanes: true, extraAutomationTargets: [] },
			{ ...deps, resetDecision: (service) => calls.push(`reset ${service}`) },
		);

		expect(calls).not.toContain("reset ScreenCapture");
	});
});

describe("#given a helper missing from the privacy lists #when the guide opens each pane #then a drag panel is attached for each missing permission and closed once it is granted", () => {
	const helperApp = "/Users/someone/src/opencua/packages/mcp/dist/opencua-mcp.app";

	function missingBoth(switchesOn: boolean[]): FakeMac {
		let pending: "accessibility" | "screenRecording" | undefined;
		const mac: FakeMac = {
			state: { accessibility: false, screenRecording: false, automation: {} },
			onRequest: {
				accessibility: () => {
					pending = "accessibility";
				},
				"screen-recording": () => {
					pending = "screenRecording";
				},
				"switch-on": () => {
					if (pending !== undefined) {
						mac.state[pending] = true;
						pending = undefined;
					}
				},
			},
			switchesOn,
		};
		return mac;
	}

	const panelCalls = (calls: readonly string[]) =>
		calls.filter((call) => call.startsWith("open ") || call.includes("panel") || call === "wait");

	it("shows the panel after opening each missing pane and closes it when the switch is on", async () => {
		const { deps, calls, printed } = fake(missingBoth([true, true]));

		const outcome = await grantPermissions(
			{ mode: "terminal", openPanes: true, extraAutomationTargets: [], helperApp },
			{ ...deps, dragPanel: fakeDragPanel(calls, true) },
		);

		expect(panelCalls(calls)).toEqual([
			`open ${PRIVACY_PANES.accessibility}`,
			`show panel ${helperApp}`,
			"wait",
			"close panel",
			`open ${PRIVACY_PANES.screenRecording}`,
			`show panel ${helperApp}`,
			"wait",
			"close panel",
		]);
		expect(outcome.granted).toEqual(["Accessibility", "Screen Recording"]);
		expect(printed()).toContain("drag it from the panel under System Settings into the list");
		expect(printed()).not.toContain("Command-Shift-G");
	});

	it("shows no panel for a permission that is already granted, and closes it when the person skips", async () => {
		const mac = missingBoth([false]);
		mac.state.accessibility = true;
		const { deps, calls } = fake(mac);

		const outcome = await grantPermissions(
			{ mode: "terminal", openPanes: true, extraAutomationTargets: [], helperApp },
			{ ...deps, dragPanel: fakeDragPanel(calls, true) },
		);

		expect(panelCalls(calls)).toEqual([
			`open ${PRIVACY_PANES.screenRecording}`,
			`show panel ${helperApp}`,
			"wait",
			"close panel",
		]);
		expect(outcome.missing).toEqual(["Screen Recording"]);
	});

	it("falls back to the + instructions and selects the helper in Finder once when the panel binary is missing", async () => {
		const { deps, calls, printed } = fake(missingBoth([true, true]));

		const outcome = await grantPermissions(
			{ mode: "terminal", openPanes: true, extraAutomationTargets: [], helperApp },
			{ ...deps, dragPanel: fakeDragPanel(calls, false) },
		);

		expect(calls.filter((call) => call.includes("panel"))).toEqual([]);
		expect(calls.filter((call) => call.startsWith("reveal "))).toEqual([`reveal ${helperApp}`]);
		expect(printed()).toContain(`paste ${helperApp}, choose Open`);
		expect(outcome.granted).toEqual(["Accessibility", "Screen Recording"]);
	});

	it("attaches nothing and opens no Finder window with --no-open or in report mode", async () => {
		for (const mode of ["terminal", "report"] as const) {
			const { deps, calls } = fake(missingBoth([false, false]));

			await grantPermissions(
				{ mode, openPanes: mode === "report", extraAutomationTargets: [], helperApp },
				{ ...deps, dragPanel: fakeDragPanel(calls, true) },
			);

			expect(calls.filter((call) => call.includes("panel") || call.startsWith("reveal "))).toEqual([]);
		}
	});
});
