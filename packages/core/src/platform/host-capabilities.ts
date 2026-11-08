import type { KoffiFunc } from "koffi";
import { koffi } from "./macos-ffi/koffi.js";
import { isScreenLocked, sessionOnConsole } from "./macos-ffi/lock-screen.js";
import {
	getMainDisplayLogicalSize,
	getMainDisplayNativePixelSize,
	screenCaptureAllowed,
} from "./macos-ffi/screenshot.js";

const applicationServices = koffi.load("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices");
const AXIsProcessTrusted = applicationServices.func("AXIsProcessTrusted", "bool", []) as KoffiFunc<() => boolean>;
const ioKit = koffi.load("/System/Library/Frameworks/IOKit.framework/IOKit");
/** Reads Input Monitoring without asking: 0 granted, 1 denied, 2 not asked yet. */
const IOHIDCheckAccess = ioKit.func("IOHIDCheckAccess", "uint32", ["uint32"]) as KoffiFunc<
	(requestType: number) => number
>;
const IOHID_REQUEST_TYPE_LISTEN_EVENT = 1;
const IOHID_ACCESS_GRANTED = 0;

export type HostPermission = "accessibility" | "screenRecording" | "inputMonitoring";

export interface HostCapabilities {
	readonly permissions: {
		readonly accessibility: boolean;
		/** Screen Recording: required for screenshots; element observation and input work without it. */
		readonly screenRecording: boolean;
		/** Input Monitoring: only the cua-history watcher needs it, to record keystrokes and clicks. */
		readonly inputMonitoring?: boolean;
		/** Why a permission reads false because its check threw (a broken binding) rather than because it was denied. */
		readonly errors?: Readonly<Partial<Record<HostPermission, string>>>;
	};
	readonly session: {
		readonly screenLocked: boolean;
		/** False when this login session is reached through Screen Sharing while another user owns the console. */
		readonly onConsole: boolean | undefined;
	};
	readonly mainDisplay: {
		readonly logical: { readonly width: number; readonly height: number };
		readonly pixels: { readonly width: number; readonly height: number };
	};
}

function guarded<T>(read: () => T, fallback: T): T {
	try {
		return read();
	} catch {
		return fallback;
	}
}

export function probeHostCapabilities(): HostCapabilities {
	const errors: Partial<Record<HostPermission, string>> = {};
	const permission = (name: HostPermission, read: () => boolean): boolean => {
		try {
			return read();
		} catch (error: unknown) {
			errors[name] = error instanceof Error ? error.message : String(error);
			return false;
		}
	};
	const accessibility = permission("accessibility", () => AXIsProcessTrusted());
	const screenRecording = permission("screenRecording", () => screenCaptureAllowed());
	const inputMonitoring = permission(
		"inputMonitoring",
		() => IOHIDCheckAccess(IOHID_REQUEST_TYPE_LISTEN_EVENT) === IOHID_ACCESS_GRANTED,
	);
	return {
		permissions: {
			accessibility,
			screenRecording,
			inputMonitoring,
			...(Object.keys(errors).length > 0 ? { errors } : {}),
		},
		session: {
			screenLocked: isScreenLocked(),
			onConsole: sessionOnConsole(),
		},
		mainDisplay: {
			logical: guarded(() => getMainDisplayLogicalSize(), { width: 0, height: 0 }),
			pixels: guarded(() => getMainDisplayNativePixelSize(), { width: 0, height: 0 }),
		},
	};
}
