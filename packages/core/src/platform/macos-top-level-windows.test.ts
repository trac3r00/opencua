import { describe, expect, it } from "bun:test";
import { vi } from "@opencua/test-support";

import {
	type TopLevelWindow,
	fillWindowTitles,
	isPrivateBrowserTitle,
	markPrivateWindows,
	placeOnSpaces,
} from "./macos-top-level-windows.js";

const BOUNDS = { x: 0, y: 0, width: 400, height: 300 };

function window(id: number, ownerPid: number, title: string): TopLevelWindow {
	return { id, ownerPid, ownerName: `app ${ownerPid}`, title, bounds: BOUNDS };
}

describe("fillWindowTitles #given window titles the WindowServer withheld (no Screen Recording)", () => {
	const listed = [window(1, 10, ""), window(2, 10, ""), window(3, 20, ""), window(4, 30, "Shown")];

	it("#when the apps asked for name their windows #then each untitled window carries its app's title, asking each app once", () => {
		const titlesOfApp = vi.fn((pid: number) =>
			pid === 10
				? new Map([
						[1, "a.txt"],
						[2, "b.txt"],
					])
				: new Map([[3, "Calculator"]]),
		);

		const filled = fillWindowTitles(listed, [10], titlesOfApp);

		expect(filled.map((entry) => entry.title)).toEqual(["a.txt", "b.txt", "", "Shown"]);
		expect(titlesOfApp.mock.calls).toEqual([[10]]);
	});

	it("#when every app is asked #then only apps with an untitled window are asked", () => {
		const titlesOfApp = vi.fn((pid: number) => new Map([[pid === 10 ? 1 : 3, `window of ${pid}`]]));

		const filled = fillWindowTitles(listed, "all", titlesOfApp);

		expect(filled.map((entry) => entry.title)).toEqual(["window of 10", "", "window of 20", "Shown"]);
		expect(titlesOfApp.mock.calls).toEqual([[10], [20]]);
	});

	it("#when an app cannot answer or names a window with nothing #then its windows stay untitled", () => {
		const filled = fillWindowTitles(listed, "all", (pid) => {
			if (pid === 10) {
				throw new Error("the app did not answer within the accessibility messaging timeout");
			}
			return new Map([[3, ""]]);
		});

		expect(filled.map((entry) => entry.title)).toEqual(["", "", "", "Shown"]);
	});
});

describe("markPrivateWindows #given a browser with a private and a regular window showing one site", () => {
	it("#when the app's accessibility titles name the private one #then only it is marked, asking the app once", () => {
		const listed = [window(1, 10, "RPLAY"), window(2, 10, "RPLAY"), window(3, 20, "Other")];
		const titlesOfApp = vi.fn(
			(_pid: number) =>
				new Map([
					[1, "RPLAY - Brave (Private)"],
					[2, "RPLAY - Brave"],
				]),
		);

		const marked = markPrivateWindows(listed, [10], titlesOfApp);

		expect(marked.map((entry) => entry.private === true)).toEqual([true, false, false]);
		expect(titlesOfApp.mock.calls).toEqual([[10]]);
	});

	it.each<[string, boolean]>([
		["Page - Brave (Private)", true],
		["Page - Google Chrome (Incognito)", true],
		["Page - Microsoft Edge InPrivate", true],
		["Page — Private Browsing", true],
		["Private notes - Notes", false],
		["Page - Brave", false],
	])("#when the title is %s #then private is %s", (title, expected) => {
		expect(isPrivateBrowserTitle(title)).toBe(expected);
	});
});

describe("placeOnSpaces #given windows spread over two displays' Spaces", () => {
	const displays = [
		{
			displayIdentifier: "main-uuid",
			currentSpaceId: 1,
			spaces: [
				{ id: 1, type: 0 },
				{ id: 2, type: 0 },
			],
		},
		{ displayIdentifier: "side-uuid", currentSpaceId: 7, spaces: [{ id: 7, type: 0 }] },
	];

	it("#when each window's Spaces are known #then it says which display and whether its Space is shown now", () => {
		const placed = placeOnSpaces(
			[window(1, 10, "shown"), window(2, 10, "parked"), window(3, 20, "side"), window(4, 30, "unknown")],
			new Map([
				[1, [1]],
				[2, [2]],
				[3, [7]],
			]),
			displays,
		);

		expect(placed.map((entry) => entry.space)).toEqual([
			{ spaceIds: [1], current: true, display: "main-uuid" },
			{ spaceIds: [2], current: false, display: "main-uuid" },
			{ spaceIds: [7], current: true, display: "side-uuid" },
			undefined,
		]);
	});
});
