import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { KoffiFunc } from "koffi";
import { cfRelease, toCFString } from "./corefoundation.js";
import { koffi } from "./koffi.js";

const TEXT_TYPE = "public.utf8-plain-text";
const LEGACY_TEXT_TYPE = "NSStringPboardType";
const FILE_URL_TYPE = "public.file-url";
const IMAGE_TYPES = ["public.png", "public.jpeg", "public.tiff"] as const;

const appKit = koffi.load("/System/Library/Frameworks/AppKit.framework/AppKit");
const objc = koffi.load("/usr/lib/libobjc.A.dylib");
void appKit;

const objcGetClass = objc.func("objc_getClass", "void *", ["str"]) as KoffiFunc<(name: string) => object | null>;
const selRegisterName = objc.func("sel_registerName", "void *", ["str"]) as KoffiFunc<(name: string) => object | null>;
const msgPointer = objc.func("objc_msgSend", "void *", ["void *", "void *"]) as KoffiFunc<
	(receiver: object, selector: object) => object | null
>;
const msgPointerObject = objc.func("objc_msgSend", "void *", ["void *", "void *", "void *"]) as KoffiFunc<
	(receiver: object, selector: object, value: object) => object | null
>;
const msgPointerInteger = objc.func("objc_msgSend", "void *", ["void *", "void *", "uint64_t"]) as KoffiFunc<
	(receiver: object, selector: object, value: number) => object | null
>;
const msgBoolObject = objc.func("objc_msgSend", "bool", ["void *", "void *", "void *"]) as KoffiFunc<
	(receiver: object, selector: object, value: object) => boolean
>;
const msgBoolObjectObject = objc.func("objc_msgSend", "bool", ["void *", "void *", "void *", "void *"]) as KoffiFunc<
	(receiver: object, selector: object, first: object, second: object) => boolean
>;
const msgInteger = objc.func("objc_msgSend", "uint64_t", ["void *", "void *"]) as KoffiFunc<
	(receiver: object, selector: object) => number
>;
const msgCString = objc.func("objc_msgSend", "str", ["void *", "void *"]) as KoffiFunc<
	(receiver: object, selector: object) => string | null
>;

export interface ClipboardImage {
	readonly pasteboardType: string;
	readonly mimeType: "image/png" | "image/jpeg" | "image/tiff";
	readonly dataBase64: string;
}

export interface ClipboardReadResult {
	readonly types: readonly string[];
	readonly text?: string;
	readonly image?: ClipboardImage;
	readonly fileUrls: readonly string[];
}

export type ClipboardWriteInput =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "image"; readonly path: string }
	| { readonly type: "file-url"; readonly paths: readonly string[] };

export interface ClipboardWriteResult {
	readonly overwritten: true;
	readonly writtenType: ClipboardWriteInput["type"];
	readonly types: readonly string[];
}

export interface PasteboardAccess {
	types(): string[];
	stringForType(type: string): string | null;
	dataForType(type: string): Buffer | null;
	clear(): void;
	setString(type: string, value: string): boolean;
	writeImage(path: string): boolean;
	writeFileUrls(paths: readonly string[]): boolean;
}

export function readClipboard(access: PasteboardAccess = nativePasteboard): ClipboardReadResult {
	const types = access.types();
	const textType = types.includes(TEXT_TYPE)
		? TEXT_TYPE
		: types.includes(LEGACY_TEXT_TYPE)
			? LEGACY_TEXT_TYPE
			: undefined;
	const text = textType === undefined ? null : access.stringForType(textType);
	const imageType = IMAGE_TYPES.find((candidate) => types.includes(candidate));
	const imageData = imageType === undefined ? null : access.dataForType(imageType);
	const fileUrl = types.includes(FILE_URL_TYPE) ? access.stringForType(FILE_URL_TYPE) : null;
	let image: ClipboardImage | undefined;
	if (imageType !== undefined && imageData !== null) {
		image = {
			pasteboardType: imageType,
			mimeType: mimeTypeForPasteboardType(imageType),
			dataBase64: imageData.toString("base64"),
		};
	}
	return {
		types,
		...(text === null ? {} : { text }),
		...(image === undefined ? {} : { image }),
		fileUrls: fileUrl === null ? [] : [fileUrl],
	};
}

export function writeClipboard(
	input: ClipboardWriteInput,
	access: PasteboardAccess = nativePasteboard,
): ClipboardWriteResult {
	const prepared = prepareClipboardInput(input);
	access.clear();
	let succeeded: boolean;
	switch (prepared.type) {
		case "text":
			succeeded = access.setString(TEXT_TYPE, prepared.text);
			break;
		case "image":
			succeeded = access.writeImage(prepared.path);
			break;
		case "file-url":
			succeeded = access.writeFileUrls(prepared.paths);
			break;
	}
	if (!succeeded) {
		throw new Error(`clipboard_write: NSPasteboard refused ${prepared.type} content`);
	}
	return { overwritten: true, writtenType: prepared.type, types: access.types() };
}

function prepareClipboardInput(input: ClipboardWriteInput): ClipboardWriteInput {
	if (input.type === "image") {
		return { type: "image", path: absoluteExistingFile(input.path) };
	}
	if (input.type === "file-url") {
		if (input.paths.length === 0) {
			throw new Error("clipboard_write: file-url paths must not be empty");
		}
		return { type: "file-url", paths: input.paths.map(absoluteExistingFile) };
	}
	return input;
}

