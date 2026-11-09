import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as ts from "typescript";
import {
	type HostInteraction,
	HostInteractionDenied,
	denyHostInteraction,
	requireAttendedHostDelivery,
	setAttendedHostDelivery,
} from "./host-interaction-policy.js";

const operations: readonly HostInteraction[] = [
	"physical-pointer",
	"global-input",
	"host-focus",
	"host-clipboard",
	"host-spaces",
	"host-window",
	"host-overlay",
];

describe("#given the human desktop #when a denied interaction is requested #then it is refused", () => {
	it.each(operations)("refuses %s without an opt-in bypass", (operation) => {
		expect(() => denyHostInteraction(operation)).toThrow(HostInteractionDenied);
		try {
			denyHostInteraction(operation);
		} catch (error: unknown) {
			expect(error).toMatchObject({ code: "HOST_INTERACTION_FORBIDDEN", operation });
		}
	});
});

// Extract only reviewed wrapper functions. Never import either native module:
// no koffi, WindowServer, app, clipboard, process, or physical-input API is loaded.
const dispatchSources = new Map(
	[
		"coregraphics-bindings",
		"skylight",
		"workspace",
		"pasteboard",
		"../macos-window-frame",
		"cursor-overlay",
		"../macos-open-app",
		"../terminal-session",
	].map((module): readonly [string, ts.SourceFile] => [
		module,
		ts.createSourceFile(
			`${module}.ts`,
			readFileSync(new URL(`../platform/macos-ffi/${module}.ts`, import.meta.url), "utf8"),
			ts.ScriptTarget.ES2022,
			true,
		),
	]),
);

function compileWrapper(module: string, name: string): string {
	const source = dispatchSources.get(module);
	if (source === undefined) throw new Error(`Missing source: ${module}`);
	const declaration = source.statements.find(
		(statement): statement is ts.FunctionDeclaration =>
			ts.isFunctionDeclaration(statement) && statement.name?.text === name,
	);
	if (declaration === undefined) throw new Error(`Missing wrapper: ${name}`);
	return ts.transpileModule(`${declaration.getText(source)}\nexports["${name}"] = ${name};`, {
		compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
	}).outputText;
}

function exportedFunction(exports: Record<string, unknown>, name: string): (...args: unknown[]) => unknown {
	const dispatch = exports[name];
	if (typeof dispatch !== "function") throw new Error(`Wrapper was not exported: ${name}`);
	return (...args) => Reflect.apply(dispatch, undefined, args);
}

const window = { id: 7, bounds: { x: 0, y: 0, width: 100, height: 100 } };
const nativeWrappers = [
	{ module: "coregraphics-bindings", name: "postToHidEventTap", operation: "global-input", input: {} },
	{
		module: "coregraphics-bindings",
		name: "warpCursorPosition",
		operation: "physical-pointer",
		input: { x: 1, y: 2 },
	},
	{ module: "skylight", name: "postMouseEventRecordToWindow", operation: "host-focus", input: window },
	{ module: "skylight", name: "activateWindowWithoutRaise", operation: "host-focus", input: window },
	{ module: "skylight", name: "beginFocusWithoutRaise", operation: "host-focus", input: window },
	{ module: "workspace", name: "activateApplication", operation: "host-focus", input: 1234 },
] as const;

