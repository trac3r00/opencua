import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Observe the existing acquire promise; never change its result, budget, or scheduling. */
export function instrumentLock(prototype, emit, now = () => performance.now()) {
	const acquire = prototype.acquire;
	prototype.acquire = async function measuredAcquire(...args) {
		const started = now();
		const acquired = await acquire.apply(this, args);
		// Telemetry must never fail an acquire that already holds the lock, or the lock is never released.
		try {
			emit({ wait_ms: now() - started, acquired });
		} catch {
			// The measurement is lost; the lock result stands.
		}
		return acquired;
	};
}

if (process.env.TEAM_INPUT_LOCK_LOG) {
	const { InputLock } = await import(pathToFileURL(process.env.TEAM_INPUT_LOCK_MODULE).href);
	instrumentLock(InputLock.prototype, (entry) => {
		appendFileSync(process.env.TEAM_INPUT_LOCK_LOG, `${JSON.stringify(entry)}\n`);
	});
}
