import type { KoffiFunc } from "koffi";

import {
	type CFTypeRef,
	cfArrayLength,
	cfArrayValueAt,
	cfDictionaryValue,
	cfRelease,
	fromCFBoolean,
	fromCFNumber,
	fromCFString,
	isCFBoolean,
	isCFDictionary,
	isCFNumber,
	isCFString,
	toCFString,
} from "./corefoundation.js";
import { koffi } from "./koffi.js";

export interface OnscreenWindow {
	readonly id: number;
	readonly ownerPid: number;
	readonly layer: number;
}

const ON_SCREEN_ONLY = 1;
const EXCLUDE_DESKTOP_ELEMENTS = 16;
const NULL_WINDOW_ID = 0;

/**
 * The dictionary keys this file reads, created once: a listing reads several keys from each of a few hundred windows,
 * and making and freeing a CFString per read was most of its cost. The set is fixed, so the strings live as long as
 * the process.
 */
const keyReferences = new Map<string, ReturnType<typeof toCFString>>();

function withKey<TResult>(key: string, callback: (reference: ReturnType<typeof toCFString>) => TResult): TResult {
	let reference = keyReferences.get(key);
	if (reference === undefined) {
		reference = toCFString(key);
		keyReferences.set(key, reference);
	}
	return callback(reference);
}

const coreGraphics = koffi.load("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics");

let windowListBinding: KoffiFunc<(option: number, relativeToWindow: number) => CFTypeRef | null> | undefined;

function getWindowListBinding(): KoffiFunc<(option: number, relativeToWindow: number) => CFTypeRef | null> | null {
	if (windowListBinding === undefined) {
		try {
			windowListBinding = coreGraphics.func("CGWindowListCopyWindowInfo", "void *", [
				"uint32_t",
				"uint32_t",
			]) as KoffiFunc<(option: number, relativeToWindow: number) => CFTypeRef | null>;
		} catch {
			return null;
		}
	}
	return windowListBinding;
}

const WINDOW_NUMBER_KEY = "kCGWindowNumber";
const WINDOW_OWNER_PID_KEY = "kCGWindowOwnerPID";
const WINDOW_LAYER_KEY = "kCGWindowLayer";
const WINDOW_OWNER_NAME_KEY = "kCGWindowOwnerName";
const WINDOW_NAME_KEY = "kCGWindowName";
const WINDOW_BOUNDS_KEY = "kCGWindowBounds";
const WINDOW_IS_ONSCREEN_KEY = "kCGWindowIsOnscreen";
const ALL_WINDOWS = 0;

export interface ListedWindow {
	readonly id: number;
	readonly ownerPid: number;
	readonly layer: number;
	/** Localized, and therefore never something to match an app by. */
	readonly ownerName: string;
	readonly title: string;
	readonly bounds: {
		readonly x: number;
		readonly y: number;
		readonly width: number;
		readonly height: number;
	};
	/** Whether the WindowServer draws it now; absent when the listing did not say. */
	readonly onScreen?: boolean;
}

/**
 * Windows the WindowServer knows about, with their bounds, on screen by default.
 *
 * `onScreenOnly: false` also reaches a window parked on another Space, hidden behind a
 * full-screen app, or minimised. That is the difference between "the app is not running a window"
 * and "the window is not where the user is looking", and it is only safe for input paths that
 * address the window directly rather than posting at global coordinates.
 */
export function listWindows(options: { readonly onScreenOnly?: boolean } = {}): readonly ListedWindow[] | undefined {
	try {
		const infos = copyWindowInfo(onScreen(options.onScreenOnly ?? true));
		if (infos === null) {
			return undefined;
		}
		try {
			const count = cfArrayLength(infos);
			const windows: ListedWindow[] = [];
			for (let index = 0; index < count; index += 1) {
				const info = cfArrayValueAt(infos, index);
				if (info === null) {
					continue;
				}
				const id = readInteger(info, WINDOW_NUMBER_KEY);
				const ownerPid = readInteger(info, WINDOW_OWNER_PID_KEY);
				if (id === undefined || ownerPid === undefined) {
					continue;
				}
				windows.push({
					id,
					ownerPid,
					layer: readInteger(info, WINDOW_LAYER_KEY) ?? 0,
					ownerName: readString(info, WINDOW_OWNER_NAME_KEY) ?? "",
					title: readString(info, WINDOW_NAME_KEY) ?? "",
					bounds: readBounds(info) ?? { x: 0, y: 0, width: 0, height: 0 },
					onScreen: readBoolean(info, WINDOW_IS_ONSCREEN_KEY) ?? false,
				});
			}
			return windows;
		} finally {
			cfRelease(infos);
		}
	} catch {
		return undefined;
	}
}

