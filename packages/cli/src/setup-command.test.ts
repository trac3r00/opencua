import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";
import { registerLifecycleCommands } from "./lifecycle-commands.js";

afterEach(() => {
	process.exitCode = 0;
});

describe("#given setup flags #when the command runs #then the injected runner receives parsed options", () => {
	it.each([
		{ args: [], expected: { doctor: true } },
		{ args: ["--yes", "--no-doctor"], expected: { yes: true, doctor: false } },
	])("forwards $args without running setup during parsing", async ({ args, expected }) => {
		const calls: unknown[] = [];
		const program = new Command();
		registerLifecycleCommands(program, {
			isJsonOutput: () => false,
			runSetup: (options) => {
				calls.push(options);
				return 7;
			},
		});
		await program.parseAsync(["setup", ...args], { from: "user" });
		expect(calls).toEqual([expected]);
		expect(process.exitCode).toBe(7);
	});
});
