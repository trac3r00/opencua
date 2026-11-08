import type { KoffiFunc } from "koffi";
import { denyHostInteraction } from "../../computer/host-interaction-policy.js";
import { isDiscoverableApplication } from "../macos-call-helpers.js";
import { OWNED_SURFACE_BUNDLE_ID, isOwnedSurfacePid } from "../owned-surfaces.js";
import { koffi } from "./koffi.js";

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
const msgPointerCString = objc.func("objc_msgSend", "void *", ["void *", "void *", "str"]) as KoffiFunc<
	(receiver: object, selector: object, value: string) => object | null
>;
const msgPointerInteger = objc.func("objc_msgSend", "void *", ["void *", "void *", "uint64_t"]) as KoffiFunc<
	(receiver: object, selector: object, value: number) => object | null
>;
const msgPointerProcessIdentifier = objc.func("objc_msgSend", "void *", ["void *", "void *", "int32_t"]) as KoffiFunc<
	(receiver: object, selector: object, value: number) => object | null
>;
const msgUnsignedInteger = objc.func("objc_msgSend", "uint64_t", ["void *", "void *"]) as KoffiFunc<
	(receiver: object, selector: object) => number
>;
const msgInteger = objc.func("objc_msgSend", "int64_t", ["void *", "void *"]) as KoffiFunc<
	(receiver: object, selector: object) => number
>;
const msgProcessIdentifier = objc.func("objc_msgSend", "int32_t", ["void *", "void *"]) as KoffiFunc<
	(receiver: object, selector: object) => number
>;
const msgBool = objc.func("objc_msgSend", "bool", ["void *", "void *"]) as KoffiFunc<
	(receiver: object, selector: object) => boolean
>;
const msgCString = objc.func("objc_msgSend", "str", ["void *", "void *"]) as KoffiFunc<
	(receiver: object, selector: object) => string | null
>;
const autoreleasePoolClass = requireClass("NSAutoreleasePool");
const bundleClass = requireClass("NSBundle");
const runningApplicationClass = requireClass("NSRunningApplication");
const workspaceClass = requireClass("NSWorkspace");

const activationPolicySelector = requireSelector("activationPolicy");
const allocSelector = requireSelector("alloc");
const bundleIdentifierSelector = requireSelector("bundleIdentifier");
const bundleUrlSelector = requireSelector("bundleURL");
const bundleWithPathSelector = requireSelector("bundleWithPath:");
const countSelector = requireSelector("count");
const fullPathForApplicationSelector = requireSelector("fullPathForApplication:");
const initSelector = requireSelector("init");
const isActiveSelector = requireSelector("isActive");
const localizedNameSelector = requireSelector("localizedName");
const objectAtIndexSelector = requireSelector("objectAtIndex:");
const pathSelector = requireSelector("path");
const processIdentifierSelector = requireSelector("processIdentifier");
const releaseSelector = requireSelector("release");
const runningApplicationWithProcessIdentifierSelector = requireSelector("runningApplicationWithProcessIdentifier:");
const runningApplicationsSelector = requireSelector("runningApplications");
const runningApplicationsWithBundleIdentifierSelector = requireSelector("runningApplicationsWithBundleIdentifier:");
const sharedWorkspaceSelector = requireSelector("sharedWorkspace");
const stringWithUtf8StringSelector = requireSelector("stringWithUTF8String:");
const utf8StringSelector = requireSelector("UTF8String");
const stringClass = requireClass("NSString");

export interface WorkspaceRunningApplication {
	readonly name: string;
	readonly bundleId: string;
	readonly pid: number;
	readonly isActive: boolean;
	readonly path: string;
}

export type RunningApplicationIdentifier = string | number;

/** Shared-host activation is forbidden, including attempts to restore previous focus. */
export function activateApplication(_pid: number): boolean {
	return denyHostInteraction("host-focus");
}

const coreFoundation = koffi.load("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation");
const CFRunLoopRunInMode = coreFoundation.func(
	"int32_t CFRunLoopRunInMode(void *mode, double seconds, bool once)",
) as KoffiFunc<(mode: object, seconds: number, returnAfterSourceHandled: boolean) => number>;

/**
 * NSWorkspace keeps its running-application list current from notifications delivered on this
 * thread's run loop, which a Node process never turns. Without this the list froze at the first
 * read: an app that quit and relaunched was still reported under its dead pid. Turning the loop
 * once, without waiting, lets the pending updates land before the list is read.
 */
