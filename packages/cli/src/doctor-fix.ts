import {
	type DoctorCheck,
	type DoctorFacts,
	type DoctorReport,
	GRANT_COMMAND,
	HELPER_DISPLAY_NAME,
	PRIVACY_PANES,
	evaluateDoctor,
	formatDoctorReport,
} from "./doctor.js";

export type RepairId = "native" | "helper" | "registrations" | "stop" | "permissions";

/**
 * One thing `opencua doctor --fix` can do about a report. `auto` repairs are safe to make unasked; rebuilding the
 * helper needs consent because macOS then asks for both permissions again; lifting the stop switch is the person's
 * call; a permission grant only a person can make, so --fix opens the pane where they make it.
 */
export interface Repair {
	readonly id: RepairId;
	readonly kind: "auto" | "consent" | "confirm" | "guide";
	readonly title: string;
}

function notOk(report: DoctorReport, matches: (id: string) => boolean): DoctorCheck[] {
	return report.checks.filter((item) => item.status !== "ok" && matches(item.id));
}

/** The repairs a report calls for, in the order --fix makes them. Pure. */
export function planRepairs(report: DoctorReport): Repair[] {
	const repairs: Repair[] = [];
	if (notOk(report, (id) => id.startsWith("native:") || id === "native-inputs").length > 0) {
		repairs.push({ id: "native", kind: "auto", title: "rebuild the universal native binaries" });
	}
	if (notOk(report, (id) => id === "helper" || id === "helper-inputs" || id === "helper-arch").length > 0) {
		repairs.push({ id: "helper", kind: "consent", title: "rebuild the signed helper app" });
	}
	if (notOk(report, (id) => id.startsWith("client:")).length > 0) {
		repairs.push({ id: "registrations", kind: "auto", title: "register opencua again with the saved MCP clients" });
	}
	if (notOk(report, (id) => id === "stop-switch").length > 0) {
		repairs.push({ id: "stop", kind: "confirm", title: "lift the stop switch" });
	}
	if (notOk(report, (id) => id.startsWith("permission:")).length > 0) {
		repairs.push({
			id: "permissions",
			kind: "guide",
			title: `grant the missing permissions to "${HELPER_DISPLAY_NAME}"`,
		});
	}
	return repairs;
}

export interface FixOptions {
	/** Consent to rebuild the helper given up front (--rebuild-helper). */
	readonly rebuildHelper: boolean;
	/** Open System Settings for a missing permission (default); --no-open only prints the command. */
	readonly openPanes: boolean;
	/** A person is at the terminal to answer questions. */
	readonly interactive: boolean;
	/**
	 * Someone is at the Mac to switch permissions on, with or without a terminal: the permission guide runs and moves on
	 * by itself as each switch turns on. False on CI, on a locked screen and with --no-wait: the pane is only opened.
	 */
	readonly guidePermissions: boolean;
}

export interface FixDependencies {
	readonly gather: () => DoctorFacts;
	readonly rebuildNative: () => boolean;
	readonly rebuildHelper: () => boolean;
	readonly reapplyRegistrations: () => boolean;
	readonly resume: () => void;
	readonly openUrl: (url: string) => boolean;
	/** Walks a person through macOS's permission dialogs (opencua permissions grant); called when guidePermissions. */
	readonly grantPermissions: () => Promise<{ readonly missing: readonly string[] }>;
	/** Asks a yes/no question; called only when interactive. Defaults to no. */
	readonly ask: (question: string) => Promise<boolean>;
	readonly print: (text: string) => void;
}

export interface FixOutcome {
	readonly fixed: readonly string[];
	readonly skipped: readonly string[];
	readonly failed: readonly string[];
	readonly report: DoctorReport;
}

function paneFor(checkId: string): { readonly url: string; readonly pane: string } | undefined {
	if (checkId === "permission:accessibility") {
		return { url: PRIVACY_PANES.accessibility, pane: "Accessibility" };
	}
	if (checkId === "permission:screen-recording") {
		return { url: PRIVACY_PANES.screenRecording, pane: "Screen & System Audio Recording" };
	}
	return checkId.startsWith("permission:automation:")
		? { url: PRIVACY_PANES.automation, pane: "Automation" }
		: undefined;
}

/**
 * The permissions an ad-hoc signed helper holds now. Any rebuild of it is a new code identity to macOS, so all of
 * them stop applying; empty when the helper is signed with a stable identity or holds nothing.
 */
export function grantsLostOnRebuild(facts: DoctorFacts): string[] {
	if (facts.helper.signature.adHoc !== true || facts.selfCheck?.ok !== true) {
		return [];
	}
	const { permissions } = facts.selfCheck.report;
	return [
		permissions.accessibility ? "Accessibility" : undefined,
		permissions.screenRecording ? "Screen Recording" : undefined,
		permissions.inputMonitoring === true ? "Input Monitoring" : undefined,
	].filter((label) => label !== undefined);
}

