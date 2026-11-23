import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import {
	MASKED_CAPTURE_BUNDLE_IDS,
	MASKED_CAPTURE_OWNER_NAMES,
	isMaskedCaptureOwner,
	maskedCaptureWindows,
} from "./capture-mask.js";

const SCKIT_SOURCE = readFileSync(new URL("../../native/sckit.m", import.meta.url), "utf8");

function nativeList(name: string): readonly string[] {
	const block = new RegExp(`static NSString \\*const ${name}\\[\\] = \\{([^}]*)\\};`).exec(SCKIT_SOURCE)?.[1];
	if (block === undefined) throw new Error(`${name} not found in sckit.m`);
	return [...block.matchAll(/@"([^"]+)"/g)].map((match) => match[1] ?? "");
}

describe("#given the masked app lists #when the native capture shim is compared #then both sides mask the same apps", () => {
	it("mirrors the bundle ids in sckit.m", () => {
		expect(nativeList("kSckMaskedBundleIds")).toEqual([...MASKED_CAPTURE_BUNDLE_IDS]);
	});

	it("mirrors the owner names in sckit.m", () => {
		expect(nativeList("kSckMaskedOwnerNames")).toEqual([...MASKED_CAPTURE_OWNER_NAMES]);
	});
});

describe("#given a window owner #when it is checked #then only password managers and auth prompts are masked", () => {
	it.each([
		[{ bundleId: "com.1password.1password" }, true],
		[{ bundleId: "COM.BITWARDEN.DESKTOP" }, true],
		[{ bundleId: "com.apple.Passwords" }, true],
		[{ name: "SecurityAgent" }, true],
		[{ name: "coreautha" }, true],
		[{ bundleId: "com.apple.Safari", name: "Safari" }, false],
		[{ name: "securityagent" }, false],
		[{}, false],
	] as const)("%o is masked: %s", (owner, expected) => {
		expect(isMaskedCaptureOwner(owner)).toBe(expected);
	});
});

describe("#given listed windows #when the masked ones are picked #then each owner is looked up once", () => {
	it("returns the masked windows and asks for each pid's bundle id once", () => {
		const windows = [
			{ id: 1, ownerPid: 10, ownerName: "1Password" },
			{ id: 2, ownerPid: 10, ownerName: "1Password" },
			{ id: 3, ownerPid: 20, ownerName: "Safari" },
			{ id: 4, ownerPid: 30, ownerName: "SecurityAgent" },
		];
		const asked: number[] = [];

		const masked = maskedCaptureWindows(windows, (pid) => {
			asked.push(pid);
			return pid === 10 ? "com.1password.1password" : pid === 20 ? "com.apple.Safari" : undefined;
		});

		expect(masked.map((window) => window.id)).toEqual([1, 2, 4]);
		expect(asked).toEqual([10, 20, 30]);
	});
});
