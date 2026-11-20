import type { AppInfo, AppState } from "../accessibility/types.js";
import { resolveElementCoordinate } from "../platform/macos-accessibility.js";
import type { AppStateOptions, KeyModifierName, ScrollOptions } from "../types/index.js";
import { currentInputScope, runInInputScope } from "./input-scope.js";
import type { ComputerInterface } from "./interface.js";
import { type KeyModifier, MODIFIER_ALIASES, normalizeModifiers } from "./modifiers.js";

export { normalizeModifiers };

export type ComputerUseMouseButton = "left" | "right" | "middle";

export const AX_PRESS_ACTION = "AXPress";

const AX_SCROLL_ACTIONS: Record<ScrollOptions["direction"], string> = {
	up: "AXScrollUpByPage",
	down: "AXScrollDownByPage",
	left: "AXScrollLeftByPage",
	right: "AXScrollRightByPage",
};

export function axScrollActionFor(direction: ScrollOptions["direction"]): string {
	return AX_SCROLL_ACTIONS[direction];
}

export async function pressElement(
	computer: ComputerInterface,
	targetPid: number,
	elementIndex: number,
): Promise<void> {
	await computer.performAction(targetPid, elementIndex, AX_PRESS_ACTION);
}

export async function scrollElement(
	computer: ComputerInterface,
	targetPid: number,
	elementIndex: number,
	direction: ScrollOptions["direction"],
	pages: number,
): Promise<void> {
	const pageCount = Math.max(1, Math.trunc(pages));
	const action = axScrollActionFor(direction);
	for (let index = 0; index < pageCount; index += 1) {
		await computer.performAction(targetPid, elementIndex, action);
	}
}

const MAX_SIMILAR_APPS = 3;
const MIN_SIMILAR_WORD_LENGTH = 3;

/**
 * The lowercase names a person sees for an app: its display name and its bundle file name without `.app`
 * (Zoom's display name is "Zoom" but its bundle and process are "zoom.us").
 */
function appNames(candidate: AppInfo): string[] {
	const names = [candidate.name.toLowerCase()];
	const bundleFile = candidate.path
		?.split("/")
		.filter((part) => part.length > 0)
		.pop();
	if (bundleFile !== undefined) {
		names.push(bundleFile.toLowerCase().replace(/\.app$/, ""));
	}
	return names;
}

/** Every lowercase key an app answers to: its names and its bundle id. */
function appKeys(candidate: AppInfo): string[] {
	return [...appNames(candidate), candidate.bundleId.toLowerCase()];
}

/**
 * The app a name, bundle id, bundle file name, or partial name refers to: an exact match wins, a partial
 * match follows, and undefined means nothing in the list matches.
 */
export function findMatchingApp(apps: readonly AppInfo[], app: string): AppInfo | undefined {
	const normalizedApp = app.trim().toLowerCase();
	// "zoom.us.app" names the bundle file; the request as given is still tried first, since a bundle id can end in .app.
	const withoutSuffix = normalizedApp.replace(/\.app$/, "");
	const triesSuffixless = withoutSuffix.length > 0 && withoutSuffix !== normalizedApp;
	return (
		apps.find((candidate) => appKeys(candidate).includes(normalizedApp)) ??
		(triesSuffixless ? apps.find((candidate) => appKeys(candidate).includes(withoutSuffix)) : undefined) ??
		apps.find((candidate) => appKeys(candidate).some((key) => key.includes(normalizedApp)))
	);
}

/**
 * Running apps whose display or bundle file name shares a word with a request nothing matched, so the caller can
 * retry with a real name. Bundle ids are left out: their vendor parts ("apple", "google") would match unrelated apps.
 */
function similarApps(apps: readonly AppInfo[], app: string): AppInfo[] {
	const words = app
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((word) => word.length >= MIN_SIMILAR_WORD_LENGTH);
	if (words.length === 0) {
		return [];
	}
	return apps
		.filter((candidate) => appNames(candidate).some((name) => words.some((word) => name.includes(word))))
		.slice(0, MAX_SIMILAR_APPS);
}

export async function resolveAppPid(computer: ComputerInterface, app: string): Promise<number> {
	const normalizedApp = app.trim().toLowerCase();
	if (normalizedApp.length === 0) {
		throw new Error("app must be a non-empty app name, bundle id, or pid");
	}

	const numericPid = Number(normalizedApp);
	if (Number.isSafeInteger(numericPid) && numericPid > 0) {
		return numericPid;
	}

	// Identity is all name matching needs; listApps would enrich every app with usage (a spawned mdls).
	const apps =
		computer.listAppIdentities === undefined ? await computer.listApps() : await computer.listAppIdentities();
	const match = findMatchingApp(apps, app);
	if (match === undefined) {
		const similar = similarApps(apps, app).map((candidate) => `${candidate.name} (${candidate.bundleId})`);
		throw new Error(
			similar.length === 0
				? `No running app matched "${app}"`
				: `No running app matched "${app}"; running apps with a similar name: ${similar.join(", ")}`,
		);
	}
	return match.pid;
}