/**
 * Repairs what is safe to repair, asks before what is not, and reports what is left. Every effect goes through
 * `deps`, so the plan and its consent rules are testable without touching the Mac.
 */
export async function runDoctorFix(options: FixOptions, deps: FixDependencies): Promise<FixOutcome> {
	const facts = deps.gather();
	const before = evaluateDoctor(facts);
	deps.print(formatDoctorReport(before));
	const repairs = planRepairs(before);
	const fixed: string[] = [];
	const skipped: string[] = [];
	const failed: string[] = [];
	if (repairs.length === 0) {
		deps.print("\nNothing for --fix to repair.");
		return { fixed, skipped, failed, report: before };
	}
	deps.print("\nRepairing:");
	for (const repair of repairs) {
		deps.print(`\n- ${repair.title}`);
		switch (repair.id) {
			case "native":
			case "registrations": {
				const ok = repair.id === "native" ? deps.rebuildNative() : deps.reapplyRegistrations();
				(ok ? fixed : failed).push(repair.title);
				break;
			}
			case "helper": {
				const lost = grantsLostOnRebuild(facts);
				if (lost.length > 0) {
					deps.print(
						`  warning: "${HELPER_DISPLAY_NAME}" is signed ad hoc and holds ${lost.join(", ")} now. Rebuilding it makes a new app to macOS, so those grants stop applying and you grant them again (${GRANT_COMMAND}). To keep grants across later rebuilds, create the signing identity first: scripts/create-signing-identity.sh in the checkout.`,
					);
				}
				// Dropping grants a person already made takes --rebuild-helper; a yes to a general question is not enough.
				const consent =
					options.rebuildHelper ||
					(lost.length === 0 &&
						options.interactive &&
						(await deps.ask(
							"Rebuild the helper app now (grants carry over with the opencua dev signing identity; with an ad-hoc build macOS asks for Screen Recording and Accessibility again)",
						)));
				if (!consent) {
					deps.print(
						lost.length > 0
							? "  skipped: rebuilding now drops the grants above, so it runs only with --rebuild-helper. Run: opencua doctor --fix --rebuild-helper"
							: "  skipped: rebuilding the helper needs your consent, because an ad-hoc build makes macOS ask for Screen Recording and Accessibility again. Run: opencua doctor --fix --rebuild-helper",
					);
					skipped.push(`${repair.title} (needs your consent: opencua doctor --fix --rebuild-helper)`);
					break;
				}
				(deps.rebuildHelper() ? fixed : failed).push(repair.title);
				break;
			}
			case "stop": {
				const stop = facts.stop;
				const description = stop.stopped ? `${stop.source} at ${stop.stoppedAt}: ${stop.reason}` : "";
				const lift =
					options.interactive &&
					(await deps.ask(`Computer use is stopped (${description}). Lift the stop so agents may act again`));
				if (!lift) {
					deps.print("  skipped: only you decide when agents may act again. Run: opencua resume");
					skipped.push(`${repair.title} (your call: opencua resume)`);
					break;
				}
				deps.resume();
				fixed.push(repair.title);
				break;
			}
			case "permissions": {
				if (options.guidePermissions) {
					const outcome = await deps.grantPermissions();
					if (outcome.missing.length === 0) {
						fixed.push(repair.title);
					} else {
						skipped.push(`grant ${outcome.missing.join(", ")} (${GRANT_COMMAND})`);
					}
					break;
				}
				const panes = notOk(before, (id) => id.startsWith("permission:")).flatMap((item) => {
					const pane = paneFor(item.id);
					return pane === undefined ? [] : [pane];
				});
				const missing = panes.filter((pane, index) => panes.findIndex((other) => other.url === pane.url) === index);
				// One pane at a time: opening a second one only replaces the first in System Settings.
				let opened = false;
				for (const pane of missing) {
					if (!opened && options.openPanes && deps.openUrl(pane.url)) {
						opened = true;
						deps.print(`  opened System Settings > Privacy & Security > ${pane.pane}`);
					} else {
						deps.print(`  ${opened ? "then " : ""}open ${pane.pane} with: open "${pane.url}"`);
					}
				}
				skipped.push(`grant ${missing.map((pane) => pane.pane).join(" and ")} to "opencua-mcp" (only you can)`);
				break;
			}
		}
	}
	const after = evaluateDoctor(deps.gather());
	deps.print(`\n${formatDoctorReport(after)}`);
	const summary = [
		fixed.length === 0 ? undefined : `Fixed: ${fixed.join("; ")}.`,
		skipped.length === 0 ? undefined : `Left for you: ${skipped.join("; ")}.`,
		failed.length === 0 ? undefined : `Failed: ${failed.join("; ")} (see the output above).`,
	].filter((line) => line !== undefined);
	deps.print(`\n${summary.join("\n")}`);
	return { fixed, skipped, failed, report: after };
}
