/**
 * Which processes are playing sound, read from what each OS reports, so an agent can tell that an
 * app it drives is playing audio. Windows reports WASAPI sessions (process id plus meter peak);
 * Linux reports PipeWire nodes (pw-dump) or PulseAudio sink inputs (pactl --format=json).
 * The readers are pure: the backends run the commands and pass their output here.
 */

/** One audio stream of a process. */
export interface AudioStream {
	readonly pid: number;
	/** Producing sound now: not paused (corked) and, where the OS reports a meter, above silence. */
	readonly playing: boolean;
	/** Meter peak from 0 to 1 when the OS reports one (Windows); undefined otherwise. */
	readonly peak?: number;
	/** The node or sink-input id to record this stream from (Linux). */
	readonly target?: number;
}

/** A peak at or below this is silence: WASAPI meters report tiny nonzero values for idle sessions. */
export const SILENT_PEAK = 0.0001;

export class AudioReportError extends Error {
	override readonly name = "AudioReportError";
}

function parse(text: string, source: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		throw new AudioReportError(`${source} output is not JSON`);
	}
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Readonly<Record<string, unknown>>)
		: undefined;
}

function list(value: unknown, source: string): readonly unknown[] {
	if (!Array.isArray(value)) throw new AudioReportError(`${source} output is not a list`);
	return value;
}

/** A pid as the OS writes it: a positive safe integer, as a number or a decimal string. */
function pid(value: unknown): number | undefined {
	const number = typeof value === "string" && /^[1-9][0-9]{0,9}$/.test(value) ? Number(value) : value;
	return typeof number === "number" && Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function id(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** PipeWire `pw-dump` output: output stream nodes; a node plays while its state is "running". */
export function readPwDump(text: string): AudioStream[] {
	const streams: AudioStream[] = [];
	for (const item of list(parse(text, "pw-dump"), "pw-dump")) {
		const object = record(item);
		if (object?.["type"] !== "PipeWire:Interface:Node") continue;
		const info = record(object["info"]);
		const props = record(info?.["props"]);
		if (props?.["media.class"] !== "Stream/Output/Audio") continue;
		const owner = pid(props["application.process.id"]);
		const target = id(object["id"]);
		if (owner === undefined || target === undefined) continue;
		streams.push({ pid: owner, playing: info?.["state"] === "running", target });
	}
	return streams;
}

/** `pactl --format=json list sink-inputs`: a sink input plays unless it is corked. */
export function readPactlSinkInputs(text: string): AudioStream[] {
	const streams: AudioStream[] = [];
	for (const item of list(parse(text, "pactl"), "pactl")) {
		const input = record(item);
		const owner = pid(record(input?.["properties"])?.["application.process.id"]);
		const target = id(input?.["index"]);
		if (owner === undefined || target === undefined) continue;
		streams.push({ pid: owner, playing: input?.["corked"] !== true, target });
	}
	return streams;
}

/** The Windows helper's WASAPI session list: [{ pid, peak, state }] with state "active" | "inactive" | "expired". */
export function readWasapiSessions(text: string): AudioStream[] {
	const streams: AudioStream[] = [];
	for (const item of list(parse(text, "WASAPI"), "WASAPI")) {
		const session = record(item);
		const owner = pid(session?.["pid"]);
		const peak = session?.["peak"];
		const state = session?.["state"];
		if (owner === undefined) continue;
		if (typeof peak !== "number" || !Number.isFinite(peak) || peak < 0 || peak > 1) {
			throw new AudioReportError(`WASAPI session of pid ${owner} has no peak between 0 and 1`);
		}
		if (state !== "active" && state !== "inactive" && state !== "expired") {
			throw new AudioReportError(`WASAPI session of pid ${owner} has an unknown state`);
		}
		streams.push({ pid: owner, playing: state === "active" && peak > SILENT_PEAK, peak });
	}
	return streams;
}

/**
 * The streams of a process and its descendants: browsers and WebViews play from a child audio
 * or GPU process, so the app's own pid rarely owns the stream. `parents` maps child pid to parent pid.
 */
export function streamsOfProcessTree(
	streams: readonly AudioStream[],
	root: number,
	parents: ReadonlyMap<number, number>,
): AudioStream[] {
	const inTree = (start: number): boolean => {
		const seen = new Set<number>();
		for (let current: number | undefined = start; current !== undefined; current = parents.get(current)) {
			if (current === root) return true;
			if (seen.has(current)) return false;
			seen.add(current);
		}
		return false;
	};
	return streams.filter((stream) => inTree(stream.pid));
}