function deliverWorkspaceUpdates(): void {
	// An autoreleased NSString is a CFString (toll-free bridged); run loop modes compare by value.
	withAutoreleasePool(() => {
		CFRunLoopRunInMode(nsString("kCFRunLoopDefaultMode"), 0, false);
	});
}

export function getRunningApplications(): WorkspaceRunningApplication[] {
	deliverWorkspaceUpdates();
	return withAutoreleasePool(() => {
		const applications = msgPointer(sharedWorkspace(), runningApplicationsSelector);
		if (applications === null) {
			return [];
		}
		const seenPids = new Set<number>();
		const listed = readApplicationArray(applications, seenPids);
		for (const pid of processIdentities.keys()) {
			if (!seenPids.has(pid)) {
				processIdentities.delete(pid);
			}
		}
		return listed;
	});
}

export function findRunningApplication(
	identifier: RunningApplicationIdentifier,
): WorkspaceRunningApplication | undefined {
	deliverWorkspaceUpdates();
	return withAutoreleasePool(() => {
		if (typeof identifier === "number") {
			if (!Number.isSafeInteger(identifier) || identifier <= 0) {
				return undefined;
			}
			const application = msgPointerProcessIdentifier(
				runningApplicationClass,
				runningApplicationWithProcessIdentifierSelector,
				identifier,
			);
			return application === null ? undefined : readApplication(application);
		}

		const bundleId = resolveBundleIdentifier(identifier);
		if (bundleId === undefined) {
			return undefined;
		}
		const bundleIdReference = nsString(bundleId);
		const indexed = msgPointerObject(
			runningApplicationClass,
			runningApplicationsWithBundleIdentifierSelector,
			bundleIdReference,
		);
		if (indexed !== null) {
			const match = readApplicationArray(indexed).find((application) => application.bundleId === bundleId);
			if (match !== undefined) {
				return match;
			}
		}
		// AppKit's indexed lookup answers with an empty set now and then on a loaded machine, which
		// would report a running app as missing and disable a whole turn; the enumeration is the
		// second, independent source for the same question. It stays off the fast path on purpose.
		return getRunningApplications().find((application) => application.bundleId === bundleId);
	});
}

function readApplicationArray(array: object, seenPids?: Set<number>): WorkspaceRunningApplication[] {
	const count = msgUnsignedInteger(array, countSelector);
	const applications: WorkspaceRunningApplication[] = [];
	for (let index = 0; index < count; index += 1) {
		const reference = msgPointerInteger(array, objectAtIndexSelector, index);
		if (reference === null) {
			continue;
		}
		const application = readApplication(reference, seenPids);
		if (application !== undefined) {
			applications.push(application);
		}
	}
	return applications;
}

function readApplication(reference: object, seenPids?: Set<number>): WorkspaceRunningApplication | undefined {
	const name = readStringProperty(reference, localizedNameSelector);
	const pid = msgProcessIdentifier(reference, processIdentifierSelector);
	seenPids?.add(pid);
	// An owned surface is a bare accessory process with no bundle; it is listed so agents can observe and drive it.
	const owned = Number.isSafeInteger(pid) && pid > 0 && isOwnedSurfacePid(pid);
	const identity = readProcessIdentity(reference, pid);
	const bundleId = identity.bundleId || (owned ? OWNED_SURFACE_BUNDLE_ID : "");
	if (name.length === 0 || bundleId.length === 0 || !Number.isSafeInteger(pid) || pid <= 0) {
		return undefined;
	}
	const path = identity.path;
	if (!owned && !isDiscoverableApplication(msgInteger(reference, activationPolicySelector), bundleId, path)) {
		return undefined;
	}
	return {
		name,
		bundleId,
		pid,
		isActive: msgBool(reference, isActiveSelector),
		path,
	};
}

interface ProcessIdentity {
	readonly startTime: string;
	readonly bundleId: string;
	readonly path: string;
}

const libSystem = koffi.load("/usr/lib/libSystem.B.dylib");
const procPidInfo = libSystem.func(
	"int proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int buffersize)",
) as KoffiFunc<(pid: number, flavor: number, argument: number, buffer: Buffer, bufferSize: number) => number>;
const PROC_PIDTBSDINFO = 3;
/** sizeof(struct proc_bsdinfo); pbi_start_tvsec and pbi_start_tvusec are its last two uint64 fields. */
const PROC_BSD_INFO_BYTES = 136;
const PROC_START_SECONDS_OFFSET = 120;
const PROC_START_MICROSECONDS_OFFSET = 128;

/** Bundle identity of each listed process, keyed by pid and checked against the process's start time. */
const processIdentities = new Map<number, ProcessIdentity>();

