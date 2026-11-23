import { randomUUID } from "node:crypto";

/**
 * A short id for one window of one app process, the same every time this server names that window, so an agent can
 * come back to "w-1a2b3c4d" after thinking instead of matching a title that may have changed or that two windows
 * share (two "Bookmarks" windows, a private and a regular window showing one site). A window id the WindowServer
 * reuses for a new window of another process gets a new ref.
 */
const refsByWindow = new Map<string, string>();
const windowsByRef = new Map<string, { readonly pid: number; readonly windowId: number }>();

export const WINDOW_REF_PATTERN = /^w-[0-9a-f]{8}$/;

export function windowRef(pid: number, windowId: number): string {
	const key = `${pid}:${windowId}`;
	let ref = refsByWindow.get(key);
	if (ref === undefined) {
		do {
			ref = `w-${randomUUID().slice(0, 8)}`;
		} while (windowsByRef.has(ref));
		refsByWindow.set(key, ref);
		windowsByRef.set(ref, { pid, windowId });
	}
	return ref;
}

/** The window a ref was given to, or undefined for a ref this server never handed out. */
export function windowForRef(ref: string): { readonly pid: number; readonly windowId: number } | undefined {
	return windowsByRef.get(ref);
}
