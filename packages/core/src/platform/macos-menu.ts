import { setTimeout as sleep } from "node:timers/promises";
import type { KoffiFunc } from "koffi";
import {
	type AXUIElementRef,
	copyAttributeValue,
	createApplicationElement,
	performAction,
	releaseAXElement,
} from "./macos-ffi/accessibility.js";
import {
	type CFArrayRef,
	cfArrayLength,
	cfArrayValueAt,
	cfRelease,
	cfRetain,
	fromCFBoolean,
	fromCFNumber,
	fromCFString,
	isCFBoolean,
	isCFNumber,
	isCFString,
} from "./macos-ffi/corefoundation.js";
import { koffi } from "./macos-ffi/koffi.js";

const MENU_SETTLE_MILLISECONDS = 80;
const ACTION_PRIORITY = ["AXPress", "AXPick", "AXShowMenu", "AXOpen"] as const;
/** How long, at most, an item may take to become enabled after its app is told it is active (~1.5 s). */
const MENU_ENABLE_POLLS = 60;
const MENU_ENABLE_POLL_MILLISECONDS = 25;

const applicationServices = koffi.load("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices");
const AX_UI_ELEMENT_REF = koffi.pointer("AXUIElementRefForMenu", koffi.opaque());
const AXUIElementCopyActionNames = applicationServices.func("AXUIElementCopyActionNames", "int32_t", [
	AX_UI_ELEMENT_REF,
	"_Out_ void **",
]) as KoffiFunc<(element: AXUIElementRef, actions: Array<CFArrayRef | null>) => number>;

export interface MenuAccessibility {
	createApplication(pid: number): AXUIElementRef;
	elementAttribute(element: AXUIElementRef, attribute: string): AXUIElementRef | null;
	copyChildren(element: AXUIElementRef): AXUIElementRef[];
	stringAttribute(element: AXUIElementRef, attribute: string): string | null;
	booleanAttribute(element: AXUIElementRef, attribute: string): boolean | null;
	numberAttribute(element: AXUIElementRef, attribute: string): number | null;
	actionNames(element: AXUIElementRef): string[];
	perform(element: AXUIElementRef, action: string): void;
	release(element: AXUIElementRef): void;
	delay(milliseconds: number): Promise<void>;
}

export interface InvokeMenuResult {
	readonly resolvedPath: readonly string[];
	readonly action: string;
}

export async function invokeMenu(
	pid: number,
	path: readonly string[],
	accessibility: MenuAccessibility = nativeMenuAccessibility,
): Promise<InvokeMenuResult> {
	const normalizedPath = normalizeMenuPath(path);
	const application = accessibility.createApplication(pid);
	// An enabled item is pressed directly, the way a key equivalent runs it: no menu opens over the
	// person's screen, and the app never enters menu tracking, where it stops answering. Opening the
	// menus hop by hop is what a menu-bar item or a submenu that must be shown first still needs.
	if (normalizedPath.length > 1) {
		try {
			if (pressLeafDirectly(application, normalizedPath, accessibility)) {
				accessibility.release(application);
				return { resolvedPath: normalizedPath, action: "AXPress" };
			}
		} catch (error) {
			accessibility.release(application);
			throw error;
		}
	}
	let finalAction = "";
	// Pressing a menu-bar item opens its menu and puts the app in menu tracking, where it answers
	// neither AppleScript nor most accessibility requests until the menu closes. A later hop that
	// fails must close that menu again, or the app stays wedged with a menu open.
	let openedMenu = false;
	try {
		for (let depth = 0; depth < normalizedPath.length; depth += 1) {
			const target = resolvePrefix(application, normalizedPath.slice(0, depth + 1), accessibility);
			try {
				if (accessibility.booleanAttribute(target, "AXEnabled") === false) {
					throw menuFailure(depth, normalizedPath, disabledReason(application, accessibility));
				}
				const action = chooseMenuAction(accessibility.actionNames(target));
				if (action === undefined) {
					throw menuFailure(depth, normalizedPath, "has no usable native menu action");
				}
				try {
					accessibility.perform(target, action);
				} catch (error: unknown) {
					const details = error instanceof Error ? error.message : String(error);
					throw menuFailure(depth, normalizedPath, `native action ${action} failed: ${details}`);
				}
				finalAction = action;
				if (depth + 1 < normalizedPath.length) {
					openedMenu = true;
				}
			} finally {
				accessibility.release(target);
			}
			if (depth + 1 < normalizedPath.length) {
				await accessibility.delay(MENU_SETTLE_MILLISECONDS);
			}
		}
	} catch (error) {
		if (openedMenu && !closeOpenedMenu(application, normalizedPath[0] ?? "", accessibility)) {
			const details = error instanceof Error ? error.message : String(error);
			throw new Error(`${details}; the menu it opened could not be closed, so the app may stay busy until Escape`);
		}
		throw error;
	} finally {
		accessibility.release(application);
	}
	return { resolvedPath: normalizedPath, action: finalAction };
}

