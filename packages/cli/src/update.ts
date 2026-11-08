import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HELPER_INPUTS_STAMP } from "./doctor.js";
import { type Environment, type InstallMarker, type Layout, canonicalPath } from "./layout.js";

/** Build outputs setup regenerates. Rebuilding them locally is not a local change, and an update restores them. */
const DERIVED_PATHS: readonly string[] = [
	"packages/core/native/libsckit.dylib",
	"packages/core/native/cursor-overlay",
	"packages/core/native/history-recorder",
	"packages/core/native/build-inputs.sha256",
];

export interface GitResult {
	readonly status: number;
	readonly stdout: string;
	readonly stderr: string;
}

export type Git = (args: readonly string[]) => GitResult;

/** Runs git in `checkout` with `env`. */
export function gitIn(checkout: string, env: Environment): Git {
	return (args) => {
		const result = spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8", env: { ...env } });
		return {
			status: result.status ?? 1,
			stdout: result.stdout ?? "",
			stderr: result.stderr || (result.error?.message ?? ""),
		};
	};
}

/** `git status --porcelain=v1` split into changes that block an update and rebuilt outputs that do not. */
export function classifyLocalChanges(porcelain: string): { blocking: string[]; derived: string[] } {
	const blocking: string[] = [];
	const derived: string[] = [];
	for (const line of porcelain.split("\n")) {
		if (line.trim() === "") {
			continue;
		}
		const path = (line.slice(3).split(" -> ").pop() ?? "").replace(/^"(.*)"$/, "$1");
		if (!line.startsWith("??") && DERIVED_PATHS.includes(path)) {
			derived.push(path);
		} else {
			blocking.push(line);
		}
	}
	return { blocking, derived };
}

export interface UpdateSource {
	readonly remote: string;
	readonly ref: string;
	/** The branch HEAD is on; undefined for a detached HEAD (an install pinned to a tag). */
	readonly branch: string | undefined;
}

/** Where an update comes from: the ref install.sh cloned, else the current branch's upstream. */
export function updateSource(
	git: Git,
	checkout: string,
	marker: InstallMarker | undefined,
): UpdateSource | { readonly error: string } {
	const head = git(["symbolic-ref", "--short", "-q", "HEAD"]);
	const branch = head.status === 0 && head.stdout.trim() !== "" ? head.stdout.trim() : undefined;
	if (marker !== undefined && marker.checkout === checkout) {
		return { remote: "origin", ref: marker.ref, branch };
	}
	if (branch === undefined) {
		return {
			error: "this checkout is not on a branch, so there is no upstream to update from; update it with git, then run ./scripts/setup.sh",
		};
	}
	const remote = git(["config", `branch.${branch}.remote`]).stdout.trim();
	const merge = git(["config", `branch.${branch}.merge`]).stdout.trim();
	if (remote === "" || merge === "") {
		return {
			error: `branch ${branch} has no upstream; set one (git branch --set-upstream-to <remote>/<branch>) or update it with git, then run ./scripts/setup.sh`,
		};
	}
	return { remote, ref: merge.replace(/^refs\/heads\//, ""), branch };
}

function readVersion(checkout: string): string {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(checkout, "package.json"), "utf8"));
		if (typeof parsed === "object" && parsed !== null && "version" in parsed && typeof parsed.version === "string") {
			return parsed.version;
		}
	} catch {
		// reported as unknown below
	}
	return "unknown";
}

function readStamp(helperApp: string): string | undefined {
	try {
		return readFileSync(join(helperApp, HELPER_INPUTS_STAMP), "utf8").trim();
	} catch {
		return undefined;
	}
}

export interface UpdateDependencies {
	readonly git: Git;
	readonly marker: InstallMarker | undefined;
	/** Runs the updated checkout's scripts/setup.sh; returns its exit status. */
	readonly runSetup: () => number;
	/** The helper inputs digest the updated checkout would build; undefined when it cannot be computed. */
	readonly helperDigest: () => string | undefined;
	/**
	 * Whether a rebuilt helper keeps its permission grants: setup signs it with the checkout's stable identity (.signing)
	 * and keeps its bundle id (a pre-rename dev.applecua.mcp helper, or another OPENCUA_BUNDLE_ID, starts over).
	 */
	readonly rebuildKeepsGrants: boolean;
	readonly print: (text: string) => void;
}

/**
 * Fast-forwards the checkout to its upstream and reruns setup, which keeps the helper (and so its permission
 * grants) unless its launcher or Info.plist changed, re-applies the MCP client registrations and runs the doctor.
 * Refuses rather than touch local work: uncommitted changes, or commits the upstream does not have.
 */
