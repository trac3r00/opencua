import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	DEFAULT_HISTORY_OBSERVATION_SETTINGS,
	type HistoryObservationSettings,
	type ObservationDefaultBehavior,
	type ObservationRule,
} from "./history-settings.js";

export type HistoryState = "running" | "paused" | "stopped";

export interface HistoryPaths {
	readonly root: string;
	readonly segmentsDir: string;
	readonly settingsPath: string;
	readonly statePath: string;
	readonly summariesPath: string;
}

export function historyPaths(stateDir: string): HistoryPaths {
	const root = join(stateDir, "cua-history");
	return {
		root,
		segmentsDir: join(root, "segments"),
		settingsPath: join(root, "settings.json"),
		statePath: join(root, "state.json"),
		summariesPath: join(root, "summaries"),
	};
}

export interface HistoryControlFs {
	exists(path: string): boolean;
	readText(path: string): string | undefined;
	writeText(path: string, text: string): void;
	ensureDir(path: string): void;
}

export const nodeHistoryControlFs: HistoryControlFs = {
	exists: (path) => existsSync(path),
	readText(path) {
		try {
			return readFileSync(path, "utf8");
		} catch {
			return undefined;
		}
	},
	writeText(path, text) {
		writeFileSync(path, text, { mode: 0o600 });
	},
	ensureDir(path) {
		mkdirSync(path, { recursive: true, mode: 0o700 });
	},
};

function parse(text: string | undefined): Record<string, unknown> | undefined {
	if (text === undefined) {
		return undefined;
	}
	try {
		const value: unknown = JSON.parse(text);
		return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

export function readHistoryState(paths: HistoryPaths, fs: HistoryControlFs = nodeHistoryControlFs): HistoryState {
	const state = parse(fs.readText(paths.statePath))?.["state"];
	return state === "running" || state === "paused" || state === "stopped" ? state : "stopped";
}

export function writeHistoryState(
	paths: HistoryPaths,
	state: HistoryState,
	fs: HistoryControlFs = nodeHistoryControlFs,
): void {
	fs.ensureDir(paths.root);
	fs.writeText(paths.statePath, `${JSON.stringify({ state, updatedAt: new Date().toISOString() }, null, 2)}\n`);
}

function behaviorOf(value: unknown): ObservationDefaultBehavior {
	return value === "do_not_observe" ? "do_not_observe" : "observe";
}

function ruleOf(value: unknown): readonly ObservationRule[] {
	if (typeof value !== "object" || value === null) {
		return [];
	}
	const rule = value as Record<string, unknown>;
	const behavior = behaviorOf(rule["behavior"]);
	if (rule["scope"] === "app" && typeof rule["bundleID"] === "string") {
		return [{ scope: "app", bundleID: rule["bundleID"], behavior }];
	}
	if (rule["scope"] === "url" && typeof rule["urlDomain"] === "string") {
		return [{ scope: "url", urlDomain: rule["urlDomain"], behavior }];
	}
	return [];
}

export function readHistorySettings(
	paths: HistoryPaths,
	fs: HistoryControlFs = nodeHistoryControlFs,
): HistoryObservationSettings {
	const raw = parse(fs.readText(paths.settingsPath));
	if (raw === undefined) {
		return DEFAULT_HISTORY_OBSERVATION_SETTINGS;
	}
	const rules = Array.isArray(raw["rules"]) ? raw["rules"].flatMap(ruleOf) : [];
	return {
		defaultApplicationBehavior: behaviorOf(raw["defaultApplicationBehavior"]),
		defaultURLBehavior: behaviorOf(raw["defaultURLBehavior"]),
		observePrivateBrowsing: raw["observePrivateBrowsing"] === true,
		rules,
	};
}

export function writeHistorySettings(
	paths: HistoryPaths,
	settings: HistoryObservationSettings,
	fs: HistoryControlFs = nodeHistoryControlFs,
): void {
	fs.ensureDir(paths.root);
	// Keys these settings do not model (rawRetentionHours) belong to other readers and are kept.
	const kept = parse(fs.readText(paths.settingsPath))?.["rawRetentionHours"];
	const document = kept === undefined ? settings : { ...settings, rawRetentionHours: kept };
	fs.writeText(paths.settingsPath, `${JSON.stringify(document, null, 2)}\n`);
}
