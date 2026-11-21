import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type Server, type Socket, createConnection, createServer } from "node:net";
import { join } from "node:path";

/**
 * A warm opencua process for the read commands. Every CLI run otherwise pays Node start-up, the core import and a cold
 * ScreenCaptureKit session (and, once installed, a second process inside the permitted helper). With `opencua daemon
 * start` running, those commands go over a same-user Unix socket to one long-lived process instead; without it, or on
 * any connection failure, they run in-process exactly as before. Input commands never go through the daemon.
 */

/** The command paths the daemon answers; everything else always runs in the CLI process. */
export const DAEMON_ROUTES: ReadonlySet<string> = new Set([
	"screenshot",
	"cursor",
	"screen",
	"windows list",
	"apps list",
	"apps state",
]);

const GLOBAL_FLAGS = new Set(["--json", "--no-cursor", "--background"]);
const GLOBAL_VALUE_OPTIONS = new Set(["--target-pid", "--target-bundle-id"]);
const HELP_FLAGS = new Set(["--help", "-h", "--version", "-V"]);

export const DAEMON_ENV = "OPENCUA_CLI_DAEMON";

export type DaemonRequest = {
	readonly argv: readonly string[];
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
};

export type DaemonResponse = { readonly stdout: string; readonly stderr: string; readonly exitCode: number };

export type DaemonStatus = { readonly pid: number; readonly startedAt: string };

export type DaemonPaths = { readonly socket: string; readonly token: string; readonly pid: string };

export function daemonPaths(stateDir: string): DaemonPaths {
	return {
		socket: join(stateDir, "cli-daemon.sock"),
		token: join(stateDir, "cli-daemon.token"),
		pid: join(stateDir, "cli-daemon.pid"),
	};
}

/** The routed command path ("apps state") for argv, or undefined when the command must run in-process. */
export function daemonRouteOf(argv: readonly string[]): string | undefined {
	if (argv.some((arg) => HELP_FLAGS.has(arg))) {
		return undefined;
	}
	const words: string[] = [];
	for (let index = 0; index < argv.length && words.length < 2; index += 1) {
		const arg = argv[index] ?? "";
		if (words.length === 0) {
			if (GLOBAL_FLAGS.has(arg) || arg.startsWith("--target-pid=") || arg.startsWith("--target-bundle-id=")) {
				continue;
			}
			if (GLOBAL_VALUE_OPTIONS.has(arg)) {
				index += 1;
				continue;
			}
			if (arg.startsWith("-")) {
				return undefined;
			}
			words.push(arg);
			continue;
		}
		if (!arg.startsWith("-")) {
			words.push(arg);
		}
	}
	const [command, subcommand] = words;
	if (command === undefined) {
		return undefined;
	}
	if (DAEMON_ROUTES.has(command)) {
		return command;
	}
	const path = `${command} ${subcommand ?? ""}`;
	return DAEMON_ROUTES.has(path) ? path : undefined;
}

export function requestEnv(env: NodeJS.ProcessEnv): Record<string, string> {
	const picked: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (key.startsWith("OPENCUA_") && value !== undefined) {
			picked[key] = value;
		}
	}
	return picked;
}

function tokensMatch(expected: string, received: unknown): boolean {
	if (typeof received !== "string") {
		return false;
	}
	const left = Buffer.from(expected);
	const right = Buffer.from(received);
	return left.length === right.length && timingSafeEqual(left, right);
}

function isRequest(value: unknown): value is DaemonRequest {
	if (typeof value !== "object" || value === null) return false;
	const argv = Reflect.get(value, "argv");
	const env = Reflect.get(value, "env");
	return (
		Array.isArray(argv) &&
		argv.every((arg) => typeof arg === "string") &&
		typeof Reflect.get(value, "cwd") === "string" &&
		typeof env === "object" &&
		env !== null &&
		Object.values(env).every((entry) => typeof entry === "string")
	);
}

function readMessage(socket: Socket, limitBytes: number): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let buffered = "";
		const onData = (chunk: Buffer): void => {
			buffered += chunk.toString("utf8");
			const newline = buffered.indexOf("\n");
			if (newline >= 0) {
				socket.off("data", onData);
				try {
					resolve(JSON.parse(buffered.slice(0, newline)));
				} catch (error: unknown) {
					reject(error);
				}
			} else if (buffered.length > limitBytes) {
				socket.off("data", onData);
				reject(new Error("daemon message too large"));
			}
		};
		socket.on("data", onData);
		socket.once("error", reject);
		socket.once("end", () => reject(new Error("daemon connection closed before a message")));
	});
}

export type DaemonServerOptions = {
	readonly socketPath: string;
	readonly token: string;
	readonly startedAt: string;
	execute(request: DaemonRequest): Promise<DaemonResponse>;
	onStop(): void;
};

const REQUEST_LIMIT_BYTES = 1024 * 1024;

/**
 * Serves read requests one at a time (the host computer it reuses is not reentrant). A request without the per-start
 * token is refused before anything runs.
 */
