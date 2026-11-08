import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as ts from "typescript";
import { z } from "zod/v4";
import { currentCursorOwner, withCursorIdentity } from "../../core/src/computer/cursor-scope.js";

// Run the real coordinator class with explicitly supplied fake boundaries.
// Its native package imports are not loaded or executed.
const source = ts.createSourceFile(
	"worker-coordinator.ts",
	readFileSync(new URL("./worker-coordinator.ts", import.meta.url), "utf8"),
	ts.ScriptTarget.ES2022,
	true,
);
const declarations = source.statements.filter(
	(statement) =>
		(ts.isClassDeclaration(statement) && statement.name?.text === "WorkerCoordinator") ||
		(ts.isFunctionDeclaration(statement) &&
			(statement.name?.text === "payload" || statement.name?.text === "workerKey")) ||
		(ts.isVariableStatement(statement) &&
			statement.declarationList.declarations.some(
				(declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === "DEFAULT_WORKER_SESSION",
			)),
);
const compiled = ts.transpileModule(declarations.map((node) => node.getText(source)).join("\n"), {
	compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

describe("#given named workers #when assigned #then virtual cursor ownership uses their names", () => {
	it("returns distinct cursor IDs with stable session and parent attribution", async () => {
		let nextId = 0;
		const observedOwners: unknown[] = [];
		const result: unknown = await runInNewContext(
			`${compiled}
			(async () => {
				const coordinator = new WorkerCoordinator(session, computer);
				try {
					await coordinator.assign([
						{worker_id:"reader-id",agent_name:"Reader",parent_agent_name:"Coordinator",task:"read",app:"First"},
						{worker_id:"writer-id",agent_name:"Writer",parent_agent_name:"Coordinator",task:"write",app:"Second"}
					]);
					return coordinator.status();
				} finally {
					await coordinator.close();
				}
			})()`,
			{
				exports: {},
				randomUUID: () => `test-id-${++nextId}`,
				withCursorIdentity,
				isOwnedSurfacePid: () => false,
				resolveAppPid: async (_computer: unknown, app: string) => (app === "First" ? 101 : 202),
				computer: { delivery: "background" },
				session: {
					observe: async () => {
						observedOwners.push(currentCursorOwner());
						return {
							content: [{ type: "text", text: JSON.stringify({ observation_token: `token-${nextId}` }) }],
						};
					},
					close: async () => undefined,
				},
			},
			{ timeout: 5_000 },
		);
		expect(result).toMatchObject([
			{ worker_id: "reader-id", cursor_owner: { agentName: "Reader", parentAgentName: "Coordinator" } },
			{ worker_id: "writer-id", cursor_owner: { agentName: "Writer", parentAgentName: "Coordinator" } },
		]);
		const cursors = z.array(z.object({ cursor_id: z.string() })).parse(result);
		expect(new Set(cursors.map((cursor) => cursor.cursor_id)).size).toBe(2);
		expect(observedOwners).toEqual([
			{ agentName: "Reader", parentAgentName: "Coordinator", sessionId: "test-id-1" },
			{ agentName: "Writer", parentAgentName: "Coordinator", sessionId: "test-id-1" },
		]);
		expect(currentCursorOwner()).toBeUndefined();
	});
});
