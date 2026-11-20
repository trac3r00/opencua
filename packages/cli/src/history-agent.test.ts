import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateHistoryText } from "./history-agent.js";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function fixture(body: string): string {
	const directory = mkdtempSync(join(tmpdir(), "opencua-history-agent-"));
	directories.push(directory);
	const executable = join(directory, "fixture");
	writeFileSync(executable, `#!/usr/bin/env node\n${body}\n`);
	chmodSync(executable, 0o755);
	return executable;
}

const expectedArguments = [
	"--print",
	"--no-session",
	"--no-tools",
	"--no-extensions",
	"--no-skills",
	"--no-context-files",
	"--no-approve",
	"--offline",
	"-",
];

describe("#given an ephemeral history adapter #when generation runs #then it obeys the process contract", () => {
	it("#given deterministic Unicode prompts #when OmO reads stdin #then it returns trimmed output and fixed arguments", async () => {
		const prompts = Array.from({ length: 12 }, (_, index) => `history ${index}: 한글🙂 café Ω`);
		for (const prompt of prompts) {
			const executable = fixture(`
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
	const expected = ${JSON.stringify(expectedArguments)};
	if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) process.exit(31);
	process.stdout.write("  " + input + "  ");
});`);
			await expect(generateHistoryText(prompt, { executable })).resolves.toBe(prompt);
		}
	}, 30_000);

	it("#given shell metacharacters in the prompt #when generation runs #then they remain stdin data", async () => {
		const prompt = `$(printf shell-must-not-run); '"; Ω`;
		const executable = fixture(`
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => process.stdout.write(input));`);
		await expect(generateHistoryText(prompt, { executable })).resolves.toBe(prompt);
	}, 30_000);

	it("#given invalid JSON text #when generation succeeds #then raw trimmed text is returned", async () => {
		const executable = fixture(`process.stdout.write("  not-json {  ");`);
		await expect(generateHistoryText("prompt", { executable })).resolves.toBe("not-json {");
	}, 30_000);

	it("#given whitespace-only stdout #when generation succeeds #then it reports empty output", async () => {
		const executable = fixture(`process.stdout.write(" \\n\\t ");`);
		await expect(generateHistoryText("prompt", { executable })).rejects.toThrow(
			"History generation returned empty text.",
		);
	}, 30_000);

	it("#given oversized stdout #when generation exceeds its bound #then it terminates with an oversize error", async () => {
		const executable = fixture(`process.stdout.write("x".repeat(262145));`);
		await expect(generateHistoryText("prompt", { executable })).rejects.toThrow(
			"History generation output exceeds 262144 bytes.",
		);
	}, 30_000);

	it("#given oversized stderr #when diagnostics exceed their bound #then it terminates without exposing them", async () => {
		const executable = fixture(`process.stderr.write("private".repeat(40000));`);
		await expect(generateHistoryText("prompt", { executable })).rejects.toThrow(
			"History generation output exceeds 262144 bytes.",
		);
	}, 30_000);

	it("#given a prompt beyond the UTF-8 byte bound #when generation is requested #then no process is needed", async () => {
		const prompt = "🙂".repeat(30_001);
		await expect(generateHistoryText(prompt, { executable: "/missing/never-started" })).rejects.toThrow(
			"History generation prompt exceeds 120000 UTF-8 bytes.",
		);
	}, 30_000);

	it("#given a nonzero child exit #when generation fails #then stderr content is not returned", async () => {
		const executable = fixture(`process.stderr.write("secret model content"); process.exit(7);`);
		await expect(generateHistoryText("secret prompt", { executable })).rejects.toThrow(
			"History generation failed with exit code 7.",
		);
	}, 30_000);

	it("#given includeFailureDetail #when the child exits nonzero #then its last output line explains why", async () => {
		const executable = fixture(`process.stdout.write("working\\nYou've hit your weekly limit"); process.exit(1);`);
		await expect(
			generateHistoryText("task", { executable, label: "Buddy agent", includeFailureDetail: true }),
		).rejects.toThrow("Buddy agent failed with exit code 1: You've hit your weekly limit");
	}, 30_000);

	it("#given an abort signal #when generation starts #then it terminates with an abort error", async () => {
		const executable = fixture("process.stdin.resume();");
		const controller = new AbortController();
		const result = generateHistoryText("prompt", { executable, signal: controller.signal });
		controller.abort();
		await expect(result).rejects.toThrow("History generation aborted.");
	}, 30_000);

	it("#given a missing executable #when generation starts #then it reports the configured path", async () => {
		await expect(generateHistoryText("prompt", { executable: "/missing/opencua-history-omo" })).rejects.toThrow(
			"History generation executable is unavailable: /missing/opencua-history-omo.",
		);
	}, 30_000);
});
