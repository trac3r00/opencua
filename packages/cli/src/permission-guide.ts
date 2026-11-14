import type { AutomationStatus } from "@opencua/core";
import { GRANT_COMMAND, HELPER_DISPLAY_NAME, PRIVACY_PANES, automationAppName } from "./doctor.js";
import { type DragPanel, type DragPanelLauncher, nativeDragPanel } from "./permission-drag.js";

/** What the helper holds, read without raising a prompt (server.js --doctor through the helper). */
export interface HelperPermissions {
	readonly accessibility: boolean;
	readonly screenRecording: boolean;
	/** Undefined from a helper that predates the Input Monitoring check. */
	readonly inputMonitoring?: boolean | undefined;
	readonly automation: Readonly<Record<string, AutomationStatus>>;
}

/** What server.js --request-permissions answered; only the kinds that were asked for are present. */
export interface PermissionRequestAnswer {
	readonly accessibility?: boolean;
	readonly screenRecording?: boolean;
	readonly inputMonitoring?: boolean;
	readonly automation?: Readonly<Record<string, AutomationStatus>>;
}

export interface GrantDependencies {
	readonly read: () => HelperPermissions | undefined;
	/** Shows macOS's dialogs for the helper; an Automation dialog blocks until it is answered. */
	readonly request: (kinds: readonly string[]) => PermissionRequestAnswer | undefined;
	readonly openUrl: (url: string) => Promise<boolean>;
	/**
	 * Clears the helper's own earlier decision for a TCC service. macOS shows no Screen Recording dialog, and lists
	 * nothing to switch on, while an older decision (a past Deny, an earlier build) is on record.
	 */
	readonly resetDecision?: (service: "ScreenCapture") => void;
	/** Re-checks until `granted` holds or the person skips; true when it holds. */
	readonly waitFor: (granted: () => boolean) => Promise<boolean>;
	readonly print: (text: string) => void;
	/**
	 * The panel attached to System Settings that a person drags the helper app from into a privacy list, used when
	 * GrantOptions.helperApp is set. Defaults to the native permission-drag binary.
	 */
	readonly dragPanel?: DragPanelLauncher;
}

/**
 * How the guide reaches a person. `terminal`: someone at the terminal, who can type s to skip a permission. `watch`:
 * no terminal, as when an agent runs setup or doctor --fix, but someone at the Mac: the guide opens each pane and moves
 * on by itself once the switch is on. `report`: nobody can switch anything on (CI, a locked screen, --no-wait), so it
 * only lists what is missing.
 */
export type GrantMode = "terminal" | "watch" | "report";

export interface GrantOptions {
	readonly mode: GrantMode;
	readonly openPanes: boolean;
	/** Apps beyond the helper's own Automation targets to ask about, e.g. approved browsers. */
	readonly extraAutomationTargets: readonly string[];
	/** The helper app's path, for adding it by hand when macOS leaves it out of a privacy list. */
	readonly helperApp?: string;
	/** Also walk through Input Monitoring, which only the cua-history watcher needs. */
	readonly inputMonitoring?: boolean;
}

export interface GrantOutcome {
	readonly granted: readonly string[];
	readonly missing: readonly string[];
	readonly notAsked: readonly string[];
}

const NAME = `"${HELPER_DISPLAY_NAME}"`;

/** The instruction line on the drag panel, which points up at the list from under System Settings. */
export const DRAG_PANEL_TITLE = "Drag this into the list above, then switch it on.";

/**
 * Walks a person through every permission the helper needs: shows macOS's own dialog (which also lists the helper in
 * System Settings), opens the pane where the switch is, and moves on as soon as it is on. In `report` mode it only
 * lists what is missing and how to grant it.
 */
