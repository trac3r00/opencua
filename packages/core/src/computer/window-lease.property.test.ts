import { describe, expect, it } from "bun:test";
import { MAX_LEASE_MS, parseLeaseFile } from "./window-lease.js";

const SEED = Number(process.env["LEASE_SEED"] ?? 20261108);
const CASES = 3000;

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

type Json = Record<string, unknown>;

function valid(index: number): Json {
	const granted = Date.parse("2026-11-08T05:00:00.000Z");
	return {
		id: `L-${index}`,
		holder: "claude-code",
		target: { bundleId: "com.apple.TextEdit", pid: 4242, startedAt: "Sat Nov  8 04:00:00 2026", windowId: 77 },
		tools: ["click"],
		grantedAt: new Date(granted).toISOString(),
		expiresAt: new Date(granted + 60_000).toISOString(),
		grantedBy: "cli",
	};
}

interface Mutation {
	readonly name: string;
	readonly keep: boolean;
	readonly apply: (entry: Json, next: () => number) => void;
}

const target = (entry: Json) => entry["target"] as Json;
const pick = <T>(next: () => number, values: readonly T[]): T => values[Math.floor(next() * values.length)] as T;
const junk = [null, 0, -1, 1.5, "", " ", true, [], {}, Number.NaN];

const MUTATIONS: readonly Mutation[] = [
	{ name: "unchanged", keep: true, apply: () => {} },
	{ name: "unknown field", keep: true, apply: (entry) => Object.assign(entry, { extra: { nested: [1] } }) },
	{ name: "note", keep: true, apply: (entry) => Object.assign(entry, { note: "for the demo" }) },
	{
		name: "whole-window region",
		keep: true,
		apply: (entry, next) =>
			Object.assign(target(entry), { region: { x: next() * 100, y: 0, width: 1 + next() * 500, height: 1 } }),
	},
	{
		name: "duplicate tools",
		keep: true,
		apply: (entry) => Object.assign(entry, { tools: ["click", "click", "type"] }),
	},
	{
		name: "max duration",
		keep: true,
		apply: (entry) =>
			Object.assign(entry, {
				expiresAt: new Date(Date.parse(entry["grantedAt"] as string) + MAX_LEASE_MS).toISOString(),
			}),
	},
	...["id", "holder", "tools", "grantedAt", "expiresAt", "grantedBy", "target"].map(
		(field): Mutation => ({ name: `missing ${field}`, keep: false, apply: (entry) => delete entry[field] }),
	),
	...["bundleId", "pid", "startedAt", "windowId"].map(
		(field): Mutation => ({
			name: `missing target.${field}`,
			keep: false,
			apply: (entry) => delete target(entry)[field],
		}),
	),
	...["id", "holder", "grantedBy"].map(
		(field): Mutation => ({
			name: `junk ${field}`,
			keep: false,
			apply: (entry, next) => Object.assign(entry, { [field]: pick(next, junk) }),
		}),
	),
	...["pid", "windowId"].map(
		(field): Mutation => ({
			name: `junk target.${field}`,
			keep: false,
			apply: (entry, next) =>
				Object.assign(target(entry), { [field]: pick(next, [0, -5, 1.5, "77", null, 2 ** 60]) }),
		}),
	),
	{ name: "empty tools", keep: false, apply: (entry) => Object.assign(entry, { tools: [] }) },
	{
		name: "unknown tool",
		keep: false,
		apply: (entry, next) =>
			Object.assign(entry, { tools: ["click", pick(next, ["shell", "Click", "", "capture "])] }),
	},
	{
		name: "expiry not after grant",
		keep: false,
		apply: (entry) => Object.assign(entry, { expiresAt: entry["grantedAt"] }),
	},
	{
		name: "over max duration",
		keep: false,
		apply: (entry) =>
			Object.assign(entry, {
				expiresAt: new Date(Date.parse(entry["grantedAt"] as string) + MAX_LEASE_MS + 1).toISOString(),
			}),
	},
	{
		name: "bad timestamp",
		keep: false,
		apply: (entry, next) => Object.assign(entry, { grantedAt: pick(next, ["yesterday", "", 0]) }),
	},
	{
		name: "bad region",
		keep: false,
		apply: (entry, next) =>
			Object.assign(target(entry), {
				region: pick(next, [
					{ x: 0, y: 0, width: 0, height: 5 },
					{ x: -1, y: 0, width: 5, height: 5 },
					{ x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 5 },
					{ x: 0, y: 0, width: 5 },
					"0,0,5,5",
				]),
			}),
	},
	{ name: "note not a string", keep: false, apply: (entry) => Object.assign(entry, { note: 5 }) },
];

describe("#given generated lease entries #when the file is parsed #then exactly the specified-valid entries survive, unweakened", () => {
	it(`holds for ${CASES} generated files (seed ${SEED})`, () => {
		const next = random(SEED);
		const executed = new Map<string, number>();
		const failing: string[] = [];
		for (let index = 0; index < CASES; index += 1) {
			const count = 1 + Math.floor(next() * 4);
			const entries: Json[] = [];
			const expectedIds: string[] = [];
			for (let slot = 0; slot < count; slot += 1) {
				const entry = structuredClone(valid(index * 10 + slot));
				const mutation = pick(next, MUTATIONS);
				mutation.apply(entry, next);
				entries.push(entry);
				executed.set(mutation.name, (executed.get(mutation.name) ?? 0) + 1);
				if (mutation.keep) expectedIds.push(entry["id"] as string);
			}
			let parsed: ReturnType<typeof parseLeaseFile>;
			try {
				parsed = parseLeaseFile(JSON.stringify({ version: 1, leases: entries }));
			} catch (error) {
				failing.push(`threw ${String(error)} on ${JSON.stringify(entries)}`);
				continue;
			}
			const ids = parsed.map((lease) => lease.id);
			if (JSON.stringify(ids) !== JSON.stringify(expectedIds)) {
				failing.push(
					`kept ${JSON.stringify(ids)} expected ${JSON.stringify(expectedIds)} from ${JSON.stringify(entries)}`,
				);
			}
			for (const lease of parsed) {
				if (lease.tools.length === 0 || new Set(lease.tools).size !== lease.tools.length)
					failing.push(`weak tools ${lease.id}`);
				if (Date.parse(lease.expiresAt) - Date.parse(lease.grantedAt) > MAX_LEASE_MS)
					failing.push(`long ${lease.id}`);
				if ("extra" in lease) failing.push(`unknown field leaked into ${lease.id}`);
			}
		}
		expect(
			MUTATIONS.filter((mutation) => (executed.get(mutation.name) ?? 0) === 0).map((mutation) => mutation.name),
		).toEqual([]);
		expect(failing.slice(0, 5)).toEqual([]);
	});
});
