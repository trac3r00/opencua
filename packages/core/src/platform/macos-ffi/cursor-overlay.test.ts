import { describe, expect, it } from "bun:test";
import { vi } from "@opencua/test-support";

import { withCursorIdentity } from "../../computer/cursor-scope.js";
import {
	AGENT_GLIDE_MILLISECONDS,
	type OverlayTransport,
	agentPaced,
	createCursorOverlay,
	glideWaitMilliseconds,
} from "./cursor-overlay.js";

function fakeTransport(): OverlayTransport & { sends: string[]; closed: boolean } {
	const state = { sends: [] as string[], closed: false };
	return {
		send(command: string, pid?: number) {
			state.sends.push(`${pid === undefined ? "" : `pid ${pid} `}${command}`);
		},
		close() {
			state.closed = true;
		},
		get sends() {
			return state.sends;
		},
		get closed() {
			return state.closed;
		},
	};
}

describe("#given an overlay transport #when driven #then it streams set/hide commands lazily", () => {
	it("resolves the transport once and forwards positioning commands", () => {
		const transport = fakeTransport();
		const factory = vi.fn(() => transport);
		const overlay = createCursorOverlay(factory);

		overlay.set({ x: 800, y: 500 });
		overlay.set({ x: 12, y: 34 });
		overlay.hide();
		overlay.close();

		expect(factory).toHaveBeenCalledTimes(1);
		// close() must NOT emit "quit": the daemon is shared across commands and
		// self-terminates on its idle timeout. Quitting here is the "cursor never
		// showed" bug (it died the instant a single verb's process exited).
		expect(transport.sends).toEqual(["set 800 500\n", "set 12 34\n", "hide\n"]);
		expect(transport.closed).toBe(true);
	});
});

describe("#given an overlay transport #when highlighting a window #then it forwards a highlight command", () => {
	it("sends rounded window bounds", () => {
		const transport = fakeTransport();
		const overlay = createCursorOverlay(() => transport);

		overlay.highlight({ x: 100, y: 200, width: 800, height: 600 });

		expect(transport.sends).toEqual(["highlight 100 200 800 600\n"]);
	});
});

describe("#given keyboard mode #when selected #then it serializes the native mode", () => {
	it("sends the keyboard mode command", () => {
		const transport = fakeTransport();
		const overlay = createCursorOverlay(() => transport);

		overlay.setMode("keyboard");
		overlay.setMode("drag", 7);
		overlay.setScrollMode?.("left", 7);
		overlay.keyPress?.(7);

		expect(transport.sends).toEqual([
			"mode keyboard\n",
			"pid 7 mode drag\n",
			"pid 7 mode scroll left\n",
			"pid 7 mode keypress\n",
		]);
	});
});

describe("#given paced pointer samples #when tracking a gesture #then native playback does not ease them again", () => {
	it("sends exact tracking commands rather than glide commands", () => {
		const transport = fakeTransport();
		const overlay = createCursorOverlay(() => transport);

		overlay.track?.({ x: -100.4, y: 240.6 });

		expect(transport.sends).toEqual(["track -100 241\n"]);
	});

	it("keeps paced samples and cleanup scoped to their app marker", () => {
		const transport = fakeTransport();
		const overlay = createCursorOverlay(() => transport);

		overlay.track?.({ x: 100.4, y: 240.6 }, 321);
		overlay.close();

		expect(transport.sends).toEqual(["pid 321 track 100 241\n", "pid 321 hide\n"]);
	});
});

describe("#given two overlay instances #when one closes #then it hides only the pids it used", () => {
	it("tracks marker pids across positioning and mode commands", () => {
		const firstTransport = fakeTransport();
		const secondTransport = fakeTransport();
		const first = createCursorOverlay(() => firstTransport);
		const second = createCursorOverlay(() => secondTransport);

		first.set({ x: 10, y: 20 }, 101);
		first.setMode("thinking", 101);
		second.set({ x: 30, y: 40 }, 202);
		second.setMode("scroll", 202);
		first.close();

		expect(firstTransport.sends).toEqual(["pid 101 set 10 20\n", "pid 101 mode thinking\n", "pid 101 hide\n"]);
		expect(secondTransport.sends).toEqual(["pid 202 set 30 40\n", "pid 202 mode scroll\n"]);
		expect(firstTransport.closed).toBe(true);
		expect(secondTransport.closed).toBe(false);
	});

	it("cleans up each worker's pid on its own transport after the identity scope ends", () => {
		const transports = new Map<string | undefined, ReturnType<typeof fakeTransport>>();
		const overlay = createCursorOverlay((identity) => {
			const transport = fakeTransport();
			transports.set(identity, transport);
			return transport;
		});

		withCursorIdentity("first", () => overlay.set({ x: 10, y: 20 }, 101));
		withCursorIdentity("second", () => overlay.set({ x: 30, y: 40 }, 202));
		overlay.close();

		expect(transports.get("first")?.sends).toEqual(["pid 101 set 10 20\n", "pid 101 hide\n"]);
		expect(transports.get("second")?.sends).toEqual(["pid 202 set 30 40\n", "pid 202 hide\n"]);
		expect([...transports.values()].every((transport) => transport.closed)).toBe(true);
	});
});

describe("#given no overlay transport #when driven #then every call is a safe no-op", () => {
	it("never throws when the factory yields nothing", () => {
		const overlay = createCursorOverlay(() => undefined);

		expect(() => {
			overlay.set({ x: 1, y: 2 });
			overlay.hide();
			overlay.close();
		}).not.toThrow();
	});
});

describe("#given invalid core motion options #when creating the overlay #then validation precedes native startup", () => {
	it("rejects out-of-range geometry without opening the transport", () => {
		const factory = vi.fn(fakeTransport);

		expect(() => createCursorOverlay(factory, { style: "signature_arc", arcSize: 2 })).toThrow(/arcSize/);
		expect(factory).not.toHaveBeenCalled();
	});
});

describe("#given a motion style with no duration #when an action glides #then it waits at agent pace", () => {
	const from = { x: 0, y: 0 };
	const to = { x: 300, y: 0 };

	it("glides a human-paced style in the agent glide time", () => {
		expect(glideWaitMilliseconds({ style: "spring_settle" }, from, to)).toBeGreaterThan(AGENT_GLIDE_MILLISECONDS);
		const paced = agentPaced({ style: "spring_settle" });
		const wait = paced === undefined ? Number.POSITIVE_INFINITY : glideWaitMilliseconds(paced, from, to);
		expect(wait).toBeGreaterThan(0);
		expect(wait).toBeLessThanOrEqual(AGENT_GLIDE_MILLISECONDS);
	});

	it("keeps a duration the person configured", () => {
		const configured = { style: "spring_settle", glideDurationMs: 400 } as const;
		expect(agentPaced(configured)).toBe(configured);
	});
});
