// macOS charges Accessibility, Screen Recording and Automation to the process that asks. The person grants them to
// the "opencua-mcp" helper, so CLI commands that read or drive apps run inside it rather than in the terminal.

/** Set in the CLI process the helper runs, so it does not relaunch itself again. */
export const IN_HELPER_ENV = "OPENCUA_CLI_IN_HELPER";

const DESKTOP_COMMANDS = new Set([
	"screenshot",
	"click",
	"right-click",
	"middle-click",
	"double-click",
	"move",
	"drag",
	"scroll",
	"type",
	"key",
	"keypress",
	"cursor",
	"screen",
	"windows",
	"apps",
	"ios",
	"utm",
]);

/** Whether a command (its path below the program, such as "apps state") needs the helper's macOS permissions. */
export function needsHelperPermissions(commandPath: string): boolean {
	const [command, subcommand] = commandPath.split(" ");
	if (command === "permissions") {
		return subcommand === "check" || subcommand === "request";
	}
	if (command === "daemon") {
		return subcommand === "run";
	}
	if (command === "space") {
		// The space's picture-in-picture captures the agent display; start only launches `space run` detached.
		return subcommand === "run";
	}
	if (command === "buddy") {
		// Only ask captures the screen; listen and agent jobs must not run as the helper (see buddy-commands.ts).
		return subcommand === "ask";
	}
	return command !== undefined && DESKTOP_COMMANDS.has(command);
}
