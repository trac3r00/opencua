import type { KoffiFunc } from "koffi";
import type { AppUsage } from "../app-usage.js";
import {
	type CFTypeRef,
	cfArrayLength,
	cfArrayValueAt,
	cfDictionaryValue,
	cfGetTypeId,
	cfRelease,
	fromCFNumber,
	isCFDictionary,
	isCFNumber,
	toCFString,
	withCFArray,
} from "./corefoundation.js";
import { koffi } from "./koffi.js";

const coreServices = koffi.load("/System/Library/Frameworks/CoreServices.framework/CoreServices");
const coreFoundation = koffi.load("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation");

const MDItemCreate = coreServices.func("MDItemCreate", "void *", ["void *", "void *"]) as KoffiFunc<
	(allocator: null, path: CFTypeRef) => CFTypeRef | null
>;
const MDItemsCopyAttributes = coreServices.func("MDItemsCopyAttributes", "void *", ["void *", "void *"]) as KoffiFunc<
	(items: CFTypeRef, names: CFTypeRef) => CFTypeRef | null
>;
const CFDateGetAbsoluteTime = coreFoundation.func("CFDateGetAbsoluteTime", "double", ["void *"]) as KoffiFunc<
	(date: CFTypeRef) => number
>;
const CFDateGetTypeID = coreFoundation.func("CFDateGetTypeID", "ulong", []) as KoffiFunc<() => number>;

/** Seconds from the Unix epoch to CoreFoundation's reference date, 2001-01-01T00:00:00Z. */
const CF_ABSOLUTE_TIME_EPOCH_SECONDS = 978_307_200;

/**
 * Spotlight's last-used date and use count for each application bundle, read in-process with one
 * MDItemsCopyAttributes call for every path instead of a spawned `mdls`. Dates are formatted the way
 * `mdls` prints them (`2026-11-08 21:59:20 +0000`), so callers see the same strings. A path Spotlight
 * does not know answers with no usage.
 */
export function readAppUsage(paths: readonly string[]): Map<string, AppUsage> {
	const usage = new Map<string, AppUsage>(paths.map((path) => [path, {}]));
	const items: { readonly path: string; readonly item: CFTypeRef }[] = [];
	try {
		for (const path of paths) {
			const pathReference = toCFString(path);
			try {
				const item = MDItemCreate(null, pathReference);
				if (item !== null) {
					items.push({ path, item });
				}
			} finally {
				cfRelease(pathReference);
			}
		}
		if (items.length === 0) {
			return usage;
		}
		const lastUsedKey = toCFString("kMDItemLastUsedDate");
		const useCountKey = toCFString("kMDItemUseCount");
		try {
			withCFArray([lastUsedKey, useCountKey], (names) =>
				withCFArray(
					items.map((entry) => entry.item),
					(itemArray) => {
						const rows = MDItemsCopyAttributes(itemArray, names);
						if (rows === null) {
							throw new Error("MDItemsCopyAttributes returned null");
						}
						try {
							const rowCount = cfArrayLength(rows);
							items.forEach((entry, index) => {
								const row = index < rowCount ? cfArrayValueAt(rows, index) : null;
								if (row !== null && isCFDictionary(row)) {
									usage.set(entry.path, usageFromAttributes(row, lastUsedKey, useCountKey));
								}
							});
						} finally {
							cfRelease(rows);
						}
					},
				),
			);
		} finally {
			cfRelease(lastUsedKey);
			cfRelease(useCountKey);
		}
		return usage;
	} finally {
		for (const { item } of items) {
			cfRelease(item);
		}
	}
}

function usageFromAttributes(attributes: CFTypeRef, lastUsedKey: CFTypeRef, useCountKey: CFTypeRef): AppUsage {
	const usage: AppUsage = {};
	const lastUsed = cfDictionaryValue(attributes, lastUsedKey);
	if (lastUsed !== null && cfGetTypeId(lastUsed) === CFDateGetTypeID()) {
		usage.lastUsedDate = formatMdlsDate(CFDateGetAbsoluteTime(lastUsed));
	}
	const useCount = cfDictionaryValue(attributes, useCountKey);
	if (useCount !== null && isCFNumber(useCount)) {
		const count = fromCFNumber(useCount);
		if (Number.isInteger(count)) {
			usage.useCount = count;
		}
	}
	return usage;
}

function formatMdlsDate(absoluteTime: number): string {
	const date = new Date(Math.floor(absoluteTime + CF_ABSOLUTE_TIME_EPOCH_SECONDS) * 1000);
	const pad = (value: number): string => String(value).padStart(2, "0");
	return (
		`${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
		`${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`
	);
}
