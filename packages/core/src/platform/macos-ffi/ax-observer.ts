import type { KoffiFunc } from "koffi";

import { resolveAxMessagingTimeoutSeconds } from "./ax-timeout.js";
import { cfRelease, toCFString } from "./corefoundation.js";
import { koffi } from "./koffi.js";

type AXObserverRef = object;
type AXUIElementRef = object;
type CFStringRef = object;
type CFRunLoopRef = object;
type CFRunLoopSourceRef = object;
type KoffiCType = ReturnType<typeof koffi.proto>;
type KoffiRegistered = ReturnType<typeof koffi.register>;

const AX_SUCCESS = 0;
/** The app did not answer inside the messaging timeout: stop asking it anything else. */
const AX_ERROR_CANNOT_COMPLETE = -25204;
const CALLBACK_PROTO = "void MacosCuaAxObserverCallback(void *observer, void *element, void *notification, void *ctx)";

/**
 * Notifications that mean an application's visible content or focus moved. One observer on
 * the application element receives these for its descendants, which is why a window
 * observation needs no per-element registration.
 */
const SETTLE_NOTIFICATIONS = [
	"AXValueChanged",
	"AXSelectedChildrenChanged",
	"AXSelectedRowsChanged",
	"AXSelectedTextChanged",
	"AXCreated",
	"AXUIElementDestroyed",
	"AXTitleChanged",
	"AXLayoutChanged",
	"AXMoved",
	"AXResized",
	"AXRowCountChanged",
	"AXFocusedUIElementChanged",
	"AXWindowCreated",
	"AXMenuOpened",
	"AXMenuClosed",
] as const;

export interface AxEventWaiter {
	/**
	 * Drives the run loop for at most `milliseconds` (zero only delivers what is already pending), returning the AX
	 * events that arrived since the previous drain, including any that another run-loop turn delivered in between.
	 */
	drain(milliseconds: number): number;
	release(): void;
}

export interface AxQuietOutcome {
	readonly quiet: boolean;
	readonly events: number;
	readonly elapsedMs: number;
}

interface AxObserverBindings {
	readonly createObserver: KoffiFunc<(pid: number, callback: unknown, observerOut: [AXObserverRef | null]) => number>;
	readonly addNotification: KoffiFunc<
		(observer: AXObserverRef, element: AXUIElementRef, notification: CFStringRef, refcon: null) => number
	>;
	readonly getRunLoopSource: KoffiFunc<(observer: AXObserverRef) => CFRunLoopSourceRef | null>;
	readonly createApplicationElement: KoffiFunc<(pid: number) => AXUIElementRef | null>;
	readonly setMessagingTimeout: KoffiFunc<(element: AXUIElementRef, seconds: number) => number>;
	readonly runLoopGetCurrent: KoffiFunc<() => CFRunLoopRef | null>;
	readonly addSource: KoffiFunc<(runLoop: CFRunLoopRef, source: CFRunLoopSourceRef, mode: CFStringRef) => void>;
	readonly removeSource: KoffiFunc<(runLoop: CFRunLoopRef, source: CFRunLoopSourceRef, mode: CFStringRef) => void>;
	readonly runLoopInMode: KoffiFunc<(mode: CFStringRef, seconds: number, returnAfterSourceHandled: boolean) => number>;
}

let cachedBindings: AxObserverBindings | null | undefined;
let callbackType: KoffiCType | undefined;
let defaultMode: CFStringRef | undefined;

function getCallbackType(): KoffiCType | undefined {
	if (callbackType === undefined) {
		try {
			callbackType = koffi.proto(CALLBACK_PROTO);
		} catch {
			callbackType = undefined;
		}
	}
	return callbackType;
}

function getBindings(): AxObserverBindings | null {
	if (cachedBindings !== undefined) {
		return cachedBindings;
	}
	if (getCallbackType() === undefined) {
		cachedBindings = null;
		return null;
	}
	try {
		const applicationServices = koffi.load(
			"/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices",
		);
		const coreFoundation = koffi.load("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation");
		cachedBindings = {
			createObserver: applicationServices.func(
				"int32_t AXObserverCreate(int32_t pid, MacosCuaAxObserverCallback *callback, _Out_ void **observer)",
			) as AxObserverBindings["createObserver"],
			addNotification: applicationServices.func("AXObserverAddNotification", "int32_t", [
				"void *",
				"void *",
				"void *",
				"void *",
			]) as AxObserverBindings["addNotification"],
			getRunLoopSource: applicationServices.func("AXObserverGetRunLoopSource", "void *", [
				"void *",
			]) as AxObserverBindings["getRunLoopSource"],
			createApplicationElement: applicationServices.func("AXUIElementCreateApplication", "void *", [
				"int32_t",
			]) as AxObserverBindings["createApplicationElement"],
			setMessagingTimeout: applicationServices.func(
				"int32_t AXUIElementSetMessagingTimeout(void *element, float seconds)",
			) as AxObserverBindings["setMessagingTimeout"],
			runLoopGetCurrent: coreFoundation.func(
				"CFRunLoopGetCurrent",
				"void *",
				[],
			) as AxObserverBindings["runLoopGetCurrent"],
			addSource: coreFoundation.func("CFRunLoopAddSource", "void", [
				"void *",
				"void *",
				"void *",
			]) as AxObserverBindings["addSource"],
			removeSource: coreFoundation.func("CFRunLoopRemoveSource", "void", [
				"void *",
				"void *",
				"void *",
			]) as AxObserverBindings["removeSource"],
			runLoopInMode: coreFoundation.func("CFRunLoopRunInMode", "int32_t", [
				"void *",
				"double",
				"bool",
			]) as AxObserverBindings["runLoopInMode"],
		};
		return cachedBindings;
	} catch {
		cachedBindings = null;
		return null;
	}
}

