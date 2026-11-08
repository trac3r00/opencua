import { describe, expect, it } from "bun:test";
import { surfaceBinaryPath } from "./owned-surfaces.js";

describe("#given the committed opencua-surface binary #when its cursor multiplexer self-test runs #then interleaved cursors keep valid strokes", () => {
	it("passes strokes, context-click replay and hover cases", async () => {
		const run = Bun.spawn([surfaceBinaryPath(), "--self-test"], { stdout: "pipe", stderr: "pipe" });
		const [code, stdout, stderr] = await Promise.all([
			run.exited,
			new Response(run.stdout).text(),
			new Response(run.stderr).text(),
		]);
		expect(stderr).toBe("");
		const lines = stdout.trim().split("\n");
		expect(lines.at(-1)).toBe("SELF-TEST OK");
		expect(lines.slice(0, -1)).toEqual(["waypoint replay: 500 attempted, 500 executed, 0 discarded, 0 failing"]);
		expect(code).toBe(0);
	});
});
