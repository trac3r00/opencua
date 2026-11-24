import { afterEach, describe, expect, it } from "bun:test";
import { createHarness, jsonPayload } from "./protocol-client-harness.js";
import { FakeGuardedComputer } from "./protocol-test-harness.js";
import { restoreBrowserCallerForTesting, setBrowserCallerForTesting } from "./script-tools.js";

let closeHarness: (() => Promise<void>) | undefined;

afterEach(async () => {
	restoreBrowserCallerForTesting();
	if (closeHarness !== undefined) {
		await closeHarness();
		closeHarness = undefined;
	}
});

/**
 * `reach(value)` is the escape every vector ends in: the value's realm's Function constructor compiling a string. In
 * the script's own realm that is refused (EvalError); a value from the worker's realm answers "object", because
 * `process` exists there. `foreign(roots)` walks everything reachable from the roots without calling anything and
 * names each object whose prototype chain ends outside the script's realm.
 */
const PRELUDE = `
	const reach = (value) => {
		try {
			return value.constructor.constructor("return typeof process")();
		} catch (error) {
			return "blocked:" + error.name;
		}
	};
	const foreign = (roots) => {
		const seen = new Set();
		const found = [];
		const walk = (value, path) => {
			if ((typeof value !== "object" && typeof value !== "function") || value === null || seen.has(value)) return;
			seen.add(value);
			let last = value;
			for (let next = Object.getPrototypeOf(value); next !== null; next = Object.getPrototypeOf(next)) last = next;
			if (last !== Object.prototype && (last !== value || typeof value === "function")) {
				found.push(path);
				return;
			}
			for (const key of Reflect.ownKeys(value)) {
				const entry = Reflect.getOwnPropertyDescriptor(value, key);
				if (entry === undefined) continue;
				const name = path + "." + String(key);
				walk(entry.value, name);
				walk(entry.get, name + "<get>");
				walk(entry.set, name + "<set>");
			}
			walk(Object.getPrototypeOf(value), path + ".__proto__");
		};
		for (const [name, root] of Object.entries(roots)) walk(root, name);
		return found;
	};
`;

const BLOCKED = "blocked:EvalError";

async function runScript(body: string, computer = new FakeGuardedComputer()) {
	const harness = await createHarness(computer);
	closeHarness = harness.close;
	const result = await harness.client.callTool({ name: "run_script", arguments: { code: PRELUDE + body } });
	return { result, payload: jsonPayload(result) };
}

function answers(payload: Record<string, unknown>): unknown[] {
	const value = payload["value"];
	return Array.isArray(value) ? value : [];
}