export function startDaemonServer(options: DaemonServerOptions): Promise<Server> {
	let queue: Promise<unknown> = Promise.resolve();
	const server = createServer((socket) => {
		const reply = (message: unknown): void => {
			socket.end(`${JSON.stringify(message)}\n`);
		};
		readMessage(socket, REQUEST_LIMIT_BYTES).then(
			(message) => {
				if (
					typeof message !== "object" ||
					message === null ||
					!tokensMatch(options.token, Reflect.get(message, "token"))
				) {
					reply({ error: "unauthorized" });
					return;
				}
				const control = Reflect.get(message, "control");
				if (control === "status") {
					reply({ status: { pid: process.pid, startedAt: options.startedAt } });
					return;
				}
				if (control === "stop") {
					reply({ stopped: true });
					options.onStop();
					return;
				}
				const request = Reflect.get(message, "request");
				if (!isRequest(request) || daemonRouteOf(request.argv) === undefined) {
					reply({ error: "not-routable" });
					return;
				}
				const run = queue.then(() => options.execute(request));
				queue = run.catch(() => undefined);
				run.then(
					(response) => reply({ response }),
					(error: unknown) =>
						reply({
							response: {
								stdout: "",
								stderr: `${error instanceof Error ? error.message : String(error)}\n`,
								exitCode: 1,
							},
						}),
				);
			},
			() => socket.destroy(),
		);
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.socketPath, () => {
			server.off("error", reject);
			resolve(server);
		});
	});
}

type ClientOptions = { readonly connectTimeoutMs?: number; readonly responseTimeoutMs?: number };

async function exchange(paths: DaemonPaths, message: object, options: ClientOptions = {}): Promise<unknown> {
	if (!existsSync(paths.socket) || !existsSync(paths.token)) {
		return undefined;
	}
	const token = readFileSync(paths.token, "utf8").trim();
	return await new Promise((resolve) => {
		const socket = createConnection(paths.socket);
		let settled = false;
		const finish = (value: unknown): void => {
			if (!settled) {
				settled = true;
				clearTimeout(connectTimer);
				clearTimeout(responseTimer);
				socket.destroy();
				resolve(value);
			}
		};
		const connectTimer = setTimeout(() => finish(undefined), options.connectTimeoutMs ?? 250);
		let responseTimer: ReturnType<typeof setTimeout> | undefined;
		socket.once("error", () => finish(undefined));
		socket.once("connect", () => {
			clearTimeout(connectTimer);
			responseTimer = setTimeout(() => finish(undefined), options.responseTimeoutMs ?? 120_000);
			socket.write(`${JSON.stringify({ ...message, token })}\n`);
			readMessage(socket, Number.POSITIVE_INFINITY).then(finish, () => finish(undefined));
		});
	});
}

/**
 * Runs a routed read command in the daemon. Undefined means "run it here": no daemon, an unroutable command, or any
 * failure to get an answer (a read is safe to repeat in-process).
 */
export async function forwardToDaemon(
	argv: readonly string[],
	context: { readonly stateDir: string; readonly cwd: string; readonly env: NodeJS.ProcessEnv },
	options: ClientOptions = {},
): Promise<DaemonResponse | undefined> {
	if (context.env[DAEMON_ENV] === "off" || daemonRouteOf(argv) === undefined) {
		return undefined;
	}
	const request: DaemonRequest = { argv: [...argv], cwd: context.cwd, env: requestEnv(context.env) };
	const answer = await exchange(daemonPaths(context.stateDir), { request }, options);
	const response = typeof answer === "object" && answer !== null ? Reflect.get(answer, "response") : undefined;
	if (
		typeof response === "object" &&
		response !== null &&
		typeof Reflect.get(response, "stdout") === "string" &&
		typeof Reflect.get(response, "stderr") === "string" &&
		typeof Reflect.get(response, "exitCode") === "number"
	) {
		return response as DaemonResponse;
	}
	return undefined;
}

export async function daemonStatus(stateDir: string): Promise<DaemonStatus | undefined> {
	const answer = await exchange(daemonPaths(stateDir), { control: "status" });
	const status = typeof answer === "object" && answer !== null ? Reflect.get(answer, "status") : undefined;
	if (typeof status === "object" && status !== null && typeof Reflect.get(status, "pid") === "number") {
		return status as DaemonStatus;
	}
	return undefined;
}

export async function stopDaemon(stateDir: string): Promise<boolean> {
	const answer = await exchange(daemonPaths(stateDir), { control: "stop" });
	return typeof answer === "object" && answer !== null && Reflect.get(answer, "stopped") === true;
}

/**
 * Starts serving in this process: a fresh token (0600) and the socket (0600) in the 0700 state directory. Refuses
 * when another daemon answers there. Resolves once listening; `stop()` closes and removes every file it created.
 */
export async function runDaemon(
	stateDir: string,
	execute: (request: DaemonRequest) => Promise<DaemonResponse>,
): Promise<{ readonly stop: () => void; readonly closed: Promise<void> }> {
	if ((await daemonStatus(stateDir)) !== undefined) {
		throw new Error("an opencua daemon is already running; stop it with `opencua daemon stop`");
	}
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	const paths = daemonPaths(stateDir);
	// A socket left by a daemon that crashed answers nothing (checked above) and would block listen.
	rmSync(paths.socket, { force: true });
	const token = randomBytes(32).toString("hex");
	writeFileSync(paths.token, `${token}\n`, { mode: 0o600 });
	writeFileSync(paths.pid, `${process.pid}\n`, { mode: 0o600 });
	let resolveClosed: () => void = () => undefined;
	const closed = new Promise<void>((resolve) => {
		resolveClosed = resolve;
	});
	let server: Server | undefined;
	let stopped = false;
	const stop = (): void => {
		if (stopped) return;
		stopped = true;
		for (const path of [paths.socket, paths.token, paths.pid]) rmSync(path, { force: true });
		if (server === undefined) {
			resolveClosed();
			return;
		}
		server.close(() => resolveClosed());
	};
	const previousUmask = process.umask(0o177);
	try {
		server = await startDaemonServer({
			socketPath: paths.socket,
			token,
			startedAt: new Date().toISOString(),
			execute,
			onStop: stop,
		});
	} catch (error: unknown) {
		stop();
		throw error;
	} finally {
		process.umask(previousUmask);
	}
	return { stop, closed };
}
