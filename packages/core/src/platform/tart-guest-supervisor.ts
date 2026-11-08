import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type CursorOwner, currentCursorIdentity, currentCursorOwner } from "../computer/cursor-scope.js";
import { assertInputMayContinue, currentInputScope } from "../computer/input-scope.js";
import type { Point } from "../types/index.js";
import { GuestNativeInput } from "./guest-native-input.js";
import { type TartGuestTarget, TartGuestTransport, readTartGuestTarget } from "./tart-guest-transport.js";

export interface GuestRuntimeProcess {
	readonly output: AsyncIterable<unknown>;
	readonly exited: Promise<number | null>;
	stop(): void;
}

interface GuestInput {
	readonly size: { readonly width: number; readonly height: number };
	beginPointerSequence?(): void;
	clickSequence?(steps: readonly PointerStep[]): Promise<void>;
	pointer(x: number, y: number, buttons: number): Promise<void>;
	key(keysym: number, down: boolean): Promise<void>;
	close(): void;
}

interface GuestCursor {
	readonly owner: CursorOwner;
	readonly x: number;
	readonly y: number;
}

interface PointerStep extends Point {
	readonly buttons: number;
}

type MouseButton = "left" | "middle" | "right";

export interface GuestSupervisorDependencies {
	start(target: TartGuestTarget): GuestRuntimeProcess;
	connect(directory: string, owner: CursorOwner): Promise<GuestInput>;
}

export class TartGuestSupervisor {
	private input: GuestInput | undefined;
	private reconnectInput: (() => Promise<GuestInput>) | undefined;
	private stopped = false;
	private closing = false;
	private closeResult: Promise<void> | undefined;
	private failed = false;
	private tail: Promise<void> = Promise.resolve();
	private readonly cursors = new Map<string, GuestCursor>();

	private constructor(
		readonly owner: CursorOwner,
		private readonly target: TartGuestTarget,
		private readonly runtime: GuestRuntimeProcess,
		/** Joined a guest another session started: it never stops that runtime. */
		private readonly attached = false,
	) {
		Object.freeze(this.owner);
	}

	static async start(
		directory: string,
		owner: CursorOwner,
		dependencies: Partial<GuestSupervisorDependencies> = {},
		options: { readonly attach?: boolean } = {},
	): Promise<TartGuestSupervisor> {
		const target = await readTartGuestTarget(directory, owner);
		assertInputMayContinue(currentInputScope());
		const attach = options.attach === true;
		const running = (attach || dependencies.connect === undefined) && (await socketExists(target));
		// Joining is opt-in: by default a running guest may belong to a runtime this server cannot vouch for.
		if (running && !attach)
			throw new Error("The owned VM already has a control socket; refuse to attach to another runtime.");
		const runtime = running ? attachedRuntime() : (dependencies.start ?? startRuntime)(target);
		const supervisor = new TartGuestSupervisor({ ...owner }, target, runtime, running);
		const abort = new AbortController();
		const timeout = setTimeout(() => abort.abort(new Error("Owned VM input startup timed out.")), 180_000);
		const markExited = () => {
			supervisor.stopped = true;
			supervisor.reconnectInput = undefined;
			supervisor.input?.close();
			abort.abort(new Error("Owned VM exited."));
		};
		const exited = runtime.exited.then(
			(code) => {
				markExited();
				throw new Error(`Owned VM exited before input was ready (${String(code)}).`);
			},
			() => {
				markExited();
				throw new Error("Owned VM process failed.");
			},
		);
		// Drain without interpreting or publishing runtime output.
		void (async () => {
			for await (const _chunk of runtime.output) {
				/* drained */
			}
		})().catch(() => {
			if (!supervisor.stopped) runtime.stop();
		});
		supervisor.reconnectInput = () =>
			dependencies.connect === undefined
				? connectGuest(directory, owner, abort.signal)
				: dependencies.connect(directory, owner);
		const connecting = (async () => {
			if (dependencies.connect === undefined && !running) await waitForSocket(target, abort.signal);
			let input: GuestInput | undefined;
			while (input === undefined) {
				abort.signal.throwIfAborted();
				assertInputMayContinue(currentInputScope());
				if (supervisor.reconnectInput === undefined) throw new Error("Owned VM stopped during input startup.");
				try {
					input = await supervisor.reconnectInput();
				} catch (error) {
					// The host socket exists before the guest agent finishes booting, and the agent answers before the
					// login session has a display to capture; both clear on their own within the startup timeout.
					if (!(error instanceof Error) || !GUEST_BOOTING.test(error.message)) throw error;
					await delay(250, undefined, { signal: abort.signal });
				}
			}
			if (input === undefined) throw new Error("Owned VM stopped during input startup.");
			if (abort.signal.aborted || supervisor.closing || supervisor.stopped) {
				input.close();
				throw new Error("Owned VM stopped during input startup.");
			}
			supervisor.input = input;
			assertInputMayContinue(currentInputScope());
		})();
		try {
			await Promise.race([connecting, exited]);
			return supervisor;
		} catch (error) {
			supervisor.failed = true;
			abort.abort(error);
			await supervisor.close();
			throw error;
		} finally {
			clearTimeout(timeout);
		}
	}

