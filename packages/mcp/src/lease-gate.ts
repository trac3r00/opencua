import {
	type GuardedComputerInterface,
	type InputObservation,
	type LeaseDecision,
	type LeaseProbes,
	type LeaseTool,
	type PreflightOptions,
	type PreflightResult,
	ToolFailure,
	appendLeaseAudit,
	currentInputScope,
	getRunningApplications,
	isOwnedSurfacePid,
	leaseHolderFromEnvironment,
	listWindows,
	processStartTime,
	readLeases,
	resolveLease,
	resolveStateDir,
	withLease,
} from "@opencua/core";

/**
 * Window leases for one server: the person named a holder in the server's environment, so this server sends input
 * only to windows the person leased to that holder. A server started without a holder has no gate at all.
 */
export interface WindowLeaseOptions {
	/** The name leases must be granted to. */
	readonly holder: string;
	/** Where the person's `opencua lease grant` wrote them. */
	readonly stateDir: string;
	/** The process and window facts a lease is checked against, read fresh for every check. */
	readonly probes?: () => LeaseProbes;
	/** A window opencua launched itself is not one of the person's, so it needs no lease. */
	readonly owned?: (pid: number) => boolean;
	/** The running apps an app named by a script, Terminal or the Dock is looked up in, read fresh for every check. */
	readonly apps?: () => readonly LeaseApp[];
}

/** A running app as an app-wide lease check finds it. */
export interface LeaseApp {
	readonly name: string;
	readonly bundleId: string;
	readonly pid: number;
}

/** The lease gate the environment asks for: none unless OPENCUA_LEASE_HOLDER names a holder. */
export function windowLeasesFromEnvironment(env: NodeJS.ProcessEnv = process.env): WindowLeaseOptions | undefined {
	const holder = leaseHolderFromEnvironment(env);
	return holder === undefined ? undefined : { holder, stateDir: resolveStateDir(env) };
}

/** `computer` as it is when leases are off, so the default path runs the very same object; gated when they are on. */
export function withWindowLeases<T extends GuardedComputerInterface>(
	computer: T,
	options: WindowLeaseOptions | undefined,
): T {
	return options === undefined ? computer : leaseGuardedComputer(computer, options);
}

/** What the host says now; the window list is read at most once per check. */
function hostProbes(): LeaseProbes {
	let windows: ReturnType<typeof listWindows>;
	return {
		now: Date.now(),
		startTime: processStartTime,
		windowOwner: (windowId) => {
			if (process.platform !== "darwin") return undefined;
			// A leased window may sit on another Space or behind the person's app, where background input still reaches it.
			windows ??= listWindows({ onScreenOnly: false }) ?? [];
			return windows.find((window) => window.id === windowId)?.ownerPid;
		},
	};
}

interface InputMethod {
	readonly tool: LeaseTool;
	/** Whether the method's first argument names the target process; otherwise the input scope does. */
	readonly targetArgument: boolean;
}

const scoped = (tool: LeaseTool): InputMethod => ({ tool, targetArgument: false });
const addressed = (tool: LeaseTool): InputMethod => ({ tool, targetArgument: true });

/**
 * Every method of a computer that sends input to an app, and the lease tool that allows it. A press, however it is
 * delivered (pointer, accessibility action, menu item), is a click; writing a field's value or its selection is
 * set_value.
 */
const INPUT_METHODS: Readonly<Record<string, InputMethod>> = {
	click: scoped("click"),
	rightClick: scoped("click"),
	middleClick: scoped("click"),
	doubleClick: scoped("click"),
	move: scoped("click"),
	drag: scoped("drag"),
	scroll: scoped("scroll"),
	key: scoped("key"),
	type: scoped("type"),
	performAction: addressed("click"),
	pressAtPosition: addressed("click"),
	focusWebPage: addressed("click"),
	invokeMenu: addressed("click"),
	scrollElementIntoView: addressed("scroll"),
	typeIntoFocused: addressed("type"),
	setValue: addressed("set_value"),
	selectText: addressed("set_value"),
};

type Denial = Exclude<LeaseDecision, { readonly lease: unknown }>;

interface Attempt {
	readonly pid: number;
	readonly windowId: number | undefined;
	readonly tool: LeaseTool | undefined;
	readonly bundleId?: string;
}

