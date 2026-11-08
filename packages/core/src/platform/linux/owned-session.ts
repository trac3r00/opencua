import { type ChildProcess, spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { spawnLinuxHelper } from "./client.js";
import { type LinuxHostComputer, createLinuxHostComputer } from "./index.js";

/**
 * An X display OpenCUA starts and owns (Xvfb, headless; or Xephyr, a window the person can watch),
 * so agents work there and never on the person's display, pointer, keyboard or workspaces. Inside
 * it, Multi-Pointer X gives every agent its own master pointer and keyboard focus.
 */
export interface OwnedDisplayPlan {
	readonly display: string;
	readonly command: string;
	readonly args: readonly string[];
}

export type OwnedDisplayKind = "xvfb" | "xephyr";

/** The lowest display number at or above `from` with no X socket or lock (from /tmp/.X11-unix entries like "X0"). */
export function freeDisplayNumber(socketNames: readonly string[], from = 90): number {
	const used = new Set(
		socketNames.flatMap((name) => {
			const match = /^X(\d{1,5})$/.exec(name);
			return match?.[1] === undefined ? [] : [Number(match[1])];
		}),
	);
	for (let number = from; number < from + 1000; number += 1) if (!used.has(number)) return number;
	throw new RangeError("no free X display number");
}

export function ownedDisplayPlan(
	kind: OwnedDisplayKind,
	number: number,
	size: { readonly width: number; readonly height: number },
): OwnedDisplayPlan {
	if (!Number.isSafeInteger(number) || number < 1 || number > 65535)
		throw new RangeError("display number out of range");
	const { width, height } = size;
	if (![width, height].every((value) => Number.isSafeInteger(value) && value >= 320 && value <= 8192)) {
		throw new RangeError("display size must be 320 to 8192 pixels per side");
	}
	const display = `:${number}`;
	const common = ["-nolisten", "tcp", "-noreset", "+extension", "Composite", "+extension", "XInputExtension"];
	return kind === "xvfb"
		? { display, command: "Xvfb", args: [display, "-screen", "0", `${width}x${height}x24`, ...common] }
		: {
				display,
				command: "Xephyr",
				args: [display, "-screen", `${width}x${height}`, "-title", `OpenCUA ${display}`, ...common],
			};
}

export interface XMaster {
	readonly name: string;
	readonly pointerId: number;
	readonly keyboardId: number;
}

/**
 * Master pointer/keyboard pairs in `xinput list --short` output. A master named N appears as
 * "N pointer  id=P [master pointer  (K)]" and "N keyboard id=K [master keyboard (P)]".
 */
export function readXinputMasters(text: string): XMaster[] {
	const pointers = new Map<string, { id: number; paired: number }>();
	const keyboards = new Map<string, { id: number; paired: number }>();
	for (const line of text.split("\n")) {
		const match =
			/^[\s⎡⎣↳~|]*(.+?) (pointer|keyboard)\s+id=(\d+)\s+\[master (pointer|keyboard)\s+\((\d+)\)\]\s*$/.exec(line);
		if (match === null) continue;
		const [, name = "", kind, id = "", masterKind, paired = ""] = match;
		if (kind !== masterKind) continue;
		if (kind === "pointer") pointers.set(name, { id: Number(id), paired: Number(paired) });
		else keyboards.set(name, { id: Number(id), paired: Number(paired) });
	}
	const masters: XMaster[] = [];
	for (const [name, pointer] of pointers) {
		const keyboard = keyboards.get(name);
		if (keyboard !== undefined && keyboard.id === pointer.paired && keyboard.paired === pointer.id) {
			masters.push({ name, pointerId: pointer.id, keyboardId: keyboard.id });
		}
	}
	return masters;
}

/** An agent's master device name: "opencua-" plus the agent name reduced to letters, digits and dashes. */
export function agentMasterName(agent: string): string {
	const slug = agent
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	if (slug.length === 0) throw new RangeError("agent name has no letters or digits");
	return `opencua-${slug}`;
}

export interface OwnedLinuxSession {
	readonly display: string;
	readonly computer: LinuxHostComputer;
	/** Creates (once) the agent's own master pointer and keyboard on this display and returns them. */
	addAgentPointer(agent: string): Promise<XMaster>;
	close(): Promise<void>;
}

type Runner = (command: string, args: readonly string[], env: Readonly<Record<string, string>>) => Promise<string>;

const runCommand: Runner = (command, args, env) =>
	new Promise((resolve, reject) => {
		const child = spawn(command, [...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		let errors = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			output += chunk;
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			errors = (errors + chunk).slice(-2048);
		});
		child.on("error", reject);
		child.on("close", (code) => (code === 0 ? resolve(output) : reject(new Error(`${command} failed: ${errors}`))));
	});

/**
 * Starts an owned display and a Linux backend bound to it. Physical input (xdotool/ydotool, MPX)
 * is enabled only because the display is OpenCUA's own; the person's DISPLAY is never used.
 */
export async function startOwnedLinuxSession(
	options: {
		readonly kind?: OwnedDisplayKind;
		readonly size?: { readonly width: number; readonly height: number };
		readonly run?: Runner;
		readonly start?: (plan: OwnedDisplayPlan) => { readonly ready: Promise<void>; stop(): void };
		readonly sockets?: () => readonly string[];
	} = {},
): Promise<OwnedLinuxSession> {
	const sockets = options.sockets ?? (() => readdirSync("/tmp/.X11-unix"));
	const plan = ownedDisplayPlan(
		options.kind ?? "xvfb",
		freeDisplayNumber(sockets()),
		options.size ?? { width: 1440, height: 900 },
	);
	const server = (options.start ?? startServer)(plan);
	await server.ready;
	const env = { DISPLAY: plan.display, WAYLAND_DISPLAY: "", XDG_SESSION_TYPE: "x11" };
	const run = options.run ?? runCommand;
	const computer = createLinuxHostComputer({ helperFactory: spawnLinuxHelper("python3", env), physical: true });
	return {
		display: plan.display,
		computer,
		async addAgentPointer(agent) {
			const name = agentMasterName(agent);
			let master = readXinputMasters(await run("xinput", ["list", "--short"], env)).find(
				(entry) => entry.name === name,
			);
			if (master === undefined) {
				await run("xinput", ["create-master", name], env);
				master = readXinputMasters(await run("xinput", ["list", "--short"], env)).find(
					(entry) => entry.name === name,
				);
			}
			if (master === undefined) throw new Error(`xinput did not create master ${name}`);
			return master;
		},
		async close() {
			await computer.close();
			server.stop();
		},
	};
}

function startServer(plan: OwnedDisplayPlan): { readonly ready: Promise<void>; stop(): void } {
	const child: ChildProcess = spawn(plan.command, [...plan.args], { stdio: ["ignore", "ignore", "pipe"] });
	const ready = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${plan.command} did not start within 10 s`)), 10_000);
		const socket = `X${plan.display.slice(1)}`;
		const check = setInterval(() => {
			if (readdirSync("/tmp/.X11-unix").includes(socket)) {
				clearInterval(check);
				clearTimeout(timer);
				resolve();
			}
		}, 50);
		child.on("exit", (code) => {
			clearInterval(check);
			clearTimeout(timer);
			reject(new Error(`${plan.command} exited (${code})`));
		});
	});
	return { ready, stop: () => child.kill() };
}
