import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as ts from "typescript";
import { currentCursorIdentity, currentCursorOwner, withCursorIdentity } from "./cursor-scope.js";
import { denyHostInteraction } from "./host-interaction-policy.js";

// Load only the renderer dispatcher and its factory wrapper. Native socket,
// process, motion and display modules are deliberately absent from this context.
const source = ts.createSourceFile(
	"cursor-overlay.ts",
	readFileSync(new URL("../platform/macos-ffi/cursor-overlay.ts", import.meta.url), "utf8"),
	ts.ScriptTarget.ES2022,
	true,
);
const declarations = source.statements.filter(
	(statement) =>
		ts.isFunctionDeclaration(statement) &&
		(statement.name?.text === "createCursorOverlay" ||
			statement.name?.text === "safeTransport" ||
			statement.name?.text === "agentPaced"),
);
const compiled = ts.transpileModule(declarations.map((node) => node.getText(source)).join("\n"), {
	compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

describe("#given named agents #when cursor transports are created #then ownership follows the cursor", () => {
	it("delivers parent and child names to separate transports without desktop access", async () => {
		const routes: { identity: unknown; owner: unknown; commands: string[] }[] = [];
		const result: unknown = await runInNewContext(
			`${compiled}
			(async () => {
				const overlay = createCursorOverlay(factory);
				const parent = {agentName:"Coordinator",sessionId:"session-one"};
				const child = {agentName:"Reader",parentAgentName:"Coordinator",sessionId:"session-one"};
				await Promise.all([
					withCursorIdentity("opaque-parent", async () => {
						overlay.set({x:1,y:2});
						await Promise.resolve();
						overlay.hide();
					}, parent),
					withCursorIdentity("opaque-child", async () => {
						overlay.set({x:3,y:4});
						await Promise.resolve();
						overlay.hide();
					}, child)
				]);
				overlay.close();
				return currentCursorOwner();
			})()`,
			{
				exports: {},
				process: { env: {} },
				CURSOR_MOTION_ENV: "OPENCUA_CURSOR_MOTION",
				AGENT_GLIDE_MILLISECONDS: 160,
				denyHostInteraction,
				currentCursorIdentity,
				currentCursorOwner,
				withCursorIdentity,
				factory: (identity: unknown, owner: unknown) => {
					const commands: string[] = [];
					const route = { identity, owner, commands };
					routes.push(route);
					return {
						send: (command: string) => route.commands.push(command),
						close: () => route.commands.push("closed"),
					};
				},
			},
			{ timeout: 5_000 },
		);
		expect(result).toBeUndefined();
		expect(routes).toEqual([
			{
				identity: "opaque-parent",
				owner: { agentName: "Coordinator", sessionId: "session-one" },
				commands: ["set 1 2\n", "hide\n", "closed"],
			},
			{
				identity: "opaque-child",
				owner: { agentName: "Reader", parentAgentName: "Coordinator", sessionId: "session-one" },
				commands: ["set 3 4\n", "hide\n", "closed"],
			},
		]);
		expect(currentCursorOwner()).toBeUndefined();
	});
});