/**
 * Press the item at the end of the path without opening its menus. True when it ran; false when the
 * item could not be resolved without opening a menu (the hop-by-hop walk is then the route). A
 * disabled item is refused here, the same refusal the walk gives, so no menu is opened for it.
 */
function pressLeafDirectly(
	application: AXUIElementRef,
	path: readonly string[],
	accessibility: MenuAccessibility,
): boolean {
	let item: AXUIElementRef;
	try {
		item = resolvePrefix(application, path, accessibility);
	} catch {
		return false;
	}
	try {
		if (accessibility.booleanAttribute(item, "AXEnabled") === false) {
			throw menuFailure(path.length - 1, path, disabledReason(application, accessibility));
		}
		if (!accessibility.actionNames(item).includes("AXPress")) {
			return false;
		}
		accessibility.perform(item, "AXPress");
		return true;
	} finally {
		accessibility.release(item);
	}
}

/** Cancel the menu a menu-bar item opened, which also closes every submenu opened under it. */
function closeOpenedMenu(application: AXUIElementRef, title: string, accessibility: MenuAccessibility): boolean {
	let item: AXUIElementRef;
	try {
		item = resolvePrefix(application, [title], accessibility);
	} catch {
		return false;
	}
	let closed = false;
	try {
		for (const child of accessibility.copyChildren(item)) {
			try {
				if (!closed && accessibility.stringAttribute(child, "AXRole") === "AXMenu") {
					accessibility.perform(child, "AXCancel");
					closed = true;
				}
			} catch {
				closed = false;
			} finally {
				accessibility.release(child);
			}
		}
	} finally {
		accessibility.release(item);
	}
	return closed;
}

function disabledReason(application: AXUIElementRef, accessibility: MenuAccessibility): string {
	return accessibility.booleanAttribute(application, "AXFrontmost") === false
		? "is disabled: the app is in the background, and macOS disables window commands such as Save, Close and Select All until the app is active; press the window's own button for it instead (find_elements, e.g. Reminders' Add Reminder)"
		: "is disabled";
}

/** AXMenuItemCmdModifiers bits. Command is implied unless the "no command" bit is set. */
const MENU_MODIFIER_SHIFT = 1;
const MENU_MODIFIER_OPTION = 2;
const MENU_MODIFIER_CONTROL = 4;
const MENU_MODIFIER_NO_COMMAND = 8;
const MENU_MODIFIER_KEYS = MENU_MODIFIER_SHIFT | MENU_MODIFIER_OPTION | MENU_MODIFIER_CONTROL;

export interface MenuKeyEquivalent {
	readonly path: readonly string[];
	readonly enabled: boolean;
}

/**
 * The menu mask a Command chord corresponds to, or undefined when the chord has no Command key
 * (only Command chords are menu key equivalents).
 */
