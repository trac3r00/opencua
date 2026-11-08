import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runInNewContext } from "node:vm";
import { vi, whenSettled } from "@opencua/test-support";

const boundary = vi.hoisted(() => ({ spawn: vi.fn(), connect: vi.fn(), ipc: vi.fn(), delay: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: boundary.spawn }));
vi.mock("node:timers/promises", () => ({ setTimeout: boundary.delay }));
vi.mock("node:net", () => ({
	createConnection: boundary.ipc,
	Socket: class {
		constructor() {
			throw new Error("A supervisor unit test attempted to open a real socket.");
		}
	},
}));

const { withCursorIdentity } = await import("../computer/cursor-scope.js");
const { runInInputScope } = await import("../computer/input-scope.js");

const { TartGuestSupervisor } = await import("./tart-guest-supervisor.js");
const { TartGuestTransport } = await import("./tart-guest-transport.js");

const owner = { agentName: "OmO", sessionId: "owned-session" };
const flags = ["--no-graphics", "--no-audio", "--no-clipboard", "--no-usb-accessories", "--net-host"];
const registry = {
	...owner,
	backend: "tart",
	store: "guest-store",
	vmName: "opencua-fixture",
	runArguments: flags,
	sharedDirectories: [],
	attachedHostDisks: [],
};
let directory: string;
let child: ReturnType<typeof fakeProcess>;
let channel: ReturnType<typeof fakeChannel>;
const supervisors: Awaited<ReturnType<typeof TartGuestSupervisor.start>>[] = [];

function fakeProcess() {
	const events = new EventEmitter();
	const stdout = new PassThrough();
	return Object.assign(events, {
		stdout,
		kill: vi.fn((_signal: string) => {
			stdout.end();
			events.emit("exit", 0);
			return true;
		}),
	});
}

function fakeChannel() {
	return {
		size: { width: 1024, height: 768 },
		pointer: vi.fn(async (_x: number, _y: number, _buttons: number) => undefined),
		key: vi.fn(async (_keysym: number, _down: boolean) => undefined),
		close: vi.fn(),
	};
}

function deferred<T>() {
	let complete: ((value: T) => void) | undefined;
	const promise = new Promise<T>((resolve) => {
		complete = resolve;
	});
	return {
		promise,
		resolve(value: T): void {
			if (complete === undefined) throw new Error("Deferred fixture was not initialized.");
			complete(value);
		},
	};
}

beforeEach(async () => {
	directory = await realpath(await mkdtemp(join(tmpdir(), "opencua-supervisor-")));
	await writeFile(join(directory, "ownership.json"), JSON.stringify(registry));
	child = fakeProcess();
	channel = fakeChannel();
	boundary.spawn.mockReset().mockReturnValue(child);
	boundary.connect.mockReset().mockResolvedValue(channel);
	boundary.delay.mockReset().mockResolvedValue(undefined);
	boundary.ipc.mockReset().mockImplementation(() => {
		throw new Error("Unexpected real IPC connection.");
	});
});

afterEach(async () => {
	for (const supervisor of supervisors.splice(0)) await supervisor.close();
	child.stdout.destroy();
	await rm(directory, { recursive: true, force: true });
});

