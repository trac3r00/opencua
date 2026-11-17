import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const nativeDirectory = fileURLToPath(new URL("../../native/", import.meta.url));
let scratch: string | undefined;
let helper: string;
let recorder: string;

async function compile(source: string, output: string, frameworks: readonly string[]): Promise<void> {
	const child = Bun.spawn(
		[
			"clang",
			"-fobjc-arc",
			"-Wall",
			"-Wno-unused-variable",
			"-Werror",
			join(nativeDirectory, source),
			...frameworks.flatMap((framework) => ["-framework", framework]),
			"-o",
			output,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
	expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
}

async function hold(command: readonly string[], stateDir: string) {
	const child = Bun.spawn([...command], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, OPENCUA_STATE_DIR: stateDir },
	});
	const reader = child.stdout.getReader();
	let text = "";
	while (!text.includes("\n")) {
		const { value, done } = await reader.read();
		if (done) break;
		text += new TextDecoder().decode(value);
	}
	return {
		answer: text.trim(),
		release: async () => {
			child.stdin.end();
			expect(await child.exited).toBe(0);
		},
	};
}

beforeAll(async () => {
	scratch = await mkdtemp(join(tmpdir(), "stop-menu-single-"));
	helper = join(scratch, "helper");
	recorder = join(scratch, "recorder");
	await Promise.all([
		compile("test/cursor-overlay-stop.m", helper, ["Cocoa"]),
		compile("test/history-native.m", recorder, ["AppKit", "ApplicationServices", "Carbon"]),
	]);
}, 60_000);

afterAll(async () => {
	if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
});

describe("#given several opencua servers #when each starts its menu helper #then the menu bar shows one opencua item", () => {
	it("shows only the first helper's item and hands it to a waiting helper when that one exits", async () => {
		if (scratch === undefined) throw new Error("missing scratch directory");
		const state = join(scratch, "servers");

		const first = await hold([helper, "visible"], state);
		const second = await hold([helper, "visible"], state);
		expect([first.answer, second.answer]).toEqual(["shown", "hidden"]);

		await first.release();
		const third = await hold([helper, "visible"], state);
		expect(third.answer).toBe("shown");
		await Promise.all([second.release(), third.release()]);
	});
});

describe("#given a menu helper or cua-history shows opencua #when the drawing overlay moves #then it adds no second item", () => {
	it("hides the drawing overlay's item while another opencua item is shown and shows it when none is", async () => {
		if (scratch === undefined) throw new Error("missing scratch directory");
		const state = join(scratch, "drawing");

		const alone = await hold([helper, "drawing"], state);
		expect(alone.answer).toBe("shown");
		await alone.release();

		const menu = await hold([helper, "visible"], state);
		const besideMenu = await hold([helper, "drawing"], state);
		expect([menu.answer, besideMenu.answer]).toEqual(["shown", "hidden"]);
		await Promise.all([menu.release(), besideMenu.release()]);

		const history = await hold([recorder, "menubar", state], state);
		const besideHistory = await hold([helper, "drawing"], state);
		expect([history.answer, besideHistory.answer]).toEqual(["held", "hidden"]);
		await Promise.all([history.release(), besideHistory.release()]);
	});
});

describe("#given cua-history running #when a menu helper starts #then the history menu is the only opencua item", () => {
	it("hides the helper while the recorder holds the menu bar and shows it again after", async () => {
		if (scratch === undefined) throw new Error("missing scratch directory");
		const state = join(scratch, "history");

		const history = await hold([recorder, "menubar", state], state);
		const during = await hold([helper, "visible"], state);
		expect([history.answer, during.answer]).toEqual(["held", "hidden"]);

		await Promise.all([history.release(), during.release()]);
		const after = await hold([helper, "visible"], state);
		expect(after.answer).toBe("shown");
		await after.release();
	});
});