export async function grantPermissions(options: GrantOptions, deps: GrantDependencies): Promise<GrantOutcome> {
	const state = deps.read();
	const granted: string[] = [];
	const missing: string[] = [];
	const notAsked: string[] = [];
	if (state === undefined) {
		deps.print(`Cannot read the permissions of ${NAME}: the helper app did not answer. Run opencua doctor.`);
		return {
			granted,
			missing: [
				"Accessibility",
				"Screen Recording",
				...(options.inputMonitoring === true ? ["Input Monitoring"] : []),
			],
			notAsked,
		};
	}
	const targets = [
		...new Set([...Object.keys(state.automation), ...options.extraAutomationTargets.map((id) => id.toLowerCase())]),
	];
	const waiting =
		options.mode === "terminal"
			? "  Waiting until it is on (type s and press Enter to skip)..."
			: "  Watching for the switch; this moves on by itself as soon as it is on...";
	const notInTime =
		options.mode === "terminal" ? "  skipped" : "  not switched on in time (the guide gives up after five minutes)";
	const open = async (url: string, pane: string) => {
		if (options.openPanes && (await deps.openUrl(url))) {
			deps.print(`  Opened System Settings > Privacy & Security > ${pane}.`);
		} else {
			deps.print(`  Open System Settings > Privacy & Security > ${pane} with: open "${url}"`);
		}
	};
	let launcher: DragPanelLauncher | undefined;
	const dragPanel = (): DragPanelLauncher => {
		launcher ??= deps.dragPanel ?? nativeDragPanel(deps.print);
		return launcher;
	};
	let revealed = false;
	// macOS can leave the helper out of the list (an ad-hoc build loses its entries on every rebuild): attach the drag
	// panel to System Settings, or else say how to add it with + and show it selected in Finder.
	const offerHelperApp = (): DragPanel | undefined => {
		const app = options.helperApp;
		if (app === undefined) {
			return undefined;
		}
		const panel = options.openPanes ? dragPanel().show(app, DRAG_PANEL_TITLE) : undefined;
		if (panel !== undefined) {
			deps.print(
				`  If ${NAME} is not in the list: drag it from the panel under System Settings into the list, then switch it on.`,
			);
			return panel;
		}
		deps.print(
			`  If ${NAME} is not in the list: click + below it, press Command-Shift-G, paste ${app}, choose Open, then switch it on.`,
		);
		if (options.openPanes && !revealed) {
			revealed = true;
			dragPanel().reveal(app);
			deps.print(`  Finder shows ${NAME} selected; you can also drag it from there into the list.`);
		}
		return undefined;
	};

	const grants: {
		readonly label: string;
		readonly pane: string;
		readonly url: string;
		readonly kind: string;
		readonly tccService?: "ScreenCapture";
		readonly why: string;
		readonly has: (current: HelperPermissions | undefined) => boolean;
	}[] = [];
	grants.push(
		{
			label: "Accessibility",
			pane: "Accessibility",
			url: PRIVACY_PANES.accessibility,
			kind: "accessibility",
			why: "read app windows and send clicks and keys",
			has: (current: HelperPermissions | undefined) => current?.accessibility === true,
		},
		{
			label: "Screen Recording",
			pane: "Screen & System Audio Recording",
			url: PRIVACY_PANES.screenRecording,
			kind: "screen-recording",
			tccService: "ScreenCapture",
			why: "take screenshots of app windows",
			has: (current: HelperPermissions | undefined) => current?.screenRecording === true,
		},
	);
	if (options.inputMonitoring === true) {
		grants.push({
			label: "Input Monitoring",
			pane: "Input Monitoring",
			url: PRIVACY_PANES.inputMonitoring,
			kind: "input-monitoring",
			why: "record the keystrokes and clicks cua-history keeps",
			has: (current: HelperPermissions | undefined) => current?.inputMonitoring === true,
		});
	}

	for (const grant of grants) {
		// Permissions can change while the guide is open. Never use the initial report to decide whether a later
		// permission still needs a prompt; --doctor starts a fresh helper process and reads TCC again.
		const current = deps.read();
		if (grant.has(current)) {
			deps.print(`ok  ${grant.label} is granted to ${NAME}.`);
			continue;
		}
		if (current === undefined) {
			deps.print(`Could not read the current ${grant.label} status from ${NAME}; run opencua doctor to check it.`);
		}
		if (options.mode === "report") {
			deps.print(`missing  ${grant.label} for ${NAME}: run ${GRANT_COMMAND} while you are at this Mac.`);
			missing.push(grant.label);
			continue;
		}
		deps.print(`\n${grant.label} lets ${NAME} ${grant.why}.`);
		deps.print(`  macOS shows a dialog for ${NAME}: choose Open System Settings, then switch on ${NAME}.`);
		if (grant.tccService !== undefined) {
			deps.resetDecision?.(grant.tccService);
		}
		deps.request([grant.kind]);
		await open(grant.url, grant.pane);
		const panel = offerHelperApp();
		deps.print(waiting);
		try {
			await deps.waitFor(() => grant.has(deps.read()));
		} finally {
			panel?.close();
		}
		// The final fresh helper report is authoritative: it catches a grant made as the deadline elapsed and
		// reports an unreadable response separately from a permission that the helper still says is off.
		const finalState = deps.read();
		if (grant.has(finalState)) {
			deps.print(`  ok  ${grant.label} is granted.`);
			granted.push(grant.label);
		} else {
			deps.print(
				finalState === undefined
					? `Could not verify ${grant.label}: the helper did not return a fresh permission report. Run opencua doctor.`
					: `${notInTime}: the latest check from ${NAME} still reports ${grant.label} off. Grant it later with ${GRANT_COMMAND}`,
			);
			if (finalState !== undefined && grant.kind === "accessibility") {
				deps.print(
					"If its switch is already on, reset the stale TCC decision, then grant it again: tccutil reset Accessibility dev.opencua.mcp",
				);
			} else if (finalState !== undefined && grant.kind === "screen-recording") {
				deps.print(
					"If its switch is already on, reset the stale TCC decision, then grant it again: tccutil reset ScreenCapture dev.opencua.mcp",
				);
			}
			missing.push(grant.label);
		}
	}

	for (const bundleId of targets) {
		const app = automationAppName(bundleId);
		const label = `Automation of ${app}`;
		const statusOf = (ask: boolean) =>
			deps.request([`${ask ? "automation" : "automation-status"}:${bundleId}`])?.automation?.[bundleId] ?? "unknown";
		if (deps.read()?.automation[bundleId] === "granted") {
			deps.print(`ok  ${NAME} may control ${app}.`);
			continue;
		}
		if (options.mode === "report") {
			deps.print(`missing  ${label} for ${NAME}: run ${GRANT_COMMAND} while you are at this Mac.`);
			missing.push(label);
			continue;
		}
		deps.print(`\n${NAME} sends Apple Events to ${app}; macOS asks once whether it may.`);
		deps.print(`  If macOS asks "${HELPER_DISPLAY_NAME}" wants access to control "${app}", choose Allow.`);
		const status = statusOf(true);
		if (status === "granted") {
			deps.print(`  ok  ${NAME} may control ${app}.`);
			granted.push(label);
		} else if (status === "not-running" || status === "unknown") {
			deps.print(`  not asked: ${app} is not running; macOS asks the first time an agent uses it.`);
			notAsked.push(label);
		} else if (status === "not-determined") {
			deps.print(`  macOS recorded no answer (the dialog was closed); run ${GRANT_COMMAND} to be asked again.`);
			missing.push(label);
		} else {
			deps.print(`  ${NAME} is not allowed to control ${app}; switch ${app} on under ${NAME}.`);
			await open(PRIVACY_PANES.automation, "Automation");
			deps.print(waiting);
			if (await deps.waitFor(() => statusOf(false) === "granted")) {
				deps.print(`  ok  ${NAME} may control ${app}.`);
				granted.push(label);
			} else {
				deps.print(`${notInTime}: switch it on later in System Settings > Privacy & Security > Automation`);
				missing.push(label);
			}
		}
	}

	if (granted.length > 0) {
		deps.print("\nRestart your MCP clients so running opencua servers pick up the new permissions.");
	}
	return { granted, missing, notAsked };
}
