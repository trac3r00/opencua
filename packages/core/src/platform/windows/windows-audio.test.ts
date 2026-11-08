import { describe, expect, it } from "bun:test";
import { createWindowsHostComputer } from "./index.js";
import type { WindowsTransport } from "./transport.js";

function transportAnswering(result: unknown): {
	readonly transport: WindowsTransport & { generation: number };
	readonly methods: string[];
} {
	const methods: string[] = [];
	const transport: WindowsTransport & { generation: number } = {
		generation: 0,
		request: async (method) => {
			methods.push(method);
			return result;
		},
		close: async () => {},
	};
	return { transport, methods };
}

describe("#given the Windows helper's WASAPI report #when an app's streams are asked #then its process tree's sessions return", () => {
	it("keeps the browser's child audio process and judges playing from state and peak", async () => {
		const helper = transportAnswering({
			sessions: [
				{ pid: 4120, peak: 0.42, state: "active" },
				{ pid: 4121, peak: 0, state: "active" },
				{ pid: 900, peak: 0.9, state: "active" },
			],
			parents: { "4120": 4000, "4121": 4000, "900": 4 },
		});
		const computer = createWindowsHostComputer({ transport: helper.transport });
		expect(await computer.getAudioStreams(4000)).toEqual([
			{ pid: 4120, playing: true, peak: 0.42 },
			{ pid: 4121, playing: false, peak: 0 },
		]);
		expect(helper.methods).toEqual(["loadAudio", "audio"]);
		await computer.getAudioStreams(4000);
		expect(helper.methods).toEqual(["loadAudio", "audio", "audio"]);
		helper.transport.generation += 1;
		await computer.getAudioStreams(4000);
		expect(helper.methods.slice(3)).toEqual(["loadAudio", "audio"]);
	});

	it("refuses a recording longer than the helper timeout allows before asking the helper", async () => {
		const helper = transportAnswering({ mimeType: "audio/wav", data: Buffer.from("RIFF").toString("base64") });
		const computer = createWindowsHostComputer({ transport: helper.transport });
		for (const [pid, seconds] of [
			[0, 1],
			[4000, 0],
			[4000, 10.5],
			[4000, Number.NaN],
		]) {
			await expect(computer.recordAudio(pid ?? 0, seconds ?? 0)).rejects.toThrow("must");
		}
		expect(helper.methods).toEqual([]);
		expect((await computer.recordAudio(4000, 10)).data.toString()).toBe("RIFF");
		expect(helper.methods).toEqual(["loadAudio", "audioRecord"]);
	});
});