/** One wrapper compiled into a context whose every native primitive is a counter. */
function fakeNativeWrapper(
	module: string,
	name: string,
): { dispatch: (input: unknown) => unknown; effects: () => number } {
	const exports: Record<string, unknown> = {};
	let nativeEffects = 0;
	const effect = () => {
		nativeEffects++;
		return 0;
	};
	runInNewContext(
		compileWrapper(module, name),
		{
			exports,
			requireAttendedHostDelivery,
			CGEventPost: effect,
			CGWarpMouseCursorPosition: effect,
			K_CG_HID_EVENT_TAP: 0,
			Buffer,
			K_CPS_NO_WINDOWS: 0x400,
			K_CPS_USER_GENERATED: 0x200,
			_SLPSGetFrontProcess: () => 0,
			frontProcessSerialNumber: () => Buffer.alloc(8),
			processSerialNumberForWindow: () => Buffer.alloc(8),
			buildMouseEventRecord: () => Buffer.alloc(248),
			SLPSSetFrontProcessWithOptions: effect,
			SLPSPostEventRecordTo: effect,
			withAutoreleasePool: (operation: () => unknown) => operation(),
			msgPointerProcessIdentifier: () => ({}),
			runningApplicationClass: {},
			runningApplicationWithProcessIdentifierSelector: {},
			activateWithOptionsSelector: {},
			ACTIVATE_IGNORING_OTHER_APPS: 2,
			msgBoolUnsignedInteger: () => effect() === 0,
		},
		{ timeout: 5_000 },
	);
	const dispatch = exportedFunction(exports, name);
	return { dispatch: (input) => dispatch(input), effects: () => nativeEffects };
}

describe("#given background delivery #when the focus, HID and pointer wrappers run in a fake-only context #then physical effects are denied", () => {
	it.each(nativeWrappers)("refuses every generated input to $name", ({ module, name, operation }) => {
		const { dispatch, effects } = fakeNativeWrapper(module, name);
		const inputs: readonly unknown[] = [
			undefined,
			null,
			{},
			{ x: 0, y: 0 },
			{ x: -1, y: 1 },
			{ x: Number.NaN, y: Number.POSITIVE_INFINITY },
			window,
			1234,
		];
		for (const input of inputs) {
			expect(() => dispatch(input)).toThrow(HostInteractionDenied);
			expect(() => dispatch(input)).toThrow(`${operation} cannot operate on the human desktop`);
			expect(effects()).toBe(0);
		}
	});

	it("rejects a deliberately unsafe fake implementation during oracle calibration", () => {
		let fakeEffects = 0;
		const unsafe = () => fakeEffects++;
		const assertDenied = (dispatch: () => unknown) => {
			expect(dispatch).toThrow(HostInteractionDenied);
			expect(fakeEffects).toBe(0);
		};
		expect(() => assertDenied(unsafe)).toThrow();
		expect(fakeEffects).toBe(1);
	});
});

describe("#given attended delivery #when the focus, HID and pointer wrappers run in a fake-only context #then they reach their native primitive", () => {
	afterEach(() => {
		setAttendedHostDelivery(false);
	});

	it.each(nativeWrappers)("routes $name to its native call", ({ module, name, input }) => {
		const { dispatch, effects } = fakeNativeWrapper(module, name);
		setAttendedHostDelivery(true);

		dispatch(input);

		expect(effects()).toBeGreaterThan(0);
	});
});

describe("#given host resources outside background app control #when their native default is used #then nothing native is touched", () => {
	it.each([
		{ module: "../terminal-session", name: "createTerminalSession", args: [], method: "runCommand" },
		{ module: "cursor-overlay", name: "createCursorOverlay", args: [] },
		{ module: "cursor-overlay", name: "defaultSocketTransport", args: [Date.now, () => undefined] },
	])("refuses the native default for $name", async (testCase) => {
		const { module, name, args } = testCase;
		const exports: Record<string, unknown> = {};
		let nativeCalls = 0;
		runInNewContext(
			compileWrapper(module, name),
			{
				exports,
				denyHostInteraction,
				spawn: () => nativeCalls++,
				connect: () => nativeCalls++,
				cursorOverlaySocketPath: () => "/synthetic/host-overlay.sock",
				nativeAccess: {
					find: () => nativeCalls++,
					run: () => nativeCalls++,
				},
			},
			{ timeout: 5_000 },
		);
		const dispatch = exportedFunction(exports, name);
		await expect(
			Promise.resolve().then(() => {
				const result: unknown = dispatch(...args);
				if ("method" in testCase && testCase.method !== undefined) {
					if (typeof result !== "object" || result === null) throw new Error("Missing resource");
					const method: unknown = Reflect.get(result, testCase.method);
					if (typeof method !== "function") throw new Error("Missing resource method");
					return Reflect.apply(method, result, []);
				}
				return result;
			}),
		).rejects.toBeInstanceOf(HostInteractionDenied);
		expect(nativeCalls).toBe(0);
	});
});

