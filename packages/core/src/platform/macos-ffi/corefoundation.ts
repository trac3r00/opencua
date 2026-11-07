import type { KoffiFunc } from "koffi";
import { koffi } from "./koffi.js";

export type CFTypeRef = object;
export type CFStringRef = CFTypeRef;
export type CFArrayRef = CFTypeRef;
export type CFNumberRef = CFTypeRef;
export type CFBooleanRef = CFTypeRef;

const CF_STRING_ENCODING_UTF8 = 0x08000100;

const coreFoundation = koffi.load("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation");
const CF_TYPE_REF = koffi.pointer("CFTypeRef", koffi.opaque());
// One opaque pointer type for every CF reference: the distinctions below live in
// TypeScript, and koffi-level tags would reject a CFString where an array of CFTypeRef
// is expected.
const CF_STRING_REF = CF_TYPE_REF;
const CF_ARRAY_REF = CF_TYPE_REF;
const CF_TYPE_REF_POINTER = koffi.pointer(CF_TYPE_REF);

const CF_NUMBER_DOUBLE_TYPE = 13;
const CF_NUMBER_SINT32_TYPE = 3;

const CFGetTypeID = coreFoundation.func("CFGetTypeID", "ulong", ["void *"]) as KoffiFunc<
	(reference: CFTypeRef) => number
>;

const CFRetainNative = coreFoundation.func("CFRetain", "void *", ["void *"]) as KoffiFunc<
	(reference: CFTypeRef) => CFTypeRef
>;

const CFStringCreateWithCString = coreFoundation.func("CFStringCreateWithCString", CF_STRING_REF, [
	"void *",
	"string",
	"uint32_t",
]) as KoffiFunc<(allocator: null, value: string, encoding: number) => CFStringRef | null>;

const CFStringGetLength = coreFoundation.func("CFStringGetLength", "long", ["void *"]) as KoffiFunc<
	(reference: CFStringRef) => number
>;

const CFStringGetMaximumSizeForEncoding = coreFoundation.func("CFStringGetMaximumSizeForEncoding", "long", [
	"long",
	"uint32_t",
]) as KoffiFunc<(length: number, encoding: number) => number>;

const CFStringGetCString = coreFoundation.func("CFStringGetCString", "bool", [
	"void *",
	"char *",
	"long",
	"uint32_t",
]) as KoffiFunc<(reference: CFStringRef, buffer: Buffer, bufferSize: number, encoding: number) => boolean>;

const CFArrayCreate = coreFoundation.func("CFArrayCreate", CF_ARRAY_REF, [
	"void *",
	CF_TYPE_REF_POINTER,
	"long",
	"void *",
]) as KoffiFunc<
	(allocator: null, values: readonly CFTypeRef[] | null, valueCount: number, callbacks: null) => CFArrayRef | null
>;

const CFArrayGetCount = coreFoundation.func("CFArrayGetCount", "long", ["void *"]) as KoffiFunc<
	(reference: CFArrayRef) => number
>;

let cfDictionaryGetValueBinding: KoffiFunc<(dictionary: CFTypeRef, key: CFStringRef) => CFTypeRef | null> | undefined;

function getCFDictionaryGetValue(): KoffiFunc<(dictionary: CFTypeRef, key: CFStringRef) => CFTypeRef | null> {
	if (cfDictionaryGetValueBinding === undefined) {
		cfDictionaryGetValueBinding = coreFoundation.func("CFDictionaryGetValue", "void *", [
			"void *",
			"void *",
		]) as KoffiFunc<(dictionary: CFTypeRef, key: CFStringRef) => CFTypeRef | null>;
	}
	return cfDictionaryGetValueBinding;
}

const CFArrayGetValueAtIndex = coreFoundation.func("CFArrayGetValueAtIndex", "void *", ["void *", "long"]) as KoffiFunc<
	(reference: CFArrayRef, index: number) => CFTypeRef | null
>;

const CFStringGetTypeID = coreFoundation.func("CFStringGetTypeID", "ulong", []) as KoffiFunc<() => number>;

