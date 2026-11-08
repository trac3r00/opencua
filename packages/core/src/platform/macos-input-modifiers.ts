import { normalizeModifiers } from "../computer/modifiers.js";
import type { KeyModifierName } from "../types/index.js";
import { modifierFlags, virtualKeyCodeFor } from "./macos-keycodes.js";

/** One modifier key going down or up: `flags` is the modifier state AFTER the change, as in a real flagsChanged event. */
export type ModifierKeyPost = (keyCode: number, keyDown: boolean, flags: number) => void;

/** The CGEventFlags mask for a list of modifiers (aliases accepted); 0 when none are held. */
export function pointerModifierFlags(modifiers: ReadonlyArray<KeyModifierName> | undefined): number {
	return modifierFlags(normalizeModifiers(modifiers));
}

/**
 * Hold modifiers for the length of a gesture, the way a person holds Command while clicking: each
 * modifier key goes down (a flagsChanged event, for apps that read modifier state from those rather
 * than from the pointer event), the gesture runs with the combined flags to stamp on its own events,
 * and every key goes back up in reverse order even when the gesture throws. Without modifiers the
 * gesture simply runs with no flags to stamp.
 */
export async function withHeldModifiers<T>(
	modifiers: ReadonlyArray<KeyModifierName> | undefined,
	post: ModifierKeyPost,
	gesture: (flags: number | undefined) => Promise<T>,
): Promise<T> {
	const held = normalizeModifiers(modifiers);
	if (held.length === 0) {
		return await gesture(undefined);
	}
	const pressed: Array<{ readonly keyCode: number; readonly flagsAfterRelease: number }> = [];
	let flags = 0;
	let result: T;
	try {
		for (const modifier of held) {
			const keyCode = virtualKeyCodeFor(modifier);
			const flagsBefore = flags;
			flags |= modifierFlags([modifier]);
			// A post can send the key and still throw (cleanup after the send), so a failed press is released
			// too; a modifier key-up for a key that never went down leaves the flags as they already are.
			pressed.push({ keyCode, flagsAfterRelease: flagsBefore });
			post(keyCode, true, flags);
		}
		result = await gesture(flags);
	} catch (error: unknown) {
		// The gesture's own failure is the one to report; a release that fails too must not hide it.
		releaseAll(pressed, post);
		throw error;
	}
	const releaseFailure = releaseAll(pressed, post);
	if (releaseFailure !== undefined) {
		throw releaseFailure;
	}
	return result;
}

/** Releases every key that went down, last first; a failing release never stops the others from going up. */
function releaseAll(
	pressed: ReadonlyArray<{ readonly keyCode: number; readonly flagsAfterRelease: number }>,
	post: ModifierKeyPost,
): unknown {
	let firstFailure: unknown;
	for (const key of [...pressed].reverse()) {
		try {
			post(key.keyCode, false, key.flagsAfterRelease);
		} catch (error: unknown) {
			firstFailure ??= error;
		}
	}
	return firstFailure;
}
