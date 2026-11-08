import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { LINUX_HELPER } from "./helper.js";

const SEED = Number(process.env["CAPTURE_SEED"] ?? 20261107);
const CASES = 120;

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

function shippedFunction(name: string): string {
	const start = LINUX_HELPER.indexOf(`def ${name}(`);
	const end = LINUX_HELPER.indexOf("\n\n\n", start);
	if (start < 0 || end < 0) throw new Error(`${name} is not in the shipped helper`);
	return LINUX_HELPER.slice(start, end);
}

const harness = `
import json, sys
class Failure(Exception):
	pass
def fail(code, message):
	raise Failure(code)
${shippedFunction("xrgb_to_rgb")}
results = []
for case in json.load(sys.stdin):
	try:
		out = xrgb_to_rgb(bytes(case["data"]), case["width"], case["height"], case["stride"], case["little"])
		results.append(list(out))
	except Failure as error:
		results.append(str(error))
print(json.dumps(results))
`;

function runPython(input: unknown): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const child = spawn("python3", ["-I", "-c", harness], { stdio: ["pipe", "pipe", "pipe"] });
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
		child.stdin.end(JSON.stringify(input));
	});
}

describe("#given generated 32-bit X window images #when the shipped helper converts them #then every pixel keeps its color", () => {
	it(`converts ${CASES} seeded images with padded rows and both byte orders (seed ${SEED})`, async () => {
		const next = random(SEED);
		const cases: Array<{ data: number[]; width: number; height: number; stride: number; little: boolean }> = [];
		const expected: unknown[] = [];
		for (let index = 0; index < CASES; index += 1) {
			const width = 1 + Math.floor(next() * 9);
			const height = 1 + Math.floor(next() * 6);
			const stride = width * 4 + 4 * Math.floor(next() * 3);
			const little = next() < 0.5;
			const pixels = Array.from({ length: width * height }, () => [0, 0, 0].map(() => Math.floor(next() * 256)));
			const data = new Array<number>(stride * height).fill(0xee);
			pixels.forEach(([red = 0, green = 0, blue = 0], at) => {
				const offset = Math.floor(at / width) * stride + (at % width) * 4;
				const bytes = little ? [blue, green, red, 0] : [0, red, green, blue];
				bytes.forEach((byte, position) => {
					data[offset + position] = byte;
				});
			});
			cases.push({ data, width, height, stride, little });
			expected.push(pixels.flat());
		}
		cases.push({ data: [1, 2, 3], width: 1, height: 1, stride: 4, little: true });
		cases.push({ data: new Array<number>(8).fill(0), width: 2, height: 1, stride: 4, little: true });
		cases.push({ data: [], width: 0, height: 1, stride: 0, little: true });
		expected.push("CAPTURE_UNAVAILABLE", "CAPTURE_UNAVAILABLE", "CAPTURE_UNAVAILABLE");
		expect(await runPython(cases)).toEqual(expected);
	});
});
