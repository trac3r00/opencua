import { describe, expect, it } from "bun:test";
import { vi } from "@opencua/test-support";

import { openUrlInApp } from "./macos-open-url.js";

const ZOOM = { bundleId: "us.zoom.xos" };
const LINK = "zoommtg://zoom.us/join?action=join&confno=123";

describe("#given a running app and a URL #when the URL is opened in that app #then Launch Services gets the app's bundle id in the background", () => {
	it("runs open -g -b with the app's bundle id and the URL", async () => {
		const run = vi.fn(async (_file: string, _args: readonly string[]) => undefined);

		const report = await openUrlInApp(ZOOM, LINK, { blocklist: [], run });

		expect(run).toHaveBeenCalledWith("/usr/bin/open", ["-g", "-b", "us.zoom.xos", LINK]);
		expect(report).toEqual({ bundleId: "us.zoom.xos", url: LINK });
	});

	it("refuses a URL the blocklist covers without running anything", async () => {
		const run = vi.fn(async (_file: string, _args: readonly string[]) => undefined);

		await expect(openUrlInApp(ZOOM, LINK, { blocklist: ["zoommtg://*"], run })).rejects.toThrow(
			"Computer Use is not allowed to open this URL",
		);
		expect(run).not.toHaveBeenCalled();
	});

	it("checks and opens the parsed URL, so case, spaces and control characters cannot slip past the blocklist", async () => {
		for (const variant of ["ZOOMMTG://zoom.us/join", "  zoommtg://zoom.us/join", "zoom\tmtg://zoom.us/join"]) {
			const run = vi.fn(async (_file: string, _args: readonly string[]) => undefined);

			await expect(openUrlInApp(ZOOM, variant, { blocklist: ["zoommtg://*"], run })).rejects.toThrow(
				"Computer Use is not allowed to open this URL",
			);
			expect(run).not.toHaveBeenCalled();
		}
		const run = vi.fn(async (_file: string, _args: readonly string[]) => undefined);

		await openUrlInApp(ZOOM, "  HTTPS://Example.COM/a", { blocklist: [], run });

		expect(run).toHaveBeenCalledWith("/usr/bin/open", ["-g", "-b", "us.zoom.xos", "https://example.com/a"]);
	});

	it("refuses text that is not an absolute URL without running anything", async () => {
		const run = vi.fn(async (_file: string, _args: readonly string[]) => undefined);

		await expect(openUrlInApp(ZOOM, "zoom.us/join", { blocklist: [], run })).rejects.toThrow(
			"open_url needs an absolute URL with a scheme",
		);
		expect(run).not.toHaveBeenCalled();
	});

	it("refuses an app without a bundle id, since Launch Services could hand the URL to another app", async () => {
		const run = vi.fn(async (_file: string, _args: readonly string[]) => undefined);

		await expect(openUrlInApp({ bundleId: "" }, LINK, { blocklist: [], run })).rejects.toThrow("has no bundle id");
		expect(run).not.toHaveBeenCalled();
	});
});
