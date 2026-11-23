import { afterEach, describe, expect, it } from "bun:test";
import type { ElementHit, Point } from "@opencua/core";
import { createHarness, jsonPayload, observe } from "./protocol-client-harness.js";
import { FakeGuardedComputer } from "./protocol-test-harness.js";

let closeHarness: (() => Promise<void>) | undefined;

afterEach(async () => {
	if (closeHarness !== undefined) {
		await closeHarness();
		closeHarness = undefined;
	}
});

const SHEET_BUTTON: ElementHit = { hit: "covered", role: "AXButton", label: "Cancel", within: "AXSheet" };

/** A background app whose element 9 is a web control at (350, 230); `answer` is what its hit test finds there. */
function coveredComputer(answer: ElementHit) {
	const computer = new FakeGuardedComputer();
	computer.delivery = "background";
	computer.elementFrames.set(9, { x: 320, y: 190, width: 60, height: 80 });
	const hitTests: { readonly id: number; readonly point: Point }[] = [];
	const pageFocus: number[] = [];
	const pointPresses: Point[] = [];
	return Object.assign(computer, {
		hitTests,
		pageFocus,
		pointPresses,
		async elementHitAt(_pid: number, id: number, point: Point): Promise<ElementHit> {
			hitTests.push({ id, point });
			return answer;
		},
		async focusWebPage(_pid: number, id: number): Promise<boolean> {
			pageFocus.push(id);
			return true;
		},
		async pressAtPosition(_pid: number, point: Point): Promise<boolean> {
			pointPresses.push(point);
			return true;
		},
		async isWebElement(_pid: number, id: number): Promise<boolean> {
			return id === 9;
		},
	});
}

describe("#given a sheet of the app covering an observed element #when it is clicked by id #then nothing is sent", () => {
	it("#then the refusal is typed TARGET_COVERED with what covers it and a re-observe hint", async () => {
		const computer = coveredComputer(SHEET_BUTTON);
		const harness = await createHarness(computer);
		closeHarness = harness.close;
		const token = await observe(harness);

		const result = await harness.client.callTool({
			name: "click",
			arguments: { app: "Finder", observation_token: token, element_index: "9" },
		});

		expect(result.isError).toBe(true);
		expect(jsonPayload(result)).toMatchObject({
			ok: false,
			code: "TARGET_COVERED",
			retry: "safe",
			disposition: {
				retry: "safe",
				delivery: "not_sent",
				evidence: {
					element: 9,
					point: { x: 350, y: 230 },
					covering: { role: "AXButton", label: "Cancel", within: "AXSheet" },
				},
			},
		});
		expect(String(jsonPayload(result)["suggestion"])).toContain("observe the app again");
		expect(computer.hitTests).toEqual([{ id: 9, point: { x: 350, y: 230 } }]);
		expect(computer.pageFocus).toEqual([]);
		expect(computer.pointPresses).toEqual([]);
		expect(computer.effects).toEqual([]);
	});

	it("#then a right-click by id and a click_target on the pointer route are refused the same way", async () => {
		const computer = coveredComputer(SHEET_BUTTON);
		const harness = await createHarness(computer);
		closeHarness = harness.close;

		const rightClick = await harness.client.callTool({
			name: "click",
			arguments: {
				app: "Finder",
				observation_token: await observe(harness),
				element_index: "9",
				mouse_button: "right",
			},
		});
		const target = await harness.client.callTool({
			name: "click_target",
			arguments: { app: "Finder", query: { label: "Open" }, press: "pointer" },
		});

		expect(jsonPayload(rightClick)).toMatchObject({ code: "TARGET_COVERED" });
		expect(jsonPayload(target)).toMatchObject({ code: "TARGET_COVERED" });
		expect(computer.effects).toEqual([]);
	});
});

describe("#given the hit test lands on the element itself or its own label #when it is clicked by id #then it clicks", () => {
	it("#then the click goes out at the element's centre", async () => {
		const computer = coveredComputer({ hit: "target" });
		const harness = await createHarness(computer);
		closeHarness = harness.close;
		const token = await observe(harness);

		const result = await harness.client.callTool({
			name: "click",
			arguments: { app: "Finder", observation_token: token, element_index: "9" },
		});

		expect(result.isError).toBeFalsy();
		expect(computer.effects).toContainEqual({ kind: "click", point: { x: 350, y: 230 } });
	});

	it("#then an unknown hit test answer does not refuse either", async () => {
		const computer = coveredComputer({ hit: "unknown" });
		const harness = await createHarness(computer);
		closeHarness = harness.close;
		const token = await observe(harness);

		const result = await harness.client.callTool({
			name: "click",
			arguments: { app: "Finder", observation_token: token, element_index: "9" },
		});

		expect(result.isError).toBeFalsy();
		expect(computer.effects).toContainEqual({ kind: "click", point: { x: 350, y: 230 } });
	});
});

describe("#given a raw coordinate click #when something covers that point #then behaviour is unchanged", () => {
	it("#then no hit test runs and the press goes out at the point", async () => {
		const computer = coveredComputer(SHEET_BUTTON);
		const harness = await createHarness(computer);
		closeHarness = harness.close;
		const token = await observe(harness);

		const result = await harness.client.callTool({
			name: "click",
			arguments: { app: "Finder", observation_token: token, x: 10, y: 20 },
		});

		expect(result.isError).toBeFalsy();
		expect(computer.hitTests).toEqual([]);
		expect(computer.pointPresses).toHaveLength(1);
	});
});
