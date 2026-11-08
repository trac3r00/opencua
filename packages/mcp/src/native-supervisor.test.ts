import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const launcherSource = fileURLToPath(new URL("../../../scripts/tcc-helper-launcher.m", import.meta.url));
const UNKNOWN_OUTCOME =
	"opencua restarted while this call ran; its outcome is unknown. Observe again before acting and never replay it.";

// A stand-in MCP server: answers initialize, tools/list and tools/call with its pid, exits on the "crash" tool, and
// records every message it receives so the test can see what the supervisor forwarded or replayed.
const FAKE_SERVER = `
const fs = require("node:fs");
const log = process.env.FAKE_LOG;
if (process.argv.includes("--doctor")) {
	process.stdout.write(JSON.stringify({ permissions: {} }) + "\\n");
	process.exit(0);
}
fs.appendFileSync(log, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2) }) + "\\n");
const reply = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let index;
	while ((index = buffer.indexOf("\\n")) >= 0) {
		const message = JSON.parse(buffer.slice(0, index));
		buffer = buffer.slice(index + 1);
		fs.appendFileSync(log, JSON.stringify({ pid: process.pid, got: message }) + "\\n");
		if (message.method === "initialize") {
			reply({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {}, logging: {} }, serverInfo: { name: "fake", version: "0" } } });
		} else if (message.method === "tools/list") {
			reply({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] } });
		} else if (message.method === "tools/call" && message.params.name === "crash") {
			process.exit(3);
		} else if (message.method === "tools/call") {
			reply({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: String(process.pid) }] } });
		}
	}
});
`;

let scratch: string;
let launcher: string;
let server: string;

beforeAll(async () => {
	scratch = await mkdtemp(join(tmpdir(), "opencua-native-supervisor-"));
	const app = join(scratch, "opencua-mcp.app", "Contents");
	await mkdir(join(app, "MacOS"), { recursive: true });
	await mkdir(join(app, "Resources"), { recursive: true });
	await mkdir(join(scratch, "dist"), { recursive: true });
	launcher = join(app, "MacOS", "opencua-mcp");
	server = join(scratch, "dist", "server.js");
	await writeFile(server, FAKE_SERVER);
	await symlink(process.execPath, join(app, "Resources", "node"));
	const compile = Bun.spawn(
		[
			"clang",
			"-fobjc-arc",
			"-Wall",
			"-Werror",
			"-framework",
			"Foundation",
			"-framework",
			"CoreServices",
			launcherSource,
			"-o",
			launcher,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const [exitCode, stderr] = await Promise.all([compile.exited, new Response(compile.stderr).text()]);
	expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
}, 60_000);

afterAll(async () => {
	await rm(scratch, { recursive: true, force: true });
});

type Message = Record<string, unknown>;

function startLauncher(name: string, env: Record<string, string> = {}) {
	const log = join(scratch, `${name}.ndjson`);
	const child = Bun.spawn([launcher, server], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "ignore",
		// Supervision is on unless a case turns it off, whatever the runner's own environment says.
		env: { ...process.env, FAKE_LOG: log, OPENCUA_NOTIFICATIONS: "off", OPENCUA_SUPERVISOR: "on", ...env },
	});
	const received: Message[] = [];
	const waiters: { readonly match: (message: Message) => boolean; readonly resolve: (message: Message) => void }[] =
		[];
	void (async () => {
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of child.stdout) {
			buffer += decoder.decode(chunk);
			let index = buffer.indexOf("\n");
			while (index >= 0) {
				const message = JSON.parse(buffer.slice(0, index)) as Message;
				buffer = buffer.slice(index + 1);
				received.push(message);
				for (const waiter of waiters.splice(0)) {
					if (waiter.match(message)) waiter.resolve(message);
					else waiters.push(waiter);
				}
				index = buffer.indexOf("\n");
			}
		}
	})();
	const next = (match: (message: Message) => boolean) =>
		new Promise<Message>((resolve, reject) => {
			const seen = received.find(match);
			if (seen !== undefined) return resolve(seen);
			const timer = setTimeout(
				() => reject(new Error(`no matching message; got ${JSON.stringify(received)}`)),
				10_000,
			);
			waiters.push({
				match,
				resolve: (message) => {
					clearTimeout(timer);
					resolve(message);
				},
			});
		});
	const send = (message: Message) => {
		child.stdin.write(`${JSON.stringify(message)}\n`);
		child.stdin.flush();
	};
	const call = (id: number, method: string, params: Message = {}) => {
		send({ jsonrpc: "2.0", id, method, params });
		return next((message) => message["id"] === id);
	};
	const entries = async () =>
		(await readFile(log, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { pid: number; argv?: string[]; got?: Message });
	return { child, received, send, call, entries };
}

const initialize = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } };

