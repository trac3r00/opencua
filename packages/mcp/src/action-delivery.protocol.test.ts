import { afterEach, describe, expect, it } from "bun:test";
import { createHarness, jsonPayload, observe } from "./protocol-client-harness.js";
import { FakeGuardedComputer } from "./protocol-test-harness.js";

let closeHarness: (() => Promise<void>) | undefined;

afterEach(async () => {
	await closeHarness?.();
	closeHarness = undefined;
});

async function clickAtCoordinates(
	harness: Awaited<ReturnType<typeof createHarness>>,
): Promise<Record<string, unknown>> {
	const token = await observe(harness);
	const result = await harness.client.callTool({
		name: "click",
		arguments: { app: "Finder", observation_token: token, x: 10, y: 20 },
	});
	expect(result.isError).toBeFalsy();
	return jsonPayload(result);
}

describe("action delivery #given the driver's delivery mode #when input takes the foreground path #then the envelope names it", () => {
	it("reports the foreground for a coordinate click under attended delivery", async () => {
		const computer = new FakeGuardedComputer();
		computer.delivery = "attended";
		const harness = await createHarness(computer);
		closeHarness = harness.close;

		const payload = await clickAtCoordinates(harness);

		expect(payload["route"]).toBe("synthetic_events");
		expect(payload["delivery"]).toBe("foreground");
	});

	it("keeps reporting the background when the driver delivers in the background", async () => {
		const computer = new FakeGuardedComputer();
		computer.delivery = "background";
		const harness = await createHarness(computer);
		closeHarness = harness.close;

		const payload = await clickAtCoordinates(harness);

		expect(payload["route"]).toBe("synthetic_events");
		expect(payload["delivery"]).toBe("background");
	});

	it("reports the foreground for typed text that falls back to synthetic events", async () => {
		const computer = new FakeGuardedComputer();
		computer.delivery = "attended";
		const harness = await createHarness(computer);
		closeHarness = harness.close;
		const token = await observe(harness);

		const payload = jsonPayload(
			await harness.client.callTool({
				name: "type_text",
				arguments: { app: "Finder", observation_token: token, text: "hello" },
			}),
		);

		expect(payload["route"]).toBe("synthetic_events");
		expect(payload["delivery"]).toBe("foreground");
	});
});

async function deliveryHarness(delivery: "attended" | "background") {
	const computer = new FakeGuardedComputer();
	computer.delivery = delivery;
	computer.elementFrames.set(9, { x: 400, y: 300, width: 60, height: 40 });
	const harness = await createHarness(computer);
	closeHarness = harness.close;
	return { computer, harness };
}

async function callWithToken(
	harness: Awaited<ReturnType<typeof createHarness>>,
	name: string,
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const token = await observe(harness);
	const result = await harness.client.callTool({
		name,
		arguments: { app: "Finder", observation_token: token, ...args },
	});
	expect(result.isError).toBeFalsy();
	return jsonPayload(result);
}

describe("action delivery #given attended delivery #when an input tool has an accessibility shortcut #then it goes through the real pointer and keyboard", () => {
	it("clicks an element id at its live frame centre instead of pressing it", async () => {
		const { computer, harness } = await deliveryHarness("attended");

		const payload = await callWithToken(harness, "click", { element_index: "9" });

		expect(computer.effects.filter((effect) => effect.kind === "performAction")).toEqual([]);
		expect(computer.effects).toContainEqual({ kind: "click", point: { x: 430, y: 320 } });
		expect(payload).toMatchObject({ route: "synthetic_events", delivery: "foreground" });
	});

	it("types through keyboard events without the accessibility write", async () => {
		const { computer, harness } = await deliveryHarness("attended");

		const payload = await callWithToken(harness, "type_text", { text: "hello" });

		expect(computer.typeOptions).toHaveLength(0);
		expect(computer.effects).toContainEqual({ kind: "type", text: "hello" });
		expect(payload).toMatchObject({ route: "synthetic_events", delivery: "foreground" });
	});

	it("scrolls an element id with the wheel at its centre instead of its page action", async () => {
		const { computer, harness } = await deliveryHarness("attended");

		const payload = await callWithToken(harness, "scroll", { element_index: "9", direction: "down" });

		expect(computer.effects.filter((effect) => effect.kind === "performAction")).toEqual([]);
		expect(computer.effects).toContainEqual({
			kind: "scroll",
			options: { direction: "down", amount: 36, position: { x: 430, y: 320 } },
		});
		expect(payload).toMatchObject({ route: "synthetic_events", delivery: "foreground" });
	});
});

describe("action delivery #given attended delivery and a target behind the person's app #when an element is clicked and text typed #then both go through the real pointer and keyboard", () => {
	it("clicks the text area's centre and then types into it with key events", async () => {
		const { computer, harness } = await deliveryHarness("attended");
		computer.frontmost = false;

		const clicked = await callWithToken(harness, "click", { element_index: "9" });
		const typed = await callWithToken(harness, "type_text", { text: "hello" });

		expect(computer.effects.filter((effect) => effect.kind === "performAction")).toEqual([]);
		expect(computer.typeOptions).toHaveLength(0);
		expect(computer.targetedInputs.map(({ effect, pid }) => [effect, pid])).toEqual([
			[{ kind: "click", point: { x: 430, y: 320 } }, 1234],
			[{ kind: "type", text: "hello" }, 1234],
		]);
		expect(clicked).toMatchObject({ route: "synthetic_events", delivery: "foreground" });
		expect(typed).toMatchObject({ route: "synthetic_events", delivery: "foreground" });
	});
});

describe("action delivery #given attended delivery #when click_target resolves a described control #then it clicks with the pointer", () => {
	it("clicks the resolved control instead of pressing it through accessibility", async () => {
		const { computer, harness } = await deliveryHarness("attended");

		const result = await harness.client.callTool({
			name: "click_target",
			arguments: { app: "Finder", query: { label: "Open" } },
		});

		expect(result.isError).toBeFalsy();
		expect(computer.effects.filter((effect) => effect.kind === "performAction")).toEqual([]);
		expect(computer.effects.filter((effect) => effect.kind === "click")).toHaveLength(1);
	});
});

describe("action delivery #given background delivery #when the same tools run #then the accessibility shortcuts stay", () => {
	it("presses an element id, writes text through accessibility first, and scrolls by page action", async () => {
		const { computer, harness } = await deliveryHarness("background");

		const clicked = await callWithToken(harness, "click", { element_index: "9" });
		await callWithToken(harness, "type_text", { text: "hello" });
		const scrolled = await callWithToken(harness, "scroll", { element_index: "9", direction: "down" });

		expect(computer.effects).toContainEqual({ kind: "performAction", pid: 1234, id: 9, action: "AXPress" });
		expect(computer.typeOptions).toHaveLength(1);
		expect(computer.effects).toContainEqual({
			kind: "performAction",
			pid: 1234,
			id: 9,
			action: "AXScrollDownByPage",
		});
		expect(computer.effects.some((effect) => effect.kind === "click" || effect.kind === "scroll")).toBe(false);
		expect(clicked).toMatchObject({ route: "accessibility", delivery: "background" });
		expect(scrolled).toMatchObject({ route: "accessibility", delivery: "background" });
	});
});
