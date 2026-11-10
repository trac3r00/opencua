import type { AxUnavailableReason } from "./types.js";

/**
 * Tells an agent why an observation holds no accessibility elements and what fixes it, so an empty tree is never
 * read as an app without UI. `processPath` names the binary macOS checked, the one a grant must cover.
 */
export function axUnavailableNote(reason: AxUnavailableReason, processPath: string): string {
	switch (reason) {
		case "accessibility-permission":
			return `no elements: the process running opencua (${processPath}) lacks macOS Accessibility permission, so the app's tree could not be read; the empty element list does not mean the app has no UI. Ask the user to run \`opencua doctor\` and grant Accessibility to opencua-mcp (or, for a CLI run without the helper, to the terminal that launched it), then restart it.`;
		case "app-not-accessible":
			return "no elements: Accessibility is granted, but the app exposed no accessibility tree (no window answered: it may be loading, minimized, on another Space, or draw its own UI). Use the screenshot, or observe again once the app shows a window.";
	}
}
