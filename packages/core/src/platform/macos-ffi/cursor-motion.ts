import type { Socket } from "node:net";
import { planMove } from "../../../vendor/cua-cursor-motion.js";
import { type MotionSample, retargetSamples } from "../../computer/retarget.js";
import type { Point } from "../../types/index.js";
import type { CursorMotionConfig } from "./cursor-motion-config.js";

export interface CursorState extends Point {
	readonly shown: boolean;
	readonly reducedMotion: boolean;
	/** Native-reported overlay mode; absent on daemon builds that predate mode reporting. */
	readonly mode?: string;
}

function parseState(text: string): CursorState {
	const value: unknown = JSON.parse(text);
	if (
		typeof value !== "object" ||
		value === null ||
		!("x" in value) ||
		typeof value.x !== "number" ||
		!Number.isFinite(value.x) ||
		!("y" in value) ||
		typeof value.y !== "number" ||
		!Number.isFinite(value.y) ||
		!("shown" in value) ||
		typeof value.shown !== "boolean" ||
		!("reducedMotion" in value) ||
		typeof value.reducedMotion !== "boolean"
	) {
		throw new Error("Invalid cursor overlay state");
	}
	const record = value as { x: number; y: number; shown: boolean; reducedMotion: boolean; mode?: unknown };
	// "mode" is optional: daemon builds that predate mode reporting simply omit it.
	if (record.mode !== undefined && typeof record.mode !== "string") {
		throw new Error("Invalid cursor overlay state");
	}
	return {
		x: record.x,
		y: record.y,
		shown: record.shown,
		reducedMotion: record.reducedMotion,
		...(typeof record.mode === "string" ? { mode: record.mode } : {}),
	};
}

export function parseCursorState(text: string): CursorState {
	return parseState(text);
}

/** A move the overlay is playing: its samples (seconds from its start), start time (ms) and target. */
export interface FlyingMove {
	readonly samples: readonly MotionSample[];
	readonly startedAt: number;
	readonly target: Point;
}

/** A new target this close to the one still being flown to is the same target that moved (it scrolled or reflowed). */
export const RETARGET_RADIUS = 60;

function packet(style: CursorMotionConfig["style"], samples: readonly MotionSample[]): string {
	const arrival = samples.at(-1)?.t ?? 0;
	return `trajectory ${JSON.stringify({ style, arrival, samples: samples.map(({ t, x, y, heading }) => [t, x, y, heading]) })}\n`;
}

/**
 * Closed-loop aim: when the target moved a little while the cursor is still flying to it, the rest of
 * the flight is bent onto the new point (same velocity at the bend, see retargetSamples) instead of
 * starting a new move from a standstill. Otherwise a fresh move is planned.
 */
export function planCursorMotion(
	point: Point,
	state: CursorState,
	motion: CursorMotionConfig,
	flying: FlyingMove | undefined,
	now: number,
): { readonly command: string; readonly move: FlyingMove } {
	if (flying !== undefined && state.shown && !state.reducedMotion) {
		const elapsed = (now - flying.startedAt) / 1000;
		const arrival = flying.samples.at(-1)?.t ?? 0;
		const moved = Math.hypot(point.x - flying.target.x, point.y - flying.target.y);
		if (elapsed >= 0 && elapsed < arrival && moved > 0 && moved <= RETARGET_RADIUS) {
			const rest = retargetSamples(flying.samples, elapsed, point)
				.filter((sample) => sample.t > elapsed)
				.map((sample) => ({ ...sample, t: sample.t - elapsed }));
			return { command: packet(motion.style, rest), move: { samples: rest, startedAt: now, target: point } };
		}
	}
	const trajectory = planMove(motion, {
		from: state.shown ? state : point,
		to: point,
		reducedMotion: state.reducedMotion,
	});
	const samples = trajectory.samples.map(({ t, x, y, heading }) => ({ t, x, y, heading }));
	return {
		command: `trajectory ${JSON.stringify({ style: motion.style, arrival: trajectory.arrivalT, samples: samples.map(({ t, x, y, heading }) => [t, x, y, heading]) })}\n`,
		move: { samples, startedAt: now, target: point },
	};
}

/** Build the native playback packet from the daemon's actual, possibly mid-flight hotspot. */
export function cursorMotionCommand(point: Point, state: CursorState, motion: CursorMotionConfig): string {
	return planCursorMotion(point, state, motion, undefined, 0).command;
}

const flyingByScope = new Map<string, FlyingMove>();

/** Query and plan on the same connection, so other clients cannot interleave a move. */
export async function prepareCursorMotion(
	socket: Socket,
	command: string,
	motion: CursorMotionConfig,
): Promise<string> {
	const match = /^(pid \d+ )?set (-?\d+) (-?\d+)\n$/.exec(command);
	if (match === null) {
		return command;
	}
	const scope = match[1] ?? "";
	const state = await new Promise<CursorState>((resolve, reject) => {
		let response = "";
		function cleanup(): void {
			socket.off("data", onData);
			socket.off("error", onError);
			socket.off("end", onEnd);
		}
		function onError(error: Error): void {
			cleanup();
			reject(error);
		}
		function onEnd(): void {
			onError(new Error("Cursor overlay closed before returning its state"));
		}
		function onData(chunk: Buffer): void {
			response += chunk.toString("utf8");
			if (response.length > 4096) {
				onError(new Error("Cursor overlay state exceeds 4096 bytes"));
				return;
			}
			const newline = response.indexOf("\n");
			if (newline < 0) {
				return;
			}
			cleanup();
			try {
				resolve(parseState(response.slice(0, newline)));
			} catch (error) {
				reject(error);
			}
		}
		socket.on("data", onData);
		socket.once("error", onError);
		socket.once("end", onEnd);
		socket.write(`${scope}state\n`);
	});
	const planned = planCursorMotion(
		{ x: Number(match[2]), y: Number(match[3]) },
		state,
		motion,
		flyingByScope.get(scope),
		Date.now(),
	);
	flyingByScope.set(scope, planned.move);
	return `${scope}${planned.command}`;
}
