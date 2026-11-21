import { createHash } from "node:crypto";
import { watch as watchDirectory } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/** Hash of the compiled modules the daemon runs, so a redeploy with identical output keeps the daemon. */
export async function readBuildId(directories: readonly string[]): Promise<string> {
	const hash = createHash("sha256");
	for (const directory of directories) {
		const names = (await readdir(directory)).filter((name) => name.endsWith(".js")).sort();
		for (const name of names) {
			hash.update(`${name}\0`);
			hash.update(await readFile(join(directory, name)));
			hash.update("\0");
		}
	}
	return hash.digest("hex").slice(0, 12);
}

export type BuildWatchOptions = {
	readonly directories: readonly string[];
	readonly initialId: string;
	readonly onChange: (buildId: string) => void;
	readonly readId?: () => Promise<string>;
	readonly watch?: (directory: string, listener: (filename: string | null) => void) => { close(): void };
	readonly schedule?: (action: () => void, delayMs: number) => () => void;
};

const SETTLE_MS = 1_000;

function watchFiles(directory: string, listener: (filename: string | null) => void): { close(): void } {
	const watcher = watchDirectory(directory, (_event, filename) => listener(filename));
	watcher.unref();
	return watcher;
}

function scheduleOnce(action: () => void, delayMs: number): () => void {
	const timer = setTimeout(action, delayMs);
	timer.unref();
	return () => clearTimeout(timer);
}

/** Reports a new build id once writes to the watched directories settle and the compiled modules differ. */
export function watchBuild(options: BuildWatchOptions): () => void {
	const readId = options.readId ?? (() => readBuildId(options.directories));
	const schedule = options.schedule ?? scheduleOnce;
	let cancel: (() => void) | undefined;
	const check = async (): Promise<void> => {
		cancel = undefined;
		try {
			const next = await readId();
			if (next !== options.initialId) options.onChange(next);
		} catch (error: unknown) {
			// A build mid-write can remove a file between readdir and readFile; its next write schedules another check.
			const message = error instanceof Error ? error.message : String(error);
			process.stderr.write(`Browser build check failed: ${message}\n`);
		}
	};
	const watchers = options.directories.map((directory) =>
		(options.watch ?? watchFiles)(directory, (filename) => {
			if (filename !== null && !filename.endsWith(".js")) return;
			cancel?.();
			cancel = schedule(() => void check(), SETTLE_MS);
		}),
	);
	return () => {
		cancel?.();
		for (const watcher of watchers) watcher.close();
	};
}
