import type { KoffiFunc } from "koffi";
import {
	type CFTypeRef,
	cfArrayLength,
	cfArrayValueAt,
	cfDictionaryValue,
	cfRelease,
	fromCFNumber,
	fromCFString,
	isCFArray,
	isCFDictionary,
	isCFNumber,
	isCFString,
	toCFInt32Number,
	withCFArray,
	withCFString,
} from "./corefoundation.js";
import { koffi } from "./koffi.js";

export type SpaceInfo = {
	readonly id: number;
	readonly type: number;
	readonly uuid?: string;
};

export type ManagedDisplaySpaces = {
	readonly displayIdentifier: string;
	readonly currentSpaceId: number;
	readonly spaces: readonly SpaceInfo[];
};

const skyLight = koffi.load("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight");
const SLSMainConnectionID = skyLight.func("SLSMainConnectionID", "uint32_t", []) as KoffiFunc<() => number>;
const SLSGetActiveSpace = skyLight.func("SLSGetActiveSpace", "uint64_t", ["uint32_t"]) as KoffiFunc<
	(connection: number) => number
>;
const SLSCopyManagedDisplaySpaces = skyLight.func("SLSCopyManagedDisplaySpaces", "void *", ["uint32_t"]) as KoffiFunc<
	(connection: number) => CFTypeRef | null
>;
/** Mask 7 asks for every space kind (user, full-screen, system) the window is on. */
const ALL_SPACES_MASK = 7;
const SLSCopySpacesForWindows = skyLight.func("SLSCopySpacesForWindows", "void *", [
	"uint32_t",
	"int32_t",
	"void *",
]) as KoffiFunc<(connection: number, mask: number, windows: CFTypeRef) => CFTypeRef | null>;
const SLSSpaceGetType = skyLight.func("SLSSpaceGetType", "uint32_t", ["uint32_t", "uint64_t"]) as KoffiFunc<
	(connection: number, spaceId: number) => number
>;

export function activeSpaceId(): number | undefined {
	try {
		const id = SLSGetActiveSpace(SLSMainConnectionID());
		return Number.isSafeInteger(id) && id > 0 ? id : undefined;
	} catch (error) {
		if (error instanceof Error) {
			return undefined;
		}
		throw error;
	}
}

export function managedDisplaySpaces(): ManagedDisplaySpaces[] {
	let copied: CFTypeRef | null;
	try {
		copied = SLSCopyManagedDisplaySpaces(SLSMainConnectionID());
	} catch (error) {
		if (error instanceof Error) {
			return [];
		}
		throw error;
	}
	if (copied === null) {
		return [];
	}
	try {
		if (!isCFArray(copied)) {
			return [];
		}
		return readManagedDisplays(copied);
	} catch (error) {
		if (error instanceof Error) {
			return [];
		}
		throw error;
	} finally {
		cfRelease(copied);
	}
}

export function spaceTypeFor(spaceId: number): number | undefined {
	if (!Number.isSafeInteger(spaceId) || spaceId <= 0) {
		return undefined;
	}
	try {
		const type = SLSSpaceGetType(SLSMainConnectionID(), spaceId);
		return Number.isSafeInteger(type) ? type : undefined;
	} catch (error) {
		if (error instanceof Error) {
			return undefined;
		}
		throw error;
	}
}

/**
 * The spaces each window is on. SLSCopySpacesForWindows answers one flat list of space ids for all the windows it is
 * given (not a list per window), so each window is asked on its own, as an SInt32 CFNumber. A window the call does not
 * place on any space (an unknown window, or one that joins every space) is left out of the map.
 */
export function spacesForWindows(windowIds: readonly number[]): Map<number, number[]> {
	if (windowIds.some((id) => !Number.isSafeInteger(id) || id <= 0 || id > 0xffffffff)) {
		return new Map();
	}
	return parseWindowSpaceResults(windowIds, windowIds.map(spacesForWindow));
}

