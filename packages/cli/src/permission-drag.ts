import { spawn, spawnSync } from "node:child_process";
import { constants, accessSync } from "node:fs";
import { join } from "node:path";
import { resolveLayout } from "./layout.js";

/** The native panel (packages/core/native/permission-drag.m) that attaches to System Settings. */
export const DRAG_PANEL_BINARY = "permission-drag";

/** A shown drag panel; close() takes it away. */
export interface DragPanel {
	readonly close: () => void;
}

/** Offers the helper app for a person to drag into a System Settings privacy list. */
export interface DragPanelLauncher {
	/** Attaches the panel to System Settings; undefined when the native binary is missing or not executable. */
	readonly show: (app: string, title: string) => DragPanel | undefined;
	/** Shows the app selected in a Finder window, to drag from there when there is no panel. */
	readonly reveal: (app: string) => void;
}

/**
 * The real launcher. The panel gets this process as --parent, so it also goes away when the CLI is killed before it
 * could close the panel.
 */
export function nativeDragPanel(
	print: (text: string) => void,
	nativeDir: string = resolveLayout().nativeDir,
): DragPanelLauncher {
	const binary = join(nativeDir, DRAG_PANEL_BINARY);
	return {
		show: (app, title) => {
			try {
				accessSync(binary, constants.X_OK);
			} catch {
				return undefined;
			}
			const child = spawn(binary, ["--app", app, "--title", title, "--parent", String(process.pid)], {
				stdio: "ignore",
			});
			child.once("error", (error) => {
				print(`  The drag panel did not start (${error.message}); add ${app} with the + button under the list.`);
			});
			return {
				close: () => {
					child.kill("SIGTERM");
				},
			};
		},
		reveal: (app) => {
			spawnSync("/usr/bin/open", ["-R", app], { stdio: "ignore" });
		},
	};
}
