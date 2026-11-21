import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Mock } from "bun:test";
import type { SpaceCommand, SpaceRecord } from "@opencua/core/light";
import { vi } from "@opencua/test-support";
import { Command } from "commander";
import { type RunningSpace, type SpaceOperations, type SpaceSize, registerSpaceCommands } from "./space-commands.js";

const space: SpaceRecord = {
	id: "a1b2c3d4",
	displayId: 7,
	bounds: { x: 3008, y: 0, width: 1920, height: 1080 },
	pid: 4242,
	createdAt: "2026-11-21T09:00:00.000Z",
	takenOver: false,
};
const other: SpaceRecord = { ...space, id: "e5f6a7b8", displayId: 8 };

class FakeOperations implements SpaceOperations {
	spaces: readonly SpaceRecord[] = [];
	readonly launched: SpaceSize[] = [];
	readonly sent: (readonly [string, SpaceCommand])[] = [];
	runSpace: () => Promise<RunningSpace> = async () => {
		throw new Error("run is not configured");
	};

	async run(): Promise<RunningSpace> {
		return await this.runSpace();
	}

	async launch(size: SpaceSize): Promise<SpaceRecord> {
		this.launched.push(size);
		return space;
	}

	list(): readonly SpaceRecord[] {
		return this.spaces;
	}

	async send(id: string, command: SpaceCommand): Promise<void> {
		this.sent.push([id, command]);
	}
}

let operations: FakeOperations;
let stdout: Mock<typeof process.stdout.write>;

function program(): Command {
	const root = new Command()
		.option("--json")
		.exitOverride()
		.configureOutput({ writeErr: () => undefined });
	registerSpaceCommands(root, {
		isJsonOutput: () => root.opts<{ json?: boolean }>().json === true,
		stateDir: "/nonexistent/opencua-state",
		entryScript: "/nonexistent/cli.js",
		operations,
	});
	return root;
}

async function run(...args: string[]): Promise<string> {
	await program().parseAsync(args, { from: "user" });
	return stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
}

beforeEach(() => {
	operations = new FakeOperations();
	stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = undefined;
});

describe("#given space start #when sizes are given or omitted #then the launched space gets them", () => {
	it("launches 1920x1080 by default and prints the record as JSON", async () => {
		const output = await run("--json", "space", "start");

		expect(operations.launched).toEqual([{ width: 1920, height: 1080 }]);
		expect(JSON.parse(output)).toEqual(space);
	});

	it("passes a custom size through", async () => {
		await run("space", "start", "--width", "2560", "--height", "1440");

		expect(operations.launched).toEqual([{ width: 2560, height: 1440 }]);
	});

	it.each([
		["--width", "100"],
		["--height", "1.5"],
	])("refuses %s %s before launching", async (flag, value) => {
		await expect(run("space", "start", flag, value)).rejects.toThrow(flag);
		expect(operations.launched).toEqual([]);
	});
});

describe("#given running spaces #when a control command names none or one #then it reaches the right space", () => {
	it.each(["stop", "takeover", "resume"] as const)("sends %s to the only running space", async (command) => {
		operations.spaces = [space];

		const output = await run("--json", "space", command);

		expect(operations.sent).toEqual([[space.id, command]]);
		expect(JSON.parse(output)).toEqual({ ok: true, id: space.id, command });
	});

	it("sends to the named space among several", async () => {
		operations.spaces = [space, other];

		await run("space", "takeover", other.id);

		expect(operations.sent).toEqual([[other.id, "takeover"]]);
	});

	it.each([
		["no space runs", [], [], "no virtual space is running"],
		["several run and none is named", [space, other], [], `${space.id}, ${other.id}`],
		["the named space is not running", [space], ["e5f6a7b8"], "no running virtual space e5f6a7b8"],
	] as const)("refuses when %s", async (_label, spaces, ids, message) => {
		operations.spaces = spaces;

		await expect(run("space", "stop", ...ids)).rejects.toThrow(message);
		expect(operations.sent).toEqual([]);
	});
});

describe("#given space status #when spaces run or not #then it lists them", () => {
	it("lists every running space as JSON", async () => {
		operations.spaces = [space, other];

		expect(JSON.parse(await run("--json", "space", "status"))).toEqual([space, other]);
	});
});

describe("#given space run #when the space starts or fails #then it reports one JSON line", () => {
	it("prints the record, stops the space on SIGTERM and returns once it has exited", async () => {
		const stops: string[] = [];
		let exit: () => void = () => undefined;
		const exited = new Promise<void>((resolve) => {
			exit = resolve;
		});
		operations.runSpace = async () => ({
			record: space,
			stop: () => {
				stops.push("stop");
				exit();
			},
			exited,
		});
		const printed = new Promise<void>((resolve) => {
			stdout.mockImplementation(() => {
				resolve();
				return true;
			});
		});

		const finished = run("space", "run");
		await printed;
		process.emit("SIGTERM");

		expect(JSON.parse(await finished)).toEqual(space);
		expect(stops).toEqual(["stop"]);
	});

	it("prints the failure as JSON and exits non-zero", async () => {
		operations.runSpace = async () => {
			throw new Error("virtual space unavailable (unsupported): no CGVirtualDisplay");
		};

		const output = await run("space", "run");

		expect(JSON.parse(output)).toEqual({ error: "virtual space unavailable (unsupported): no CGVirtualDisplay" });
		expect(process.exitCode).toBe(1);
	});
});
