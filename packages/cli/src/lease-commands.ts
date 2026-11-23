import { randomBytes } from "node:crypto";
import {
	DEFAULT_LEASE_MS,
	LEASE_HOLDER_ENV,
	LEASE_TOOLS,
	type LeaseTool,
	MAX_LEASE_MS,
	type WindowLease,
	appendLeaseAudit,
	parseLeaseHolder,
	readLeases,
	resolveStateDir,
	writeLeases,
} from "@opencua/core/light";
import type { Command } from "commander";

interface HostApp {
	readonly name: string;
	readonly bundleId: string;
	readonly pid: number;
}

interface HostWindow {
	readonly id: number;
	readonly title: string;
}

/** What `lease grant` reads from the desktop to turn an app and a window the person names into a process and a window id. */
export interface LeaseHost {
	apps(): readonly HostApp[];
	windows(pid: number): Promise<readonly HostWindow[]>;
	/** The kernel start time of the process at `pid`, undefined when none runs. */
	startTime(pid: number): string | undefined;
}

export interface LeaseCommandDeps {
	readonly isJsonOutput: () => boolean;
	readonly stateDir?: () => string;
	readonly now?: () => Date;
	readonly host?: () => Promise<LeaseHost>;
	readonly newId?: () => string;
	readonly write?: (text: string) => void;
}

/** Reads the running apps and their windows; nothing here activates an app, moves a window or sends input. */
async function desktopHost(): Promise<LeaseHost> {
	const core = await import("@opencua/core");
	return {
		apps: () => core.getRunningApplications(),
		windows: async (pid) =>
			(await core.listTopLevelWindows({ includeOffscreen: true, titlesFor: [pid] }))
				.filter((window) => window.ownerPid === pid)
				.map(({ id, title }) => ({ id, title })),
		startTime: core.processStartTime,
	};
}

/** Leases cover input. Pixels are not gated by a lease yet, so granting `capture` would promise what is not enforced. */
const GRANTABLE_TOOLS: readonly LeaseTool[] = LEASE_TOOLS.filter((tool) => tool !== "capture");

function parseTools(value: string): readonly LeaseTool[] {
	const names = value
		.split(",")
		.map((name) => name.trim())
		.filter((name) => name.length > 0);
	if (names.length === 0) throw new Error(`--tools takes a comma-separated list of: ${GRANTABLE_TOOLS.join(", ")}.`);
	const tools: LeaseTool[] = [];
	for (const name of names) {
		if (name === "capture") {
			throw new Error(
				"--tools cannot list capture: a lease covers input, and screenshots are not gated by one yet.",
			);
		}
		const tool = GRANTABLE_TOOLS.find((candidate) => candidate === name);
		if (tool === undefined) {
			throw new Error(`--tools does not know "${name}". Use any of: ${GRANTABLE_TOOLS.join(", ")}.`);
		}
		if (!tools.includes(tool)) tools.push(tool);
	}
	return tools;
}

const DURATION_UNITS: Readonly<Record<string, number>> = { s: 1_000, m: 60_000, h: 3_600_000 };

function parseDuration(value: string): number {
	const match = /^(\d+)([smh])$/.exec(value.trim());
	const milliseconds = match === null ? 0 : Number(match[1]) * (DURATION_UNITS[match[2] ?? ""] ?? 0);
	if (milliseconds <= 0 || milliseconds > MAX_LEASE_MS) {
		throw new Error(
			`--for takes a time such as 45s, 30m or 2h, at most ${MAX_LEASE_MS / 3_600_000}h; "${value}" is not one.`,
		);
	}
	return milliseconds;
}

function parseHolder(value: string): string {
	const holder = parseLeaseHolder(value);
	if (holder === undefined) {
		throw new Error("--holder takes a name of at most 128 characters without control characters.");
	}
	return holder;
}

function resolveApp(apps: readonly HostApp[], wanted: string): HostApp {
	const name = wanted.trim().toLowerCase();
	const matches = /^\d+$/.test(name)
		? apps.filter((app) => app.pid === Number(name))
		: apps.filter((app) => app.bundleId.toLowerCase() === name || app.name.toLowerCase() === name);
	const [app, ...others] = matches;
	if (app === undefined) {
		throw new Error(`No running app matches "${wanted}". Name it by bundle id, app name or pid (opencua apps list).`);
	}
	if (others.length > 0) {
		throw new Error(
			`"${wanted}" matches ${matches.length} processes (pids ${matches.map((match) => match.pid).join(", ")}); name one by pid.`,
		);
	}
	return app;
}

function describeWindows(windows: readonly HostWindow[]): string {
	return windows.map((window) => `${window.id} ${JSON.stringify(window.title)}`).join(", ");
}

function resolveWindow(app: HostApp, windows: readonly HostWindow[], wanted: string | undefined): HostWindow {
	if (windows.length === 0) throw new Error(`${app.name} (pid ${app.pid}) has no window to lease.`);
	if (wanted === undefined) {
		const [only, ...others] = windows;
		if (only !== undefined && others.length === 0) return only;
		throw new Error(
			`${app.name} has ${windows.length} windows; pick one with --window: ${describeWindows(windows)}.`,
		);
	}
	const text = wanted.trim().toLowerCase();
	const matches = /^\d+$/.test(text)
		? windows.filter((window) => window.id === Number(text))
		: windows.filter((window) => window.title.toLowerCase().includes(text));
	const [window, ...others] = matches;
	if (window === undefined || others.length > 0) {
		throw new Error(
			`--window "${wanted}" names ${matches.length} of ${app.name}'s windows; pick one of: ${describeWindows(windows)}.`,
		);
	}
	return window;
}

