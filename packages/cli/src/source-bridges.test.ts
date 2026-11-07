import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const ENTRY = "cli.ts";
const RELATIVE_SPECIFIER = /(?:from|import)\s*\(?\s*["'](\.\/[^"']+)["']/g;

const isCodeLine = (line: string): boolean => line.trim() !== "" && !line.trimStart().startsWith("//");

const relativeImportsOf = (file: string): string[] =>
	[...readFileSync(join(SRC_DIR, file), "utf8").matchAll(RELATIVE_SPECIFIER)]
		.map((match) => match[1] ?? "")
		.filter((specifier) => specifier !== "")
		.map((specifier) => specifier.slice("./".length));

describe("source bridges", () => {
	test("#given every .js file in src #when its code lines are read #then it re-exports exactly its sibling .ts and the sibling exists", () => {
		const violations = readdirSync(SRC_DIR)
			.filter((file) => file.endsWith(".js"))
			.flatMap((file) => {
				const name = file.slice(0, -".js".length);
				const codeLines = readFileSync(join(SRC_DIR, file), "utf8").split("\n").filter(isCodeLine);
				const expected = [`export * from "./${name}.ts";`];
				const problems: string[] = [];
				if (JSON.stringify(codeLines) !== JSON.stringify(expected)) {
					problems.push(`${file}: code lines ${JSON.stringify(codeLines)}`);
				}
				if (!existsSync(join(SRC_DIR, `${name}.ts`))) {
					problems.push(`${file}: sibling ${name}.ts is missing`);
				}
				return problems;
			});
		expect(violations).toEqual([]);
	});

	test("#given cli.ts and its transitive relative imports #when the import graph is walked #then every imported .ts module has a .js bridge", () => {
		const visited = new Set<string>([ENTRY]);
		const queue = [ENTRY];
		const problems: string[] = [];
		for (let index = 0; index < queue.length; index++) {
			const file = queue[index] ?? ENTRY;
			for (const specifier of relativeImportsOf(file)) {
				const target = specifier.replace(/\.js$/, ".ts");
				if (!existsSync(join(SRC_DIR, target))) {
					problems.push(`${file} imports ${specifier}: ${target} is missing`);
					continue;
				}
				if (!visited.has(target)) {
					visited.add(target);
					queue.push(target);
				}
			}
		}
		for (const target of visited) {
			if (target === ENTRY) continue;
			const bridge = target.replace(/\.ts$/, ".js");
			if (!existsSync(join(SRC_DIR, bridge))) {
				problems.push(`${target} is imported as ./${bridge} but the bridge is missing`);
			}
		}
		expect(problems).toEqual([]);
	});
});
