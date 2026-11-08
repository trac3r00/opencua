import { describe, expect, it } from "bun:test";
import { type ShellCommand, SurfaceDriver, parseAgentLine } from "./surface-driver.js";

describe("#given agent channel lines #when parsed #then they match the native ParseAgentLine rules", () => {
	it("accepts the native self-test line and rejects what the native parser rejects", () => {
		expect(parseAgentLine("4294967295 1 G 12.5 300")).toEqual({
			tag: 4294967295,
			context: true,
			kind: "drag",
			point: { x: 12.5, y: 300 },
		});
		for (const bad of [
			"0 0 D 1 1",
			"4294967296 0 D 1 1",
			"7 0 X 1 1",
			"7 0 D 1",
			"",
			"7 0 D nan 1",
			"7 0 D 1 Infinity",
		]) {
			expect(parseAgentLine(bad)).toBeUndefined();
		}
	});
});

describe("#given two agents on a shared surface #when their strokes overlap #then the shell gets one merged pointer stream and both marks", () => {
	it("sends marks for every agent at once and the waiting stroke after the first, at its own pace", () => {
		const commands: ShellCommand[] = [];
		const driver = new SurfaceDriver((command) => commands.push(command));
		driver.line("1 0 D 0 0", 0.0);
		driver.line("2 0 D 50 50", 0.05);
		driver.line("2 0 G 60 55", 0.06);
		driver.line("2 0 U 60 55", 0.07);
		driver.line("1 0 U 0 0", 0.2);
		driver.tick(0.3);
		const pointer = () =>
			commands
				.filter((command) => command.t === "pointer")
				.map((command) => `${command.kind} ${command.x},${command.y}`);
		expect(pointer()).toEqual(["down 0,0", "up 0,0", "down 50,50"]);
		expect(
			commands.filter((command) => command.t === "mark").map((command) => (command.t === "mark" ? command.tag : 0)),
		).toEqual([1, 2, 2, 2, 1]);
		driver.tick(0.31);
		driver.tick(0.32);
		expect(pointer().slice(3)).toEqual(["drag 60,55", "up 60,55"]);
		expect(driver.line("garbage", 0.4)).toBe(false);
	});
});
