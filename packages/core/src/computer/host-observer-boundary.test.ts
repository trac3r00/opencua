import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as ts from "typescript";
import { CursorKeyedObservations } from "../platform/cursor-observations.js";

// Evaluate the actual class, but not its imports or module initializers. Every dependency
// capable of desktop input is absent or replaced with a counter. This test cannot load FFI.
const source = ts.createSourceFile(
	"macos.ts",
	readFileSync(new URL("../platform/macos.ts", import.meta.url), "utf8"),
	ts.ScriptTarget.ES2022,
	true,
);
const declaration = source.statements.find(
	(statement): statement is ts.ClassDeclaration =>
		ts.isClassDeclaration(statement) && statement.name?.text === "MacOSHostComputer",
);
if (declaration === undefined) throw new Error("Missing MacOSHostComputer class");
const compiled = ts.transpileModule(declaration.getText(source), {
	compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function fixture() {
	const exports: Record<string, unknown> = {};
	const dispatched: string[] = [];
	const controllerArgs: unknown[][] = [];
	const attendedGrants: boolean[] = [];
	let locked = 0;
	const record =
		(name: string) =>
		async (..._args: unknown[]): Promise<void> => {
			dispatched.push(name);
		};
	runInNewContext(
		compiled,
		{
			exports,
			CursorKeyedObservations,
			HostComputer: Object,
			InputLock: class {
				run = <T>(burst: () => Promise<T>): Promise<T> => {
					locked++;
					return burst();
				};
			},
			MacOSInputController: class {
				constructor(...args: unknown[]) {
					controllerArgs.push(args);
				}
				readonly currentTargetPid = 4242;
				move = record("move");
				click = record("click");
				doubleClick = record("doubleClick");
				typeText = record("typeText");
				scroll = record("scroll");
				drag = record("drag");
			},
			setAttendedHostDelivery: (enabled: boolean) => attendedGrants.push(enabled),
			isOwnedSurfacePid: () => false,
			cursorMotionFromEnvironment: () => undefined,
			cursorBackgroundCuesEnabled: () => false,
			agentCursorEnabled: () => false,
			createCursorOverlay: () => {
				throw new Error("the boundary fixture never builds a real overlay");
			},
			NOOP_POINTER_OVERLAY: { highlight: () => undefined, set: () => undefined },
			NOOP_DISPLAY_SLEEP: {},
			isScreenLocked: () => false,
		},
		{ timeout: 5_000 },
	);
	const hostConstructor = exports["MacOSHostComputer"];
	if (typeof hostConstructor !== "function") throw new Error("Missing host constructor");
	const instance: unknown = Reflect.construct(hostConstructor, []);
	if (typeof instance !== "object" || instance === null) throw new Error("Missing host instance");
	return { hostConstructor, instance, dispatched, controllerArgs, attendedGrants, locked: () => locked };
}

function method(instance: object, name: string): (...args: unknown[]) => unknown {
	const found: unknown = Reflect.get(instance, name);
	if (typeof found !== "function") throw new Error(`Missing method: ${name}`);
	return (...args) => Reflect.apply(found, instance, args);
}

describe("#given the macOS host #when its capabilities are read #then the person's apps take background input", () => {
	it("advertises screenshot, input and clipboard capability", () => {
		const { instance } = fixture();
		expect(Reflect.get(instance, "capabilities")).toEqual({
			supportsScreenshot: true,
			supportsInput: true,
			supportsAccessibility: true,
			supportsClipboard: true,
		});
		expect(Object.isFrozen(Reflect.get(instance, "capabilities"))).toBe(true);
	});

	it("leaves background activation to the input controller's default, so apps take the first background click", () => {
		const { controllerArgs } = fixture();
		expect(controllerArgs).toHaveLength(1);
		expect(controllerArgs[0]?.[4]).toBe("background");
		// undefined selects backgroundActivationEnabled(): on unless OPENCUA_BACKGROUND_ACTIVATION turns it off.
		expect(controllerArgs[0]?.[5]).toBeUndefined();
	});
});

describe("#given the macOS host #when attended delivery is requested #then the process opts into direct input", () => {
	it("opts in only for attended construction and builds an attended input controller", () => {
		const { hostConstructor, controllerArgs, dispatched, attendedGrants } = fixture();
		expect(attendedGrants).toEqual([]);

		Reflect.construct(hostConstructor, [{ delivery: "attended" }]);

		expect(attendedGrants).toEqual([true]);
		expect(controllerArgs[1]?.[4]).toBe("attended");
		expect(dispatched).toEqual([]);
	});
});

describe("#given the macOS host #when a host app gets input #then it reaches the input controller under the input lock", () => {
	it.each([
		{ name: "move", args: [{ x: 1, y: 2 }], expected: "move" },
		{ name: "click", args: [{ x: 1, y: 2 }], expected: "click" },
		{ name: "rightClick", args: [{ x: 1, y: 2 }], expected: "click" },
		{ name: "doubleClick", args: [{ x: 1, y: 2 }], expected: "doubleClick" },
		{ name: "type", args: ["hello"], expected: "typeText" },
		{ name: "scroll", args: [{ x: 1, y: 2, deltaY: 3 }], expected: "scroll" },
		{ name: "drag", args: [{ from: { x: 1, y: 2 }, to: { x: 3, y: 4 } }], expected: "drag" },
	])("dispatches $name for a pid opencua did not launch", async ({ name, args, expected }) => {
		const { instance, dispatched, locked } = fixture();
		await method(instance, name)(...args);
		expect(dispatched).toEqual([expected]);
		expect(locked()).toBe(1);
	});

	it("checks the stored observation instead of refusing the host outright", async () => {
		const { instance, dispatched } = fixture();
		const expected = {
			pid: 4242,
			bundleId: "com.apple.calculator",
			windowId: 7,
			windowBounds: { x: 0, y: 0, width: 100, height: 100 },
			generation: 1,
			observedElementIds: new Set<number>(),
		};
		await expect(method(instance, "preflightInput")(expected)).resolves.toEqual({
			ok: false,
			reason: "observation-replaced",
		});
		expect(dispatched).toEqual([]);
	});
});