describe("#given host app resources #when their native default is used #then it reaches the native seam", () => {
	const pasteboardConstants = {
		TEXT_TYPE: "public.utf8-plain-text",
		LEGACY_TEXT_TYPE: "NSStringPboardType",
		FILE_URL_TYPE: "public.file-url",
		IMAGE_TYPES: ["public.png", "public.jpeg", "public.tiff"],
	};

	it("reads the host clipboard through the native pasteboard", () => {
		const exports: Record<string, unknown> = {};
		runInNewContext(compileWrapper("pasteboard", "readClipboard"), {
			exports,
			...pasteboardConstants,
			nativePasteboard: {
				types: () => ["public.utf8-plain-text"],
				stringForType: (type: string) => (type === "public.utf8-plain-text" ? "copied" : null),
				dataForType: () => null,
			},
		});

		expect(exportedFunction(exports, "readClipboard")()).toEqual({
			types: ["public.utf8-plain-text"],
			text: "copied",
			fileUrls: [],
		});
	});

	it("writes the host clipboard through the native pasteboard", () => {
		const exports: Record<string, unknown> = {};
		const writes: string[] = [];
		runInNewContext(compileWrapper("pasteboard", "writeClipboard"), {
			exports,
			...pasteboardConstants,
			prepareClipboardInput: (input: unknown) => input,
			nativePasteboard: {
				clear: () => writes.push("clear"),
				setString: (type: string, value: string) => writes.push(`${type}=${value}`) > 0,
				types: () => ["public.utf8-plain-text"],
			},
		});

		expect(exportedFunction(exports, "writeClipboard")({ type: "text", text: "synthetic" })).toEqual({
			overwritten: true,
			writtenType: "text",
			types: ["public.utf8-plain-text"],
		});
		expect(writes).toEqual(["clear", "public.utf8-plain-text=synthetic"]);
	});

	it("resolves a host window frame through WindowServer instead of refusing", async () => {
		const exports: Record<string, unknown> = {};
		let frameReads = 0;
		runInNewContext(compileWrapper("../macos-window-frame", "setWindowFrame"), {
			exports,
			validateFrame: () => undefined,
			nativeWindowFrameDependencies: {
				windowFrames: async () => {
					frameReads++;
					return [];
				},
			},
		});

		await expect(
			Promise.resolve().then(() =>
				exportedFunction(exports, "setWindowFrame")(123, 99, { x: 0, y: 0, width: 100, height: 100 }),
			),
		).rejects.toThrow("window_id 99 is closed, stale, or unknown to WindowServer");
		expect(frameReads).toBe(1);
	});

	it("launches an app in the background with open -g -j and no focus restore", async () => {
		const exports: Record<string, unknown> = {};
		const spawned: unknown[][] = [];
		runInNewContext(compileWrapper("../macos-open-app", "spawnOpenLauncher"), {
			exports,
			Promise,
			Error,
			String,
			openArguments: (target: string, background: boolean) => [...(background ? ["-g", "-j"] : []), "-a", target],
			spawn: (...args: unknown[]) => {
				spawned.push(args);
				return {
					stderr: { on: () => undefined },
					once: (event: string, listener: (code: number) => void) => {
						if (event === "close") listener(0);
					},
				};
			},
		});
		const launcher: unknown = exportedFunction(exports, "spawnOpenLauncher")();
		if (typeof launcher !== "object" || launcher === null) throw new Error("Missing launcher");
		const launch: unknown = Reflect.get(launcher, "launch");
		if (typeof launch !== "function") throw new Error("Missing launch");

		await Reflect.apply(launch, launcher, ["Calculator"]);

		expect(spawned).toEqual([["open", ["-g", "-j", "-a", "Calculator"], { stdio: ["ignore", "ignore", "pipe"] }]]);
		expect(Reflect.get(launcher, "background")).toBe(true);
		expect(Reflect.has(launcher, "restoreFrontmost")).toBe(false);
	});
});