const CFNumberGetTypeID = coreFoundation.func("CFNumberGetTypeID", "ulong", []) as KoffiFunc<() => number>;

const CFNumberGetValue = coreFoundation.func("CFNumberGetValue", "bool", ["void *", "int32_t", "void *"]) as KoffiFunc<
	(reference: CFNumberRef, type: number, valuePointer: Buffer) => boolean
>;

const CFArrayGetTypeID = coreFoundation.func("CFArrayGetTypeID", "ulong", []) as KoffiFunc<() => number>;

const CFBooleanGetTypeID = coreFoundation.func("CFBooleanGetTypeID", "ulong", []) as KoffiFunc<() => number>;

const CFNullGetTypeID = coreFoundation.func("CFNullGetTypeID", "ulong", []) as KoffiFunc<() => number>;

let cfDictionaryGetTypeIdBinding: KoffiFunc<() => number> | undefined;

// Bound on first use rather than at module load: a harness that mocks this module should not have
// to know about a function only the window listing needs.
function cfDictionaryGetTypeId(): number {
	if (cfDictionaryGetTypeIdBinding === undefined) {
		cfDictionaryGetTypeIdBinding = coreFoundation.func("CFDictionaryGetTypeID", "ulong", []) as KoffiFunc<
			() => number
		>;
	}
	return cfDictionaryGetTypeIdBinding();
}

const CFBooleanGetValue = coreFoundation.func("CFBooleanGetValue", "bool", ["void *"]) as KoffiFunc<
	(reference: CFBooleanRef) => boolean
>;

const CFReleaseNative = coreFoundation.func("CFRelease", "void", ["void *"]) as KoffiFunc<
	(reference: CFTypeRef) => void
>;

let booleanTrue: CFBooleanRef | undefined;

/** The kCFBooleanTrue constant, read from CoreFoundation's exported variable on first use. */
export function cfBooleanTrue(): CFBooleanRef {
	booleanTrue ??= koffi.decode(coreFoundation.symbol("kCFBooleanTrue", "void *"), "void *");
	if (booleanTrue === undefined || booleanTrue === null) {
		throw new Error("kCFBooleanTrue is unavailable");
	}
	return booleanTrue;
}

export function cfGetTypeId(reference: CFTypeRef): number {
	return CFGetTypeID(reference);
}

export function cfRetain(reference: CFTypeRef): CFTypeRef {
	return CFRetainNative(reference);
}

export function cfRelease(reference: CFTypeRef | null): void {
	if (reference !== null) {
		CFReleaseNative(reference);
	}
}

export function toCFString(value: string): CFStringRef {
	const reference = CFStringCreateWithCString(null, value, CF_STRING_ENCODING_UTF8);
	if (reference === null) {
		throw new Error("CFStringCreateWithCString returned null");
	}
	return reference;
}

export function fromCFString(reference: CFStringRef): string {
	const length = CFStringGetLength(reference);
	const maximumSize = CFStringGetMaximumSizeForEncoding(length, CF_STRING_ENCODING_UTF8);
	if (maximumSize < 0) {
		throw new Error("CFStringGetMaximumSizeForEncoding returned a negative length");
	}

	const buffer = Buffer.alloc(maximumSize + 1);
	const didCopy = CFStringGetCString(reference, buffer, buffer.byteLength, CF_STRING_ENCODING_UTF8);
	if (!didCopy) {
		throw new Error("CFStringGetCString failed");
	}

	const endIndex = buffer.indexOf(0);
	return buffer.subarray(0, endIndex === -1 ? buffer.byteLength : endIndex).toString("utf8");
}

let cfNumberCreateBinding:
	| KoffiFunc<(allocator: null, numberType: number, valuePtr: Buffer) => CFNumberRef | null>
	| undefined;

/** Bound on first use, like CFDictionaryGetValue, so loading this module binds only what every caller needs. */
function getCFNumberCreate(): KoffiFunc<(allocator: null, numberType: number, valuePtr: Buffer) => CFNumberRef | null> {
	if (cfNumberCreateBinding === undefined) {
		cfNumberCreateBinding = coreFoundation.func("CFNumberCreate", CF_TYPE_REF, [
			"void *",
			"int",
			"void *",
		]) as KoffiFunc<(allocator: null, numberType: number, valuePtr: Buffer) => CFNumberRef | null>;
	}
	return cfNumberCreateBinding;
}