export function commandChordMask(modifiers: readonly string[]): number | undefined {
	const names = new Set(modifiers.map((modifier) => modifier.trim().toLowerCase()));
	if (![...names].some((name) => ["cmd", "command", "meta", "super"].includes(name))) {
		return undefined;
	}
	let mask = 0;
	if (names.has("shift")) {
		mask |= MENU_MODIFIER_SHIFT;
	}
	if (names.has("option") || names.has("alt")) {
		mask |= MENU_MODIFIER_OPTION;
	}
	if (names.has("control") || names.has("ctrl")) {
		mask |= MENU_MODIFIER_CONTROL;
	}
	return mask;
}

/**
 * The menu item a Command chord would trigger, read from the menu bar without opening any menu:
 * each item publishes its key equivalent (AXMenuItemCmdChar) and modifiers. Looks one submenu
 * level deep, which covers Format > Font > Bold style shortcuts.
 */
export function findMenuKeyEquivalent(
	pid: number,
	key: string,
	modifiers: readonly string[],
	accessibility: MenuAccessibility = nativeMenuAccessibility,
): MenuKeyEquivalent | undefined {
	const mask = commandChordMask(modifiers);
	if (mask === undefined || Array.from(key).length !== 1) {
		return undefined;
	}
	const application = accessibility.createApplication(pid);
	try {
		const menuBar = accessibility.elementAttribute(application, "AXMenuBar");
		if (menuBar === null) {
			return undefined;
		}
		try {
			return searchKeyEquivalent(menuBar, [], key.toLowerCase(), mask, 0, accessibility);
		} finally {
			accessibility.release(menuBar);
		}
	} finally {
		accessibility.release(application);
	}
}

function searchKeyEquivalent(
	parent: AXUIElementRef,
	path: readonly string[],
	key: string,
	mask: number,
	depth: number,
	accessibility: MenuAccessibility,
): MenuKeyEquivalent | undefined {
	const children = semanticChildren(parent, accessibility);
	try {
		for (const child of children) {
			const title = accessibility.stringAttribute(child, "AXTitle") ?? "";
			const itemPath = [...path, title];
			const character = accessibility.stringAttribute(child, "AXMenuItemCmdChar");
			const itemModifiers = accessibility.numberAttribute(child, "AXMenuItemCmdModifiers") ?? 0;
			if (
				character !== null &&
				character.toLowerCase() === key &&
				(itemModifiers & MENU_MODIFIER_NO_COMMAND) === 0 &&
				(itemModifiers & MENU_MODIFIER_KEYS) === mask
			) {
				return { path: itemPath, enabled: accessibility.booleanAttribute(child, "AXEnabled") !== false };
			}
			// The menu bar's items are menus; below them one submenu level is searched.
			if (depth < 2) {
				const found = searchKeyEquivalent(child, itemPath, key, mask, depth + 1, accessibility);
				if (found !== undefined) {
					return found;
				}
			}
		}
		return undefined;
	} finally {
		for (const child of children) {
			accessibility.release(child);
		}
	}
}

/**
 * Press a menu item directly, without opening the menus above it, so an app in the background
 * runs the command without a menu appearing over the person's screen.
 */
export function pressMenuItem(
	pid: number,
	path: readonly string[],
	accessibility: MenuAccessibility = nativeMenuAccessibility,
): void {
	const normalizedPath = normalizeMenuPath(path);
	const application = accessibility.createApplication(pid);
	try {
		const item = resolvePrefix(application, normalizedPath, accessibility);
		try {
			if (accessibility.booleanAttribute(item, "AXEnabled") === false) {
				throw menuFailure(normalizedPath.length - 1, normalizedPath, disabledReason(application, accessibility));
			}
			accessibility.perform(item, "AXPress");
		} finally {
			accessibility.release(item);
		}
	} finally {
		accessibility.release(application);
	}
}

/** Whether the app is the active one, which is what makes its window commands available. */
export function applicationIsFrontmost(
	pid: number,
	accessibility: MenuAccessibility = nativeMenuAccessibility,
): boolean {
	const application = accessibility.createApplication(pid);
	try {
		return accessibility.booleanAttribute(application, "AXFrontmost") === true;
	} finally {
		accessibility.release(application);
	}
}

