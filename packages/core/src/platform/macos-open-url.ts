import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { blockedUrl } from "../permission/url-blocklist.js";

const execFileAsync = promisify(execFile);
const OPEN_TIMEOUT_MILLISECONDS = 10_000;

export interface OpenUrlOptions {
	/** URL patterns Computer Use must not open (the same blocklist that guards browser pages). */
	readonly blocklist: readonly string[];
	/** Runs a command to completion; tests replace it so nothing is launched. */
	readonly run?: (file: string, args: readonly string[]) => Promise<unknown>;
}

export interface OpenUrlReport {
	readonly bundleId: string;
	readonly url: string;
}

async function runCommand(file: string, args: readonly string[]): Promise<unknown> {
	return await execFileAsync(file, [...args], { timeout: OPEN_TIMEOUT_MILLISECONDS });
}

/**
 * Hand `url` to one running app through Launch Services, in the background (`open -g -b`). Naming the bundle id
 * keeps the URL in the app the agent observed instead of whichever app claims its scheme; `-g` leaves the person's
 * frontmost app in front (an app may still activate itself, as it can on any open).
 */
export async function openUrlInApp(
	app: { readonly bundleId: string },
	url: string,
	options: OpenUrlOptions,
): Promise<OpenUrlReport> {
	if (!URL.canParse(url)) {
		throw new Error(
			`open_url needs an absolute URL with a scheme (zoommtg://..., https://...), got ${JSON.stringify(url)}`,
		);
	}
	if (blockedUrl(url, options.blocklist)) {
		throw new Error(`Computer Use is not allowed to open this URL: ${url}`);
	}
	if (app.bundleId.length === 0) {
		throw new Error("the target app has no bundle id, so the URL cannot be kept in that app");
	}
	await (options.run ?? runCommand)("/usr/bin/open", ["-g", "-b", app.bundleId, url]);
	return { bundleId: app.bundleId, url };
}
