import { describe, expect, it } from "bun:test";
import {
	AudioReportError,
	type AudioStream,
	SILENT_PEAK,
	readPactlSinkInputs,
	readPwDump,
	readWasapiSessions,
	streamsOfProcessTree,
} from "./audio-sessions.js";

// Seeded generated-case property tests. Each generator also returns the streams it encoded, so
// the oracle is the generator's own record, never the reader. Replay with AUDIO_SEED=<seed>.
const SEED = Number(process.env["AUDIO_SEED"] ?? 20261107);
const CASES = 300;

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

interface Case {
	readonly text: string;
	readonly expected: AudioStream[];
}

function pidText(next: () => number, value: number): number | string {
	return next() < 0.5 ? value : String(value);
}

function pwDumpCase(next: () => number): Case {
	const items: unknown[] = [];
	const expected: AudioStream[] = [];
	const count = Math.floor(next() * 8);
	for (let index = 0; index < count; index += 1) {
		const pid = 1 + Math.floor(next() * 40_000);
		const running = next() < 0.5;
		const kind = next();
		if (kind < 0.6) {
			items.push({
				id: 30 + index,
				type: "PipeWire:Interface:Node",
				info: {
					state: running ? "running" : "idle",
					props: { "media.class": "Stream/Output/Audio", "application.process.id": pidText(next, pid) },
				},
			});
			expected.push({ pid, playing: running, target: 30 + index });
		} else if (kind < 0.75) {
			items.push({
				id: 30 + index,
				type: "PipeWire:Interface:Node",
				info: { state: "running", props: { "media.class": "Stream/Input/Audio", "application.process.id": pid } },
			});
		} else if (kind < 0.85) {
			items.push({ id: 30 + index, type: "PipeWire:Interface:Link", info: {} });
		} else {
			items.push({
				id: 30 + index,
				type: "PipeWire:Interface:Node",
				info: {
					state: "running",
					props: { "media.class": "Stream/Output/Audio", "application.process.id": "0x10" },
				},
			});
		}
	}
	return { text: JSON.stringify(items), expected };
}

function pactlCase(next: () => number): Case {
	const items: unknown[] = [];
	const expected: AudioStream[] = [];
	const count = Math.floor(next() * 8);
	for (let index = 0; index < count; index += 1) {
		const pid = 1 + Math.floor(next() * 40_000);
		const corked = next() < 0.5;
		if (next() < 0.8) {
			items.push({
				index,
				corked,
				properties: { "application.process.id": pidText(next, pid), "media.name": "가나 🎵" },
			});
			expected.push({ pid, playing: !corked, target: index });
		} else {
			items.push({ index, corked, properties: { "media.name": "no owner" } });
		}
	}
	return { text: JSON.stringify(items), expected };
}

function wasapiCase(next: () => number): Case {
	const items: unknown[] = [];
	const expected: AudioStream[] = [];
	const count = Math.floor(next() * 8);
	for (let index = 0; index < count; index += 1) {
		const pid = 1 + Math.floor(next() * 40_000);
		const state = ["active", "inactive", "expired"][Math.floor(next() * 3)] ?? "active";
		const boundary = [0, SILENT_PEAK, SILENT_PEAK * 2, 1];
		const peak = next() < 0.4 ? (boundary[Math.floor(next() * boundary.length)] ?? 0) : next();
		items.push({ pid, peak, state });
		expected.push({ pid, playing: state === "active" && peak > SILENT_PEAK, peak });
	}
	return { text: JSON.stringify(items), expected };
}

describe("#given generated OS audio reports #when read #then the streams match what the report encoded", () => {
	const families = [
		["pw-dump", pwDumpCase, readPwDump],
		["pactl", pactlCase, readPactlSinkInputs],
		["WASAPI", wasapiCase, readWasapiSessions],
	] as const;
	for (const [name, generate, read] of families) {
		it(`reads ${CASES} seeded ${name} reports (seed ${SEED})`, () => {
			const next = random(SEED + name.length);
			const failures: string[] = [];
			let executed = 0;
			let nonEmpty = 0;
			for (let index = 0; index < CASES; index += 1) {
				const generated = generate(next);
				const got = read(generated.text);
				if (JSON.stringify(got) !== JSON.stringify(generated.expected))
					failures.push(`case ${index}: ${generated.text}`);
				executed += 1;
				if (generated.expected.length > 0) nonEmpty += 1;
			}
			expect(failures).toEqual([]);
			expect(executed).toBe(CASES);
			expect(nonEmpty).toBeGreaterThan(CASES / 2);
		});
	}
});

describe("#given malformed audio reports #when read #then each is rejected with AudioReportError", () => {
	it("rejects truncated JSON, non-list output, and WASAPI sessions with bad peaks or states", () => {
		const valid = JSON.stringify([{ pid: 5, peak: 0.5, state: "active" }]);
		const malformed: Array<[(text: string) => AudioStream[], string]> = [
			[readPwDump, "[{"],
			[readPwDump, "{}"],
			[readPactlSinkInputs, ""],
			[readPactlSinkInputs, '"text"'],
			[readWasapiSessions, valid.slice(0, -2)],
			[readWasapiSessions, JSON.stringify([{ pid: 5, peak: 1.5, state: "active" }])],
			[readWasapiSessions, JSON.stringify([{ pid: 5, peak: -0.1, state: "active" }])],
			[readWasapiSessions, JSON.stringify([{ pid: 5, peak: "0.5", state: "active" }])],
			[readWasapiSessions, JSON.stringify([{ pid: 5, peak: 0.5, state: "playing" }])],
		];
		for (const [read, text] of malformed) {
			expect(() => read(text)).toThrow(AudioReportError);
		}
		expect(readWasapiSessions(valid)).toEqual([{ pid: 5, playing: true, peak: 0.5 }]);
	});
});

describe("#given a process tree #when streams are matched to an app #then only the app and its descendants count", () => {
	it(`matches an independent descendant walk on ${CASES} generated trees, cycles included`, () => {
		const next = random(SEED + 99);
		const failures: string[] = [];
		for (let index = 0; index < CASES; index += 1) {
			const size = 1 + Math.floor(next() * 25);
			const parents = new Map<number, number>();
			for (let child = 2; child <= size; child += 1) parents.set(child, 1 + Math.floor(next() * (child - 1)));
			if (next() < 0.2 && size > 3) parents.set(1, size);
			const root = 1 + Math.floor(next() * size);
			const children = new Map<number, number[]>();
			for (const [child, parent] of parents) children.set(parent, [...(children.get(parent) ?? []), child]);
			const descendants = new Set<number>([root]);
			const queue = [root];
			for (let current = queue.shift(); current !== undefined; current = queue.shift()) {
				for (const child of children.get(current) ?? []) {
					if (!descendants.has(child)) {
						descendants.add(child);
						queue.push(child);
					}
				}
			}
			const streams = Array.from({ length: size + 3 }, (_, pid) => ({ pid: pid + 1, playing: true }));
			const got = streamsOfProcessTree(streams, root, parents).map((stream) => stream.pid);
			const want = streams.map((stream) => stream.pid).filter((pid) => descendants.has(pid));
			if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(`case ${index} root ${root}`);
		}
		expect(failures).toEqual([]);
	});
});
