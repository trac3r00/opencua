import { describe, expect, it } from "bun:test";
import { diffAxTreeChanges, diffAxTreesByKey } from "./diff.js";
import type { AXTreeElement } from "./types.js";

// Property test (seeded generated cases, not coverage-guided fuzzing). The oracle is the edit
// script the generator applied, not the diff algorithm: every case knows how many elements it
// added, removed and changed. Replay one case with DIFF_SEED=<seed>.
const SEED = Number(process.env["DIFF_SEED"] ?? 20261107);
const CASES = 400;

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

const ROLES = ["Button", "Edit", "Text", "Row"];
const LABELS = ["", "OK", "Cancel", "검색", "e\u0301", "😀 emoji", "a|b", "  "];

interface Generated {
	readonly before: AXTreeElement[];
	readonly after: AXTreeElement[];
	readonly added: number;
	readonly removed: number;
	readonly changed: number;
	readonly family: string;
}

function make(id: number, role: string, label: string, y: number, value: string | null): AXTreeElement {
	return {
		id,
		role,
		label,
		value,
		frame: { x: id % 7, y, width: 10 + (id % 5), height: 10 },
		actions: [],
		children: [],
	};
}

// Elements of one case get distinct (role, label, y) keys unless the family asks for duplicates,
// so the expected counts follow from the edit script alone.
function generate(next: () => number, index: number): Generated {
	const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] ?? (items[0] as T);
	const family = ["empty", "unique", "duplicates", "renumbered"][index % 4] ?? "unique";
	const size = family === "empty" ? 0 : 1 + Math.floor(next() * 30);
	const before: AXTreeElement[] = [];
	for (let item = 0; item < size; item += 1) {
		const y = family === "duplicates" ? 100 * Math.floor(item / 3) : item * 20;
		const label = family === "duplicates" ? "Same" : pick(LABELS);
		before.push(make(item + 1, family === "duplicates" ? "Row" : pick(ROLES), label, y, next() < 0.5 ? null : "v"));
	}
	const kept: AXTreeElement[] = [];
	let removed = 0;
	let changed = 0;
	for (const element of before) {
		const roll = next();
		if (roll < 0.2 && family !== "duplicates") {
			removed += 1;
		} else if (roll < 0.4 && family !== "duplicates") {
			changed += 1;
			kept.push({ ...element, value: `${element.value ?? ""}*` });
		} else {
			kept.push(element);
		}
	}
	let added = 0;
	const extra = family === "empty" ? Math.floor(next() * 3) : Math.floor(next() * 4);
	for (let item = 0; item < extra; item += 1) {
		kept.push(make(1000 + item, "Added", `new ${item}`, 10_000 + item * 20, null));
		added += 1;
	}
	if (family === "duplicates" && before.length > 0) {
		// One more copy of an existing row is an addition, not a change.
		const twin = before[0];
		if (twin !== undefined) {
			kept.push({ ...twin, id: 5000 });
			added += 1;
		}
	}
	// Renumbered trees get new ids and a different order; content identity must still match.
	const after =
		family === "renumbered" ? kept.map((element, position) => ({ ...element, id: 9000 + position })).reverse() : kept;
	return { before, after, added, removed, changed, family };
}

describe("#given generated accessibility tree edits #when diffed by content key #then the counts match the applied edit script", () => {
	it(`holds for ${CASES} seeded cases across every family (seed ${SEED})`, () => {
		const next = random(SEED);
		const executed = new Map<string, number>();
		const failures: string[] = [];
		for (let index = 0; index < CASES; index += 1) {
			const generated = generate(next, index);
			const summary = diffAxTreesByKey(generated.before, generated.after);
			const changes = diffAxTreeChanges(generated.before, generated.after);
			const expected = { added: generated.added, removed: generated.removed, changed: generated.changed };
			const listed = {
				added: changes.added.length,
				removed: changes.removed.length,
				changed: changes.changed.length,
			};
			if (
				JSON.stringify(summary) !== JSON.stringify(expected) ||
				JSON.stringify(listed) !== JSON.stringify(expected)
			) {
				failures.push(
					`case ${index} (${generated.family}): want ${JSON.stringify(expected)} got ${JSON.stringify(summary)} listed ${JSON.stringify(listed)}`,
				);
			}
			executed.set(generated.family, (executed.get(generated.family) ?? 0) + 1);
		}
		expect(failures).toEqual([]);
		expect(Object.fromEntries(executed)).toEqual({ empty: 100, unique: 100, duplicates: 100, renumbered: 100 });
	});

	it("reports nothing when a tree is diffed against itself or an empty tree against an empty tree", () => {
		const next = random(SEED + 1);
		for (let index = 0; index < 50; index += 1) {
			const { before } = generate(next, index);
			expect(diffAxTreesByKey(before, before)).toEqual({ added: 0, removed: 0, changed: 0 });
		}
		expect(diffAxTreesByKey([], [])).toEqual({ added: 0, removed: 0, changed: 0 });
	});
});
