import { type ActivityFeed, type ActivityState, defaultActivityFeed, resolveStateDir } from "@opencua/core/light";
import type { Command } from "commander";

const STATES: readonly ActivityState[] = [
	"idle",
	"listening",
	"hearing",
	"thinking",
	"working",
	"speaking",
	"done",
	"error",
];

export interface HudCommandDeps {
	readonly isJsonOutput: () => boolean;
	readonly feed?: () => ActivityFeed;
}

function parseState(value: string): ActivityState {
	const state = STATES.find((candidate) => candidate === value);
	if (state === undefined) throw new Error(`Unknown state "${value}". Use one of: ${STATES.join(", ")}.`);
	return state;
}

export function sourceFor(agent: string): string {
	return `agent-${agent.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-")}`;
}

function parseTtl(value: string): number {
	const seconds = Number(value);
	if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`--ttl takes seconds above 0, not "${value}".`);
	return seconds;
}

/**
 * `opencua hud`: put any agent on the status pill, for agents that do not drive OpenCUA itself, such as Claude Code
 * through its hooks (thinking on UserPromptSubmit, cleared on Stop).
 */
export function registerHudCommands(program: Command, deps: HudCommandDeps): void {
	const feed = deps.feed ?? (() => defaultActivityFeed(resolveStateDir()));
	const emit = (value: unknown, text: string): void => {
		process.stdout.write(deps.isJsonOutput() ? `${JSON.stringify(value)}\n` : `${text}\n`);
	};
	const hud = program
		.command("hud")
		.description("The status pill at the bottom of the screen: show what agents are doing");

	hud.command("set")
		.description("Show a line for an agent until it is cleared or its ttl runs out")
		.argument("<state>", STATES.join(" | "))
		.argument("[text...]", "what it is doing")
		.option("--agent <name>", "the name to show", "Agent")
		.option("--source <id>", "a stable id for this agent's line (default: from --agent)")
		.option("--ttl <seconds>", "hide the line after this long (default 600)", parseTtl, 600)
		.action(
			(
				state: string,
				words: readonly string[],
				options: { readonly agent: string; readonly source?: string; readonly ttl: number },
			) => {
				const source = options.source ?? sourceFor(options.agent);
				const text = words.join(" ");
				const shown = feed().write({
					source,
					agent: options.agent,
					state: parseState(state),
					...(text.length === 0 ? {} : { text }),
					ttl: options.ttl,
				});
				emit({ source, shown }, `${shown.state}${shown.text === undefined ? "" : `: ${shown.text}`}`);
			},
		);

	hud.command("clear")
		.description("Remove an agent's line")
		.option("--agent <name>", "the name it was set with", "Agent")
		.option("--source <id>", "the id it was set with")
		.action((options: { readonly agent: string; readonly source?: string }) => {
			const source = options.source ?? sourceFor(options.agent);
			const shown = feed().clear(source);
			emit({ source, shown }, `${shown.state}${shown.text === undefined ? "" : `: ${shown.text}`}`);
		});

	hud.command("show")
		.description("Print what the pill shows now")
		.action(() => {
			const shown = feed().read();
			emit(
				shown,
				`${shown.state}${shown.text === undefined ? "" : `: ${shown.text}`}${shown.detail === undefined ? "" : `\n${shown.detail}`}`,
			);
		});
}
