import { describe, expect, it } from "bun:test";
import {
	AX_ACTIVATION_TTL_MS,
	AX_ENHANCED_USER_INTERFACE_ATTRIBUTE,
	AX_MANUAL_ACCESSIBILITY_ATTRIBUTE,
	type AxActivationDeps,
	type AxWalkObservation,
	DEFAULT_WALK_BUDGET,
	DEFAULT_WALK_DEPTH,
	MAX_ADAPTIVE_WALK_BUDGET,
	MAX_ADAPTIVE_WALK_DEPTH,
	bundlePathForExecutable,
	createAxActivation,
	detectAxToolkit,
	looksFlat,
} from "./ax-activation.js";

const SLACK = "/Applications/Slack.app/Contents/MacOS/Slack";
const BRAVE = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
const NOTES = "/System/Applications/Notes.app/Contents/MacOS/Notes";

const FILES: ReadonlyMap<string, readonly string[]> = new Map([
	["/Applications/Slack.app/Contents/Frameworks", ["Electron Framework.framework", "Squirrel.framework"]],
	["/Applications/Slack.app/Contents/Frameworks/Electron Framework.framework", []],
	["/Applications/Brave Browser.app/Contents/Frameworks", ["Brave Browser Framework.framework"]],
	[
		"/Applications/Brave Browser.app/Contents/Frameworks/Brave Browser Framework.framework/Versions/Current/Helpers/chrome_crashpad_handler",
		[],
	],
	["/System/Applications/Notes.app/Contents/Frameworks", ["NotesShared.framework"]],
]);

interface FakeHost {
	readonly deps: AxActivationDeps;
	readonly writes: Array<{ pid: number; attribute: string; value: boolean }>;
	readonly reads: Array<{ pid: number; attribute: string }>;
	readonly attributes: Map<string, boolean>;
	paths: Map<number, string>;
	clock: number;
	refuseWrites: boolean;
}

function fakeHost(paths: Record<number, string>): FakeHost {
	const host: FakeHost = {
		writes: [],
		reads: [],
		attributes: new Map(),
		paths: new Map(Object.entries(paths).map(([pid, path]) => [Number(pid), path])),
		clock: 1_000,
		refuseWrites: false,
		deps: {
			executablePath: (pid) => host.paths.get(pid),
			pathExists: (path) => FILES.has(path),
			listDirectory: (path) => FILES.get(path) ?? [],
			readBooleanAttribute: (pid, attribute) => {
				host.reads.push({ pid, attribute });
				return host.attributes.get(`${pid}:${attribute}`);
			},
			writeBooleanAttribute: (pid, attribute, value) => {
				host.writes.push({ pid, attribute, value });
				if (host.refuseWrites) {
					return false;
				}
				host.attributes.set(`${pid}:${attribute}`, value);
				return true;
			},
			now: () => host.clock,
		},
	};
	return host;
}

function walk(overrides: Partial<AxWalkObservation> = {}): AxWalkObservation {
	return { budgetExhausted: false, depthTruncated: false, sizesTree: true, flat: true, ...overrides };
}

describe("#given app bundles on disk", () => {
	it("#when detecting toolkits #then Electron, Chromium and native apps are told apart by their frameworks", () => {
		const fs = fakeHost({}).deps;
		expect(detectAxToolkit(SLACK, fs)).toBe("electron");
		expect(detectAxToolkit(BRAVE, fs)).toBe("chromium");
		expect(detectAxToolkit(NOTES, fs)).toBe("native");
		expect(detectAxToolkit("/usr/local/bin/bun", fs)).toBe("native");
		expect(detectAxToolkit(undefined, fs)).toBe("native");
	});

	it("#when an app nests inside another bundle #then the bundle that holds the executable is used", () => {
		expect(
			bundlePathForExecutable(
				"/Applications/Docker.app/Contents/MacOS/Docker Desktop.app/Contents/MacOS/Docker Desktop",
			),
		).toBe("/Applications/Docker.app/Contents/MacOS/Docker Desktop.app");
	});
});

describe("#given walked trees", () => {
	it("#when the web area is missing or empty #then the tree looks flat", () => {
		expect(
			looksFlat([
				{ role: "AXWindow", children: [1] },
				{ role: "AXWebArea", children: [] },
			]),
		).toBe(true);
		expect(looksFlat([{ role: "AXWindow", children: [] }])).toBe(true);
		expect(looksFlat([{ role: "AXWebArea", children: [2] }])).toBe(false);
	});
});