	status() {
		return {
			owner: this.owner,
			running: !this.stopped,
			closing: this.closing,
			inputAvailable: !this.stopped && !this.closing && !this.failed && this.input !== undefined,
			display: this.input?.size,
			cursors: [...this.cursors.entries()].map(([id, cursor]) => ({ id, ...cursor })),
		};
	}

	refreshDisplay(): Promise<void> {
		return this.perform(async (input) => {
			if (this.reconnectInput === undefined) throw new Error("Owned VM input is not ready.");
			const replacement = await this.reconnectInput();
			if (this.stopped || this.closing || this.failed) {
				replacement.close();
				throw new Error("Owned VM stopped during display refresh.");
			}
			if (input.size.width !== replacement.size.width || input.size.height !== replacement.size.height) {
				this.cursors.clear();
			}
			input.close();
			this.input = replacement;
		});
	}

	move(x: number, y: number): Promise<void> {
		return this.pointerSequence([{ x, y, buttons: 0 }]);
	}

	click(x: number, y: number, button: MouseButton = "left", count: 1 | 2 = 1): Promise<void> {
		const buttons = buttonMask(button);
		if (buttons === undefined || (count !== 1 && count !== 2))
			return Promise.reject(new Error("Invalid guest click."));
		const events = Array.from({ length: count }, () => [
			{ x, y, buttons },
			{ x, y, buttons: 0 },
		]).flat();
		return this.pointerSequence(events, true);
	}

	scroll(x: number, y: number, direction: "up" | "down" | "left" | "right", steps: number): Promise<void> {
		const buttons = { up: 8, down: 16, left: 32, right: 64 }[direction];
		if (!Number.isSafeInteger(buttons) || !Number.isSafeInteger(steps) || steps < 1 || steps > 100)
			return Promise.reject(new Error("Invalid guest scroll."));
		const events = Array.from({ length: steps }, () => [
			{ x, y, buttons },
			{ x, y, buttons: 0 },
		]).flat();
		return this.pointerSequence(events);
	}

	drag(points: readonly Point[], button: MouseButton = "left"): Promise<void> {
		const buttons = buttonMask(button);
		const last = points.at(-1);
		if (buttons === undefined || points.length < 2 || points.length > 256 || last === undefined)
			return Promise.reject(new Error("Invalid guest drag."));
		// One guest script per drag, with samples at most DRAG_SAMPLE_PIXELS apart: AppKit selection tracking ignores a
		// press and a few far jumps that arrive as separate processes hundreds of milliseconds apart.
		const path: PointerStep[] = [];
		for (const [index, point] of points.entries()) {
			const previous = points[index - 1];
			if (previous !== undefined) {
				const segments = Math.ceil(Math.hypot(point.x - previous.x, point.y - previous.y) / DRAG_SAMPLE_PIXELS);
				for (let step = 1; step < segments; step++) {
					path.push({
						x: Math.round(previous.x + ((point.x - previous.x) * step) / segments),
						y: Math.round(previous.y + ((point.y - previous.y) * step) / segments),
						buttons,
					});
				}
			}
			path.push({ x: point.x, y: point.y, buttons });
		}
		if (path.length > MAX_DRAG_STEPS) return Promise.reject(new Error("Guest drag path is too long."));
		return this.pointerSequence([...path, { x: last.x, y: last.y, buttons: 0 }], true);
	}

