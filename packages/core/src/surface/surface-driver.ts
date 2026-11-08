import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { type Server, createServer } from "node:net";
import { createInterface } from "node:readline";
import { CursorMux, type MuxKind, type MuxPoint } from "./cursor-mux.js";
import { MOUTH_SCRIPT } from "./mouth.js";

/**
 * The Windows and Linux shared surfaces: a native shell (WebView2 / WebKitGTK window) that only shows
 * the page, draws cursor marks, and injects the pointer events it is told to, driven by this process,
 * which accepts agents on the same line protocol as the macOS surface socket and merges them with the
 * shared CursorMux. Shell commands are JSON lines on the shell's stdin.
 */
export type ShellCommand =
	| { readonly t: "init"; readonly scripts: readonly string[] }
	| { readonly t: "speak"; readonly audio: string }
	| { readonly t: "pointer"; readonly kind: MuxKind; readonly x: number; readonly y: number }
	| { readonly t: "mark"; readonly tag: number; readonly x: number; readonly y: number; readonly down: boolean };

export interface AgentLine {
	readonly tag: number;
	readonly context: boolean;
	readonly kind: MuxKind;
	readonly point: MuxPoint;
}

const KINDS: Readonly<Record<string, MuxKind>> = { D: "down", G: "drag", U: "up", M: "move" };

/** "<tag> <context> <D|G|U|M> <x> <y>", as ParseAgentLine in native/opencua-surface.m accepts it. */
export function parseAgentLine(line: string): AgentLine | undefined {
	const match = /^\s*(\d+)\s+(-?\d+)\s+(\S)\s+(\S+)\s+(\S+)/.exec(line);
	if (match === null) return undefined;
	const [, tagText = "", flag = "", letter = "", xText = "", yText = ""] = match;
	const tag = Number(tagText);
	const kind = KINDS[letter];
	const x = Number(xText);
	const y = Number(yText);
	if (!Number.isSafeInteger(tag) || tag <= 0 || tag > 0xffffffff || kind === undefined) return undefined;
	if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
	return { tag, context: flag === "1", kind, point: { x, y } };
}

/** Merges agent lines into shell commands; times in seconds, supplied by the caller. */
export class SurfaceDriver {
	private readonly mux: CursorMux;

	constructor(private readonly send: (command: ShellCommand) => void) {
		this.mux = new CursorMux((kind, point) => send({ t: "pointer", kind, x: point.x, y: point.y }));
		send({ t: "init", scripts: [MOUTH_SCRIPT] });
	}

	/** Plays a clip (WAV or any format the page decodes) into the page's microphone stream. */
	speak(audio: Buffer): void {
		if (audio.length === 0) throw new RangeError("empty clip");
		this.send({ t: "speak", audio: audio.toString("base64") });
	}

	line(text: string, now: number): boolean {
		const parsed = parseAgentLine(text);
		if (parsed === undefined) return false;
		this.send({
			t: "mark",
			tag: parsed.tag,
			x: parsed.point.x,
			y: parsed.point.y,
			down: parsed.kind === "down" || parsed.kind === "drag",
		});
		this.mux.cursor(parsed.tag, parsed.kind, parsed.point, parsed.context, now);
		return true;
	}

	tick(now: number): void {
		this.mux.pump(now);
	}
}

/**
 * Starts a shell and serves agents on `socketPath` (a Unix socket, or a \\.\pipe\ name on Windows).
 * The 8 ms pump matches the macOS surface timer, so waited strokes replay at their own pace.
 */
export function startSurfaceDriver(options: {
	readonly socketPath: string;
	readonly shell: { readonly command: string; readonly args: readonly string[] };
	/** Called once when the shell cannot start or the socket cannot be served; everything is torn down first. */
	readonly onError?: (error: Error) => void;
}): { readonly server: Server; readonly shell: ChildProcessWithoutNullStreams; stop(): void } {
	const shell = spawn(options.shell.command, [...options.shell.args], { stdio: ["pipe", "pipe", "pipe"] });
	const driver = new SurfaceDriver((command) => shell.stdin.write(`${JSON.stringify(command)}\n`));
	const clock = () => performance.now() / 1000;
	const server = createServer((socket) => {
		const lines = createInterface({ input: socket });
		lines.on("line", (line) => driver.line(line, clock()));
	});
	server.listen(options.socketPath);
	const timer = setInterval(() => driver.tick(clock()), 8);
	const stop = () => {
		clearInterval(timer);
		server.close();
		shell.kill();
	};
	shell.on("exit", stop);
	let failed = false;
	const fail = (error: Error) => {
		if (failed) return;
		failed = true;
		stop();
		options.onError?.(error);
	};
	shell.on("error", (error) =>
		fail(new Error(`surface shell ${options.shell.command} could not start: ${error.message}`)),
	);
	server.on("error", (error) => fail(error));
	return { server, shell, stop };
}