/**
 * Whether the item at `path` is enabled, read without opening any menu; undefined when it cannot be
 * resolved that way (a submenu that only fills while it is shown).
 */
function menuItemEnabled(
	pid: number,
	path: readonly string[],
	accessibility: MenuAccessibility = nativeMenuAccessibility,
): boolean | undefined {
	const application = accessibility.createApplication(pid);
	try {
		let item: AXUIElementRef;
		try {
			item = resolvePrefix(application, path, accessibility);
		} catch {
			return undefined;
		}
		try {
			return accessibility.booleanAttribute(item, "AXEnabled") !== false;
		} finally {
			accessibility.release(item);
		}
	} finally {
		accessibility.release(application);
	}
}

/**
 * Wait, bounded, for the item at `path` to read enabled. An app told it is active re-validates its menus on
 * its next pass through its event loop, not at once, and re-validating retitles items as well as enabling
 * them (Save… becomes Save once a saved document's window is main), so an item that does not resolve yet
 * is waited for too. True once it reads enabled; false when it stays disabled (the command does not apply
 * to that window right now) or never resolves without opening a menu.
 */
async function waitForMenuItemEnabled(
	pid: number,
	path: readonly string[],
	accessibility: MenuAccessibility = nativeMenuAccessibility,
): Promise<boolean> {
	for (let poll = 0; ; poll += 1) {
		if (menuItemEnabled(pid, path, accessibility) === true) {
			return true;
		}
		if (poll >= MENU_ENABLE_POLLS) {
			return false;
		}
		await accessibility.delay(MENU_ENABLE_POLL_MILLISECONDS);
	}
}

/**
 * The menu item a Command chord stands for, waited for (bounded, as waitForMenuItemEnabled) until it reads
 * enabled in an app just told it is active. It is looked up by its key on every poll, since re-validating
 * can retitle it. Undefined when none turns up enabled in time.
 */
export async function waitForKeyEquivalentEnabled(
	pid: number,
	key: string,
	modifiers: readonly string[],
	accessibility: MenuAccessibility = nativeMenuAccessibility,
): Promise<MenuKeyEquivalent | undefined> {
	for (let poll = 0; ; poll += 1) {
		const item = findMenuKeyEquivalent(pid, key, modifiers, accessibility);
		if (item?.enabled === true) {
			return item;
		}
		if (poll >= MENU_ENABLE_POLLS) {
			return undefined;
		}
		await accessibility.delay(MENU_ENABLE_POLL_MILLISECONDS);
	}
}

/**
 * Runs a window command for the window it is meant for (MacOSInputController.withWindowCommand): it asks
 * `wantsActivation` whether an app behind the person's should be told it is active first, and tells
 * `command` whether the app is held active while it runs.
 */
export type WindowMenuRunner = (
	wantsActivation: () => boolean,
	command: (held: boolean) => Promise<InvokeMenuResult>,
) => Promise<InvokeMenuResult>;

/**
 * Invoke a menu path for one window of an app that may sit behind the person's. macOS validates window
 * commands (Save, Close, New Folder) against their app being active: in the background they read
 * disabled, and the enabled flags and titles an inactive app reports are only what it last validated, so
 * they are no evidence either way. When the app has the path's menu, it is therefore told it is active
 * first (the runner tells the person's own frontmost app nothing), and the item is pressed once it reads
 * enabled under its re-validated title. An item that stays disabled is refused with the reason: nothing
 * is pressed that would not run.
 */
export async function invokeWindowMenu(
	pid: number,
	path: readonly string[],
	runWindowCommand: WindowMenuRunner,
	accessibility: MenuAccessibility = nativeMenuAccessibility,
): Promise<InvokeMenuResult> {
	const normalizedPath = normalizeMenuPath(path);
	return await runWindowCommand(
		() => menuItemEnabled(pid, normalizedPath.slice(0, 1), accessibility) !== undefined,
		async (held) => {
			if (held) {
				await waitForMenuItemEnabled(pid, normalizedPath, accessibility);
			}
			return await invokeMenu(pid, normalizedPath, accessibility);
		},
	);
}