	key(keysym: number): Promise<void> {
		return this.chord([keysym]);
	}

	chord(keysyms: readonly number[]): Promise<void> {
		const keys = [...keysyms];
		if (
			keys.length === 0 ||
			keys.length > 8 ||
			new Set(keys).size !== keys.length ||
			keys.some((key) => !Number.isSafeInteger(key) || key < 0 || key > 0xffffffff)
		) {
			return Promise.reject(new Error("Invalid guest key chord."));
		}
		return this.perform((input) => pressChord(input, keys));
	}

	paste(text: string, transport: TartGuestTransport): Promise<void> {
		if (!transport.matches(this.target)) {
			return Promise.reject(new Error("Clipboard and input must belong to the same isolated guest."));
		}
		return this.perform(async (input) => {
			const script = `ObjC.import("AppKit");
const board = $.NSPasteboard.generalPasteboard;
board.clearContents;
if (!board.setStringForType($(${JSON.stringify(text)}), $.NSPasteboardTypeString))
	throw new Error("Guest clipboard write failed.");`;
			await transport.execute(["/usr/bin/osascript", "-l", "JavaScript"], script);
			await pressChord(input, [0xffe7, 0x76]);
		});
	}

	close(): Promise<void> {
		if (this.closeResult !== undefined) return this.closeResult;
		this.closing = true;
		this.closeResult = (async () => {
			await this.tail;
			this.input?.close();
			this.reconnectInput = undefined;
			if (this.attached) return;
			if (!this.stopped) this.runtime.stop();
			let timeout: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					this.runtime.exited,
					new Promise<never>((_resolve, reject) => {
						timeout = setTimeout(() => reject(new Error("Owned VM shutdown timed out.")), 10_000);
					}),
				]);
			} finally {
				if (timeout !== undefined) clearTimeout(timeout);
			}
		})();
		return this.closeResult;
	}

	private perform(action: (input: GuestInput, owner: CursorOwner, cursorId: string) => Promise<void>): Promise<void> {
		const owner = currentCursorOwner() ?? this.owner;
		const cursorId = currentCursorIdentity() ?? this.owner.sessionId;
		const scope = currentInputScope();
		if (
			owner.sessionId !== this.owner.sessionId ||
			(owner.agentName !== this.owner.agentName && owner.parentAgentName !== this.owner.agentName)
		) {
			return Promise.reject(new Error("This agent does not own the isolated desktop session."));
		}
		const result = this.tail.then(async () => {
			if (this.stopped || this.closing || this.failed || this.input === undefined)
				throw new Error("Owned VM input is closed.");
			assertInputMayContinue(scope);
			await action(this.input, owner, cursorId);
		});
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private pointerSequence(events: readonly PointerStep[], atomicClick = false): Promise<void> {
		const steps = events.map(({ x, y, buttons }) => ({ x, y, buttons }));
		return this.perform(async (input, owner, id) => {
			if (
				steps.some(
					({ x, y }) =>
						!Number.isSafeInteger(x) ||
						!Number.isSafeInteger(y) ||
						x < 0 ||
						y < 0 ||
						x >= input.size.width ||
						y >= input.size.height,
				)
			) {
				throw new Error("Guest pointer path is outside the observed display.");
			}
			if (atomicClick && input.clickSequence !== undefined) {
				await input.clickSequence(steps);
				const last = steps.at(-1);
				if (last !== undefined) this.cursors.set(id, { owner, x: last.x, y: last.y });
				return;
			}
			let held = 0;
			let last: PointerStep | undefined;
			input.beginPointerSequence?.();
			try {
				for (const step of steps) {
					assertInputMayContinue(currentInputScope());
					last = step;
					if (step.buttons !== 0) held = step.buttons;
					await input.pointer(step.x, step.y, step.buttons);
					held = step.buttons;
				}
			} finally {
				if (held !== 0 && last !== undefined) await input.pointer(last.x, last.y, 0);
			}
			if (last !== undefined) this.cursors.set(id, { owner, x: last.x, y: last.y });
		});
	}
}

