import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { gzipSync } from "node:zlib";
import { DESKTOP_NAME, desktopLauncherScript } from "./desktop-launcher.js";
import { windowsHelperScript } from "./helper.js";

export class WindowsHostError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(`${code}: ${message}`);
		this.name = "WindowsHostError";
	}
}

export interface WindowsTransport {
	readonly generation: number;
	request(method: string, params?: Readonly<Record<string, unknown>>): Promise<unknown>;
	close(): Promise<void>;
}

export interface WindowsProcess {
	write(line: string): void;
	kill(): void;
}

export type WindowsProcessFactory = (
	executable: string,
	args: readonly string[],
	onLine: (line: string) => void,
	onExit: (reason: string, missing: boolean) => void,
	env?: Readonly<Record<string, string>>,
) => WindowsProcess;

export interface PowerShellTransportOptions {
	readonly physical?: boolean;
	readonly allowWmChar?: boolean;
	readonly timeoutMs?: number;
	readonly processFactory?: WindowsProcessFactory;
	/** Run the helper and the apps it starts on this owned Win32 desktop ("OpenCUA-..."), never the person's. */
	readonly desktop?: string;
}

const processFactory: WindowsProcessFactory = (executable, args, onLine, onExit, env) => {
	const child: ChildProcessWithoutNullStreams = spawn(executable, [...args], {
		windowsHide: true,
		...(env === undefined ? {} : { env: { ...process.env, ...env } }),
	});
	const lines = createInterface({ input: child.stdout });
	lines.on("line", onLine);
	let diagnostic = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		diagnostic = (diagnostic + chunk).slice(-2048);
	});
	child.on("error", (error: NodeJS.ErrnoException) => onExit(error.message, error.code === "ENOENT"));
	child.on("exit", (code, signal) => {
		lines.close();
		onExit(`PowerShell exited (${code ?? signal}): ${diagnostic}`, false);
	});
	return {
		write(line) {
			child.stdin.write(line, (error) => {
				if (error) onExit(error.message, false);
			});
		},
		kill() {
			lines.close();
			child.kill();
		},
	};
};

/** A timed-out or crashed host is discarded. Mutations are never replayed automatically. */
export class PowerShellTransport implements WindowsTransport {
	generation = 0;
	private process: WindowsProcess | undefined;
	private nextId = 0;
	private closed = false;
	private executable = "pwsh";
	private readonly pending = new Map<
		number,
		{ resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; line: string }
	>();

	constructor(private readonly options: PowerShellTransportOptions = {}) {
		if (!Number.isFinite(options.timeoutMs ?? 15_000) || (options.timeoutMs ?? 15_000) <= 0) {
			throw new WindowsHostError("INVALID_ARGUMENT", "timeoutMs must be positive and finite");
		}
		if (options.desktop !== undefined && !DESKTOP_NAME.test(options.desktop)) {
			throw new WindowsHostError("INVALID_ARGUMENT", "desktop must look like OpenCUA-<letters, digits, dashes>");
		}
	}

	request(method: string, params: Readonly<Record<string, unknown>> = {}): Promise<unknown> {
		if (this.closed) return Promise.reject(new WindowsHostError("CLOSED", "Windows host is closed"));
		return new Promise((resolve, reject) => {
			const id = ++this.nextId;
			const timer = setTimeout(() => {
				this.reset(new WindowsHostError("TIMEOUT", `${method} timed out; observe again before retrying`));
			}, this.options.timeoutMs ?? 15_000);
			const line = `${JSON.stringify({ id, method, params })}\n`;
			this.pending.set(id, { resolve, reject, timer, line });
			try {
				if (!this.process) this.start([line]);
				else this.process.write(line);
			} catch (error) {
				this.reset(new WindowsHostError("HOST_EXITED", error instanceof Error ? error.message : String(error)));
			}
		});
	}

	private start(lines: readonly string[]): void {
		const generation = ++this.generation;
		const script = `$PhysicalAllowed=$${this.options.physical === true}; $WmCharAllowed=$${this.options.allowWmChar === true};\n${windowsHelperScript}`;
		const packed = gzipSync(Buffer.from(script)).toString("base64");
		const bootstrap = `$m=[IO.MemoryStream]::new([Convert]::FromBase64String('${packed}')); $z=[IO.Compression.GZipStream]::new($m,[IO.Compression.CompressionMode]::Decompress); $r=[IO.StreamReader]::new($z); try { Invoke-Expression ($r.ReadToEnd()) } finally { $r.Dispose(); $z.Dispose(); $m.Dispose() }`;
		const encoded = Buffer.from(bootstrap, "utf16le").toString("base64");
		const desktop = this.options.desktop;
		const command =
			desktop === undefined
				? encoded
				: Buffer.from(desktopLauncherScript(desktop, this.executable), "utf16le").toString("base64");
		let missing = false;
		const process = (this.options.processFactory ?? processFactory)(
			this.executable,
			["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", command],
			(line) => {
				if (generation === this.generation) this.receive(line);
			},
			(reason, notFound) => {
				if (generation !== this.generation) return;
				if (notFound && this.executable === "pwsh") {
					missing = true;
					this.process = undefined;
					this.executable = "powershell.exe";
					this.start([...this.pending.values()].map((pending) => pending.line));
					return;
				}
				this.reset(new WindowsHostError("HOST_EXITED", reason));
			},
			desktop === undefined ? undefined : { OPENCUA_HELPER: encoded },
		);
		if (!missing && generation === this.generation) {
			this.process = process;
			for (const line of lines) process.write(line);
		}
	}

	private receive(line: string): void {
		try {
			const envelope: unknown = JSON.parse(line);
			if (typeof envelope !== "object" || envelope === null || !("id" in envelope)) {
				throw new WindowsHostError("PROTOCOL", "Missing response id");
			}
			if (typeof envelope.id !== "number") throw new WindowsHostError("PROTOCOL", "Invalid response id");
			const pending = this.pending.get(envelope.id);
			if (!pending) return;
			if ("error" in envelope) {
				const error = envelope.error;
				if (
					typeof error !== "object" ||
					error === null ||
					!("code" in error) ||
					typeof error.code !== "string" ||
					!("message" in error) ||
					typeof error.message !== "string"
				) {
					throw new WindowsHostError("PROTOCOL", "Invalid error envelope");
				}
				clearTimeout(pending.timer);
				this.pending.delete(envelope.id);
				pending.reject(new WindowsHostError(error.code, error.message));
			} else if ("result" in envelope) {
				clearTimeout(pending.timer);
				this.pending.delete(envelope.id);
				pending.resolve(envelope.result);
			} else throw new WindowsHostError("PROTOCOL", "Missing response result");
		} catch (error) {
			this.reset(
				error instanceof WindowsHostError
					? error
					: new WindowsHostError("PROTOCOL", error instanceof Error ? error.message : String(error)),
			);
		}
	}

	private reset(error: Error): void {
		const process = this.process;
		this.process = undefined;
		++this.generation;
		process?.kill();
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}

	async close(): Promise<void> {
		this.closed = true;
		this.reset(new WindowsHostError("CLOSED", "Windows host is closed"));
	}
}
