/** Apple hosts Phone/FaceTime call banners outside the regular application process. */
const CALL_HOST_PATHS = new Map([
	["com.apple.notificationcenterui", "/System/Library/CoreServices/NotificationCenter.app"],
	[
		"com.apple.FaceTime.FaceTimeNotificationExtension",
		"/System/Library/ExtensionKit/Extensions/FaceTimeNotificationExtension.appex",
	],
	[
		"com.apple.facetime.NotificationViewBridgeService",
		"/System/Library/PrivateFrameworks/FaceTimeNotificationViewBridge.framework/Versions/A/XPCServices/FaceTimeNotificationViewBridgeService.xpc",
	],
	[
		"com.apple.facetime.NotificationService",
		"/System/Library/PrivateFrameworks/FaceTimeNotification.framework/Versions/A/XPCServices/FaceTimeNotificationService.xpc",
	],
]);

const SYSTEM_UI_DISCOVERY = new Map([["com.apple.controlcenter", "/System/Library/CoreServices/ControlCenter.app"]]);

export function isSystemCallHost(bundleId: string, path: string): boolean {
	return CALL_HOST_PATHS.get(bundleId) === path;
}

function isSystemUiDiscoveryHost(bundleId: string, path: string): boolean {
	return SYSTEM_UI_DISCOVERY.get(bundleId) === path;
}

/** Discovery does not confer approval: helpers retain their own bundle identity. */
export function isDiscoverableApplication(activationPolicy: number, bundleId: string, path: string): boolean {
	return (
		activationPolicy === REGULAR_POLICY ||
		isMenuBarApp(activationPolicy, bundleId, path) ||
		isSystemCallHost(bundleId, path) ||
		isSystemUiDiscoveryHost(bundleId, path)
	);
}

const REGULAR_POLICY = 0;
const ACCESSORY_POLICY = 1;

/**
 * A menu bar app (accessory policy, LSUIElement) has windows, popovers and settings people use, so it is a target like
 * any app. Apple's own accessory processes include the permission, authentication and alert prompts only a person may
 * answer, so those (under /System, or claiming an Apple bundle id elsewhere) stay out unless listed above.
 */
function isMenuBarApp(activationPolicy: number, bundleId: string, path: string): boolean {
	return (
		activationPolicy === ACCESSORY_POLICY &&
		path.endsWith(".app") &&
		!path.startsWith("/System/") &&
		!bundleId.startsWith("com.apple.")
	);
}
