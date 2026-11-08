import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AppInfo } from "../accessibility/types.js";
import { type AppUsage, parseAppUsageBlocks } from "./app-usage.js";
import { execFileStdout } from "./exec-util.js";
import { readAppUsage } from "./macos-ffi/workspace-usage.js";
import {
	type RunningApplicationIdentifier,
	type WorkspaceRunningApplication,
	findRunningApplication,
	getRunningApplications,
} from "./macos-ffi/workspace.js";

const execFileAsync = promisify(execFile);
const LIST_APPS_TIMEOUT_MILLISECONDS = 20_000;

export interface RunningAppInfo extends AppInfo {
	readonly isActive: boolean;
	readonly path: string;
}

/**
 * Spotlight usage for each app bundle path, read in-process; the spawned `mdls` (most of a list_apps call) is only
 * the fallback for a host where the in-process read fails.
 */
export async function collectAppUsage(paths: readonly string[]): Promise<Map<string, AppUsage>> {
	if (paths.length === 0) {
		return new Map();
	}
	try {
		return readAppUsage(paths);
	} catch {
		return await collectAppUsageWithMdls(paths);
	}
}

async function collectAppUsageWithMdls(paths: readonly string[]): Promise<Map<string, AppUsage>> {
	try {
		const result = await execFileAsync(
			"mdls",
			["-name", "kMDItemLastUsedDate", "-name", "kMDItemUseCount", ...paths],
			{
				encoding: "utf8",
				timeout: LIST_APPS_TIMEOUT_MILLISECONDS,
			},
		);
		return parseAppUsageBlocks(execFileStdout(result), paths);
	} catch {
		return new Map(paths.map((path) => [path, {}]));
	}
}

export interface RunningApplicationLookup {
	getRunningApplications(): readonly WorkspaceRunningApplication[];
	findRunningApplication(identifier: RunningApplicationIdentifier): WorkspaceRunningApplication | undefined;
}

const nativeRunningApplicationLookup: RunningApplicationLookup = {
	getRunningApplications,
	findRunningApplication,
};
let runningApplicationLookup = nativeRunningApplicationLookup;

/**
 * Replace the native application lookup. Tests inject a deterministic list here instead of
 * depending on whichever apps happen to be running on the machine; production never calls it.
 */
export function setRunningApplicationLookupForTesting(lookup: RunningApplicationLookup | undefined): void {
	runningApplicationLookup = lookup ?? nativeRunningApplicationLookup;
}

/**
 * Running applications, enumerated in-process through NSWorkspace. The AppleScript/JXA path
 * costs most of a second per call and is only a fallback for hosts where the native lookup
 * fails.
 */
export async function getRunningMacOSApps(): Promise<RunningAppInfo[]> {
	try {
		return mapRunningApps(runningApplicationLookup.getRunningApplications());
	} catch {
		return await getRunningMacOSAppsWithJxa();
	}
}

export async function findRunningApp(identifier: RunningApplicationIdentifier): Promise<RunningAppInfo | undefined> {
	try {
		const application = runningApplicationLookup.findRunningApplication(identifier);
		return application === undefined ? undefined : mapRunningApp(application);
	} catch {
		const applications = await getRunningMacOSAppsWithJxa();
		return applications.find((application) => matchesIdentifier(application, identifier));
	}
}

async function getRunningMacOSAppsWithJxa(): Promise<RunningAppInfo[]> {
	const result = await execFileAsync("osascript", ["-l", "JavaScript", "-e", LIST_APPS_JXA], {
		encoding: "utf8",
		timeout: LIST_APPS_TIMEOUT_MILLISECONDS,
	});
	return parseRunningApps(execFileStdout(result));
}

function mapRunningApps(applications: readonly WorkspaceRunningApplication[]): RunningAppInfo[] {
	return applications.map(mapRunningApp).sort((left, right) => left.name.localeCompare(right.name));
}

function mapRunningApp(application: WorkspaceRunningApplication): RunningAppInfo {
	return { ...application, isRunning: true };
}

function matchesIdentifier(application: RunningAppInfo, identifier: RunningApplicationIdentifier): boolean {
	return typeof identifier === "number"
		? application.pid === identifier
		: application.bundleId === identifier || application.name === identifier;
}

export function parseRunningApps(output: string): RunningAppInfo[] {
	const parsed: unknown = JSON.parse(output);
	if (!Array.isArray(parsed)) {
		throw new Error("list apps output must be a JSON array");
	}
	return parsed.map(parseRunningApp).sort((left, right) => left.name.localeCompare(right.name));
}

function parseRunningApp(value: unknown): RunningAppInfo {
	if (!isRecord(value)) {
		throw new Error("running app entry must be an object");
	}
	const name = stringField(value, "name");
	const pid = numberField(value, "pid");
	const bundleId = stringField(value, "bundleId");
	const isActive = booleanField(value, "isActive");
	const path = optionalStringField(value, "path");
	return { name, pid, bundleId, isActive, isRunning: true, path };
}

function optionalStringField(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	return typeof value === "string" ? value : "";
}

function stringField(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string") {
		throw new Error(`running app ${key} must be a string`);
	}
	return value;
}

function numberField(record: Record<string, unknown>, key: string): number {
	const value = record[key];
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`running app ${key} must be a positive integer`);
	}
	return value;
}

function booleanField(record: Record<string, unknown>, key: string): boolean {
	const value = record[key];
	if (typeof value !== "boolean") {
		throw new Error(`running app ${key} must be a boolean`);
	}
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

const LIST_APPS_JXA = `
const systemEvents = Application("System Events");
function readString(value) {
	try {
		const result = value();
		return typeof result === "string" ? result : "";
	} catch {
		return "";
	}
}
function readPath(process) {
	try {
		return process.file().posixPath();
	} catch {
		return "";
	}
}
JSON.stringify(
	systemEvents.applicationProcesses.whose({ backgroundOnly: false })()
		.map((process) => ({
			name: readString(process.name),
			bundleId: readString(process.bundleIdentifier),
			pid: process.unixId(),
			isActive: process.frontmost(),
			path: readPath(process),
		}))
		.filter((app) => app.name.length > 0 && Number.isInteger(app.pid) && app.pid > 0 && app.bundleId.length > 0),
);
`;
