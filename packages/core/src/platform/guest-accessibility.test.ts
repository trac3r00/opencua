import { describe, expect, it } from "bun:test";
import { readGuestAccessibility } from "./guest-accessibility.js";

function guest(reply: string) {
	const calls: { args: readonly string[]; input: string | undefined }[] = [];
	return {
		calls,
		transport: {
			async execute(args: readonly string[], input?: string): Promise<Buffer> {
				calls.push({ args, input });
				return Buffer.from(args[0] === "/bin/sh" ? "" : reply);
			},
		},
	};
}

const textEdit = JSON.stringify({
	trusted: 1,
	app: "TextEdit",
	window: 1,
	screen: [1024, 768],
	elements: [
		{ depth: 0, role: "AXWindow", title: "t1.txt", frame: [79, 55, 656, 422] },
		{ depth: 1, role: "AXTextArea", value: "Agent 1:\n", frame: [79, 87, 656, 384] },
		{ depth: 1, role: "AXGroup" },
	],
});

describe("#given an agent-owned guest #when its accessibility tree is read #then elements come in screenshot pixels", () => {
	it("installs the helper once per transport and scales point frames to the screenshot size", async () => {
		const fake = guest(textEdit);
		const helper = async () => Buffer.from("helper-bytes");

		const first = await readGuestAccessibility(fake.transport, { width: 2048, height: 1536 }, helper);
		await readGuestAccessibility(fake.transport, { width: 2048, height: 1536 }, helper);

		expect(fake.calls.filter((call) => call.args[0] === "/bin/sh")).toHaveLength(1);
		expect(fake.calls[0]?.input).toBe(Buffer.from("helper-bytes").toString("base64"));
		expect(first).toEqual({
			app: "TextEdit",
			elements: [
				{ depth: 0, role: "AXWindow", title: "t1.txt", frame: [158, 110, 1312, 844] },
				{ depth: 1, role: "AXTextArea", value: "Agent 1:\n", frame: [158, 174, 1312, 768] },
				{ depth: 1, role: "AXGroup" },
			],
		});
	});

	it("refuses a reply from a guest agent without accessibility permission", async () => {
		const fake = guest(JSON.stringify({ trusted: 0, app: "TextEdit", screen: [1024, 768], elements: [] }));

		await expect(
			readGuestAccessibility(fake.transport, { width: 2048, height: 1536 }, async () => Buffer.from("x")),
		).rejects.toThrow("no accessibility permission");
	});

	it("refuses output that is not JSON", async () => {
		const fake = guest("Segmentation fault");

		await expect(
			readGuestAccessibility(fake.transport, { width: 2048, height: 1536 }, async () => Buffer.from("x")),
		).rejects.toThrow("no JSON");
	});
});
