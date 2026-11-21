import { describe, expect, it } from "bun:test";
import { needsHelperPermissions } from "./helper-route.js";

describe("#given a CLI command #when deciding where it runs #then commands that need macOS permissions use the helper", () => {
	it.each([
		"apps state",
		"apps list",
		"windows list",
		"screen",
		"screenshot",
		"click",
		"type",
		"ios tap",
		"utm list",
		"space run",
	])("runs %s in the helper", (path) => {
		expect(needsHelperPermissions(path)).toBe(true);
	});

	it.each(["permissions check", "permissions request"])(
		"runs %s in the helper so it reports the helper's grant",
		(path) => {
			expect(needsHelperPermissions(path)).toBe(true);
		},
	);

	it.each([
		"permissions grant",
		"doctor",
		"update",
		"setup",
		"config",
		"history status",
		"stop",
		"stop-status",
		"space start",
		"space takeover",
		"--version",
		"",
	])("keeps %j in the terminal process", (path) => {
		expect(needsHelperPermissions(path)).toBe(false);
	});
});