/**
 * CoreFoundation compares run-loop modes by string content, so building the documented default
 * mode name is equivalent to reading the framework's exported constant.
 */
function getDefaultMode(): CFStringRef | undefined {
	if (defaultMode === undefined) {
		try {
			defaultMode = toCFString("kCFRunLoopDefaultMode");
		} catch {
			defaultMode = undefined;
		}
	}
	return defaultMode;
}

export function isAxObserverAvailable(): boolean {
	return getBindings() !== null && getDefaultMode() !== undefined;
}

/**
 * Subscribes to accessibility change notifications for one application. Returns null when the
 * platform calls or every registration are unavailable, so callers keep their polling path.
 * The callback runs while `drain` drives the run loop on the calling thread.
 */
export function createAxEventWaiter(pid: number): AxEventWaiter | null {
	if (!Number.isSafeInteger(pid) || pid <= 0) {
		return null;
	}
	const bindings = getBindings();
	const type = getCallbackType();
	const mode = getDefaultMode();
	if (bindings === null || type === undefined || mode === undefined) {
		return null;
	}

	let events = 0;
	let callback: KoffiRegistered;
	try {
		callback = koffi.register(() => {
			events += 1;
		}, koffi.pointer(type));
	} catch {
		return null;
	}

	const observerOut: [AXObserverRef | null] = [null];
	if (bindings.createObserver(pid, callback, observerOut) !== AX_SUCCESS || observerOut[0] === null) {
		koffi.unregister(callback);
		return null;
	}
	const observer = observerOut[0];
	const element = bindings.createApplicationElement(pid);
	if (element === null) {
		cfRelease(observer);
		koffi.unregister(callback);
		return null;
	}

	let registered = 0;
	const timeoutSeconds = resolveAxMessagingTimeoutSeconds();
	if (timeoutSeconds > 0) {
		bindings.setMessagingTimeout(element, timeoutSeconds);
	}
	for (const name of SETTLE_NOTIFICATIONS) {
		const notification = toCFString(name);
		try {
			const result = bindings.addNotification(observer, element, notification, null);
			if (result === AX_SUCCESS) {
				registered += 1;
				continue;
			}
			// An app that cannot answer is not going to answer the next fourteen either. Without
			// this the settle spent one messaging timeout per notification, measured at 22.6 s
			// against a stopped app before the whole observation failed.
			if (result === AX_ERROR_CANNOT_COMPLETE) {
				break;
			}
		} finally {
			cfRelease(notification);
		}
	}
	cfRelease(element);

	const source = bindings.getRunLoopSource(observer);
	const runLoop = bindings.runLoopGetCurrent();
	if (registered === 0 || source === null || runLoop === null) {
		cfRelease(observer);
		koffi.unregister(callback);
		return null;
	}
	bindings.addSource(runLoop, source, mode);

	let released = false;
	let reported = 0;
	return {
		drain(milliseconds: number): number {
			if (released || milliseconds < 0) {
				return 0;
			}
			bindings.runLoopInMode(mode, milliseconds / 1000, false);
			const seen = events - reported;
			reported = events;
			return seen;
		},
		release(): void {
			if (released) {
				return;
			}
			released = true;
			bindings.removeSource(runLoop, source, mode);
			cfRelease(observer);
			koffi.unregister(callback);
		},
	};
}

export function waitForAxQuiet(
	waiter: AxEventWaiter,
	options: { readonly quietMs: number; readonly deadlineMs: number; readonly now: () => number },
): AxQuietOutcome {
	const started = options.now();
	let events = 0;
	let remaining = options.deadlineMs;
	if (remaining <= 0) {
		return { quiet: true, events, elapsedMs: 0 };
	}
	while (true) {
		const window = Math.max(1, Math.min(options.quietMs, remaining));
		const seen = waiter.drain(window);
		events += seen;
		const elapsed = options.now() - started;
		if (seen === 0) {
			return { quiet: true, events, elapsedMs: elapsed };
		}
		remaining = options.deadlineMs - elapsed;
		if (remaining <= 0) {
			return { quiet: false, events, elapsedMs: elapsed };
		}
	}
}