export type BackgroundKeyPlan =
	| { readonly kind: "keys" }
	| { readonly kind: "menu"; readonly path: readonly string[] }
	| { readonly kind: "select-all" }
	| { readonly kind: "copy-selection" }
	| { readonly kind: "paste-text" }
	| { readonly kind: "refuse"; readonly message: string };

/**
 * How background delivery carries out a Command chord for an app that is not the active one.
 *
 * AppKit matches menu key equivalents only for the active app, so a posted Cmd+S reaches a
 * background app and does nothing — and window commands (Save, Select All, Copy) are disabled
 * until it is active anyway. An enabled menu item is pressed through accessibility; Select All,
 * Copy and Paste in a text field are done through accessibility on the field itself; anything
 * else is refused with the reason rather than reported as if the key had worked.
 */
export function planBackgroundKeyEquivalent(input: {
	readonly frontmost: boolean;
	readonly key: string;
	readonly modifiers: readonly string[];
	readonly item: MenuKeyEquivalent | undefined;
}): BackgroundKeyPlan {
	if (input.frontmost) {
		return { kind: "keys" };
	}
	if (input.item === undefined) {
		if (input.key.toLowerCase() === "z" && commandChordMask(input.modifiers) === 0) {
			return {
				kind: "refuse",
				message:
					"Undo is unavailable: no matching Undo menu command was found in the background app. No key was sent. Background delivery never brings the app forward; call ask_user if the person needs to perform Undo.",
			};
		}
		return { kind: "keys" };
	}
	if (input.item.enabled) {
		return { kind: "menu", path: input.item.path };
	}
	if (commandChordMask(input.modifiers) === 0) {
		switch (input.key.toLowerCase()) {
			case "a":
				return { kind: "select-all" };
			case "c":
				return { kind: "copy-selection" };
			case "v":
				return { kind: "paste-text" };
		}
	}
	const chord = [...input.modifiers, input.key].join("+");
	return {
		kind: "refuse",
		message: `${chord} would do nothing: ${input.item.path.join(" > ")} is disabled while the app is in the background, and background delivery never brings an app forward. Replace text with set_value, or call ask_user so the person can bring the app forward (or run with OPENCUA_DELIVERY=attended) for window commands such as Save.`,
	};
}

export function normalizeMenuPath(path: readonly string[]): string[] {
	if (path.length < 1 || path.length > 16) {
		throw new Error("invoke_menu: path must contain between 1 and 16 segments");
	}
	return path.map((segment, index) => {
		const normalized = segment.trim();
		if (normalized.length === 0) {
			throw new Error(`invoke_menu: path segment ${index} is empty`);
		}
		return normalized;
	});
}

export function chooseMenuAction(actions: readonly string[]): string | undefined {
	return ACTION_PRIORITY.find((action) => actions.includes(action));
}

function resolvePrefix(
	application: AXUIElementRef,
	prefix: readonly string[],
	accessibility: MenuAccessibility,
): AXUIElementRef {
	const menuBar = accessibility.elementAttribute(application, "AXMenuBar");
	if (menuBar === null) {
		throw new Error("invoke_menu: target exposes no AXMenuBar; failed at hop 0");
	}
	let current = menuBar;
	try {
		for (let depth = 0; depth < prefix.length; depth += 1) {
			const children = semanticChildren(current, accessibility);
			const segment = prefix[depth];
			const matches: AXUIElementRef[] = [];
			for (const child of children) {
				if (accessibility.stringAttribute(child, "AXTitle") === segment) {
					matches.push(child);
				} else {
					accessibility.release(child);
				}
			}
			if (matches.length !== 1) {
				for (const match of matches) {
					accessibility.release(match);
				}
				throw menuFailure(depth, prefix, matches.length === 0 ? "was not found" : "is ambiguous");
			}
			const next = matches[0];
			if (next === undefined) {
				throw new Error("invoke_menu: internal menu match disappeared");
			}
			accessibility.release(current);
			current = next;
		}
		return current;
	} catch (error) {
		accessibility.release(current);
		throw error;
	}
}

