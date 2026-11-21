import { describe, expect, it } from "bun:test";
import { isDiscoverableApplication } from "./macos-call-helpers.js";

describe("#given background call helpers #when discovering apps #then only verified system helpers are included", () => {
	it("discovers the notification extension despite its prohibited activation policy", () => {
		expect(
			isDiscoverableApplication(
				2,
				"com.apple.FaceTime.FaceTimeNotificationExtension",
				"/System/Library/ExtensionKit/Extensions/FaceTimeNotificationExtension.appex",
			),
		).toBe(true);
	});

	it("keeps ordinary background agents and impersonated helpers out", () => {
		expect(isDiscoverableApplication(2, "com.example.agent", "/tmp/Agent.app")).toBe(false);
		expect(isDiscoverableApplication(2, "com.apple.FaceTime.FaceTimeNotificationExtension", "/tmp/Fake.appex")).toBe(
			false,
		);
	});

	it("preserves regular application discovery", () => {
		expect(isDiscoverableApplication(0, "com.apple.FaceTime", "/System/Applications/FaceTime.app")).toBe(true);
	});

	it("discovers the Notification Center host despite its accessory activation policy", () => {
		expect(
			isDiscoverableApplication(
				1,
				"com.apple.notificationcenterui",
				"/System/Library/CoreServices/NotificationCenter.app",
			),
		).toBe(true);
	});

	it("#given a third-party menu bar app #when discovering #then it is a target, while Apple's accessory prompts stay out", () => {
		expect(isDiscoverableApplication(1, "dev.opentool.OpenTool", "/Applications/OpenTool.app")).toBe(true);
		expect(
			isDiscoverableApplication(
				1,
				"com.apple.SecurityAgent",
				"/System/Library/Frameworks/Security.framework/Versions/A/MachServices/SecurityAgent.bundle",
			),
		).toBe(false);
		expect(
			isDiscoverableApplication(
				1,
				"com.apple.accessibility.universalAccessAuthWarn",
				"/System/Library/CoreServices/universalAccessAuthWarn.app",
			),
		).toBe(false);
		expect(isDiscoverableApplication(2, "dev.opentool.OpenTool", "/Applications/OpenTool.app")).toBe(false);
	});

	it("#given Control Center #when the verified bundle path is discovered #then its system UI process is included", () => {
		expect(
			isDiscoverableApplication(1, "com.apple.controlcenter", "/System/Library/CoreServices/ControlCenter.app"),
		).toBe(true);
		expect(isDiscoverableApplication(1, "com.apple.controlcenter", "/tmp/ControlCenter.app")).toBe(false);
		expect(isDiscoverableApplication(1, "com.apple.other-ui", "/System/Library/CoreServices/ControlCenter.app")).toBe(
			false,
		);
	});
});