function onScreen(onScreenOnly: boolean): number {
	return (onScreenOnly ? ON_SCREEN_ONLY : ALL_WINDOWS) | EXCLUDE_DESKTOP_ELEMENTS;
}

function copyWindowInfo(option: number): CFTypeRef | null {
	const copyWindowList = getWindowListBinding();
	return copyWindowList === null ? null : copyWindowList(option, NULL_WINDOW_ID);
}

function readString(info: CFTypeRef, key: string): string | undefined {
	return withKey(key, (keyReference) => {
		const value = cfDictionaryValue(info, keyReference);
		if (value === null || !isCFString(value)) {
			return undefined;
		}
		return fromCFString(value);
	});
}

function readBoolean(info: CFTypeRef, key: string): boolean | undefined {
	return withKey(key, (keyReference) => {
		const value = cfDictionaryValue(info, keyReference);
		return value !== null && isCFBoolean(value) ? fromCFBoolean(value) : undefined;
	});
}

function readBounds(info: CFTypeRef): ListedWindow["bounds"] | undefined {
	return withKey(WINDOW_BOUNDS_KEY, (keyReference) => {
		const value = cfDictionaryValue(info, keyReference);
		if (value === null || !isCFDictionary(value)) {
			return undefined;
		}
		const x = readDictionaryNumber(value, "X");
		const y = readDictionaryNumber(value, "Y");
		const width = readDictionaryNumber(value, "Width");
		const height = readDictionaryNumber(value, "Height");
		if (x === undefined || y === undefined || width === undefined || height === undefined) {
			return undefined;
		}
		return { x, y, width, height };
	});
}

function readDictionaryNumber(dictionary: CFTypeRef, key: string): number | undefined {
	return withKey(key, (keyReference) => {
		const value = cfDictionaryValue(dictionary, keyReference);
		if (value === null || !isCFNumber(value)) {
			return undefined;
		}
		return fromCFNumber(value);
	});
}

/**
 * On-screen membership is the only public proof that a window exists, is owned by the process
 * it claims, and sits on the current Space rather than minimized or parked on another one.
 * Returns undefined when the list cannot be read at all, which callers must treat as unknown
 * rather than as "nothing is on screen".
 */
export function listOnscreenWindows(): readonly OnscreenWindow[] | undefined {
	try {
		return readOnscreenWindows() ?? undefined;
	} catch {
		return undefined;
	}
}

function readOnscreenWindows(): readonly OnscreenWindow[] | null {
	const copyWindowInfo = getWindowListBinding();
	if (copyWindowInfo === null) {
		return null;
	}
	const infos = copyWindowInfo(ON_SCREEN_ONLY | EXCLUDE_DESKTOP_ELEMENTS, NULL_WINDOW_ID);
	if (infos === null) {
		return null;
	}
	try {
		const count = cfArrayLength(infos);
		const windows: OnscreenWindow[] = [];
		for (let index = 0; index < count; index += 1) {
			const info = cfArrayValueAt(infos, index);
			if (info === null) {
				continue;
			}
			const id = readInteger(info, WINDOW_NUMBER_KEY);
			const ownerPid = readInteger(info, WINDOW_OWNER_PID_KEY);
			if (id === undefined || ownerPid === undefined) {
				continue;
			}
			windows.push({ id, ownerPid, layer: readInteger(info, WINDOW_LAYER_KEY) ?? 0 });
		}
		return windows;
	} finally {
		cfRelease(infos);
	}
}

function readInteger(info: CFTypeRef, key: string): number | undefined {
	return withKey(key, (keyReference) => {
		const value = cfDictionaryValue(info, keyReference);
		if (value === null || !isCFNumber(value)) {
			return undefined;
		}
		return fromCFNumber(value);
	});
}
