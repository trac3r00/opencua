import { AsyncLocalStorage } from "node:async_hooks";

export interface CursorOwner {
	readonly agentName: string;
	readonly sessionId: string;
	readonly parentAgentName?: string;
	/** What the cursor is doing (a worker's task), shown beside its name where cursors are labeled. */
	readonly purpose?: string;
}

/** Longest purpose shown on a cursor label; longer ones end with an ellipsis. */
const PURPOSE_LABEL_CHARACTERS = 48;

function purposeLabel(purpose: string): string {
	// Only the start can be shown, so a long task is cut before any work; control and format characters (bidi
	// overrides, zero-width marks) become spaces so a label cannot disguise which worker it names.
	const clean = purpose
		.slice(0, PURPOSE_LABEL_CHARACTERS * 8)
		.replace(/[\p{Cc}\p{Cf}]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
	const characters = Array.from(clean);
	return characters.length <= PURPOSE_LABEL_CHARACTERS
		? clean
		: `${characters.slice(0, PURPOSE_LABEL_CHARACTERS - 1).join("")}…`;
}

interface CursorContext {
	readonly identity: string;
	readonly owner?: CursorOwner;
}

const cursorIdentity = new AsyncLocalStorage<CursorContext>();

export function withCursorIdentity<T>(identity: string, callback: () => T, owner?: CursorOwner): T {
	if (owner === undefined) return cursorIdentity.run({ identity }, callback);
	for (const name of [owner.agentName, owner.sessionId, owner.parentAgentName]) {
		if (
			name !== undefined &&
			(name.trim().length === 0 ||
				name.length > 128 ||
				Array.from(name).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))
		) {
			throw new TypeError(
				"Cursor owner names and session IDs must be nonempty, at most 128 characters, and contain no control characters.",
			);
		}
	}
	const purpose = owner.purpose === undefined ? undefined : purposeLabel(owner.purpose);
	const snapshot: CursorOwner = Object.freeze({
		agentName: owner.agentName.trim(),
		sessionId: owner.sessionId.trim(),
		...(owner.parentAgentName === undefined ? {} : { parentAgentName: owner.parentAgentName.trim() }),
		...(purpose === undefined || purpose === "" ? {} : { purpose }),
	});
	return cursorIdentity.run({ identity, owner: snapshot }, callback);
}

export function currentCursorIdentity(): string | undefined {
	return cursorIdentity.getStore()?.identity;
}

export function currentCursorOwner(): CursorOwner | undefined {
	return cursorIdentity.getStore()?.owner;
}

const contextClick = new AsyncLocalStorage<true>();

/**
 * Marks the input sent inside `callback` as a context click: picking a tool, size or color. A window several cursors
 * share replays a cursor's context clicks before it continues, after another cursor changed that state.
 */
export function withContextClick<T>(callback: () => T): T {
	return contextClick.run(true, callback);
}

export function inContextClick(): boolean {
	return contextClick.getStore() === true;
}