const GUEST_BOOTING = /GRPCConnectionPoolError|could not create image from display/;
const DRAG_SAMPLE_PIXELS = 24;
const MAX_DRAG_STEPS = 511;

function buttonMask(button: MouseButton): number | undefined {
	if (button === "left") return 1;
	if (button === "middle") return 2;
	if (button === "right") return 4;
	return undefined;
}

async function pressChord(input: GuestInput, keysyms: readonly number[]): Promise<void> {
	const pressed: number[] = [];
	const errors: unknown[] = [];
	try {
		for (const key of keysyms) {
			assertInputMayContinue(currentInputScope());
			pressed.push(key);
			await input.key(key, true);
		}
	} catch (error) {
		errors.push(error);
	} finally {
		for (const key of pressed.reverse()) {
			try {
				await input.key(key, false);
			} catch (error) {
				errors.push(error);
			}
		}
	}
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, "Guest key chord failed.");
}

/** A guest runtime owned by another session: no output to drain, no exit to observe, nothing to stop. */
function attachedRuntime(): GuestRuntimeProcess {
	return {
		output: (async function* () {})(),
		exited: new Promise<number | null>(() => undefined),
		stop(): void {},
	};
}

function startRuntime(target: TartGuestTarget): GuestRuntimeProcess {
	const child = spawn(target.executable, ["run", target.vm, ...target.runArguments], {
		env: { HOME: homedir(), PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TART_HOME: target.store },
		stdio: ["ignore", "pipe", "ignore"],
	});
	return {
		output: child.stdout,
		exited: new Promise((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", resolve);
		}),
		stop(): void {
			child.kill("SIGINT");
		},
	};
}

async function socketExists(target: TartGuestTarget): Promise<boolean> {
	return await new Promise<boolean>((resolve, reject) => {
		const socket = createConnection({ path: join(target.store, "vms", target.vm, "control.sock") });
		socket.setTimeout(1000, () => {
			socket.destroy();
			reject(new Error("Owned VM control socket probe timed out."));
		});
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", (error: NodeJS.ErrnoException) => {
			socket.destroy();
			if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolve(false);
			else reject(error);
		});
	});
}

async function waitForSocket(target: TartGuestTarget, signal: AbortSignal): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const watcher = watch(join(target.store, "vms", target.vm), { signal });
		const finish = (error?: unknown) => {
			watcher.close();
			signal.removeEventListener("abort", aborted);
			if (error === undefined) resolve();
			else reject(error);
		};
		const aborted = () => finish(signal.reason);
		const check = () => {
			void socketExists(target).then((ready) => {
				if (ready) finish();
			}, finish);
		};
		watcher.on("change", check);
		watcher.on("error", finish);
		signal.addEventListener("abort", aborted, { once: true });
		if (signal.aborted) aborted();
		else check();
	});
}

async function connectGuest(directory: string, owner: CursorOwner, signal: AbortSignal): Promise<GuestInput> {
	const transport = await TartGuestTransport.open(directory, owner, undefined, signal);
	try {
		const screenshot = await transport.screenshot();
		const size = { width: screenshot.width, height: screenshot.height };
		const native = new GuestNativeInput(transport);
		await native.checkPermissions();
		return {
			size,
			beginPointerSequence: () => native.beginPointerSequence(),
			clickSequence: (steps) => native.pointers(steps, size.width, size.height),
			pointer: (x, y, buttons) => native.pointer(x, y, buttons, size.width, size.height),
			key: (keysym, down) => native.key(keysym, down),
			close: () => transport.close(),
		};
	} catch (error) {
		transport.close();
		throw error;
	}
}