export async function getAppStateForApp(
	computer: ComputerInterface,
	app: string,
	options?: AppStateOptions,
): Promise<AppState> {
	return await computer.getAppState(await resolveAppPid(computer, app), options);
}

/**
 * Run `action` with its keyboard and pointer input aimed at `targetPid`. The target travels in the input scope of
 * `action`'s own async flow instead of being set on the computer, so actions for different apps can overlap without
 * one ever posting to the other's app (or, after the other finished, to none). A dispatch the guarded session already
 * bound to an observed window of the same app keeps that window, and its stop check, for this action.
 */
export async function withTargetedApp<TValue>(
	_computer: ComputerInterface,
	targetPid: number,
	action: () => Promise<TValue>,
): Promise<TValue> {
	if (!Number.isSafeInteger(targetPid) || targetPid <= 0) {
		throw new Error("target pid must be a positive integer");
	}
	const outer = currentInputScope();
	const windowId = outer?.target?.pid === targetPid ? outer.target.windowId : undefined;
	return await runInInputScope(
		{
			target: windowId === undefined ? { pid: targetPid } : { pid: targetPid, windowId },
			...(outer?.interruption === undefined ? {} : { interruption: outer.interruption }),
		},
		action,
	);
}

export async function resolvePointForElement(
	computer: ComputerInterface,
	targetPid: number,
	elementIndex: number,
): Promise<{ x: number; y: number }> {
	const state = await computer.getAppState(targetPid);
	return resolveElementCoordinate(state.elements, elementIndex);
}

export function parseElementIndex(elementIndex: string | number): number {
	const index = typeof elementIndex === "number" ? elementIndex : Number(elementIndex.trim());
	if (!Number.isSafeInteger(index) || index < 0) {
		throw new Error(`Invalid element index: ${String(elementIndex)}`);
	}
	return index;
}

export function parseKeyChord(key: string): { readonly key: string; readonly modifiers: KeyModifier[] } {
	// "+" is both the separator and a key. A chord that ends in "+" ("+", "cmd++") names the plus key,
	// which on the keyboard is shift with "=".
	const trimmed = key.trim();
	const plusKey = trimmed.endsWith("+");
	const parts = (plusKey ? trimmed.slice(0, -1) : trimmed)
		.split("+")
		.map((part) => part.trim())
		.filter(Boolean);
	if (plusKey) {
		parts.push("shift", "=");
	}
	const finalKey = parts.at(-1);
	if (finalKey === undefined) {
		throw new Error("key must be non-empty");
	}
	const modifiers = parts.slice(0, -1).map((part) => {
		const modifier = MODIFIER_ALIASES.get(part.toLowerCase());
		if (modifier === undefined) {
			throw new Error(`unsupported key modifier: ${part}`);
		}
		return modifier;
	});
	return { key: finalKey, modifiers };
}

/** Run an action, then capture state for the caller to verify its intended effect. */
export async function observeAction(
	computer: ComputerInterface,
	targetPid: number,
	action: () => Promise<void>,
): Promise<AppState> {
	await action();
	return await computer.getAppState(targetPid);
}

export async function clickPoint(
	computer: ComputerInterface,
	point: { readonly x: number; readonly y: number },
	button: ComputerUseMouseButton,
	clickCount: number,
	modifiers?: ReadonlyArray<KeyModifierName>,
): Promise<void> {
	const count = Math.max(1, Math.trunc(clickCount));
	// Passed only when asked for, so a plain click keeps its exact call shape.
	const options = modifiers === undefined || modifiers.length === 0 ? undefined : { modifiers };
	if (button === "left" && count === 2) {
		await (options === undefined ? computer.doubleClick(point) : computer.doubleClick(point, options));
		return;
	}
	for (let index = 0; index < count; index += 1) {
		switch (button) {
			case "left":
				await (options === undefined ? computer.click(point) : computer.click(point, options));
				break;
			case "right":
				await (options === undefined ? computer.rightClick(point) : computer.rightClick(point, options));
				break;
			case "middle":
				await (options === undefined ? computer.middleClick(point) : computer.middleClick(point, options));
				break;
		}
	}
}
