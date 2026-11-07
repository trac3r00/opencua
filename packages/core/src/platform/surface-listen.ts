import { execFileSync } from "node:child_process";
import { measureProcessAudioViaSck } from "./macos-ffi/sckit.js";
import { type OwnedSurfaceOptions, isOwnedSurfacePid, readOwnedSurfaces, surfaceAudioState } from "./owned-surfaces.js";

export interface SurfaceListening {
	readonly rmsDb: number;
	readonly peakDb: number;
	readonly samples: number;
	readonly durationMs: number;
}

export interface ProcessIdentity {
	/** The executable path or name, as `ps -o comm=` reports it. */
	readonly command: string;
	/** When the process started (epoch ms, second resolution). */
	readonly startedAt: number;
}

export interface SurfaceListenDependencies {
	readonly measure: (
		pid: number,
		durationMs: number,
	) => Promise<{ readonly rms: number; readonly peak: number; readonly samples: number } | null>;
	readonly owned: (pid: number, options: OwnedSurfaceOptions) => boolean;
	readonly identity: (pid: number) => ProcessIdentity | undefined;
	readonly surfaceStartedAt: (pid: number, options: OwnedSurfaceOptions) => number | undefined;
}

function processIdentity(pid: number): ProcessIdentity | undefined {
	try {
		const line = execFileSync("/bin/ps", ["-o", "lstart=,comm=", "-p", String(pid)], { encoding: "utf8" }).trim();
		const match = /^(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.+)$/.exec(line);
		if (match === null) return undefined;
		const startedAt = Date.parse(match[1] ?? "");
		return Number.isFinite(startedAt) ? { command: match[2] ?? "", startedAt } : undefined;
	} catch {
		return undefined;
	}
}

const nativeDependencies: SurfaceListenDependencies = {
	measure: measureProcessAudioViaSck,
	owned: (pid, options) => isOwnedSurfacePid(pid, options),
	identity: processIdentity,
	surfaceStartedAt: (pid, options) => {
		const surface = readOwnedSurfaces(options).find((entry) => entry.pid === pid);
		const startedAt = surface === undefined ? Number.NaN : Date.parse(surface.startedAt);
		return Number.isFinite(startedAt) ? startedAt : undefined;
	},
};

const GPU_PROCESS = "com.apple.WebKit.GPU";
const decibels = (value: number): number => (value > 0 ? Math.max(-160, 20 * Math.log10(value)) : -160);

/**
 * Hears an opencua-owned surface for `durationMs`: the real audio its page plays, media elements included, through a
 * process tap on the WebKit GPU process the surface reported. Refused for anything that is not an owned surface, and
 * for a reported pid that is no longer that surface's GPU process (not a WebKit GPU process, or one that started before
 * the surface: the pid was reused). The person's own apps are never listened to.
 */
export async function listenToSurface(
	pid: number,
	durationMs: number,
	options: OwnedSurfaceOptions = {},
	dependencies: SurfaceListenDependencies = nativeDependencies,
): Promise<SurfaceListening> {
	if (!Number.isSafeInteger(durationMs) || durationMs < 50 || durationMs > 10_000) {
		throw new Error("listen duration_ms must be an integer from 50 to 10000");
	}
	if (!dependencies.owned(pid, options)) throw new Error(`pid ${pid} is not an open owned surface`);
	const gpuPid = surfaceAudioState(pid, options)?.gpuPid;
	if (gpuPid === undefined) {
		throw new Error(`surface ${pid} has not reported an audio process yet; it reports one once its page uses audio`);
	}
	const identity = dependencies.identity(gpuPid);
	const surfaceStartedAt = dependencies.surfaceStartedAt(pid, options);
	if (
		identity === undefined ||
		!identity.command.endsWith(GPU_PROCESS) ||
		surfaceStartedAt === undefined ||
		identity.startedAt < surfaceStartedAt
	) {
		throw new Error(`surface ${pid}'s reported audio process ${gpuPid} is gone or is not its WebKit GPU process`);
	}
	const level = await dependencies.measure(gpuPid, durationMs);
	if (level === null) throw new Error("the native capture library is unavailable on this host");
	return { rmsDb: decibels(level.rms), peakDb: decibels(level.peak), samples: level.samples, durationMs };
}
