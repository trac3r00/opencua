import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CORPUS_SCRIPTS, CORPUS_SEED, type ScriptStep, cursorMuxScripts } from "./cursor-mux-scripts.js";
import { CursorMux, type MuxKind } from "./cursor-mux.js";

const LETTER: Record<MuxKind, string> = { down: "D", drag: "G", up: "U", move: "M" };
const KIND = { D: "down", G: "drag", U: "up", M: "move" } as const;

function runPort(steps: readonly ScriptStep[]): string {
	const out: string[] = [];
	const mux = new CursorMux((kind, point) => out.push(`${LETTER[kind]}${point.x},${point.y}`));
	for (const step of steps) {
		if (step.type === "pump") mux.pump(step.at);
		else mux.cursor(step.tag, KIND[step.kind], { x: step.x, y: step.y }, step.context, step.at);
	}
	return out.join(" ");
}

describe("#given scripts the native CursorMux recorded #when the TypeScript port replays them #then every merged stream is identical", () => {
	it(`matches all ${CORPUS_SCRIPTS} scripts of seed ${CORPUS_SEED}`, () => {
		const corpus: unknown = JSON.parse(
			readFileSync(fileURLToPath(new URL("cursor-mux.corpus.json", import.meta.url)), "utf8"),
		);
		if (typeof corpus !== "object" || corpus === null || !("outputs" in corpus) || !Array.isArray(corpus.outputs)) {
			throw new Error("corpus has no outputs");
		}
		const outputs = corpus.outputs;
		const scripts = cursorMuxScripts();
		expect(outputs).toHaveLength(scripts.length);
		const mismatches = scripts.flatMap((steps, index) => {
			const got = runPort(steps);
			return got === outputs[index]
				? []
				: [`script ${index}\n  native: ${String(outputs[index])}\n  port:   ${got}`];
		});
		expect(mismatches.slice(0, 3)).toEqual([]);
		const switching = outputs.filter((line: unknown) => typeof line === "string" && line.split(" ").length > 4);
		expect(switching.length).toBeGreaterThan(CORPUS_SCRIPTS / 2);
	});
});
