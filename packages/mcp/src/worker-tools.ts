import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SpawnGuidance } from "./host-detection.js";
import { expectFromInput } from "./step-actions.js";
import type { ToolContent, ToolResult } from "./tool-result.js";
import { manageWorkersSchema, parseRunSteps, runWorkerSchema, workerManagementRequestSchema } from "./tool-schemas.js";
import { WorkerControlRefusal, type WorkerCoordinator, WorkerRegionRefusal } from "./worker-coordinator.js";
import type { WorkerAssignment, WorkerObservation, WorkerRunResult } from "./worker-coordinator.js";

function attributedEntry(
	attribution:
		| Omit<WorkerObservation, "result">
		| Omit<WorkerRunResult, "result">
		| Omit<WorkerAssignment, "observation">,
	result: ToolResult,
	images: ToolContent[],
): Record<string, unknown> {
	const texts: unknown[] = [];
	const imageIndexes: number[] = [];
	for (const item of result.content) {
		if (item.type === "text") {
			try {
				const parsed: unknown = JSON.parse(item.text);
				texts.push(parsed);
			} catch {
				texts.push(item.text);
			}
		} else {
			imageIndexes.push(images.length);
			images.push(item);
		}
	}
	const value = texts.length === 1 ? texts[0] : texts;
	const resultFields =
		typeof value === "object" && value !== null && !Array.isArray(value)
			? Object.fromEntries(Object.entries(value))
			: { result: value };
	const attributed = {
		...resultFields,
		...attribution,
		...(imageIndexes.length === 0 ? {} : { images: imageIndexes }),
	};
	return attributed;
}

function attributedResult(
	attribution: Omit<WorkerObservation, "result"> | Omit<WorkerRunResult, "result">,
	result: ToolResult,
): ToolResult {
	const images: ToolContent[] = [];
	const attributed = attributedEntry(attribution, result, images);
	return {
		content: [{ type: "text", text: JSON.stringify(attributed) }, ...images],
		...(result.isError === true ? { isError: true } : {}),
	};
}

function assignedResult(assignments: readonly WorkerAssignment[], spawn: SpawnGuidance | undefined): ToolResult {
	const images: ToolContent[] = [];
	const entries = assignments.map(({ observation, ...assignment }) =>
		observation === undefined ? assignment : attributedEntry(assignment, observation, images),
	);
	return {
		content: [
			// Guidance first: clients that read the last text block still find the worker list there.
			...(spawn === undefined ? [] : [{ type: "text" as const, text: JSON.stringify({ spawn }) }]),
			{ type: "text", text: JSON.stringify(entries, null, 2) },
			...images,
		],
	};
}

function objectResult(value: unknown): ToolResult {
	return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

/** A user Take Over or Stop, or a pointer target outside the worker's region, answers as a refusal that provably sent nothing. */
async function refusingControl(run: () => Promise<ToolResult>): Promise<ToolResult> {
	try {
		return await run();
	} catch (error: unknown) {
		if (!(error instanceof WorkerControlRefusal || error instanceof WorkerRegionRefusal)) throw error;
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						error: error.message,
						reason: error.reason,
						actionDispatched: error instanceof WorkerRegionRefusal ? error.actionDispatched : false,
					}),
				},
			],
			isError: true,
		};
	}
}

/** `spawn` names how the connected harness starts one subagent per assigned worker; it rides on every assign answer. */
export function registerWorkerTools(
	server: McpServer,
	coordinator: WorkerCoordinator,
	spawn?: () => SpawnGuidance,
): void {
	server.registerTool(
		"manage_workers",
		{
			description:
				"Assign disjoint app tasks per session_id (default: default; worker names may repeat across sessions, app PIDs cannot), observe a worker for a fresh token, inspect assignments, release an idle worker or a whole session (release_session), or control one worker: pause (user Take Over; cancels its run, refuses runs until resume), stop (cancels and refuses until release), resume. agent_name and parent_agent_name name the cursor owner (default worker_id); cursor ids are opaque server keys.",
			inputSchema: manageWorkersSchema,
			annotations: { readOnlyHint: false, destructiveHint: true },
		},
		async (input) =>
			refusingControl(async () => {
				const request = workerManagementRequestSchema.parse(input);
				const session = request.session_id;
				const observation = (fields: {
					readonly include_screenshot?: boolean | undefined;
					readonly diff_only?: boolean | undefined;
					readonly max_elements?: number | undefined;
					readonly element_format?: "json" | "table" | undefined;
				}) => ({
					...(fields.include_screenshot === undefined ? {} : { includeScreenshot: fields.include_screenshot }),
					...(fields.max_elements === undefined ? {} : { maxElements: fields.max_elements }),
					...(fields.diff_only === undefined ? {} : { diffOnly: fields.diff_only }),
					...(fields.element_format === undefined ? {} : { elementFormat: fields.element_format }),
				});
				switch (request.op) {
					case "assign":
						return assignedResult(
							await coordinator.assign(request.assignments, session, observation(request)),
							spawn?.(),
						);
					case "status":
						return objectResult(coordinator.status(session));
					case "observe": {
						const observed = await coordinator.observe(request.worker_id, observation(request), session);
						const { result, ...attribution } = observed;
						return attributedResult(attribution, result);
					}
					case "release":
						coordinator.release(request.worker_id, session);
						return objectResult({ session_id: session ?? "default", released: request.worker_id });
					case "release_session":
						coordinator.releaseSession(session);
						return objectResult({ released_session: session ?? "default" });
					case "pause":
						return objectResult({
							session_id: session ?? "default",
							worker_id: request.worker_id,
							control: coordinator.pause(request.worker_id, session),
						});
					case "stop":
						return objectResult({
							session_id: session ?? "default",
							worker_id: request.worker_id,
							control: coordinator.stop(request.worker_id, session),
						});
					case "resume":
						return objectResult({
							session_id: session ?? "default",
							worker_id: request.worker_id,
							control: coordinator.resume(request.worker_id, session),
						});
				}
			}),
	);
	server.registerTool(
		"run_worker",
		{
			description:
				"Run ordered worker steps with session_id (default: default) and a one-use observation_token. Different apps run concurrently with isolated virtual cursors under background delivery. Text-only by default; expect verifies outcomes. Refusals set isError.",
			inputSchema: runWorkerSchema,
			annotations: { readOnlyHint: false, destructiveHint: true },
		},
		async (input, extra) =>
			refusingControl(async () => {
				const result: WorkerRunResult = await coordinator.run(
					input.worker_id,
					input.observation_token,
					parseRunSteps(input.steps, "run_worker"),
					expectFromInput(input.expect),
					{ fullState: input.full_state === true, includeScreenshot: input.include_screenshot === true },
					{ signal: extra.signal, ...(input.pace === undefined ? {} : { pace: input.pace }) },
					input.session_id,
				);
				const { result: innerResult, ...attribution } = result;
				return attributedResult(attribution, innerResult);
			}),
	);
}