function describeLease(lease: WindowLease, now: number): string {
	const { target } = lease;
	const expiry = Date.parse(lease.expiresAt) > now ? "until" : "expired";
	return `${lease.id}  ${lease.holder}  ${target.bundleId} pid ${target.pid} window ${target.windowId}  ${lease.tools.join(",")}  ${expiry} ${lease.expiresAt}`;
}

interface GrantOptions {
	readonly holder: string;
	readonly app: string;
	readonly window?: string;
	readonly tools: readonly LeaseTool[];
	readonly for: number;
	readonly note?: string;
}

/**
 * `opencua lease`: the person's side of window leases. A server started with OPENCUA_LEASE_HOLDER sends input only
 * to windows leased to that holder; servers started without it are not affected by anything written here.
 */
export function registerLeaseCommands(program: Command, deps: LeaseCommandDeps): void {
	const stateDir = deps.stateDir ?? resolveStateDir;
	const now = deps.now ?? (() => new Date());
	const host = deps.host ?? desktopHost;
	const newId = deps.newId ?? (() => `L-${randomBytes(4).toString("hex")}`);
	const write = deps.write ?? ((text: string) => process.stdout.write(text));
	const emit = (value: unknown, text: string): void => {
		write(deps.isJsonOutput() ? `${JSON.stringify(value)}\n` : `${text}\n`);
	};
	const lease = program
		.command("lease")
		.description(
			`Window leases: let one agent act in one window for a while (enforced by servers started with ${LEASE_HOLDER_ENV})`,
		);

	lease
		.command("grant")
		.description("Lease one window of a running app to a holder")
		.requiredOption(
			"--holder <name>",
			`the holder, as the agent's server names it in ${LEASE_HOLDER_ENV}`,
			parseHolder,
		)
		.requiredOption("--app <app>", "the app, by bundle id, name or pid")
		.option("--window <window>", "the window, by id or part of its title (needed when the app has several)")
		.requiredOption("--tools <tools>", `what the holder may do: ${GRANTABLE_TOOLS.join(",")}`, parseTools)
		.option("--for <time>", "how long, such as 45s, 30m or 2h (at most 8h)", parseDuration, DEFAULT_LEASE_MS)
		.option("--note <text>", "a note kept with the lease")
		.action(async (options: GrantOptions) => {
			const at = now();
			const desktop = await host();
			const app = resolveApp(desktop.apps(), options.app);
			const startedAt = desktop.startTime(app.pid);
			if (startedAt === undefined) throw new Error(`${app.name} (pid ${app.pid}) is no longer running.`);
			const window = resolveWindow(app, await desktop.windows(app.pid), options.window);
			const granted: WindowLease = {
				id: newId(),
				holder: options.holder,
				target: { bundleId: app.bundleId, pid: app.pid, startedAt, windowId: window.id },
				tools: options.tools,
				grantedAt: at.toISOString(),
				expiresAt: new Date(at.getTime() + options.for).toISOString(),
				grantedBy: "cli",
				...(options.note === undefined ? {} : { note: options.note }),
			};
			const directory = stateDir();
			const kept = readLeases(directory).filter((existing) => Date.parse(existing.expiresAt) > at.getTime());
			writeLeases(directory, [...kept, granted]);
			appendLeaseAudit(
				directory,
				{
					event: "grant",
					leaseId: granted.id,
					holder: granted.holder,
					pid: app.pid,
					bundleId: app.bundleId,
					windowId: window.id,
					by: "cli",
				},
				at,
			);
			emit(
				granted,
				`granted ${granted.id}: "${granted.holder}" may ${granted.tools.join(", ")} in window ${window.id} ${JSON.stringify(window.title)} of ${app.bundleId} (pid ${app.pid}) until ${granted.expiresAt}\nenforced by opencua servers started with ${LEASE_HOLDER_ENV}=${granted.holder}; revoke with: opencua lease revoke ${granted.id}`,
			);
		});

	lease
		.command("list")
		.description("List the leases in force")
		.option("--all", "include expired leases")
		.action((options: { readonly all?: boolean }) => {
			const at = now().getTime();
			const leases = readLeases(stateDir()).filter(
				(entry) => options.all === true || Date.parse(entry.expiresAt) > at,
			);
			emit(leases, leases.length === 0 ? "no leases" : leases.map((entry) => describeLease(entry, at)).join("\n"));
		});

	lease
		.command("revoke")
		.description("Revoke a lease by id, or every lease with --all")
		.argument("[id]", "the lease id, as `opencua lease list` shows it")
		.option("--all", "revoke every lease")
		.action((id: string | undefined, options: { readonly all?: boolean }) => {
			if (id === undefined && options.all !== true) throw new Error("Name a lease id, or pass --all.");
			const at = now();
			const directory = stateDir();
			const leases = readLeases(directory);
			const revoked = leases.filter((entry) => options.all === true || entry.id === id);
			if (id !== undefined && options.all !== true && revoked.length === 0) {
				throw new Error(`No lease ${id}. See: opencua lease list --all`);
			}
			writeLeases(
				directory,
				leases.filter((entry) => !revoked.includes(entry)),
			);
			for (const entry of revoked) {
				appendLeaseAudit(
					directory,
					{ event: "revoke", leaseId: entry.id, holder: entry.holder, pid: entry.target.pid, by: "cli" },
					at,
				);
			}
			emit(
				{ revoked: revoked.map((entry) => entry.id) },
				revoked.length === 0 ? "no leases to revoke" : `revoked ${revoked.map((entry) => entry.id).join(", ")}`,
			);
		});
}
