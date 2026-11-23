import type { KoffiFunc } from "koffi";
import { koffi } from "./koffi.js";

/**
 * What the kernel says about the process at a pid. A pid alone names whichever process holds it now, so anything
 * that remembers a process across time (a worker claim, an owned surface, a window lease) keeps its start time too.
 * Both answers come from the kernel's own record of the process, not from memory the process can rewrite (its
 * arguments, which is what `ps -o comm=` prints).
 */
const PROC_PIDTBSDINFO = 3;
/** sizeof(struct proc_bsdinfo); pbi_start_tvsec and pbi_start_tvusec are its last two uint64 fields. */
const PROC_BSD_INFO_BYTES = 136;
const PROC_START_SECONDS_OFFSET = 120;
const PROC_START_MICROSECONDS_OFFSET = 128;
/** PROC_PIDPATHINFO_MAXSIZE: four times MAXPATHLEN. */
const PATH_BUFFER_BYTES = 4096;

type PidInfo = KoffiFunc<(pid: number, flavor: number, argument: number, buffer: Buffer, bufferSize: number) => number>;
type PidPath = KoffiFunc<(pid: number, buffer: Buffer, size: number) => number>;

let pidInfo: PidInfo | undefined;
let pidPath: PidPath | undefined;

/** Each function is bound on its first use, so a platform without libproc can still load this module. */
function libSystem(): ReturnType<typeof koffi.load> {
	return koffi.load("/usr/lib/libSystem.B.dylib");
}

/**
 * When `pid` started, to the microsecond, as "<seconds>.<microseconds>" since the epoch; undefined when no process
 * holds the pid or the platform does not say. A later process that reuses the pid starts at another time. The value
 * is the same in every process that asks, whatever its time zone or locale.
 */
export function processStartTime(pid: number): string | undefined {
	if (process.platform !== "darwin" || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
	pidInfo ??= libSystem().func(
		"int proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int buffersize)",
	) as PidInfo;
	const info = Buffer.alloc(PROC_BSD_INFO_BYTES);
	if (pidInfo(pid, PROC_PIDTBSDINFO, 0, info, PROC_BSD_INFO_BYTES) !== PROC_BSD_INFO_BYTES) {
		return undefined;
	}
	return `${info.readBigUInt64LE(PROC_START_SECONDS_OFFSET)}.${info.readBigUInt64LE(PROC_START_MICROSECONDS_OFFSET)}`;
}

/** The file `pid` is executing, as the kernel resolves it from the open executable; undefined when it cannot say. */
export function processExecutablePath(pid: number): string | undefined {
	if (process.platform !== "darwin" || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
	pidPath ??= libSystem().func("int32_t proc_pidpath(int32_t pid, _Out_ uint8_t *buffer, uint32_t size)") as PidPath;
	const path = Buffer.alloc(PATH_BUFFER_BYTES);
	const length = pidPath(pid, path, path.byteLength);
	return length > 0 ? path.subarray(0, length).toString("utf8") : undefined;
}
