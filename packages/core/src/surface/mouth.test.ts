import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { pcmWav } from "./mouth.js";
import { type ShellCommand, SurfaceDriver } from "./surface-driver.js";

function pythonWave(wav: Buffer): Promise<{ channels: number; width: number; rate: number; frames: number[] }> {
	const script =
		"import io, json, struct, sys, wave\n" +
		"w = wave.open(io.BytesIO(sys.stdin.buffer.read()))\n" +
		"raw = w.readframes(w.getnframes())\n" +
		"print(json.dumps({'channels': w.getnchannels(), 'width': w.getsampwidth(), 'rate': w.getframerate(),\n" +
		"  'frames': list(struct.unpack('<%dh' % (len(raw) // 2), raw))}))\n";
	return new Promise((resolve, reject) => {
		const child = spawn("python3", ["-I", "-c", script], { stdio: ["pipe", "pipe", "pipe"] });
		let output = "";
		let errors = "";
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			errors += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => (code === 0 ? resolve(JSON.parse(output)) : reject(new Error(errors))));
		child.stdin.end(wav);
	});
}

describe("#given agent speech samples #when packed as WAV #then an independent WAV reader gets the same PCM", () => {
	it("round-trips clipped, non-finite and edge samples through Python's wave module", async () => {
		const samples = new Float32Array([0, 1, -1, 0.5, -0.5, 2, -3, Number.NaN, Number.POSITIVE_INFINITY, 1e-6]);
		const decoded = await pythonWave(pcmWav(samples, 16000));
		expect(decoded).toEqual({
			channels: 1,
			width: 2,
			rate: 16000,
			frames: [0, 32767, -32767, 16384, -16383, 32767, -32767, 0, 0, 0],
		});
		expect(() => pcmWav(samples, 100)).toThrow(RangeError);
	});
});

describe("#given a surface driver #when it starts and the agent speaks #then the shell gets the mouth script and the clip", () => {
	it("sends the mouth script first and the clip as base64, refusing an empty clip", () => {
		const commands: ShellCommand[] = [];
		const driver = new SurfaceDriver((command) => commands.push(command));
		expect(commands[0]?.t).toBe("init");
		const clip = pcmWav(new Float32Array([0.25]), 8000);
		driver.speak(clip);
		expect(commands.at(-1)).toEqual({ t: "speak", audio: clip.toString("base64") });
		expect(() => driver.speak(Buffer.alloc(0))).toThrow(RangeError);
	});
});