function semanticChildren(parent: AXUIElementRef, accessibility: MenuAccessibility): AXUIElementRef[] {
	const result: AXUIElementRef[] = [];
	for (const child of accessibility.copyChildren(parent)) {
		if (accessibility.stringAttribute(child, "AXRole") === "AXMenu") {
			result.push(...accessibility.copyChildren(child));
			accessibility.release(child);
		} else {
			result.push(child);
		}
	}
	return result;
}

function menuFailure(depth: number, path: readonly string[], reason: string): Error {
	return new Error(`invoke_menu: path segment ${depth} ("${path[depth] ?? ""}") ${reason}; failed at hop ${depth}`);
}

function copyElementAttribute(element: AXUIElementRef, attribute: string): AXUIElementRef | null {
	try {
		return copyAttributeValue(element, attribute);
	} catch {
		return null;
	}
}

function nativeCopyChildren(element: AXUIElementRef): AXUIElementRef[] {
	const value = copyElementAttribute(element, "AXChildren");
	if (value === null) {
		return [];
	}
	try {
		const children: AXUIElementRef[] = [];
		for (let index = 0; index < cfArrayLength(value); index += 1) {
			const child = cfArrayValueAt(value, index);
			if (child !== null) {
				children.push(cfRetain(child));
			}
		}
		return children;
	} finally {
		cfRelease(value);
	}
}

function nativeStringAttribute(element: AXUIElementRef, attribute: string): string | null {
	const value = copyElementAttribute(element, attribute);
	if (value === null) {
		return null;
	}
	try {
		return isCFString(value) ? fromCFString(value) : null;
	} finally {
		cfRelease(value);
	}
}

function nativeBooleanAttribute(element: AXUIElementRef, attribute: string): boolean | null {
	const value = copyElementAttribute(element, attribute);
	if (value === null) {
		return null;
	}
	try {
		return isCFBoolean(value) ? fromCFBoolean(value) : null;
	} finally {
		cfRelease(value);
	}
}

function nativeNumberAttribute(element: AXUIElementRef, attribute: string): number | null {
	const value = copyElementAttribute(element, attribute);
	if (value === null) {
		return null;
	}
	try {
		return isCFNumber(value) ? fromCFNumber(value) : null;
	} finally {
		cfRelease(value);
	}
}

function nativeActionNames(element: AXUIElementRef): string[] {
	const out: Array<CFArrayRef | null> = [null];
	if (AXUIElementCopyActionNames(element, out) !== 0) {
		return [];
	}
	const actions = out[0];
	if (actions === undefined || actions === null) {
		return [];
	}
	try {
		const names: string[] = [];
		for (let index = 0; index < cfArrayLength(actions); index += 1) {
			const action = cfArrayValueAt(actions, index);
			if (action !== null && isCFString(action)) {
				names.push(fromCFString(action));
			}
		}
		return names;
	} finally {
		cfRelease(actions);
	}
}

// Arrow wrappers resolve the native functions when a menu is used rather than when this module
// loads, so importing it (the host computer does) costs nothing until a menu is touched.
const nativeMenuAccessibility: MenuAccessibility = {
	createApplication: (pid) => createApplicationElement(pid),
	elementAttribute: copyElementAttribute,
	copyChildren: nativeCopyChildren,
	stringAttribute: nativeStringAttribute,
	booleanAttribute: nativeBooleanAttribute,
	numberAttribute: nativeNumberAttribute,
	actionNames: nativeActionNames,
	perform: (element, action) => performAction(element, action),
	release: (element) => releaseAXElement(element),
	delay: async (milliseconds) => await sleep(milliseconds),
};