/** When `pid` started, to the microsecond; undefined when the process is gone. A reused pid starts at another time. */
function processStartTime(pid: number): string | undefined {
	const info = Buffer.alloc(PROC_BSD_INFO_BYTES);
	if (procPidInfo(pid, PROC_PIDTBSDINFO, 0, info, PROC_BSD_INFO_BYTES) !== PROC_BSD_INFO_BYTES) {
		return undefined;
	}
	return `${info.readBigUInt64LE(PROC_START_SECONDS_OFFSET)}.${info.readBigUInt64LE(PROC_START_MICROSECONDS_OFFSET)}`;
}

/**
 * A process's bundle identifier and bundle path. Both are fixed for the life of the process, yet NSWorkspace
 * hands out fresh NSRunningApplication objects after every run-loop turn and each re-reads them from
 * LaunchServices, which made every enumeration cost tens of milliseconds. They are reused while the same
 * process (same pid and start time) is running; an incomplete identity, as an app still launching can
 * report, is read again next time.
 */
function readProcessIdentity(reference: object, pid: number): { readonly bundleId: string; readonly path: string } {
	const startTime = Number.isSafeInteger(pid) && pid > 0 ? processStartTime(pid) : undefined;
	const cached = processIdentities.get(pid);
	if (startTime !== undefined && cached?.startTime === startTime) {
		return cached;
	}
	const bundleId = readStringProperty(reference, bundleIdentifierSelector);
	const bundleUrl = msgPointer(reference, bundleUrlSelector);
	const path = bundleUrl === null ? "" : readStringProperty(bundleUrl, pathSelector);
	if (startTime !== undefined && bundleId.length > 0 && path.length > 0) {
		processIdentities.set(pid, { startTime, bundleId, path });
	} else {
		processIdentities.delete(pid);
	}
	return { bundleId, path };
}

function resolveBundleIdentifier(bundleIdOrName: string): string | undefined {
	if (bundleIdOrName.length === 0) {
		return undefined;
	}
	const directMatches = runningApplicationsWithBundleIdentifier(bundleIdOrName);
	if (directMatches !== null && msgUnsignedInteger(directMatches, countSelector) > 0) {
		return bundleIdOrName;
	}
	const applicationPath = msgPointerObject(
		sharedWorkspace(),
		fullPathForApplicationSelector,
		nsString(bundleIdOrName),
	);
	if (applicationPath !== null) {
		const bundle = msgPointerObject(bundleClass, bundleWithPathSelector, applicationPath);
		const resolved = bundle === null ? undefined : nonEmptyStringProperty(bundle, bundleIdentifierSelector);
		if (resolved !== undefined) {
			return resolved;
		}
	}
	// AppKit's indexed query answers with an empty set now and then on a loaded machine, and a
	// bundle identifier has no path to fall back on, so a running app would be reported as missing.
	// The enumeration knows the same ids; it runs only when everything else came up empty.
	return getRunningApplications().some((application) => application.bundleId === bundleIdOrName)
		? bundleIdOrName
		: undefined;
}

function runningApplicationsWithBundleIdentifier(bundleId: string): object | null {
	return msgPointerObject(
		runningApplicationClass,
		runningApplicationsWithBundleIdentifierSelector,
		nsString(bundleId),
	);
}

function sharedWorkspace(): object {
	const workspace = msgPointer(workspaceClass, sharedWorkspaceSelector);
	if (workspace === null) {
		throw new Error("NSWorkspace.sharedWorkspace returned null");
	}
	return workspace;
}

function nsString(value: string): object {
	const reference = msgPointerCString(stringClass, stringWithUtf8StringSelector, value);
	if (reference === null) {
		throw new Error("NSString.stringWithUTF8String returned null");
	}
	return reference;
}

function nonEmptyStringProperty(receiver: object, selector: object): string | undefined {
	const value = readStringProperty(receiver, selector);
	return value.length === 0 ? undefined : value;
}

function readStringProperty(receiver: object, selector: object): string {
	const value = msgPointer(receiver, selector);
	return value === null ? "" : (msgCString(value, utf8StringSelector) ?? "");
}

function withAutoreleasePool<T>(operation: () => T): T {
	const allocated = msgPointer(autoreleasePoolClass, allocSelector);
	if (allocated === null) {
		throw new Error("NSAutoreleasePool.alloc returned null");
	}
	const pool = msgPointer(allocated, initSelector);
	if (pool === null) {
		msgPointer(allocated, releaseSelector);
		throw new Error("NSAutoreleasePool.init returned null");
	}
	try {
		return operation();
	} finally {
		msgPointer(pool, releaseSelector);
	}
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
