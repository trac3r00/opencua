import type { AppInfo, AppState } from "../accessibility/types.js";
import { resolveElementCoordinate } from "../platform/macos-accessibility.js";
import type { AppStateOptions, KeyModifierName, ScrollOptions } from "../types/index.js";
import { currentInputScope, runInInputScope } from "./input-scope.js";
import type { ComputerInterface } from "./interface.js";
import { type KeyModifier, MODIFIER_ALIASES, normalizeModifiers } from "./modifiers.js";
import { appNotRunning } from "./tool-failure.js";

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

/**
 * The app a name, bundle id, or partial app name refers to: an exact name or bundle-id match
 * wins, a partial match follows, and undefined means nothing in the list matches.
 */
export function findMatchingApp(apps: readonly AppInfo[], app: string): AppInfo | undefined {
	const normalizedApp = app.trim().toLowerCase();
	const exactMatch = apps.find((candidate) => {
		const name = candidate.name.toLowerCase();
		const bundleId = candidate.bundleId.toLowerCase();
		return name === normalizedApp || bundleId === normalizedApp;
	});
	if (exactMatch !== undefined) {
		return exactMatch;
	}
	return apps.find((candidate) => {
		const name = candidate.name.toLowerCase();
		const bundleId = candidate.bundleId.toLowerCase();
		return name.includes(normalizedApp) || bundleId.includes(normalizedApp);
	});
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
		throw appNotRunning(`No running app matched "${app}"`);
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