export function runUpdate(layout: Pick<Layout, "checkout" | "helperApp">, deps: UpdateDependencies): number {
	const { git, print } = deps;
	const fail = (message: string): number => {
		print(`update refused: ${message}`);
		return 1;
	};
	const toplevel = git(["rev-parse", "--show-toplevel"]);
	if (toplevel.status !== 0 || canonicalPath(toplevel.stdout.trim()) !== layout.checkout) {
		return fail(`${layout.checkout} is not a git checkout, so opencua cannot update it`);
	}
	const status = git(["status", "--porcelain=v1", "--untracked-files=normal"]);
	if (status.status !== 0) {
		return fail(`git status failed: ${status.stderr.trim()}`);
	}
	const changes = classifyLocalChanges(status.stdout);
	if (changes.blocking.length > 0) {
		const listed = changes.blocking.slice(0, 10).map((line) => `  ${line}`);
		const more = changes.blocking.length > 10 ? [`  ... and ${changes.blocking.length - 10} more`] : [];
		return fail(
			[
				`${layout.checkout} has local changes:`,
				...listed,
				...more,
				`Commit or stash them (git -C "${layout.checkout}" stash), then run opencua update again.`,
			].join("\n"),
		);
	}
	const source = updateSource(git, layout.checkout, deps.marker);
	if ("error" in source) {
		return fail(source.error);
	}
	const oldCommit = git(["rev-parse", "--short", "HEAD"]).stdout.trim();
	const oldVersion = readVersion(layout.checkout);
	print(`Fetching ${source.ref} from ${source.remote}...`);
	const fetched = git(["fetch", "--quiet", source.remote, source.ref]);
	if (fetched.status !== 0) {
		return fail(`git fetch ${source.remote} ${source.ref} failed: ${fetched.stderr.trim()}`);
	}
	const target = git(["rev-parse", "--verify", "--quiet", "FETCH_HEAD^{commit}"]).stdout.trim();
	const head = git(["rev-parse", "HEAD"]).stdout.trim();
	if (target === "") {
		return fail(`${source.remote} ${source.ref} did not resolve to a commit`);
	}
	if (target === head) {
		print(`Already up to date: opencua ${oldVersion} (${oldCommit}).`);
		return 0;
	}
	if (git(["merge-base", "--is-ancestor", "HEAD", target]).status !== 0) {
		return fail(
			`this checkout has commits that ${source.remote} ${source.ref} does not, so it cannot fast-forward; reconcile them with git, then run ./scripts/setup.sh`,
		);
	}
	if (changes.derived.length > 0) {
		print(
			`Restoring rebuilt native binaries before updating (setup checks them again): ${changes.derived.join(", ")}`,
		);
		const restored = git(["checkout", "--", ...changes.derived]);
		if (restored.status !== 0) {
			return fail(`git checkout of ${changes.derived.join(", ")} failed: ${restored.stderr.trim()}`);
		}
	}
	const moved =
		source.branch === undefined
			? git(["checkout", "--quiet", "--detach", target])
			: git(["merge", "--ff-only", "--quiet", target]);
	if (moved.status !== 0) {
		return fail(`fast-forward to ${target.slice(0, 7)} failed: ${moved.stderr.trim()}`);
	}
	const newCommit = git(["rev-parse", "--short", "HEAD"]).stdout.trim();
	const newVersion = readVersion(layout.checkout);
	const transition = `opencua ${oldVersion} (${oldCommit}) -> ${newVersion} (${newCommit})`;
	print(`Updating ${transition}`);
	const stamp = readStamp(layout.helperApp);
	const digest = stamp === undefined ? undefined : deps.helperDigest();
	if (stamp !== undefined && digest !== undefined && stamp !== digest) {
		print(
			deps.rebuildKeepsGrants
				? "note: this update changes the helper app's launcher, Info.plist or history recorder, so setup rebuilds it with the same signing identity and bundle id: its permission grants stay. Reconnect each MCP client once (e.g. /mcp reconnect opencua) so running servers move to the new helper."
				: "warning: this update changes the helper app's launcher, Info.plist or history recorder, so setup rebuilds it. Without the same signing identity and bundle id the rebuild is a new code identity: macOS will ask for Screen Recording and Accessibility again.",
		);
	}
	const setupStatus = deps.runSetup();
	if (setupStatus !== 0) {
		print(
			`\nThe checkout is at ${newCommit}, but setup failed (exit ${setupStatus}). Fix what it reported, then run ./scripts/setup.sh or opencua update again.`,
		);
		return setupStatus;
	}
	print(`\nUpdated ${transition}.`);
	return 0;
}