/** A CFNumber holding a double; the caller releases it. */
export function toCFNumber(value: number): CFNumberRef {
	const buffer = Buffer.alloc(8);
	buffer.writeDoubleLE(value, 0);
	const reference = getCFNumberCreate()(null, CF_NUMBER_DOUBLE_TYPE, buffer);
	if (reference === null) {
		throw new Error("CFNumberCreate failed");
	}
	return reference;
}

/** A CFNumber holding a 32-bit integer, for APIs that read their numbers as SInt32; the caller releases it. */
export function toCFInt32Number(value: number): CFNumberRef {
	const buffer = Buffer.alloc(4);
	buffer.writeInt32LE(value, 0);
	const reference = getCFNumberCreate()(null, CF_NUMBER_SINT32_TYPE, buffer);
	if (reference === null) {
		throw new Error("CFNumberCreate failed");
	}
	return reference;
}

export function fromCFNumber(reference: CFNumberRef): number {
	const buffer = Buffer.alloc(8);
	if (!CFNumberGetValue(reference, CF_NUMBER_DOUBLE_TYPE, buffer)) {
		throw new Error("CFNumberGetValue failed");
	}
	return buffer.readDoubleLE(0);
}

export function fromCFBoolean(reference: CFBooleanRef): boolean {
	return CFBooleanGetValue(reference);
}

export function cfArrayLength(reference: CFArrayRef): number {
	return CFArrayGetCount(reference);
}

/**
 * Type check for values that claim to be arrays. Applications do misreport attribute
 * types (an `AXChildren` value that is a string, a number, or a bare element), and
 * treating such a value as a CFArray crashes inside CFArrayGetCount.
 */
export function isCFArray(reference: CFTypeRef): reference is CFArrayRef {
	return cfGetTypeId(reference) === CFArrayGetTypeID();
}

export function cfArrayValueAt(reference: CFArrayRef, index: number): CFTypeRef | null {
	return CFArrayGetValueAtIndex(reference, index);
}

/** Borrowed value from a dictionary: the containing collection still owns it. */
export function cfDictionaryValue(dictionary: CFTypeRef, key: CFStringRef): CFTypeRef | null {
	return getCFDictionaryGetValue()(dictionary, key);
}

export function isCFString(reference: CFTypeRef): reference is CFStringRef {
	return cfGetTypeId(reference) === CFStringGetTypeID();
}

export function isCFNumber(reference: CFTypeRef): reference is CFNumberRef {
	return cfGetTypeId(reference) === CFNumberGetTypeID();
}

export function isCFBoolean(reference: CFTypeRef): reference is CFBooleanRef {
	return cfGetTypeId(reference) === CFBooleanGetTypeID();
}

/**
 * Type check before reading a nested dictionary. `kCGWindowBounds` arrives as one, and a value
 * that merely claims to be a dictionary crashes inside CFDictionaryGetValue.
 */
export function isCFDictionary(reference: CFTypeRef): boolean {
	return cfGetTypeId(reference) === cfDictionaryGetTypeId();
}

/** `kCFNull`, which `AXUIElementCopyMultipleAttributeValues` returns for unsupported attributes. */
export function isCFNull(reference: CFTypeRef): boolean {
	return cfGetTypeId(reference) === CFNullGetTypeID();
}

export function withCFString<TResult>(value: string, callback: (reference: CFStringRef) => TResult): TResult {
	const reference = toCFString(value);
	try {
		return callback(reference);
	} finally {
		cfRelease(reference);
	}
}

export function withCFArray<TResult>(
	values: readonly CFTypeRef[],
	callback: (reference: CFArrayRef) => TResult,
): TResult {
	const reference = CFArrayCreate(null, values.length === 0 ? null : values, values.length, null);
	if (reference === null) {
		throw new Error("CFArrayCreate returned null");
	}

	try {
		return callback(reference);
	} finally {
		cfRelease(reference);
	}
}
