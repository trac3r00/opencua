import { describe, expect, it } from "bun:test";
import { record } from "./client.js";
import { type LinuxHelperFactory, createLinuxHostComputer } from "./index.js";

function helperAnswering(report: unknown): { readonly factory: LinuxHelperFactory; readonly methods: unknown[] } {
	const methods: unknown[] = [];
	const factory: LinuxHelperFactory = (events) => ({
		send: (line) => {
			const request = record(JSON.parse(line));
			methods.push(request["method"]);
			events.line(JSON.stringify({ id: request["id"], result: report }));
		},
		close: () => {},
	});
	return { factory, methods };
}

const PW_DUMP = JSON.stringify([
	{
		id: 41,
		type: "PipeWire:Interface:Node",
		info: { state: "running", props: { "media.class": "Stream/Output/Audio", "application.process.id": "205" } },
	},
	{
		id: 42,
		type: "PipeWire:Interface:Node",
		info: { state: "idle", props: { "media.class": "Stream/Output/Audio", "application.process.id": 900 } },
	},
]);

describe("#given the Linux helper's audio report #when an app's streams are asked #then only its process tree's streams return", () => {
	it("reads pw-dump and finds the stream of the app's child process", async () => {
		const helper = helperAnswering({ source: "pw-dump", text: PW_DUMP, parents: { "205": 100, "900": 1 } });
		const computer = createLinuxHostComputer({ helperFactory: helper.factory });
		expect(await computer.getAudioStreams(100)).toEqual([{ pid: 205, playing: true, target: 41 }]);
		expect(helper.methods).toEqual(["audio"]);
		await computer.close();
	});

	it("records one stream as WAV and refuses bad targets or durations before asking the helper", async () => {
		const helper = helperAnswering({ mimeType: "audio/wav", data: Buffer.from("RIFF").toString("base64") });
		const computer = createLinuxHostComputer({ helperFactory: helper.factory });
		for (const [target, seconds] of [
			[-1, 1],
			[1.5, 1],
			[41, 0],
			[41, 31],
			[41, Number.NaN],
		]) {
			await expect(computer.recordAudio(target ?? 0, seconds ?? 0)).rejects.toThrow("must");
		}
		expect(helper.methods).toEqual([]);
		const recording = await computer.recordAudio(41, 2);
		expect(recording.data.toString()).toBe("RIFF");
		expect(helper.methods).toEqual(["audioRecord"]);
		await computer.close();
	});

	it("reads pactl sink inputs when PipeWire is absent and treats a corked input as not playing", async () => {
		const pactl = JSON.stringify([{ index: 3, corked: true, properties: { "application.process.id": "100" } }]);
		const helper = helperAnswering({ source: "pactl", text: pactl, parents: {} });
		const computer = createLinuxHostComputer({ helperFactory: helper.factory });
		expect(await computer.getAudioStreams(100)).toEqual([{ pid: 100, playing: false, target: 3 }]);
		await computer.close();
	});
});