describe("#given the helper launcher serving server.js #when a client talks to it #then it supervises without a second Node", () => {
	it("advertises listChanged, answers pings itself and runs the server as the only Node process", async () => {
		const session = startLauncher("basic");

		const initialized = await session.call(1, "initialize", initialize);
		const pong = await session.call(2, "ping");
		const echoed = await session.call(3, "tools/call", { name: "echo", arguments: {} });

		expect(initialized["result"]).toMatchObject({ capabilities: { tools: { listChanged: true }, logging: {} } });
		expect(pong).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
		const log = await session.entries();
		const started = log.filter((entry) => entry.argv !== undefined);
		expect(started.length).toBe(1);
		expect(started[0]?.argv).toEqual(["--supervised-child"]);
		expect(log.some((entry) => entry.got?.["method"] === "ping")).toBe(false);
		const pid = Number((echoed["result"] as { content: { text: string }[] }).content[0]?.text);
		const tree = await Bun.$`ps -axo pid=,ppid=,command=`.text();
		const servers = tree.split("\n").filter((line) => line.includes(server));
		// Stage one and the supervising stage are the launcher itself; the only other process is the server child.
		expect(
			servers
				.filter((line) => line.includes("--supervised-child"))
				.map((line) => Number(line.trim().split(/\s+/)[0])),
		).toEqual([pid]);
		expect(servers.length).toBe(3);

		session.child.stdin.end();
		expect(await session.child.exited).toBe(0);
		expect(() => process.kill(pid, 0)).toThrow();
	});

	it("fails a call cut off by a crash, restarts the server behind the same connection and replays initialize", async () => {
		const session = startLauncher("crash");
		await session.call(1, "initialize", initialize);
		session.send({ jsonrpc: "2.0", method: "notifications/initialized" });
		await session.call(2, "tools/list");
		const first = await session.call(3, "tools/call", { name: "echo", arguments: {} });

		const cut = await session.call(4, "tools/call", { name: "crash", arguments: {} });
		const after = await session.call(5, "tools/call", { name: "echo", arguments: {} });

		expect(cut["error"]).toEqual({ code: -32000, message: UNKNOWN_OUTCOME });
		const before = Number((first["result"] as { content: { text: string }[] }).content[0]?.text);
		const restarted = Number((after["result"] as { content: { text: string }[] }).content[0]?.text);
		expect(restarted).not.toBe(before);
		const replayed = (await session.entries()).filter((entry) => entry.pid === restarted && entry.got !== undefined);
		expect(replayed.map((entry) => [entry.got?.["method"], entry.got?.["id"]])).toEqual([
			["initialize", "opencua-supervisor-init-1"],
			["notifications/initialized", undefined],
			["tools/list", "opencua-supervisor-tools-1"],
			["tools/call", 5],
		]);
		// The restarted server lists the same tools, so the client is not told to list them again.
		expect(session.received.some((message) => message["method"] === "notifications/tools/list_changed")).toBe(false);

		session.child.stdin.end();
		expect(await session.child.exited).toBe(0);
	});

	it("serves directly with OPENCUA_SUPERVISOR=off, as server.ts does", async () => {
		const session = startLauncher("off", { OPENCUA_SUPERVISOR: "off" });

		await session.call(1, "initialize", initialize);

		expect((await session.entries()).find((entry) => entry.argv !== undefined)?.argv).toEqual([]);
		session.child.stdin.end();
		expect(await session.child.exited).toBe(0);
	});
});