describe("#given an owned VM supervisor #when it starts #then input and credentials stay in the owned guest channel", () => {
	it("keeps native click press and release in one guest transaction instead of creating a long press", async () => {
		const clickSequence = vi.fn(async () => undefined);
		boundary.connect.mockResolvedValueOnce({ ...channel, clickSequence });
		const supervisor = await TartGuestSupervisor.start(directory, owner, { connect: boundary.connect });
		supervisors.push(supervisor);
		await supervisor.click(20, 30, "left", 2);
		expect(clickSequence).toHaveBeenCalledWith([
			{ x: 20, y: 30, buttons: 1 },
			{ x: 20, y: 30, buttons: 0 },
			{ x: 20, y: 30, buttons: 1 },
			{ x: 20, y: 30, buttons: 0 },
		]);
		expect(channel.pointer).not.toHaveBeenCalled();
		expect(supervisor.status().cursors).toEqual([{ id: owner.sessionId, owner, x: 20, y: 30 }]);
	});

	it("waits for guest-agent readiness without retrying input or starting another VM", async () => {
		const entered = deferred<void>();
		const resume = deferred<void>();
		boundary.connect.mockRejectedValueOnce(new Error("GRPCConnectionPoolError"));
		boundary.delay.mockImplementationOnce(() => {
			entered.resolve(undefined);
			return resume.promise;
		});
		const starting = TartGuestSupervisor.start(directory, owner, { connect: boundary.connect });
		try {
			await entered.promise;
			expect(boundary.connect).toHaveBeenCalledTimes(1);
			expect(channel.pointer).not.toHaveBeenCalled();
			resume.resolve(undefined);
			const supervisor = await starting;
			supervisors.push(supervisor);
			expect(boundary.connect).toHaveBeenCalledTimes(2);
			expect(boundary.spawn).toHaveBeenCalledTimes(1);
		} finally {
			resume.resolve(undefined);
		}
	});

	it("waits while the booted guest has no display to capture yet, then starts", async () => {
		boundary.connect.mockRejectedValueOnce(
			new Error("Guest command failed (1): could not create image from display"),
		);

		const supervisor = await TartGuestSupervisor.start(directory, owner, { connect: boundary.connect });
		supervisors.push(supervisor);

		expect(boundary.connect).toHaveBeenCalledTimes(2);
		expect(boundary.delay).toHaveBeenCalledTimes(1);
		expect(boundary.spawn).toHaveBeenCalledTimes(1);
		expect(supervisor.status().inputAvailable).toBe(true);
	});

	it("refuses an already-running owned VM before starting another runtime", async () => {
		const socket = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), destroy: vi.fn() });
		boundary.ipc.mockImplementation(() => {
			queueMicrotask(() => socket.emit("connect"));
			return socket;
		});
		await expect(TartGuestSupervisor.start(directory, owner)).rejects.toThrow("already has a control socket");
		expect(boundary.spawn).not.toHaveBeenCalled();
		expect(socket.destroy).toHaveBeenCalledOnce();
		expect(boundary.ipc).toHaveBeenCalledWith({
			path: join(directory, "guest-store/vms/opencua-fixture/control.sock"),
		});
	});

	it("joins an already-running owned VM only when attaching was asked for, and never stops it", async () => {
		const socket = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), destroy: vi.fn() });
		boundary.ipc.mockImplementation(() => {
			queueMicrotask(() => socket.emit("connect"));
			return socket;
		});

		const supervisor = await TartGuestSupervisor.start(
			directory,
			owner,
			{ connect: boundary.connect },
			{ attach: true },
		);
		await supervisor.click(5, 6);
		await supervisor.close();

		expect(boundary.spawn).not.toHaveBeenCalled();
		expect(child.kill).not.toHaveBeenCalled();
		expect(channel.pointer).toHaveBeenCalledWith(5, 6, 1);
		expect(channel.close).toHaveBeenCalled();
	});

	it("forces headless isolation flags and attributes a child's cursor without exposing credentials", async () => {
		const supervisor = await TartGuestSupervisor.start(directory, owner, { connect: boundary.connect });
		supervisors.push(supervisor);
		expect(boundary.spawn).toHaveBeenCalledWith(
			join(directory, "tart.app/Contents/MacOS/tart"),
			["run", "opencua-fixture", ...flags],
			{
				env: {
					HOME: expect.any(String),
					PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
					TART_HOME: join(directory, "guest-store"),
				},
				stdio: ["ignore", "pipe", "ignore"],
			},
		);
		expect(boundary.connect).toHaveBeenCalledWith(directory, owner);
		const reader = { agentName: "Reader", parentAgentName: "OmO", sessionId: owner.sessionId };
		await withCursorIdentity("reader-cursor", () => supervisor.click(20, 30), reader);
		expect(channel.pointer.mock.calls).toEqual([
			[20, 30, 1],
			[20, 30, 0],
		]);
		expect(supervisor.status().cursors).toEqual([{ id: "reader-cursor", owner: reader, x: 20, y: 30 }]);
		expect(JSON.stringify(supervisor.status())).not.toContain("fixture-secret");
	});

	it("rejects foreign ownership without sending a guest event", async () => {
		const supervisor = await TartGuestSupervisor.start(directory, owner, { connect: boundary.connect });
		supervisors.push(supervisor);
		const foreign = { agentName: "OmO", sessionId: "other-session" };
		const request = withCursorIdentity("foreign", () => supervisor.click(20, 30), foreign);
		await expect(request).rejects.toThrow(/does not own/);
		expect(channel.pointer).not.toHaveBeenCalled();
	});

	it("routes right and middle clicks, wheel steps and drag releases to the guest", async () => {
		const supervisor = await TartGuestSupervisor.start(directory, owner, { connect: boundary.connect });
		supervisors.push(supervisor);
		await supervisor.click(20, 30, "right", 2);
		expect(channel.pointer.mock.calls).toEqual([
			[20, 30, 4],
			[20, 30, 0],
			[20, 30, 4],
			[20, 30, 0],
		]);
		channel.pointer.mockClear();
		await supervisor.click(20, 30, "middle");
		expect(channel.pointer.mock.calls).toEqual([
			[20, 30, 2],
			[20, 30, 0],
		]);
		channel.pointer.mockClear();
		await supervisor.scroll(20, 30, "down", 2);
		expect(channel.pointer.mock.calls).toEqual([
			[20, 30, 16],
			[20, 30, 0],
			[20, 30, 16],
			[20, 30, 0],
		]);
		channel.pointer.mockClear();
		await supervisor.drag([
			{ x: 10, y: 20 },
			{ x: 100, y: 200 },
		]);
		// A 201-pixel drag is sampled every 20 pixels so guest tracking loops see a continuous path.
		expect(channel.pointer.mock.calls).toEqual([
			...Array.from({ length: 10 }, (_, index): [number, number, number] => [10 + 10 * index, 20 + 20 * index, 1]),
			[100, 200, 0],
		]);
	});

	it("validates the whole pointer path before pressing a button", async () => {
		const supervisor = await TartGuestSupervisor.start(directory, owner, { connect: boundary.connect });
		supervisors.push(supervisor);
		await expect(
			supervisor.drag([
				{ x: 10, y: 20 },
				{ x: -1, y: 20 },
			]),
		).rejects.toThrow(/outside/);
		await expect(Reflect.apply(supervisor.scroll, supervisor, [10, 20, "constructor", 1])).rejects.toThrow(
			/Invalid guest scroll/,
		);
		expect(channel.pointer).not.toHaveBeenCalled();
	});

	it("releases a drag at its last dispatched point when stopped", async () => {
		const supervisor = await TartGuestSupervisor.start(directory, owner, { connect: boundary.connect });
		supervisors.push(supervisor);
		let stopped = false;
		channel.pointer.mockImplementation(async (_x, _y, buttons) => {
			if (buttons !== 0) stopped = true;
			return undefined;
		});
		const scope = { interruption: () => (stopped ? "fixture stop" : undefined) };
		const points = [
			{ x: 10, y: 20 },
			{ x: 100, y: 200 },
		];
		await expect(runInInputScope(scope, () => supervisor.drag(points))).rejects.toThrow("fixture stop");
		expect(channel.pointer.mock.calls).toEqual([
			[10, 20, 1],
			[10, 20, 0],
		]);
	});

	it("snapshots queued key and pointer data instead of observing later caller mutations", async () => {
		const supervisor = await TartGuestSupervisor.start(directory, owner, { connect: boundary.connect });
		supervisors.push(supervisor);
		const entered = deferred<void>();
		const gate = deferred<void>();
		channel.pointer.mockImplementationOnce(async () => {
			entered.resolve(undefined);
			await gate.promise;
			return undefined;
		});
		const first = supervisor.move(1, 2);
		await entered.promise;
		try {
			const keys = [0xffe7, 0x76];
			const chord = supervisor.chord(keys);
			keys[1] = 0x71;
			const end = { x: 30, y: 40 };
			const drag = supervisor.drag([{ x: 10, y: 20 }, end]);
			end.x = 99;
			gate.resolve(undefined);
			await Promise.all([first, chord, drag]);
			expect(channel.key.mock.calls).toEqual([
				[0xffe7, true],
				[0x76, true],
				[0x76, false],
				[0xffe7, false],
			]);
			expect(channel.pointer.mock.calls).toEqual([
				[1, 2, 0],
				[10, 20, 1],
				[20, 30, 1],
				[30, 40, 1],
				[30, 40, 0],
			]);
		} finally {
			gate.resolve(undefined);
		}
	});

	it("refreshes boot-time display geometry and discards stale cursor coordinates", async () => {
		const supervisor = await TartGuestSupervisor.start(directory, owner, { connect: boundary.connect });
		supervisors.push(supervisor);
		await supervisor.move(20, 30);
		const replacement = fakeChannel();
		replacement.size.width = 2048;
		replacement.size.height = 1536;
		boundary.connect.mockResolvedValueOnce(replacement);
		await supervisor.refreshDisplay();
		expect(channel.close).toHaveBeenCalledTimes(1);
		expect(supervisor.status().display).toEqual({ width: 2048, height: 1536 });
		expect(supervisor.status().cursors).toEqual([]);
		await supervisor.click(1024, 804);
		expect(replacement.pointer.mock.calls).toEqual([
			[1024, 804, 1],
			[1024, 804, 0],
		]);
	});

	it("stops its exact runtime when the private guest channel refuses connection", async () => {
		boundary.connect.mockRejectedValueOnce(new Error("guest channel refused"));
		const request = TartGuestSupervisor.start(directory, owner, { connect: boundary.connect });
		await expect(request).rejects.toThrow("guest channel refused");
		expect(boundary.connect).toHaveBeenCalledTimes(1);
		expect(child.kill).toHaveBeenCalledWith("SIGINT");
	});

	it("closes a replacement input channel if the VM exits during display refresh", async () => {
		const supervisor = await TartGuestSupervisor.start(directory, owner, { connect: boundary.connect });
		supervisors.push(supervisor);
		const connection = deferred<ReturnType<typeof fakeChannel>>();
		const entered = deferred<void>();
		boundary.connect.mockImplementationOnce(() => {
			entered.resolve(undefined);
			return connection.promise;
		});
		const refreshing = supervisor.refreshDisplay();
		await entered.promise;
		const rejected = whenSettled(refreshing, (settled) =>
			expect(settled).rejects.toThrow(/stopped during display refresh/),
		);
		child.stdout.end();
		child.emit("exit", 0);
		const replacement = fakeChannel();
		connection.resolve(replacement);
		await rejected;
		expect(replacement.close).toHaveBeenCalledTimes(1);
		expect(supervisor.status().running).toBe(false);
	});

	it("rejects registry ownership before spawning any process", async () => {
		await expect(TartGuestSupervisor.start(directory, { ...owner, sessionId: "other" })).rejects.toThrow(/registry/);
		expect(boundary.spawn).not.toHaveBeenCalled();
	});

	it("releases the virtual key when a dispatch fails", async () => {
		const supervisor = await TartGuestSupervisor.start(directory, owner, { connect: boundary.connect });
		supervisors.push(supervisor);
		channel.key.mockRejectedValueOnce(new Error("synthetic write failure"));
		await expect(supervisor.key(0xff0d)).rejects.toThrow("synthetic write failure");
		expect(channel.key.mock.calls).toEqual([
			[0xff0d, true],
			[0xff0d, false],
		]);
	});

	it("attempts every modifier release even when one release fails", async () => {
		const supervisor = await TartGuestSupervisor.start(directory, owner, { connect: boundary.connect });
		supervisors.push(supervisor);
		channel.key.mockImplementation(async (keysym, down) => {
			if (keysym === 0x76 && !down) throw new Error("synthetic release failure");
			return undefined;
		});
		await expect(supervisor.chord([0xffe7, 0x76])).rejects.toThrow("synthetic release failure");
		expect(channel.key.mock.calls).toEqual([
			[0xffe7, true],
			[0x76, true],
			[0x76, false],
			[0xffe7, false],
		]);
	});

	it("rejects an invalid chord before pressing any key", async () => {
		const supervisor = await TartGuestSupervisor.start(directory, owner, { connect: boundary.connect });
		supervisors.push(supervisor);
		await expect(supervisor.chord([0xffe7, -1])).rejects.toThrow(/Invalid guest key chord/);
		expect(channel.key).not.toHaveBeenCalled();
	});

	it("releases a held modifier when the stop signal changes during a chord", async () => {
		const supervisor = await TartGuestSupervisor.start(directory, owner, { connect: boundary.connect });
		supervisors.push(supervisor);
		let stopped = false;
		channel.key.mockImplementation(async (_keysym, down) => {
			if (down) stopped = true;
			return undefined;
		});
		const scope = { interruption: () => (stopped ? "fixture stop" : undefined) };
		await expect(runInInputScope(scope, () => supervisor.chord([0xffe7, 0x76]))).rejects.toThrow("fixture stop");
		expect(channel.key.mock.calls).toEqual([
			[0xffe7, true],
			[0xffe7, false],
		]);
	});

	it("honors a stop before starting the owned runtime", async () => {
		const scope = { interruption: () => "fixture stop" };
		await expect(
			runInInputScope(scope, () => TartGuestSupervisor.start(directory, owner, { connect: boundary.connect })),
		).rejects.toThrow("fixture stop");
		expect(boundary.spawn).not.toHaveBeenCalled();
	});

	it("writes Unicode text only to the matching guest clipboard before its paste chord", async () => {
		const supervisor = await TartGuestSupervisor.start(directory, owner, { connect: boundary.connect });
		supervisors.push(supervisor);
		const writes: unknown[] = [];
		let clears = 0;
		const text = 'OmO 한글\n"; throw new Error("not code");';
		const transport = await TartGuestTransport.open(directory, owner, async (command) => {
			if (command.input === undefined) return Buffer.from("VirtualMac2,1\n");
			const bridge = Object.assign((value: unknown) => value, {
				NSPasteboardTypeString: "fixture-text",
				NSPasteboard: {
					generalPasteboard: {
						get clearContents() {
							clears++;
							return 0;
						},
						setStringForType(value: unknown, type: unknown) {
							writes.push({ value, type });
							return true;
						},
					},
				},
			});
			runInNewContext(command.input, { ObjC: { import: () => undefined }, $: bridge }, { timeout: 5_000 });
			return Buffer.alloc(0);
		});
		try {
			await supervisor.paste(text, transport);
			expect(clears).toBe(1);
			expect(writes).toEqual([{ value: text, type: "fixture-text" }]);
			expect(channel.key.mock.calls).toEqual([
				[0xffe7, true],
				[0x76, true],
				[0x76, false],
				[0xffe7, false],
			]);
		} finally {
			transport.close();
		}
	});

	it("rejects a clipboard transport for a different VM before any input", async () => {
		const supervisor = await TartGuestSupervisor.start(directory, owner, { connect: boundary.connect });
		supervisors.push(supervisor);
		await writeFile(join(directory, "ownership.json"), JSON.stringify({ ...registry, vmName: "opencua-other" }));
		const run = vi.fn(async () => Buffer.from("VirtualMac2,1\n"));
		const transport = await TartGuestTransport.open(directory, owner, run);
		try {
			await expect(supervisor.paste("fixture", transport)).rejects.toThrow(/same isolated guest/);
			expect(run).toHaveBeenCalledTimes(1);
			expect(channel.key).not.toHaveBeenCalled();
		} finally {
			transport.close();
		}
	});

	it("waits for its process exit and refuses new input after close", async () => {
		const supervisor = await TartGuestSupervisor.start(directory, owner, { connect: boundary.connect });
		supervisors.push(supervisor);
		await supervisor.close();
		await supervisor.close();
		expect(child.kill).toHaveBeenCalledTimes(1);
		expect(supervisor.status().running).toBe(false);
		await expect(supervisor.move(1, 2)).rejects.toThrow(/closed/);
	});

	it("shares one pending shutdown across concurrent close calls", async () => {
		const supervisor = await TartGuestSupervisor.start(directory, owner, { connect: boundary.connect });
		supervisors.push(supervisor);
		const stopping = deferred<void>();
		child.kill.mockImplementation(() => {
			stopping.resolve(undefined);
			return true;
		});
		const first = supervisor.close();
		const second = supervisor.close();
		try {
			expect(second).toBe(first);
			await stopping.promise;
			expect(supervisor.status()).toMatchObject({ running: true, closing: true, inputAvailable: false });
			expect(child.kill).toHaveBeenCalledTimes(1);
		} finally {
			child.stdout.end();
			child.emit("exit", 0);
			await Promise.all([first, second]);
		}
		expect(supervisor.status().running).toBe(false);
	});
});
