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
 * The shared-host backend is observation-only. Preserve an explicit attended request so the
 * constructor rejects it, rather than silently accepting a request to borrow the human desktop.
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
	// Every backend is observation-only on the shared host, so an explicit attended request is a
	// configuration error here too, not a per-action refusal later.
	if (platform !== "darwin" && deliveryFromProcessEnvironment() === "attended") {
		denyHostInteraction("global-input");
	}
	if (platform === "linux") return new GuardedPlatformComputer(createLinuxHostComputer(), { approval: appApproval });
	if (platform === "win32") return new GuardedPlatformComputer(createWindowsHostComputer(), { approval: appApproval });
	// The person's desktop takes input only for opencua-owned windows, which are always driven in the background.
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