function spacesForWindow(windowId: number): number[] {
	const number = toCFInt32Number(windowId | 0);
	try {
		return withCFArray([number], (windows) => {
			const copied = SLSCopySpacesForWindows(SLSMainConnectionID(), ALL_SPACES_MASK, windows);
			if (copied === null) return [];
			try {
				return readSpaceIds(copied);
			} finally {
				cfRelease(copied);
			}
		});
	} finally {
		cfRelease(number);
	}
}

/** Space ids from the copied list; anything that is not an array of numbers yields none rather than a crash. */
function readSpaceIds(list: CFTypeRef): number[] {
	if (!isCFArray(list)) return [];
	const ids: number[] = [];
	for (let index = 0; index < cfArrayLength(list); index += 1) {
		const value = cfArrayValueAt(list, index);
		if (value === null || !isCFNumber(value)) continue;
		const id = fromCFNumber(value);
		if (Number.isSafeInteger(id) && id > 0) ids.push(id);
	}
	return ids;
}

/** Pair each window with its space ids; a window with no spaces is left out. */
export function parseWindowSpaceResults(
	windowIds: readonly number[],
	spaceIdsByWindow: readonly (readonly number[])[],
): Map<number, number[]> {
	return new Map(
		windowIds.flatMap((windowId, index) => {
			const spaceIds = spaceIdsByWindow[index];
			return spaceIds === undefined || spaceIds.length === 0 ? [] : [[windowId, [...spaceIds]]];
		}),
	);
}

function readManagedDisplays(array: CFTypeRef): ManagedDisplaySpaces[] {
	const displays: ManagedDisplaySpaces[] = [];
	for (let index = 0; index < cfArrayLength(array); index += 1) {
		const reference = cfArrayValueAt(array, index);
		if (reference === null || !isCFDictionary(reference)) {
			continue;
		}
		const identifier = dictionaryString(reference, "Display Identifier");
		const current = dictionaryValue(reference, "Current Space");
		if (identifier === undefined || current === null || !isCFDictionary(current)) {
			continue;
		}
		const currentSpaceId = dictionaryNumber(current, "ManagedSpaceID") ?? dictionaryNumber(current, "id64");
		const spaces = dictionaryValue(reference, "Spaces");
		if (currentSpaceId === undefined || spaces === null || !isCFArray(spaces)) {
			continue;
		}
		displays.push({
			displayIdentifier: identifier,
			currentSpaceId,
			spaces: readSpaces(spaces),
		});
	}
	return displays;
}

function readSpaces(array: CFTypeRef): SpaceInfo[] {
	const spaces: SpaceInfo[] = [];
	for (let index = 0; index < cfArrayLength(array); index += 1) {
		const reference = cfArrayValueAt(array, index);
		if (reference === null || !isCFDictionary(reference)) {
			continue;
		}
		const id = dictionaryNumber(reference, "ManagedSpaceID") ?? dictionaryNumber(reference, "id64");
		const type = dictionaryNumber(reference, "type");
		if (id === undefined || type === undefined) {
			continue;
		}
		const uuid = dictionaryString(reference, "uuid");
		spaces.push(uuid === undefined ? { id, type } : { id, type, uuid });
	}
	return spaces;
}

function dictionaryValue(dictionary: CFTypeRef, key: string): CFTypeRef | null {
	return withCFString(key, (keyReference) => cfDictionaryValue(dictionary, keyReference));
}

function dictionaryNumber(dictionary: CFTypeRef, key: string): number | undefined {
	const value = dictionaryValue(dictionary, key);
	return value !== null && isCFNumber(value) ? fromCFNumber(value) : undefined;
}

function dictionaryString(dictionary: CFTypeRef, key: string): string | undefined {
	const value = dictionaryValue(dictionary, key);
	return value !== null && isCFString(value) ? fromCFString(value) : undefined;
}
