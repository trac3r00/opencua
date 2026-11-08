import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CORPUS_SCRIPTS, CORPUS_SEED, cursorMuxScripts, replayInput } from "./cursor-mux-scripts.js";

const binary = process.argv[2];
if (binary === undefined) throw new Error("usage: record-cursor-mux-corpus.ts <opencua-surface binary>");
const scripts = cursorMuxScripts();
const result = spawnSync(binary, ["--replay"], { input: replayInput(scripts), encoding: "utf8" });
if (result.status !== 0) throw new Error(`replay failed: ${result.stderr}`);
const outputs = result.stdout.split("\n").slice(0, scripts.length);
if (outputs.length !== scripts.length) throw new Error(`expected ${scripts.length} outputs, got ${outputs.length}`);
writeFileSync(
	fileURLToPath(new URL("cursor-mux.corpus.json", import.meta.url)),
	`${JSON.stringify({ seed: CORPUS_SEED, scripts: CORPUS_SCRIPTS, outputs })}\n`,
);
