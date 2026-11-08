import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { LINUX_HELPER } from "./helper.js";

export const LINUX_INSTALL_HINTS =
	"apt: sudo apt install python3 python3-gi gir1.2-atspi-2.0 gir1.2-gdkpixbuf-2.0 imagemagick; " +
	"dnf: sudo dnf install python3 python3-gobject at-spi2-core gdk-pixbuf2 ImageMagick; " +
	"pacman: sudo pacman -S python python-gobject at-spi2-core gdk-pixbuf2 imagemagick; " +
	"Wayland captures with grim instead of ImageMagick";

export class LinuxBackendError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(code === "MISSING_DEPENDENCY" ? `${message}. ${LINUX_INSTALL_HINTS}` : message);
		this.name = "LinuxBackendError";
	}
}

/** One transport owns one process. Callbacks must be registered before sending. */
export interface LinuxHelperTransport {
	send(line: string): void;
	close(): void;
}

export interface LinuxHelperEvents {
	readonly line: (line: string) => void;
	readonly exit: (error: Error) => void;
}

export type LinuxHelperFactory = (events: LinuxHelperEvents) => LinuxHelperTransport;

export interface LinuxClientOptions {
	readonly helperFactory?: LinuxHelperFactory;
	readonly python?: string;
	readonly timeoutMs?: number;
}

/** `env` overrides the helper's environment, e.g. DISPLAY of an owned display. */
export function spawnLinuxHelper(python = "python3", env?: Readonly<Record<string, string>>): LinuxHelperFactory {
	return (events) => {
		const child = spawn(python, ["-u", "-c", LINUX_HELPER], {
			stdio: ["pipe", "pipe", "pipe"],
			detached: true,
			...(env === undefined ? {} : { env: { ...process.env, ...env } }),
		});
		const lines = createInterface({ input: child.stdout });
		let diagnostic = "";
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			diagnostic = (diagnostic + chunk).slice(-4096);
		});
		lines.on("line", events.line);
		child.on("error", (error: NodeJS.ErrnoException) => {
			events.exit(
				new LinuxBackendError(
					error.code === "ENOENT" ? "MISSING_DEPENDENCY" : "HELPER_CRASH",
					`Cannot start ${python}: ${error.message}`,
				),
			);
		});
		child.on("exit", (code, signal) => {
			events.exit(new LinuxBackendError("HELPER_CRASH", `Linux helper exited (${code ?? signal}): ${diagnostic}`));
		});
		child.stdin.on("error", (error: Error) => events.exit(error));
		return {
			send: (line) => {
				child.stdin.write(`${line}\n`);
			},
			close: () => {
				lines.close();
				child.stdin.destroy();
				if (child.pid !== undefined) {
					try {
						// Also stop capture/input utilities owned by this helper.
						process.kill(-child.pid, "SIGKILL");
					} catch (error) {
						if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
					}
				}
			},
		};
	};
}

interface Pending {
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

export function record(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new LinuxBackendError("PROTOCOL_ERROR", "Expected a JSON object from Linux helper");
	}
	return Object.fromEntries(Object.entries(value));
}

export class LinuxHelperClient {
	private transport: LinuxHelperTransport | undefined;
	private generation = 0;
	private nextId = 0;
	private closed = false;
	private readonly pending = new Map<number, Pending>();
	private readonly factory: LinuxHelperFactory;
	private readonly timeoutMs: number;

	constructor(options: LinuxClientOptions = {}) {
		this.factory = options.helperFactory ?? spawnLinuxHelper(options.python);
		this.timeoutMs = options.timeoutMs ?? 10_000;
		if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
			throw new LinuxBackendError("INVALID_ARGUMENT", "timeoutMs must be positive and finite");
		}
	}

	get epoch(): number {
		return this.generation;
	}

	request(
		method: string,
		params: Readonly<Record<string, unknown>> = {},
		timeoutMs = this.timeoutMs,
	): Promise<unknown> {
		if (this.closed) return Promise.reject(new LinuxBackendError("CLOSED", "Linux computer is closed"));
		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
			return Promise.reject(new LinuxBackendError("INVALID_ARGUMENT", "timeoutMs must be positive and finite"));
		}
		if (!this.transport) {
			const generation = ++this.generation;
			this.transport = this.factory({
				line: (line) => {
					if (generation === this.generation) this.receive(line);
				},
				exit: (error) => {
					if (generation === this.generation) this.reset(error);
				},
			});
		}
		const id = ++this.nextId;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				// A timed-out native call can still mutate later. Kill the whole helper; never replay actions.
				this.reset(new LinuxBackendError("TIMEOUT", `Linux ${method} exceeded ${timeoutMs} ms; observe again`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			try {
				this.transport?.send(JSON.stringify({ id, method, params }));
			} catch (error) {
				this.reset(error instanceof Error ? error : new LinuxBackendError("HELPER_CRASH", String(error)));
			}
		});
	}

	private receive(line: string): void {
		try {
			const response = record(JSON.parse(line));
			const id = response["id"];
			if (typeof id !== "number") throw new LinuxBackendError("PROTOCOL_ERROR", "Missing response id");
			const pending = this.pending.get(id);
			if (!pending) return;
			const error = response["error"];
			if (error !== undefined) {
				const detail = record(error);
				if (typeof detail["code"] !== "string" || typeof detail["message"] !== "string") {
					throw new LinuxBackendError("PROTOCOL_ERROR", "Malformed helper error");
				}
				this.pending.delete(id);
				clearTimeout(pending.timer);
				pending.reject(new LinuxBackendError(detail["code"], detail["message"]));
			} else if ("result" in response) {
				this.pending.delete(id);
				clearTimeout(pending.timer);
				pending.resolve(response["result"]);
			} else {
				throw new LinuxBackendError("PROTOCOL_ERROR", "Missing response result");
			}
		} catch (error) {
			this.reset(error instanceof Error ? error : new LinuxBackendError("PROTOCOL_ERROR", String(error)));
		}
	}

	private reset(error: Error): void {
		const transport = this.transport;
		this.transport = undefined;
		++this.generation;
		transport?.close();
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}

	close(): void {
		this.closed = true;
		this.reset(new LinuxBackendError("CLOSED", "Linux computer is closed"));
	}
}
