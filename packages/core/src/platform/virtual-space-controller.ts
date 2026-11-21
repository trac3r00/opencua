import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { type Server, type Socket, createServer } from "node:net";
import { createInterface } from "node:readline";
import { type StopSource, StopSwitch } from "./stop-switch.js";
import {
	type SpaceCommand,
	type SpaceHelperEvent,
	type SpaceRecord,
	parseSpaceCommand,
	parseSpaceHelperLine,
	removeSpaceRecord,
	spaceControlPath,
	virtualSpaceBinary,
	writeSpaceRecord,
} from "./virtual-space.js";

export const TAKEOVER_REASON = "user-took-over-virtual-space";

export interface SpaceHelperProcess {
	readonly pid?: number | undefined;
	readonly stdin: { write(chunk: string): unknown; end(): unknown };
	readonly stdout: NodeJS.ReadableStream;
	once(event: "exit", listener: (code: number | null) => void): unknown;
	once(event: "error", listener: (error: Error) => void): unknown;
}

export interface SpaceStopSwitch {
	stop(reason: string, source: StopSource): unknown;
	resume(): boolean;
}

export interface VirtualSpaceOptions {
	readonly stateDir: string;
	readonly width?: number;
	readonly height?: number;
	readonly spawnHelper?: (args: readonly string[]) => SpaceHelperProcess;
	readonly stopSwitch?: SpaceStopSwitch;
}

type Origin = "pip" | "control";

function spawnNativeHelper(args: readonly string[]): SpaceHelperProcess {
	return spawn(virtualSpaceBinary(), args, { stdio: ["pipe", "pipe", "inherit"] });
}

/**
 * Owns one virtual space: the helper process that holds the display and shows the picture-in-picture, the record
 * in `<stateDir>/spaces/<id>.json`, and the control socket next to it. The person's Take over engages the stop
 * switch so every agent pauses; Resume lifts it again, but only a stop this space engaged. The record and socket
 * go away when the helper exits; a takeover stop stays until the person resumes.
 */
export class VirtualSpace {
	readonly id: string = randomUUID().slice(0, 8);
	readonly exited: Promise<void>;
	private readonly stateDir: string;
	private readonly stopSwitch: SpaceStopSwitch;
	private readonly helper: SpaceHelperProcess;
	private readonly control: Server;
	private readonly ready: Promise<void>;
	private current: SpaceRecord | undefined;
	private settleReady: { resolve(): void; reject(error: Error): void } | undefined;

	static async start(options: VirtualSpaceOptions): Promise<VirtualSpace> {
		const space = new VirtualSpace(options);
		await space.ready;
		return space;
	}

	private constructor(options: VirtualSpaceOptions) {
		this.stateDir = options.stateDir;
		this.stopSwitch = options.stopSwitch ?? new StopSwitch(options.stateDir);
		this.ready = new Promise<void>((resolve, reject) => {
			this.settleReady = { resolve, reject };
		});
		this.control = createServer((socket) => this.serve(socket));
		this.control.on("error", (error) => this.fail(error));
		const size = ["--width", String(options.width ?? 1920), "--height", String(options.height ?? 1080)];
		this.helper = (options.spawnHelper ?? spawnNativeHelper)(["--create", ...size, "--pip"]);
		this.exited = new Promise<void>((resolve) => {
			const finish = (reason: string) => {
				this.control.close(() => undefined);
				removeSpaceRecord(this.stateDir, this.id);
				this.fail(new Error(`the virtual-space helper ${reason} before its display was ready`));
				resolve();
			};
			this.helper.once("exit", (code) => finish(`exited with code ${code ?? "unknown"}`));
			this.helper.once("error", (error) => finish(`failed: ${error.message}`));
		});
		createInterface({ input: this.helper.stdout }).on("line", (line) => {
			const event = parseSpaceHelperLine(line);
			if (event !== undefined) this.handle(event);
		});
	}

	/** The space as recorded now; defined from the moment `start` resolves. */
	get record(): SpaceRecord {
		if (this.current === undefined) throw new Error(`virtual space ${this.id} is not running`);
		return this.current;
	}

	takeover(origin: Origin): void {
		if (this.current === undefined) return;
		this.stopSwitch.stop(TAKEOVER_REASON, origin === "pip" ? "menu" : "cli");
		if (origin === "control") this.helper.stdin.write("takeover\n");
		this.save({ ...this.current, takenOver: true });
	}

	/** Hands control back to the agents; false when the person had not taken over. */
	resume(origin: Origin): boolean {
		if (this.current?.takenOver !== true) return false;
		this.stopSwitch.resume();
		if (origin === "control") this.helper.stdin.write("resume\n");
		this.save({ ...this.current, takenOver: false });
		return true;
	}

	/** Closes the helper's stdin; it releases the display and exits, which settles `exited`. */
	stop(): void {
		this.helper.stdin.end();
	}

	private handle(event: SpaceHelperEvent): void {
		switch (event.kind) {
			case "created":
				this.created({
					id: this.id,
					displayId: event.displayId,
					bounds: event.bounds,
					pid: this.helper.pid ?? process.pid,
					createdAt: new Date().toISOString(),
					takenOver: false,
				});
				return;
			case "failed":
				this.fail(new Error(`virtual space unavailable (${event.error}): ${event.message}`));
				return;
			case "takeover":
				this.takeover("pip");
				return;
			case "resume":
				this.resume("pip");
				return;
			case "state":
				return;
			default: {
				const unreachable: never = event;
				throw new Error(`unhandled helper event ${JSON.stringify(unreachable)}`);
			}
		}
	}

	private created(record: SpaceRecord): void {
		this.save(record);
		const path = spaceControlPath(this.stateDir, this.id);
		rmSync(path, { force: true });
		this.control.listen(path, () => {
			this.settleReady?.resolve();
			this.settleReady = undefined;
		});
	}

	private fail(error: Error): void {
		if (this.settleReady === undefined) return;
		this.settleReady.reject(error);
		this.settleReady = undefined;
		this.stop();
	}

	private save(record: SpaceRecord): void {
		this.current = record;
		writeSpaceRecord(this.stateDir, record);
	}

	private serve(socket: Socket): void {
		createInterface({ input: socket }).once("line", (line) => {
			const command = parseSpaceCommand(line);
			if (command === undefined) {
				socket.end(`unknown command: ${line.trim()}\n`);
				return;
			}
			this.apply(command);
			socket.end("ok\n");
		});
	}

	private apply(command: SpaceCommand): void {
		switch (command) {
			case "takeover":
				this.takeover("control");
				return;
			case "resume":
				this.resume("control");
				return;
			case "stop":
				this.stop();
				return;
			default: {
				const unreachable: never = command;
				throw new Error(`unhandled space command ${String(unreachable)}`);
			}
		}
	}
}