describe("#given a cold Electron app", () => {
	it("#when it is observed flat repeatedly within the TTL #then AXManualAccessibility is written once", () => {
		const host = fakeHost({ 10: SLACK });
		const activation = createAxActivation(host.deps);
		activation.beforeWalk(10);
		activation.afterWalk(10, walk());
		activation.beforeWalk(10);
		host.clock += AX_ACTIVATION_TTL_MS - 1;
		activation.afterWalk(10, walk());
		expect(host.writes).toEqual([{ pid: 10, attribute: AX_MANUAL_ACCESSIBILITY_ATTRIBUTE, value: true }]);
		expect(host.reads).toHaveLength(1);
	});

	it("#when the TTL lapses and its tree is populated #then no message is sent, whatever the flag reads back", () => {
		const host = fakeHost({ 10: SLACK });
		const activation = createAxActivation(host.deps);
		activation.beforeWalk(10);
		host.attributes.set(`10:${AX_MANUAL_ACCESSIBILITY_ATTRIBUTE}`, false);
		host.clock += AX_ACTIVATION_TTL_MS;
		activation.beforeWalk(10);
		activation.afterWalk(10, walk({ flat: false }));
		expect(host.writes).toHaveLength(1);
		expect(host.reads).toHaveLength(1);
	});

	it("#when the TTL lapses and its tree is still flat #then the flag is written again", () => {
		const host = fakeHost({ 10: SLACK });
		const activation = createAxActivation(host.deps);
		activation.beforeWalk(10);
		host.attributes.set(`10:${AX_MANUAL_ACCESSIBILITY_ATTRIBUTE}`, false);
		host.clock += AX_ACTIVATION_TTL_MS;
		activation.afterWalk(10, walk());
		expect(host.writes.map((write) => write.value)).toEqual([true, true]);
	});

	it("#when the app refuses the write #then it is not asked again within the TTL and nothing is restored", () => {
		const host = fakeHost({ 10: SLACK });
		host.refuseWrites = true;
		const activation = createAxActivation(host.deps);
		activation.beforeWalk(10);
		activation.afterWalk(10, walk());
		expect(host.writes).toHaveLength(1);
		expect(activation.restore()).toEqual([]);
	});

	it("#when restored #then the prior value is written back once and forgotten", () => {
		const host = fakeHost({ 10: SLACK });
		const activation = createAxActivation(host.deps);
		activation.beforeWalk(10);
		expect(activation.restore(10)).toEqual([
			{ pid: 10, attribute: AX_MANUAL_ACCESSIBILITY_ATTRIBUTE, restoredTo: false, restored: true },
		]);
		expect(host.attributes.get(`10:${AX_MANUAL_ACCESSIBILITY_ATTRIBUTE}`)).toBe(false);
		expect(activation.restore(10)).toEqual([]);
	});
});

describe("#given an Electron app whose accessibility was already on", () => {
	it("#when observed and then restored #then nothing is written either way", () => {
		const host = fakeHost({ 10: SLACK });
		host.attributes.set(`10:${AX_MANUAL_ACCESSIBILITY_ATTRIBUTE}`, true);
		const activation = createAxActivation(host.deps);
		activation.beforeWalk(10);
		expect(activation.restore()).toEqual([]);
		expect(host.writes).toEqual([]);
	});
});

describe("#given a Chromium browser", () => {
	it("#when it is observed before any walk #then AXEnhancedUserInterface is left alone", () => {
		const host = fakeHost({ 20: BRAVE });
		const activation = createAxActivation(host.deps);
		activation.beforeWalk(20);
		activation.afterWalk(20, walk({ flat: false }));
		expect(host.writes).toEqual([]);
	});

	it("#when its tree comes back flat #then AXEnhancedUserInterface is set and restore puts it back", () => {
		const host = fakeHost({ 20: BRAVE });
		const activation = createAxActivation(host.deps);
		activation.beforeWalk(20);
		activation.afterWalk(20, walk({ flat: true }));
		expect(host.writes).toEqual([{ pid: 20, attribute: AX_ENHANCED_USER_INTERFACE_ATTRIBUTE, value: true }]);
		expect(activation.restore()).toEqual([
			{ pid: 20, attribute: AX_ENHANCED_USER_INTERFACE_ATTRIBUTE, restoredTo: false, restored: true },
		]);
	});

	it("#when a cut-off walk has no web area yet #then it is not taken for a flat tree", () => {
		const host = fakeHost({ 20: BRAVE });
		const activation = createAxActivation(host.deps);
		activation.afterWalk(20, walk({ budgetExhausted: true }));
		activation.afterWalk(20, walk({ depthTruncated: true }));
		expect(host.writes).toEqual([]);
	});
});