function absoluteExistingFile(path: string): string {
	if (!isAbsolute(path)) {
		throw new Error("clipboard_write: file paths must be absolute");
	}
	const normalized = resolve(path);
	let isFile = false;
	try {
		isFile = statSync(normalized).isFile();
	} catch {
		isFile = false;
	}
	if (!isFile) {
		throw new Error(`clipboard_write: path must identify an existing file: ${path}`);
	}
	return normalized;
}

function generalPasteboard(): object {
	const pasteboardClass = requireClass("NSPasteboard");
	const pasteboard = msgPointer(pasteboardClass, requireSelector("generalPasteboard"));
	if (pasteboard === null) {
		throw new Error("NSPasteboard.generalPasteboard returned null");
	}
	return pasteboard;
}

function nativeTypes(): string[] {
	const array = msgPointer(generalPasteboard(), requireSelector("types"));
	if (array === null) {
		return [];
	}
	const count = msgInteger(array, requireSelector("count"));
	const types: string[] = [];
	for (let index = 0; index < count; index += 1) {
		const value = msgPointerInteger(array, requireSelector("objectAtIndex:"), index);
		if (value !== null) {
			const text = msgCString(value, requireSelector("UTF8String"));
			if (text !== null) {
				types.push(text);
			}
		}
	}
	return types;
}

function nativeStringForType(type: string): string | null {
	const typeReference = toCFString(type);
	try {
		const value = msgPointerObject(generalPasteboard(), requireSelector("stringForType:"), typeReference);
		return value === null ? null : msgCString(value, requireSelector("UTF8String"));
	} finally {
		cfRelease(typeReference);
	}
}

function nativeDataForType(type: string): Buffer | null {
	const typeReference = toCFString(type);
	try {
		const data = msgPointerObject(generalPasteboard(), requireSelector("dataForType:"), typeReference);
		if (data === null) {
			return null;
		}
		const length = msgInteger(data, requireSelector("length"));
		const bytes = msgPointer(data, requireSelector("bytes"));
		if (bytes === null || length === 0) {
			return Buffer.alloc(0);
		}
		const decoded: ArrayLike<number> = koffi.decode(bytes, "uint8_t", length);
		return Buffer.from(decoded);
	} finally {
		cfRelease(typeReference);
	}
}

function nativeSetString(type: string, value: string): boolean {
	const typeReference = toCFString(type);
	const valueReference = toCFString(value);
	try {
		return msgBoolObjectObject(
			generalPasteboard(),
			requireSelector("setString:forType:"),
			valueReference,
			typeReference,
		);
	} finally {
		cfRelease(valueReference);
		cfRelease(typeReference);
	}
}

function nativeWriteImage(path: string): boolean {
	const imageClass = requireClass("NSImage");
	const allocated = msgPointer(imageClass, requireSelector("alloc"));
	if (allocated === null) {
		return false;
	}
	const pathReference = toCFString(path);
	let image: object | null = null;
	try {
		image = msgPointerObject(allocated, requireSelector("initWithContentsOfFile:"), pathReference);
		return image !== null && nativeWriteObjects([image]);
	} finally {
		cfRelease(pathReference);
		if (image !== null) {
			msgPointer(image, requireSelector("release"));
		} else {
			msgPointer(allocated, requireSelector("release"));
		}
	}
}

function nativeWriteFileUrls(paths: readonly string[]): boolean {
	const urlClass = requireClass("NSURL");
	const urls: object[] = [];
	for (const path of paths) {
		const pathReference = toCFString(path);
		try {
			const url = msgPointerObject(urlClass, requireSelector("fileURLWithPath:"), pathReference);
			if (url === null) {
				return false;
			}
			urls.push(url);
		} finally {
			cfRelease(pathReference);
		}
	}
	return nativeWriteObjects(urls);
}

function nativeWriteObjects(objects: readonly object[]): boolean {
	if (objects.length === 0) {
		return false;
	}
	const mutableArrayClass = requireClass("NSMutableArray");
	const array = msgPointer(mutableArrayClass, requireSelector("array"));
	if (array === null) {
		return false;
	}
	for (const object of objects) {
		msgPointerObject(array, requireSelector("addObject:"), object);
	}
	return msgBoolObject(generalPasteboard(), requireSelector("writeObjects:"), array);
}

function mimeTypeForPasteboardType(type: (typeof IMAGE_TYPES)[number]): ClipboardImage["mimeType"] {
	if (type === "public.png") {
		return "image/png";
	}
	return type === "public.jpeg" ? "image/jpeg" : "image/tiff";
}

function requireClass(name: string): object {
	const value = objcGetClass(name);
	if (value === null) {
		throw new Error(`Objective-C class not found: ${name}`);
	}
	return value;
}

function requireSelector(name: string): object {
	const value = selRegisterName(name);
	if (value === null) {
		throw new Error(`Objective-C selector not found: ${name}`);
	}
	return value;
}

const nativePasteboard: PasteboardAccess = {
	types: nativeTypes,
	stringForType: nativeStringForType,
	dataForType: nativeDataForType,
	clear: () => {
		msgInteger(generalPasteboard(), requireSelector("clearContents"));
	},
	setString: nativeSetString,
	writeImage: nativeWriteImage,
	writeFileUrls: nativeWriteFileUrls,
};
