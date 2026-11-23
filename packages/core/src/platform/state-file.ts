import { type Stats, lstatSync } from "node:fs";

/**
 * The stat of a state file opencua may take a decision from, or undefined when its contents could be someone
 * else's: it must be a regular file (a link in its place is not followed), owned by this user, that neither the
 * group nor everyone can write. Who may read it does not matter here. Where the platform has no POSIX ownership
 * the check is that it is a regular file.
 *
 * This keeps other users out. A process running as this user can still write the file, so a caller that grants
 * something on its contents has to check each claim against the system as well.
 */
export function trustedStateFile(path: string, uid: number | undefined = process.getuid?.()): Stats | undefined {
	let stat: Stats;
	try {
		stat = lstatSync(path);
	} catch {
		return undefined;
	}
	if (!stat.isFile()) return undefined;
	if (uid === undefined) return stat;
	return stat.uid === uid && (stat.mode & 0o022) === 0 ? stat : undefined;
}