describe("#given a native app", () => {
	it("#when observed with flat and cut-off trees #then nothing is written and the limits stay default", () => {
		const host = fakeHost({ 30: NOTES });
		const activation = createAxActivation(host.deps);
		activation.beforeWalk(30);
		activation.afterWalk(30, walk());
		activation.afterWalk(30, walk({ budgetExhausted: true, depthTruncated: true }));
		expect(host.writes).toEqual([]);
		expect(host.reads).toEqual([]);
		expect(activation.walkLimits(30)).toEqual({ maxElements: DEFAULT_WALK_BUDGET, maxDepth: DEFAULT_WALK_DEPTH });
	});
});

describe("#given a large Electron tree", () => {
	it("#when default walks keep running out of elements #then the budget doubles up to the bound and never shrinks", () => {
		const host = fakeHost({ 10: SLACK });
		const activation = createAxActivation(host.deps);
		const budget = () => activation.walkLimits(10).maxElements;
		expect(budget()).toBe(DEFAULT_WALK_BUDGET);
		activation.afterWalk(10, walk({ budgetExhausted: true, flat: false }));
		expect(budget()).toBe(DEFAULT_WALK_BUDGET * 2);
		activation.afterWalk(10, walk({ budgetExhausted: true, flat: false }));
		expect(budget()).toBe(MAX_ADAPTIVE_WALK_BUDGET);
		activation.afterWalk(10, walk({ flat: false }));
		expect(activation.walkLimits(10)).toEqual({
			maxElements: MAX_ADAPTIVE_WALK_BUDGET,
			maxDepth: DEFAULT_WALK_DEPTH,
		});
	});

	it("#when default walks keep hitting the depth limit #then only the depth grows, up to its bound", () => {
		const host = fakeHost({ 10: SLACK });
		const activation = createAxActivation(host.deps);
		for (let walkIndex = 0; walkIndex < 4; walkIndex++) {
			activation.afterWalk(10, walk({ depthTruncated: true, flat: false }));
		}
		expect(activation.walkLimits(10)).toEqual({
			maxElements: DEFAULT_WALK_BUDGET,
			maxDepth: MAX_ADAPTIVE_WALK_DEPTH,
		});
	});

	it("#when a cut-off walk had explicit limits #then it does not grow the default ones", () => {
		const host = fakeHost({ 10: SLACK });
		const activation = createAxActivation(host.deps);
		activation.afterWalk(10, walk({ budgetExhausted: true, depthTruncated: true, sizesTree: false, flat: false }));
		expect(activation.walkLimits(10)).toEqual({ maxElements: DEFAULT_WALK_BUDGET, maxDepth: DEFAULT_WALK_DEPTH });
	});
});

describe("#given a pid that changes hands", () => {
	it("#when the TTL lapses and the pid runs another program #then the old activation is dropped, not restored", () => {
		const host = fakeHost({ 10: SLACK });
		const activation = createAxActivation(host.deps);
		activation.beforeWalk(10);
		host.paths.set(10, NOTES);
		host.clock += AX_ACTIVATION_TTL_MS;
		expect(activation.toolkitFor(10)).toBe("native");
		expect(activation.restore()).toEqual([]);
	});

	it("#when the process exited #then forgetting it leaves nothing to restore", () => {
		const host = fakeHost({ 10: SLACK, 20: BRAVE });
		const activation = createAxActivation(host.deps);
		activation.beforeWalk(10);
		activation.afterWalk(20, walk());
		activation.forgetExcept(new Set([20]));
		expect(activation.restore().map((result) => result.pid)).toEqual([20]);
	});
});
