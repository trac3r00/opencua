import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Per-app rules an agent or the person can tune for speed and verification. Rules that protect the person
 * (background delivery, never taking the foreground or the real cursor, approvals, the allowed apps) are not in this
 * file and cannot be put there.
 */
export interface AppRules {
	/** Default pace of a run_steps batch on the app; a pace named in the call still wins. */
	readonly pace?: "verified" | "fast";
}

export interface RulesProfile {
	readonly default: AppRules;
	/** Keyed by app name or bundle id, matched without regard to case. */
	readonly apps: Readonly<Record<string, AppRules>>;
}

export const RULES_ENV = "OPENCUA_RULES";
export const EMPTY_RULES: RulesProfile = { default: {}, apps: {} };

const RULE_KEYS = new Set(["pace"]);
/** Rules that keep the person's desktop theirs: only the person changes these, through OpenCUA's own settings. */
const PROTECTED_KEYS = new Set([
	"delivery",
	"foreground",
	"focus",
	"realCursor",
	"approval",
	"approvals",
	"allowedApps",
	"allowedBundleIds",
	"confirm",
]);

function parseAppRules(value: unknown, where: string): AppRules {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${where} must be an object of rules`);
	}
	let pace: AppRules["pace"];
	for (const [key, setting] of Object.entries(value)) {
		if (PROTECTED_KEYS.has(key)) {
			throw new Error(
				`${where}.${key} protects the person's desktop and cannot be set in a rules profile; only pace can`,
			);
		}
		if (!RULE_KEYS.has(key)) {
			throw new Error(`${where}.${key} is not a rule; the only rule is pace`);
		}
		if (setting !== "verified" && setting !== "fast") throw new Error(`${where}.pace is "verified" or "fast"`);
		pace = setting;
	}
	return pace === undefined ? {} : { pace };
}

/** Parse a rules profile; throws with the offending path when a rule is unknown, protected or malformed. */
export function parseRulesProfile(value: unknown): RulesProfile {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("a rules profile is an object with optional default and apps");
	}
	const profile: { default: AppRules; apps: Record<string, AppRules> } = { default: {}, apps: {} };
	for (const [key, section] of Object.entries(value)) {
		if (key === "default") {
			profile.default = parseAppRules(section, "default");
		} else if (key === "apps") {
			if (typeof section !== "object" || section === null || Array.isArray(section)) {
				throw new Error("apps must map app names or bundle ids to rules");
			}
			for (const [app, rules] of Object.entries(section)) {
				profile.apps[app.toLowerCase()] = parseAppRules(rules, `apps.${app}`);
			}
		} else if (PROTECTED_KEYS.has(key)) {
			throw new Error(`${key} protects the person's desktop and cannot be set in a rules profile`);
		} else {
			throw new Error(`${key} is not part of a rules profile; use default and apps`);
		}
	}
	return profile;
}

/** The rules for one app: its own entry (by name, then bundle id) over the profile default. */
export function rulesForApp(
	profile: RulesProfile,
	app: { readonly name?: string | undefined; readonly bundleId?: string | undefined },
): AppRules {
	const own =
		(app.name === undefined ? undefined : profile.apps[app.name.toLowerCase()]) ??
		(app.bundleId === undefined ? undefined : profile.apps[app.bundleId.toLowerCase()]);
	return { ...profile.default, ...own };
}

export function rulesProfilePath(environment: Readonly<Record<string, string | undefined>> = process.env): string {
	const configured = environment[RULES_ENV]?.trim();
	return configured !== undefined && configured.length > 0 ? configured : join(homedir(), ".opencua", "rules.json");
}

/**
 * Reads the profile file and re-reads it when it changes, so an edit applies to the next call without a restart.
 * A missing file means no rules; a file that does not parse is reported once per change and leaves no rules in force.
 */
export function rulesProfileLoader(
	path: string,
	report: (message: string) => void = (message) => process.stderr.write(`${message}\n`),
): () => RulesProfile {
	let loadedAt: number | undefined;
	let current: RulesProfile = EMPTY_RULES;
	return () => {
		let modified: number | undefined;
		try {
			modified = statSync(path).mtimeMs;
		} catch {
			loadedAt = undefined;
			current = EMPTY_RULES;
			return current;
		}
		if (modified === loadedAt) return current;
		loadedAt = modified;
		try {
			current = parseRulesProfile(JSON.parse(readFileSync(path, "utf8")));
		} catch (error: unknown) {
			current = EMPTY_RULES;
			report(`opencua: rules profile ${path} ignored: ${error instanceof Error ? error.message : String(error)}`);
		}
		return current;
	};
}
