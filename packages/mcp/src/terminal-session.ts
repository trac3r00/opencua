import type { HostCapabilities, StopStatusSource } from "@opencua/core";
import { describeUserStop, dispatchTerminalCommand, readVisibleText } from "@opencua/core";
import type { AppLeaseGate } from "./lease-gate.js";
import type { ToolResult } from "./tool-result.js";
import { refusalResult, textResult } from "./tool-result.js";

const TERMINAL_BUNDLE_ID = "com.apple.Terminal";

export interface TerminalGuardOptions {
	readonly allowedBundleIds: readonly string[] | undefined;
	readonly delivery: "background" | "attended";
	readonly probeHost: () => HostCapabilities;
	readonly stopSwitch?: StopStatusSource;
	readonly dispatch?: TerminalCommandSource;
	readonly readText?: TerminalTextReader;
	/**
	 * Window leases are on: a command needs the holder's `terminal` lease on Terminal.app. The command opens a window of
	 * its own, so a lease on any Terminal window allows it. Reading is observation, which leases do not gate.
	 */
	readonly leases?: AppLeaseGate;
}

export type TerminalCommandSource = (command: string) => Promise<{
	readonly dispatched: true;
	readonly windowId?: number;
	readonly marker: string;
}>;
export type TerminalTextReader = (windowId?: number) => string;

export class TerminalGuardSession {
	private stopped = false;
	private readonly dispatch: TerminalCommandSource;
	private readonly readText: TerminalTextReader;

	constructor(private readonly options: TerminalGuardOptions) {
		this.dispatch = options.dispatch ?? ((command) => dispatchTerminalCommand({ command }));
		this.readText = options.readText ?? readVisibleText;
	}

	async run(command: unknown): Promise<ToolResult> {
		const refusal = this.policyRefusal(true);
		if (refusal !== undefined) return refusal;
		if (typeof command !== "string" || command.trim() === "") {
			return refusalResult("terminal-invalid-command", "terminal.run requires a non-empty command string.");
		}
		const leaseRefusal = this.options.leases?.refuse(TERMINAL_BUNDLE_ID, "terminal");
		if (leaseRefusal !== undefined) return refusalResult(leaseRefusal.reason, leaseRefusal.message);
		try {
			return textResult(JSON.stringify(await this.dispatch(command)));
		} catch (error) {
			return refusalResult("terminal-run-failed", error instanceof Error ? error.message : String(error));
		}
	}

	read(windowId: unknown): string | ToolResult {
		const refusal = this.policyRefusal(false);
		if (refusal !== undefined) return refusal;
		if (
			windowId !== undefined &&
			(typeof windowId !== "number" || !Number.isSafeInteger(windowId) || windowId <= 0)
		) {
			return refusalResult("terminal-invalid-window", "windowId must be a positive integer.");
		}
		try {
			return this.readText(windowId);
		} catch (error) {
			return refusalResult("terminal-read-failed", error instanceof Error ? error.message : String(error));
		}
	}

	close(): void {
		this.stopped = true;
	}

	private policyRefusal(mutation: boolean): ToolResult | undefined {
		if (this.stopped) return refusalResult("terminal-session-closed");
		const stop = this.options.stopSwitch?.status();
		if (stop?.stopped === true) return refusalResult("user-stopped", describeUserStop(stop));
		const allowedBundleIds = this.options.allowedBundleIds;
		if (
			allowedBundleIds !== undefined &&
			!allowedBundleIds.some((bundleId) => bundleId.toLowerCase() === TERMINAL_BUNDLE_ID.toLowerCase())
		) {
			return refusalResult(
				"terminal-not-approved",
				"Allow com.apple.Terminal in OPENCUA_ALLOWED_BUNDLE_IDS to use Terminal.app.",
			);
		}
		const host = this.options.probeHost();
		if (!host.permissions.accessibility) return refusalResult("accessibility-permission-required");
		if (host.session.screenLocked) return refusalResult("screen-locked");
		if (mutation && (this.options.delivery !== "attended" || host.session.onConsole !== true)) {
			return refusalResult(
				"terminal-mutation-unavailable",
				"Terminal.app commands require attended console delivery.",
			);
		}
		return undefined;
	}
}