/** Write a refusal to the lease audit log; the refusal stands whether or not it could be recorded. */
function auditRefusal(
	options: WindowLeaseOptions,
	target: {
		readonly pid?: number;
		readonly bundleId?: string | undefined;
		readonly windowId?: number | undefined;
		readonly tool?: LeaseTool | undefined;
	},
	denial: Denial,
): void {
	try {
		appendLeaseAudit(options.stateDir, {
			event: "refuse",
			holder: options.holder,
			...(target.pid === undefined ? {} : { pid: target.pid }),
			...(target.bundleId === undefined ? {} : { bundleId: target.bundleId }),
			...(target.windowId === undefined ? {} : { windowId: target.windowId }),
			...(target.tool === undefined ? {} : { tool: target.tool }),
			code: denial.code,
			reason: denial.detail,
			by: "server",
		});
	} catch (error: unknown) {
		process.stderr.write(
			`opencua: could not write the lease audit log: ${error instanceof Error ? error.message : String(error)}\n`,
		);
	}
}

/** What was refused and the command with which the person allows it; no window means a lease on any of the app's. */
function explain(holder: string, denial: Denial, app: string, window: string | undefined, tools: string): string {
	const windowOption = window === undefined ? "" : ` --window ${window}`;
	return `${denial.code}: ${denial.detail}. Window leases are on for this server, so only the person can allow this: opencua lease grant --holder ${JSON.stringify(holder)} --app ${app}${windowOption} --tools ${tools}`;
}

/** Why a route that reaches a whole app may not act, in the terms a refusal result takes. */
export interface LeaseRefusal {
	readonly reason: Denial["code"];
	readonly message: string;
}

/**
 * Window leases for the routes that reach a whole app rather than one of its windows: a script talks to the app's
 * scripting objects, a Terminal command opens a window of its own, a Dock menu command acts on the app. A live
 * whole-window lease on any window of the app that lists the tool allows it, so the person grants it with the same
 * `opencua lease grant`.
 */
export interface AppLeaseGate {
	/**
	 * Why the holder may not use `tool` on the app `app` names (bundle id or app name), or undefined when every running
	 * process of that app holds such a lease. An app that is not running is refused: nothing it would launch is leased.
	 */
	refuse(app: string, tool: LeaseTool): LeaseRefusal | undefined;
	/** The refusal for an action whose app cannot be told (`detail` says why), so no lease can be checked. */
	refuseUnattributed(tool: LeaseTool, detail: string): LeaseRefusal;
}

/** The app-wide lease check the server's lease options ask for: none when leases are off. */
export function appLeaseGate(options: WindowLeaseOptions | undefined): AppLeaseGate | undefined {
	if (options === undefined) return undefined;
	const probes = options.probes ?? hostProbes;
	const owned = options.owned ?? isOwnedSurfacePid;
	const apps = options.apps ?? (() => (process.platform === "darwin" ? getRunningApplications() : []));
	const refusalOf = (denial: Denial, app: string, tool: LeaseTool): LeaseRefusal => ({
		reason: denial.code,
		message: explain(options.holder, denial, app, undefined, tool),
	});
	return {
		refuse(app, tool) {
			const wanted = app
				.trim()
				.toLowerCase()
				.replace(/\.app$/, "");
			const running = apps().filter(
				(candidate) => candidate.bundleId.toLowerCase() === wanted || candidate.name.toLowerCase() === wanted,
			);
			if (running.length === 0) {
				const denial: Denial = {
					code: "lease-required",
					detail: `${JSON.stringify(app)} is not running, so no lease can cover it (open it first)`,
				};
				auditRefusal(options, { tool }, denial);
				return refusalOf(denial, JSON.stringify(app), tool);
			}
			for (const entry of running) {
				if (owned(entry.pid)) continue;
				const decision = resolveLease(
					readLeases(options.stateDir),
					options.holder,
					{ pid: entry.pid },
					tool,
					probes(),
				);
				if ("code" in decision) {
					auditRefusal(options, { pid: entry.pid, bundleId: entry.bundleId, tool }, decision);
					return refusalOf(decision, String(entry.pid), tool);
				}
			}
			return undefined;
		},
		refuseUnattributed(tool, detail) {
			const denial: Denial = { code: "lease-required", detail };
			auditRefusal(options, { tool }, denial);
			return refusalOf(denial, "<app>", tool);
		},
	};
}

