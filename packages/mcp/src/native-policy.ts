import {
	AppApprovalStore,
	GuardedPlatformComputer,
	MacOSHostComputer,
	createLinuxHostComputer,
	createWindowsHostComputer,
	denyHostInteraction,
	listTopLevelWindows,
} from "@opencua/core";
import type { GuardedComputerInterface, InputDelivery, WindowProbe } from "@opencua/core";

export function allowedBundleIdsFromEnvironment(value: string | undefined): readonly string[] | undefined {
	return value
		?.split(",")
		.map((bundleId) => bundleId.trim())
		.filter((bundleId) => bundleId.length > 0);
}

/**
 * Host input is background-only: it reaches the target app per process and never takes focus, posts global
 * HID input or moves the physical pointer. Preserve an explicit attended request so the constructor rejects
 * it, rather than silently downgrading a request to borrow the person's focus and pointer.
 */
function deliveryFromEnvironment(value: string | undefined): InputDelivery {
	return value?.trim().toLowerCase() === "attended" ? "attended" : "background";
}

/** Optional exact restriction: unset permits named apps; explicitly empty permits none. */
export function allowedBundleIdsFromProcessEnvironment(): readonly string[] | undefined {
	return allowedBundleIdsFromEnvironment(process.env["OPENCUA_ALLOWED_BUNDLE_IDS"]);
}

/** MCP input must not take over the desktop, including when a legacy attended setting remains. */
export function deliveryFromProcessEnvironment(): InputDelivery {
	return deliveryFromEnvironment(process.env["OPENCUA_DELIVERY"]);
}

export function createNativeComputer(platform: NodeJS.Platform = process.platform): GuardedComputerInterface {
	const appApproval = new AppApprovalStore(allowedBundleIdsFromProcessEnvironment());
	// Windows and Linux host backends take no input, so an explicit attended request is a
	// configuration error here too, not a per-action refusal later.
	if (platform !== "darwin" && deliveryFromProcessEnvironment() === "attended") {
		denyHostInteraction("global-input");
	}
	if (platform === "linux") return new GuardedPlatformComputer(createLinuxHostComputer(), { approval: appApproval });
	if (platform === "win32") return new GuardedPlatformComputer(createWindowsHostComputer(), { approval: appApproval });
	// The macOS host drives any app the allowlist permits, always in the background.
	const delivery = process.env["OPENCUA_DELIVERY"] === undefined ? "background" : deliveryFromProcessEnvironment();
	return new MacOSHostComputer({ appApproval, delivery });
}

export function createNativeWindowProbe(): WindowProbe | undefined {
	if (process.platform !== "darwin") return undefined;
	return (options) => {
		return listTopLevelWindows({
			...options,
			includeOffscreen: options?.includeOffscreen ?? deliveryFromProcessEnvironment() === "background",
		});
	};
}