describe("run_script realm #given a value the script can touch #when it climbs to that value's Function constructor #then it never compiles code in the worker's realm", () => {
	it.each([
		["log.constructor", "return [log, console, console.log, console.error].map(reach);"],
		["this.constructor.constructor", "return [this, globalThis].map(reach);"],
		[
			"apple.apps().constructor.constructor",
			"const pending = apple.apps(); const answer = [reach(pending)]; await pending; return answer;",
		],
		["sleep.constructor and the timers", "return [sleep, sleep(0), setTimeout, clearTimeout].map(reach);"],
		[
			"the error from invalid()",
			'try { apple.app(""); return ["no error"]; } catch (error) { return [reach(error)]; }',
		],
		[
			"a rejection from apple.*",
			`const finder = apple.app("Finder");
			try { await finder.click(9); return ["no error"]; } catch (error) { return [reach(error)]; }`,
		],
		[
			"values passed back from the host",
			`const state = await apple.app("Finder").observe();
			return [state, state.elements, state.elements[0], await apple.apps(), apple.steps.click(9)].map(reach);`,
		],
		[
			"the apple object, its handles and their methods",
			`const finder = apple.app("Finder");
			const browser = apple.browser();
			const getter = Object.getOwnPropertyDescriptor(browser, "context").get;
			return [apple, apple.app, apple.steps, apple.steps.click, finder, finder.click, browser, getter, apple.dock()].map(reach);`,
		],
	])("%s", async (_vector, body) => {
		const { payload } = await runScript(body);

		expect(payload["ok"]).toBe(true);
		expect(answers(payload)).not.toEqual([]);
		expect(new Set(answers(payload))).toEqual(new Set([BLOCKED]));
	});

	// Bun 1.4.4 on x86_64 segfaults the whole test process when the host calls back into functions a run_script object
	// carries (reproduced under Rosetta; bun.report/1.4.4/mt138afee6i3F3). The server runs run_script on Node, and arm64
	// Bun runs these two checks.
	it.skipIf(process.arch === "x64")(
		"#when the script hands the host an object with callbacks #then the callbacks get the script realm's values",
		async () => {
			const { payload } = await runScript(`
			const captured = [];
			const fake = {
				name: "Finder",
				observe(options) { captured.push(options); return {}; },
				step(raw) { captured.push(raw); return {}; },
			};
			try { await apple.arrange([fake]); } catch (error) { captured.push(error); }
			return captured.map(reach);
		`);

			expect(payload["ok"]).toBe(true);
			expect(answers(payload)).not.toEqual([]);
			expect(new Set(answers(payload))).toEqual(new Set([BLOCKED]));
		},
	);

	// Same Bun x86_64 crash as above.
	it.skipIf(process.arch === "x64")(
		"#when the script replaces Array.prototype.map and Promise.prototype.then #then no host function passes through them",
		async () => {
			const { payload } = await runScript(`
			const seen = [];
			const map = Array.prototype.map;
			const then = Promise.prototype.then;
			Array.prototype.map = function (callback, ...rest) { seen.push(callback); return map.call(this, callback, ...rest); };
			Promise.prototype.then = function (resolved, rejected) { seen.push(resolved, rejected); return then.call(this, resolved, rejected); };
			try { await apple.arrange([{ name: "Finder", observe() { return {}; }, step() { return {}; } }]); } catch (error) {}
			await sleep(5);
			Array.prototype.map = map;
			Promise.prototype.then = then;
			return seen.filter((value) => typeof value === "function").map(reach).filter((answer) => answer !== "${BLOCKED}");
		`);

			expect(payload).toMatchObject({ ok: true, value: [] });
		},
	);

	it("#when the script exhausts the stack around a host call #then the overflow error is still the script realm's", async () => {
		const { payload } = await runScript(`
			const realms = new Set();
			let caught = 0;
			const probe = () => {
				try { apple.steps.menu("File > Open"); } catch (error) { caught += 1; realms.add(reach(error)); }
			};
			const dive = () => {
				try { dive(); } catch (error) { caught += 1; realms.add(reach(error)); }
				probe();
			};
			dive();
			return { caught: caught > 0, realms: [...realms].filter((answer) => !answer.startsWith("blocked:")) };
		`);

		expect(payload).toMatchObject({ ok: true, value: { caught: true, realms: [] } });
	});

	it("#when the script asks for a dynamic import or a ShadowRealm #then neither gives it the worker's realm", async () => {
		const { payload } = await runScript(`
			let imported;
			try { await import("node:child_process"); imported = "imported"; } catch (error) { imported = reach(error); }
			const shadow = typeof ShadowRealm === "undefined" ? "absent" : new ShadowRealm().evaluate("typeof process");
			return { imported, shadow, wasm: typeof WebAssembly };
		`);

		expect(payload).toMatchObject({ ok: true, value: { imported: BLOCKED, shadow: "absent", wasm: "undefined" } });
	});

	it("#when a callback inspects its own call stack #then it finds only the script's functions", async () => {
		const { payload } = await runScript(`
			const found = [];
			await new Promise((resolve) => {
				setTimeout(function callback() {
					found.push(callback.caller);
					Error.prepareStackTrace = (error, sites) => sites.map((site) => site.getFunction());
					for (const entry of [].concat(new Error("trace").stack)) found.push(entry);
					delete Error.prepareStackTrace;
					resolve();
				}, 0);
			});
			return found.filter((entry) => typeof entry === "function").map((entry) => entry.name);
		`);

		expect(payload["ok"]).toBe(true);
		expect(new Set(answers(payload))).toEqual(new Set(["callback"]));
	});

	it("#when everything reachable is walked #then every object belongs to the script's realm", async () => {
		const computer = new FakeGuardedComputer();
		computer.preflightResult = { ok: false, reason: "window-changed" };
		const { payload } = await runScript(
			`
			const finder = apple.app("Finder");
			const pending = apple.apps();
			const roots = { globalThis, pending, apps: await pending, state: await finder.observe(), finder, browser: apple.browser() };
			try { apple.app(""); } catch (error) { roots.invalid = error; }
			try { await finder.click(9); } catch (error) { roots.rejection = error; }
			return foreign(roots);
		`,
			computer,
		);

		expect(payload).toMatchObject({ ok: true, value: [] });
	});
});

describe("run_script realm #given the membrane between script and host #when values cross it #then the script API behaves as before", () => {
	it("#when a caught action error is thrown again #then the run still fails as that action with its payload", async () => {
		const computer = new FakeGuardedComputer();
		computer.preflightResult = { ok: false, reason: "window-changed" };

		const { result, payload } = await runScript(
			`
			const finder = apple.app("Finder");
			await finder.observe();
			try {
				await finder.click(9);
			} catch (error) {
				if (!(error instanceof Error) || error.name !== "ScriptActionError") throw new Error("lost its shape");
				throw error;
			}
		`,
			computer,
		);

		expect(result.isError).toBe(true);
		expect(payload).toMatchObject({
			ok: false,
			kind: "action-failed",
			payload: { actionDispatched: false, reason: "window-changed" },
		});
	});

	it("#when a script changes a built step before running it #then the host runs the changed step", async () => {
		const computer = new FakeGuardedComputer();

		const { payload } = await runScript(
			`
			const finder = apple.app("Finder");
			await finder.observe();
			const step = apple.steps.setValue(20, "built");
			step.value = "changed";
			await finder.batch([step]);
			return Object.isFrozen(apple) && Object.isFrozen(finder) && !Object.isFrozen(step);
		`,
			computer,
		);

		expect(payload).toMatchObject({ ok: true, value: true });
		expect(computer.effects.filter((effect) => effect.kind === "setValue")).toEqual([
			{ kind: "setValue", pid: 1234, id: 20, value: "changed" },
		]);
	});

	it("#when the browser handle opens a page #then its context getter follows the latest answer", async () => {
		setBrowserCallerForTesting({
			async call() {
				return { session_id: "s1", context_id: "ctx-1", observation_id: "obs-1" };
			},
			async close() {},
		});

		const { payload } = await runScript(`
			const browser = apple.browser();
			const before = browser.context;
			await browser.open("https://example.test/");
			return [before === undefined, browser.context];
		`);

		expect(payload).toMatchObject({ ok: true, value: [true, "ctx-1"] });
	});

	it("#when the script logs values with their own JSON form #then the log shows that form", async () => {
		const { payload } = await runScript(`
			log(new Date(0), { toJSON: () => "custom" }, 7n);
			return null;
		`);

		expect(payload).toMatchObject({ ok: true, log: ['"1970-01-01T00:00:00.000Z" "custom" 7'] });
	});
});
