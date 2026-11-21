import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
	type SpaceCommand,
	type SpaceRecord,
	VirtualSpace,
	listSpaces,
	parseSpaceRecord,
	sendSpaceCommand,
} from "@opencua/core/light";
import type { Command } from "commander";

export interface SpaceSize {
	readonly width: number;
	readonly height: number;
}

export interface RunningSpace {
	readonly record: SpaceRecord;
	readonly stop: () => void;
	readonly exited: Promise<void>;
}

export interface SpaceOperations {
	run(size: SpaceSize): Promise<RunningSpace>;
	launch(size: SpaceSize): Promise<SpaceRecord>;
	list(): readonly SpaceRecord[];
	send(id: string, command: SpaceCommand): Promise<void>;
}

export interface SpaceCommandDeps {
	readonly isJsonOutput: () => boolean;
	readonly stateDir: string;
	readonly entryScript: string;
	readonly operations?: SpaceOperations;
}

const CONTROL_COMMANDS = [
	{ name: "stop", description: "Stop a virtual space and release its display", done: "is stopping" },
	{
		name: "takeover",
		description: "Take over a virtual space yourself; every agent pauses until you resume",
		done: "is yours; agents are paused until `opencua space resume`",
	},
	{ name: "resume", description: "Hand a virtual space back to the agents", done: "is back with the agents" },
] as const satisfies readonly { readonly name: SpaceCommand; readonly description: string; readonly done: string }[];

export function nativeSpaceOperations(stateDir: string, entryScript: string): SpaceOperations {
	return {
		run: async (size) => {
			const space = await VirtualSpace.start({ stateDir, ...size });
			return { record: space.record, stop: () => space.stop(), exited: space.exited };
		},
		launch: async (size) => await launchDetached(entryScript, size),
		list: () => listSpaces(stateDir),
		send: async (id, command) => await sendSpaceCommand(stateDir, id, command),
	};
}

/** Runs `opencua space run` detached, so the space outlives this command, and returns what it reports. */
async function launchDetached(entryScript: string, size: SpaceSize): Promise<SpaceRecord> {
	const child = spawn(
		process.execPath,
		[entryScript, "space", "run", "--width", String(size.width), "--height", String(size.height)],
		{ detached: true, stdio: ["ignore", "pipe", "ignore"] },
	);
	try {
		const line = await new Promise<string>((resolve, reject) => {
			createInterface({ input: child.stdout }).once("line", resolve);
			child.once("error", reject);
			child.once("exit", (code) => reject(new Error(`opencua space run exited with code ${code ?? "unknown"}`)));
		});
		const reported: unknown = JSON.parse(line);
		const record = parseSpaceRecord(reported);
		if (record !== undefined) return record;
		const failure =
			typeof reported === "object" && reported !== null && "error" in reported ? String(reported.error) : line;
		throw new Error(failure);
	} finally {
		child.stdout.destroy();
		child.unref();
	}
}

function describeSpace(record: SpaceRecord): string {
	const { x, y, width, height } = record.bounds;
	const control = record.takenOver ? " (you have control; agents paused)" : "";
	return `space ${record.id}: display ${record.displayId} at ${x},${y} ${width}x${height}${control}`;
}

function pickSpace(spaces: readonly SpaceRecord[], id: string | undefined): SpaceRecord {
	if (id !== undefined) {
		const match = spaces.find((space) => space.id === id);
		if (match === undefined) throw new Error(`no running virtual space ${id}`);
		return match;
	}
	const [only, ...others] = spaces;
	if (only === undefined) throw new Error("no virtual space is running");
	if (others.length > 0) {
		throw new Error(
			`${spaces.length} virtual spaces are running (${spaces.map((space) => space.id).join(", ")}); name one`,
		);
	}
	return only;
}

function sizeOption(name: "width" | "height", min: number, max: number): (value: string) => number {
	return (value) => {
		const size = Number(value);
		if (!Number.isInteger(size) || size < min || size > max) {
			throw new Error(`--${name} must be an integer from ${min} to ${max}`);
		}
		return size;
	};
}

function withSizeOptions(command: Command): Command {
	return command
		.option("--width <points>", "display width", sizeOption("width", 640, 7680), 1920)
		.option("--height <points>", "display height", sizeOption("height", 480, 4320), 1080);
}

export function registerSpaceCommands(program: Command, deps: SpaceCommandDeps): void {
	const operations = deps.operations ?? nativeSpaceOperations(deps.stateDir, deps.entryScript);
	const write = (json: unknown, human: string) =>
		process.stdout.write(`${deps.isJsonOutput() ? JSON.stringify(json) : human}\n`);
	const space = program
		.command("space")
		.description("A display of their own for agents, shown to you as a picture-in-picture at the bottom left");

	withSizeOptions(
		space.command("start").description("Create a virtual space that runs until `opencua space stop`"),
	).action(async (size: SpaceSize) => {
		const record = await operations.launch(size);
		write(record, describeSpace(record));
	});

	// What `start` runs detached; it always prints one JSON line: the record, or {"error": ...}.
	withSizeOptions(space.command("run", { hidden: true })).action(async (size: SpaceSize) => {
		let running: RunningSpace;
		try {
			running = await operations.run(size);
		} catch (error: unknown) {
			process.stdout.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
			process.exitCode = 1;
			return;
		}
		process.stdout.write(`${JSON.stringify(running.record)}\n`);
		const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
		for (const signal of signals) process.on(signal, running.stop);
		await running.exited;
		for (const signal of signals) process.off(signal, running.stop);
	});

	space
		.command("status")
		.description("List running virtual spaces")
		.action(() => {
			const spaces = operations.list();
			write(spaces, spaces.length === 0 ? "no virtual space is running" : spaces.map(describeSpace).join("\n"));
		});

	for (const control of CONTROL_COMMANDS) {
		space
			.command(control.name)
			.description(control.description)
			.argument("[id]", "space id (default: the only running space)")
			.action(async (id: string | undefined) => {
				const target = pickSpace(operations.list(), id);
				await operations.send(target.id, control.name);
				write({ ok: true, id: target.id, command: control.name }, `space ${target.id} ${control.done}`);
			});
	}
}
