/**
 * Seeded multi-cursor input scripts for the CursorMux conformance corpus. The same scripts drive the
 * native mux (opencua-surface --replay, which recorded cursor-mux.corpus.json) and the TypeScript
 * port. Regenerate the corpus on macOS with:
 *   bun packages/core/src/surface/record-cursor-mux-corpus.ts <path to opencua-surface>
 */
export type ScriptStep =
	| {
			readonly type: "event";
			readonly tag: number;
			readonly kind: "D" | "G" | "U" | "M";
			readonly context: boolean;
			readonly x: number;
			readonly y: number;
			readonly at: number;
	  }
	| { readonly type: "pump"; readonly at: number };

export const CORPUS_SEED = 20261107;
export const CORPUS_SCRIPTS = 400;

function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

/** Strokes, palette picks (one row band, so picks replace each other), hovers and pumps on a millisecond clock. */
export function cursorMuxScripts(seed = CORPUS_SEED, count = CORPUS_SCRIPTS): ScriptStep[][] {
	const next = random(seed);
	const scripts: ScriptStep[][] = [];
	for (let index = 0; index < count; index += 1) {
		const steps: ScriptStep[] = [];
		const cursors = 1 + Math.floor(next() * 4);
		let ms = 0;
		const tick = () => {
			ms += Math.floor(next() * (next() < 0.1 ? 1500 : 40));
			return ms / 1000;
		};
		for (let action = 0; action < 4 + Math.floor(next() * 12); action += 1) {
			const tag = 1 + Math.floor(next() * cursors);
			const roll = next();
			if (roll < 0.45) {
				let x = Math.floor(next() * 500);
				let y = Math.floor(next() * 300);
				steps.push({ type: "event", tag, kind: "D", context: false, x, y, at: tick() });
				for (let point = 0; point < Math.floor(next() * 6); point += 1) {
					x += Math.floor(next() * 21) - 10;
					y += Math.floor(next() * 21) - 10;
					steps.push({ type: "event", tag, kind: "G", context: false, x, y, at: tick() });
				}
				steps.push({ type: "event", tag, kind: "U", context: false, x, y, at: tick() });
			} else if (roll < 0.75) {
				const x = 20 + 16 * Math.floor(next() * 8) + (next() < 0.4 ? Math.floor(next() * 6) : 0);
				const at = tick();
				steps.push({ type: "event", tag, kind: "D", context: true, x, y: 1317, at });
				steps.push({ type: "event", tag, kind: "U", context: true, x, y: 1317, at });
			} else if (roll < 0.85) {
				steps.push({
					type: "event",
					tag,
					kind: "M",
					context: false,
					x: Math.floor(next() * 500),
					y: Math.floor(next() * 300),
					at: tick(),
				});
			} else {
				steps.push({ type: "pump", at: tick() });
			}
		}
		steps.push({ type: "pump", at: ms / 1000 + 3 }, { type: "pump", at: ms / 1000 + 6 });
		scripts.push(steps);
	}
	return scripts;
}

export function replayInput(scripts: readonly ScriptStep[][]): string {
	return scripts
		.map(
			(steps) =>
				`${steps
					.map((step) =>
						step.type === "pump"
							? `p ${step.at}`
							: `e ${step.tag} ${step.kind} ${step.context ? 1 : 0} ${step.x} ${step.y} ${step.at}`,
					)
					.join("\n")}\nend`,
		)
		.join("\n")
		.concat("\n");
}
