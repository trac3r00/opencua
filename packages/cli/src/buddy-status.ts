import { type ChildProcess, spawn } from "node:child_process";

// The bottom-of-screen status pill (`buddy-hud --status`): what buddy, and the agents it started, are doing right now.
// Every press gets a visible answer, so a question that was not heard, or is still being worked out, never looks like
// buddy is broken.

export type BuddyState = "idle" | "listening" | "hearing" | "thinking" | "working" | "speaking" | "done" | "error";

export interface StatusUpdate {
	readonly state: BuddyState;
	readonly text?: string;
	readonly detail?: string;
	/** Seconds until the pill hides itself, unless another update comes first. */
	readonly ttl?: number;
}

const MAX_TEXT = 160;

function clip(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT - 1)}…` : flat;
}

export function statusLine(update: StatusUpdate): string {
	const line: Record<string, string | number> = { state: update.state };
	if (update.text !== undefined && update.text.length > 0) line["text"] = clip(update.text);
	if (update.detail !== undefined && update.detail.length > 0) line["detail"] = clip(update.detail);
	if (update.ttl !== undefined && update.ttl > 0) line["ttl"] = update.ttl;
	return `${JSON.stringify(line)}\n`;
}

export function agentsDetail(running: number): string | undefined {
	if (running <= 0) return undefined;
	return running === 1 ? "1 agent working in the background" : `${running} agents working in the background`;
}

export type StatusSpawn = (binary: string, args: readonly string[]) => ChildProcess;

const defaultSpawn: StatusSpawn = (binary, args) => spawn(binary, [...args], { stdio: ["pipe", "ignore", "ignore"] });

/**
 * Owns one `buddy-hud --status` process: started on the first update, started again if it died, and given the
 * running-agents line on every update. Without a HUD binary (not built) or with OPENCUA_BUDDY_HUD=off it does nothing.
 */
export class StatusHud {
	private child: ChildProcess | undefined;
	private last: StatusUpdate = { state: "idle" };
	private agents = 0;
	private readonly binary: string | undefined;
	private readonly spawnHud: StatusSpawn;

	// Plain fields, not parameter properties: the CLI also runs from source under Node's strip-only TypeScript.
	constructor(binary: string | undefined, spawnHud: StatusSpawn = defaultSpawn, env: NodeJS.ProcessEnv = process.env) {
		this.binary = env["OPENCUA_BUDDY_HUD"] === "off" ? undefined : binary;
		this.spawnHud = spawnHud;
	}

	get current(): StatusUpdate {
		return this.last;
	}

	set(update: StatusUpdate): void {
		this.last = update;
		this.send(update);
	}

	/** How many background agents run; shown under buddy's own state, or on its own while buddy is idle. */
	setAgents(running: number): void {
		if (running === this.agents) return;
		this.agents = running;
		this.send(this.last);
	}

	close(): void {
		const child = this.child;
		this.child = undefined;
		child?.stdin?.end();
	}

	private send(update: StatusUpdate): void {
		const detail = update.detail ?? agentsDetail(this.agents);
		const shown: StatusUpdate =
			update.state === "idle" && this.agents > 0
				? { state: "working", text: agentsDetail(this.agents) ?? "" }
				: { ...update, ...(detail === undefined ? {} : { detail }) };
		const child = this.ensure();
		if (child?.stdin === null || child?.stdin === undefined) return;
		child.stdin.write(statusLine(shown));
	}

	private ensure(): ChildProcess | undefined {
		if (this.binary === undefined) return undefined;
		if (this.child !== undefined) return this.child;
		const child = this.spawnHud(this.binary, ["--status"]);
		// A HUD that cannot start must not take buddy down with it; the next update tries again.
		child.on("error", () => {
			if (this.child === child) this.child = undefined;
		});
		child.on("exit", () => {
			if (this.child === child) this.child = undefined;
		});
		child.stdin?.on("error", () => undefined);
		this.child = child;
		return child;
	}
}