function leaseGuardedComputer<T extends GuardedComputerInterface>(computer: T, options: WindowLeaseOptions): T {
	const probes = options.probes ?? hostProbes;
	const owned = options.owned ?? isOwnedSurfacePid;

	/** The lease that allows the attempt (none is needed on an owned surface), or why there is none. */
	const decide = (attempt: Attempt): LeaseDecision | undefined => {
		if (owned(attempt.pid)) return undefined;
		const decision: LeaseDecision =
			attempt.windowId === undefined
				? { code: "lease-required", detail: `no observed window of process ${attempt.pid} names the target` }
				: resolveLease(
						readLeases(options.stateDir),
						options.holder,
						{ pid: attempt.pid, windowId: attempt.windowId },
						attempt.tool,
						probes(),
					);
		if ("code" in decision) auditRefusal(options, attempt, decision);
		return decision;
	};

	const explainAttempt = (attempt: Attempt, denial: Denial): string =>
		explain(
			options.holder,
			denial,
			String(attempt.pid),
			attempt.windowId === undefined ? "<window id>" : String(attempt.windowId),
			attempt.tool ?? "<tools>",
		);

	const preflightInput = async (
		expected: InputObservation,
		preflightOptions?: PreflightOptions,
	): Promise<PreflightResult> => {
		// The computer's own refusals come first: a window that is gone or an app that is not approved needs no lease.
		const result = await computer.preflightInput(expected, preflightOptions);
		if (!result.ok) return result;
		const attempt: Attempt = {
			pid: expected.pid,
			windowId: expected.windowId,
			tool: undefined,
			bundleId: expected.bundleId,
		};
		const decision = decide(attempt);
		return decision === undefined || "lease" in decision
			? result
			: { ok: false, reason: decision.code, detail: explainAttempt(attempt, decision) };
	};

	/** The window an input method is aimed at: the dispatch's own scope, else the app's latest observation. */
	const attemptOf = (method: InputMethod, firstArgument: unknown): Attempt | undefined => {
		const scope = currentInputScope()?.target;
		const pid = method.targetArgument ? firstArgument : scope?.pid;
		if (typeof pid !== "number") return undefined;
		const scopedWindow = scope?.pid === pid ? scope.windowId : undefined;
		return { pid, windowId: scopedWindow ?? computer.getInputObservation(pid)?.windowId, tool: method.tool };
	};

	const gated = (method: InputMethod, send: (...sent: unknown[]) => unknown) => {
		return async (...sent: unknown[]): Promise<unknown> => {
			const attempt = attemptOf(method, sent[0]);
			if (attempt === undefined) {
				throw refusal("lease-required: input with no target app cannot be matched to a window lease");
			}
			const decision = decide(attempt);
			if (decision === undefined) return await send(...sent);
			if ("code" in decision) throw refusal(explainAttempt(attempt, decision), decision.code);
			return await withLease(decision.lease, async () => await send(...sent));
		};
	};

	const methods = new Map<PropertyKey, { readonly source: unknown; readonly method: unknown }>();
	return new Proxy(computer, {
		get(target, property) {
			const source: unknown = Reflect.get(target, property, target);
			if (typeof source !== "function") return source;
			const known = methods.get(property);
			if (known?.source === source) return known.method;
			const send = (...sent: unknown[]): unknown => Reflect.apply(source, target, sent);
			const input = typeof property === "string" ? INPUT_METHODS[property] : undefined;
			const method =
				property === "preflightInput" ? preflightInput : input === undefined ? send : gated(input, send);
			methods.set(property, { source, method });
			return method;
		},
	});
}

function refusal(message: string, code: Denial["code"] = "lease-required"): ToolFailure {
	return new ToolFailure(message, {
		code: code.toUpperCase().replaceAll("-", "_"),
		delivery: "not_sent",
		retry: "never",
		hint: "Nothing was sent for this step. Do not retry; ask the user to grant the window lease named in the message.",
	});
}
