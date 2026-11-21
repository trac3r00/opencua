/**
 * Wait until a focus change the browser applies asynchronously has landed: `focused` is read until it answers true
 * or `limitMs` passes. True when focus landed in time.
 */
export async function settleWebFocus(
	focused: () => boolean,
	options: {
		readonly limitMs: number;
		readonly pollMs: number;
		readonly now?: () => number;
		readonly sleep?: (milliseconds: number) => Promise<void>;
	},
): Promise<boolean> {
	const now = options.now ?? Date.now;
	const sleep =
		options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
	const deadline = now() + options.limitMs;
	while (!focused()) {
		if (now() >= deadline) return false;
		await sleep(options.pollMs);
	}
	return true;
}
