import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";

const appSchema = z.string().min(1);
const observationTokenSchema = z.string().min(1);
const elementIndexSchema = z.string();
const coordinateSchema = z.number();
const fullStateSchema = z.boolean().optional();
const includeScreenshotSchema = z.boolean().optional();

/** Upper bound for one verified field-update call, so a single request stays reviewable. */
const MAX_SET_FIELD_UPDATES = 10;
/** Upper bound for one ordered action batch, so a single request stays reviewable. */
export const MAX_RUN_STEPS = 20;
/** Maximum intermediate points in a single drag, keeping each gesture bounded. */
export const MAX_DRAG_WAYPOINTS = 100;
/** Upper bound for one wait_for step inside a batch. */
const MAX_WAIT_MILLISECONDS = 10_000;
/** Upper bound for the matches one element query answers with. */
const MAX_FIND_RESULTS = 25;

export const emptySchema = z.object({});

export const iosObserveSchema = z.object({});
export const iosScreenshotSchema = z.object({ path: z.string().min(1).optional() });
const phoneToken = { observation_token: observationTokenSchema };
const phonePoint = { x: z.number().finite(), y: z.number().finite() };
export const iosTapSchema = z.object({ ...phoneToken, ...phonePoint });
export const iosTapTextSchema = z.object({
	...phoneToken,
	query: z.string().min(1),
	index: z.number().int().nonnegative().optional(),
	exact: z.boolean().optional(),
});
export const iosLongPressSchema = z.object({
	...phoneToken,
	...phonePoint,
	duration_ms: z.number().positive().optional(),
});
const directions = z.enum(["up", "down", "left", "right"]);
const at = { at: z.object(phonePoint).optional() };
export const iosSwipeSchema = z.object({
	...phoneToken,
	direction: directions,
	distance: z.number().positive().optional(),
	kind: z.enum(["flick", "drag"]).optional(),
	...at,
});
export const iosScrollSchema = z.object({
	...phoneToken,
	direction: directions,
	amount: z.number().positive().optional(),
	borrow_pointer: z
		.boolean()
		.optional()
		.describe(
			"Allow the scroll to briefly borrow the person's real pointer; background delivery refuses a phone scroll without it.",
		),
	...at,
});
export const iosTypeTextSchema = z.object({
	...phoneToken,
	text: z.string(),
	mode: z.enum(["paste", "keystrokes"]).optional(),
});
export const iosPressKeysSchema = z.object({ ...phoneToken, combo: z.string().min(1) });
export const iosHomeSchema = z.object({ ...phoneToken });
export const iosAppSwitcherSchema = z.object({ ...phoneToken });
export const iosOpenAppSchema = z.object({ ...phoneToken, name: z.string().min(1) });

const iosRunStepSchema = z.discriminatedUnion("action", [
	z.object({
		action: z.literal("tap_text"),
		query: z.string().min(1),
		index: z.number().int().nonnegative().optional(),
		exact: z.boolean().optional(),
	}),
	z.object({ action: z.literal("tap"), ...phonePoint }),
	z.object({
		action: z.literal("swipe"),
		direction: directions,
		distance: z.number().positive().optional(),
		kind: z.enum(["flick", "drag"]).optional(),
		...at,
	}),
	z.object({
		action: z.literal("scroll"),
		direction: directions,
		amount: z.number().positive().optional(),
		borrow_pointer: z.boolean().optional(),
		...at,
	}),
	z.object({ action: z.literal("type_text"), text: z.string(), mode: z.enum(["paste", "keystrokes"]).optional() }),
	z.object({ action: z.literal("press_keys"), combo: z.string().min(1) }),
	z.object({ action: z.literal("home") }),
	z.object({ action: z.literal("app_switcher") }),
	z.object({
		action: z.literal("wait"),
		text: z.string().min(1),
		timeout_ms: z.number().int().min(1).max(10_000).default(3000),
	}),
]);

export type IosRunStep = z.infer<typeof iosRunStepSchema>;

export const iosRunSchema = z.object({
	...phoneToken,
	steps: z.array(iosRunStepSchema).min(1).max(8),
	expect: z.object({
		text: z.string().min(1).max(500),
		timeout_ms: z.number().int().min(1).max(10_000).default(3000),
	}),
});

const MAX_VERIFY_CHECKS = 10;

const verifyCheckFields = {
	element_index: elementIndexSchema,
	exists: z.boolean().optional(),
	value: z.string().optional(),
	label: z.string().optional(),
};

/**
 * The outcome an action promises to produce, checked after it dispatched (and, with a timeout,
 * polled until it holds). One shape is shared by verify_state, run_steps, and click_target so a
 * check written for one call means the same thing in the others.
 */
const verifyExpectSchema = z.object({
	checks: z.array(z.object(verifyCheckFields)).max(MAX_VERIFY_CHECKS).optional(),
	window_title: z.string().optional(),
	timeout_ms: z.number().int().positive().max(10_000).optional(),
});

/**
 * One described element: every field given must hold. Role matching ignores the AX prefix and
 * case; label matching collapses whitespace; the needles are case-insensitive substrings.
 */
export const elementQuerySchema = z
	.object({
		role: z.string().min(1).optional(),
		label: z.string().min(1).optional(),
		label_contains: z.string().min(1).optional(),
		value_contains: z.string().min(1).optional(),
		text: z.string().min(1).optional(),
	})
	.refine(
		(query) =>
			[query.role, query.label, query.label_contains, query.value_contains, query.text].some(
				(field) => field !== undefined,
			),
		{ message: "a query needs at least one of role, label, label_contains, value_contains, or text" },
	);

export const verifyStateSchema = z.object({
	app: appSchema,
	observation_token: observationTokenSchema,
	...verifyExpectSchema.shape,
});

export const getAppStateSchema = z.object({
	app: appSchema,
	profile: z.enum(["fast", "full", "visual"]).optional(),
	diff_only: z.boolean().optional(),
	include_screenshot: z.boolean().optional(),
	include_accessibility_tree: z.boolean().optional(),
	window_id: z.number().int().positive().optional(),
	settle_ms: z.number().int().nonnegative().optional(),
	max_elements: z.number().int().positive().optional(),
	include_menu_bar: z.boolean().optional(),
	subtree_of: z.number().int().nonnegative().optional(),
	element_format: z.enum(["json", "table"]).optional(),
});

/**
 * Modifier keys held for the whole gesture, like a person holding Command while clicking. Aliases are
 * accepted (cmd, opt, alt, ctrl) and normalized to command, option, control, shift.
 */
const modifiersSchema = z
	.array(z.enum(["command", "shift", "option", "control", "cmd", "opt", "alt", "ctrl"]))
	.max(4)
	.optional()
	.describe("Held during gesture; aliases cmd/opt/alt/ctrl. Sent to app, not real keyboard.");
const modifierFields = { modifiers: modifiersSchema };

const clickFields = {
	...modifierFields,
	element_index: elementIndexSchema.optional(),
	x: coordinateSchema.optional(),
	y: coordinateSchema.optional(),
	click_count: z.number().int().positive().optional(),
	mouse_button: z.enum(["left", "right", "middle"]).optional(),
};

export const clickSchema = z.object({
	app: appSchema,
	observation_token: observationTokenSchema,
	...clickFields,
	full_state: fullStateSchema,
	include_screenshot: includeScreenshotSchema,
});

export const findElementsSchema = z.object({
	app: appSchema,
	query: elementQuerySchema,
	window_id: z.number().int().positive().optional(),
	max_results: z.number().int().positive().max(MAX_FIND_RESULTS).optional(),
	max_elements: z.number().int().positive().optional(),
	include_screenshot: includeScreenshotSchema,
});

export const clickTargetSchema = z.object({
	app: appSchema,
	query: elementQuerySchema,
	window_id: z.number().int().positive().optional(),
	index: z.number().int().nonnegative().optional(),
	timeout_ms: z.number().int().nonnegative().max(10_000).optional(),
	press: z.enum(["auto", "accessibility", "pointer"]).optional(),
	hover_first: z.boolean().optional(),
	click_count: z.number().int().positive().optional(),
	mouse_button: z.enum(["left", "right", "middle"]).optional(),
	expect: verifyExpectSchema.optional(),
	full_state: fullStateSchema,
	include_screenshot: includeScreenshotSchema,
});

export const openAppSchema = z.object({
	name: z.string().min(1),
	timeout_ms: z.number().int().positive().max(30_000).optional(),
});

const performSecondaryActionFields = {
	element_index: elementIndexSchema,
	action: z.string().min(1),
};

export const performSecondaryActionSchema = z.object({
	app: appSchema,
	observation_token: observationTokenSchema,
	...performSecondaryActionFields,
	full_state: fullStateSchema,
	include_screenshot: includeScreenshotSchema,
});

const setValueFields = {
	element_index: elementIndexSchema,
	value: z.string(),
};

export const setValueSchema = z.object({
	app: appSchema,
	observation_token: observationTokenSchema,
	...setValueFields,
	full_state: fullStateSchema,
	include_screenshot: includeScreenshotSchema,
});

export const setFieldsSchema = z.object({
	app: appSchema,
	observation_token: observationTokenSchema,
	updates: z
		.array(
			z.object({
				element_index: elementIndexSchema,
				value: z.string(),
			}),
		)
		.min(1)
		.max(MAX_SET_FIELD_UPDATES),
	full_state: fullStateSchema,
	include_screenshot: includeScreenshotSchema,
});

const selectTextFields = {
	element_index: elementIndexSchema,
	text: z.string().optional(),
	prefix: z.string().optional(),
	suffix: z.string().optional(),
	selection: z.enum(["text", "before", "after"]).optional(),
};

export const selectTextSchema = z.object({
	app: appSchema,
	observation_token: observationTokenSchema,
	...selectTextFields,
	full_state: fullStateSchema,
	include_screenshot: includeScreenshotSchema,
});

const dragFields = {
	...modifierFields,
	from_x: coordinateSchema,
	from_y: coordinateSchema,
	to_x: coordinateSchema,
	to_y: coordinateSchema,
	duration_ms: z.number().finite().int().min(0).max(30_000).optional(),
	waypoints: z
		.array(z.object({ x: z.number().finite(), y: z.number().finite() }).strict())
		.max(MAX_DRAG_WAYPOINTS)
		.optional(),
	mouse_button: z.enum(["left", "right", "middle"]).optional(),
};

export const dragSchema = z.object({
	app: appSchema,
	observation_token: observationTokenSchema,
	...dragFields,
	full_state: fullStateSchema,
	include_screenshot: includeScreenshotSchema,
});

const scrollFields = {
	modifiers: modifiersSchema.describe(
		"Refused: modified wheel events do not scroll a background app, so nothing is dispatched.",
	),
	direction: z.enum(["up", "down", "left", "right"]),
	element_index: elementIndexSchema,
	pages: z.number().positive().optional(),
};

export const scrollSchema = z.object({
	app: appSchema,
	observation_token: observationTokenSchema,
	...scrollFields,
	full_state: fullStateSchema,
	include_screenshot: includeScreenshotSchema,
});

const typeTextFields = {
	text: z.string(),
};

export const typeTextSchema = z.object({
	app: appSchema,
	observation_token: observationTokenSchema,
	...typeTextFields,
	full_state: fullStateSchema,
	include_screenshot: includeScreenshotSchema,
});

const keySequenceEntrySchema = z.union([
	z.string().min(1),
	z.object({
		key: z.string().min(1),
		hold_seconds: z.number().nonnegative().optional(),
	}),
]);

const pressKeysFields = {
	keys: z.array(keySequenceEntrySchema).min(1),
	hold_seconds: z.number().nonnegative().optional(),
	interval_seconds: z.number().nonnegative().optional(),
};

export const pressKeysSchema = z.object({
	app: appSchema,
	observation_token: observationTokenSchema,
	...pressKeysFields,
	full_state: fullStateSchema,
	include_screenshot: includeScreenshotSchema,
});

/**
 * A step may name its element by id from the token observation, or describe it with `target`,
 * which is resolved against a fresh read of the window right before the step runs. That is what
 * lets one batch act on UI an earlier step created (a sheet, a menu, a new row).
 */
/** Upper bound for the pages one scroll-until-found search may scroll. */
const MAX_FIND_PAGES = 50;
export const DEFAULT_FIND_PAGES = 10;

/**
 * Look for the `target` past the edge of the window, the way a person scrolls to a row: check what is shown
 * (accessibility, and the window's pixels), scroll the scroll area one page, check again, stop at the first
 * sighting. Background-only: a page is an accessibility action on the scroll area, never the real wheel or pointer.
 */
const findSchema = z
	.object({
		scroll_within: z
			.union([elementIndexSchema, elementQuerySchema])
			.optional()
			.describe("Scrollable area to page: element_index or a query (default: the window's largest scroll area)."),
		direction: directions.optional().describe("Search direction (default down)."),
		max_pages: z
			.number()
			.int()
			.positive()
			.max(MAX_FIND_PAGES)
			.optional()
			.describe(`Pages to scroll before giving up (default ${DEFAULT_FIND_PAGES}, max ${MAX_FIND_PAGES}).`),
		vision: z
			.enum(["auto", "off", "only"])
			.optional()
			.describe(
				"auto (default): accessibility, then window-capture OCR when it has no match; off: accessibility only; only: OCR only. OCR needs Screen Recording and a text-bearing target (skipped with the reason otherwise); OCR hits can only be clicked.",
			),
	})
	.describe("Page-scroll until target appears; returns found_by, pages, and scrolled_into_view.");

const stepTargetFields = {
	target: elementQuerySchema.optional(),
	target_index: z.number().int().nonnegative().optional(),
	find: findSchema.optional(),
};
const optionalElementIndex = { element_index: elementIndexSchema.optional() };

/**
 * One ordered action inside a run_steps batch. Element steps name their element by id from the
 * token observation or by `target`; `wait_for` pauses the batch until the UI shows (or stops
 * showing) something, so a whole flow can run in one call without guessing sleeps.
 */
export const runStepSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("click"),
		...clickFields,
		context: z.boolean().optional().describe("Tool/color pick, re-applied in a shared window."),
		...stepTargetFields,
	}),
	z.object({
		type: z.literal("perform_secondary_action"),
		...performSecondaryActionFields,
		...optionalElementIndex,
		...stepTargetFields,
	}),
	z.object({ type: z.literal("set_value"), ...setValueFields, ...optionalElementIndex, ...stepTargetFields }),
	z.object({ type: z.literal("select_text"), ...selectTextFields, ...optionalElementIndex, ...stepTargetFields }),
	z.object({ type: z.literal("drag"), ...dragFields }),
	z.object({ type: z.literal("scroll"), ...scrollFields, ...optionalElementIndex, ...stepTargetFields }),
	/** Scroll the described target into view (default bounded find) and stop: no click, edit, or other action on it. */
	z
		.object({
			type: z.literal("reveal"),
			target: elementQuerySchema,
			target_index: stepTargetFields.target_index,
			find: findSchema.optional(),
		})
		.strict(),
	z.object({
		type: z.literal("wait_for"),
		target: elementQuerySchema.optional(),
		gone: z.boolean().optional(),
		window_title: z.string().min(1).optional(),
		timeout_ms: z.number().int().positive().max(MAX_WAIT_MILLISECONDS).optional(),
	}),
	z.object({ type: z.literal("type_text"), ...typeTextFields }),
	z.object({ type: z.literal("press_keys"), ...pressKeysFields }),
	z.object({ type: z.literal("invoke_menu"), path: z.array(z.string()).min(1).max(16) }),
	z.object({
		type: z.literal("set_window_frame"),
		x: z.number().finite(),
		y: z.number().finite(),
		width: z.number().positive().finite(),
		height: z.number().positive().finite(),
	}),
	z.object({
		type: z.literal("clipboard_write"),
		text: z.string().optional(),
		image_path: z.string().optional(),
		file_path: z.string().optional(),
	}),
]);

const paceSchema = z
	.enum(["verified", "fast"])
	.optional()
	.describe(
		"verified (default) reads before each element step; fast resolves known targets from one read, with cheap guards between steps. Unknown targets and wait_for still read; intermediate states are not read.",
	);

/** Published shape of `find`: field names and enums only; the strict {@link findSchema} does the real validation. */
const compactFindSchema = z
	.object({
		scroll_within: z
			.union([elementIndexSchema, z.record(z.string(), z.string())])
			.optional()
			.describe("Scrollable area (default largest): element_index or query."),
		direction: directions.optional().describe("default down"),
		max_pages: z
			.number()
			.int()
			.positive()
			.optional()
			.describe(`default ${DEFAULT_FIND_PAGES}, max ${MAX_FIND_PAGES}`),
		vision: z
			.enum(["auto", "off", "only"])
			.optional()
			.describe(
				"auto: accessibility then OCR; off: accessibility only; only: OCR only. OCR needs Screen Recording; hits can only be clicked.",
			),
	})
	.describe("Scroll until target appears; returns found_by and pages scrolled.");

const compactQuerySchema = z
	.object({
		role: z.string().optional(),
		label: z.string().optional(),
		label_contains: z.string().optional(),
		value_contains: z.string().optional(),
		text: z.string().optional(),
	})
	.describe("At least one field; all fields must match.");

const STEP_TYPES = [
	"click",
	"perform_secondary_action",
	"set_value",
	"select_text",
	"drag",
	"scroll",
	"reveal",
	"wait_for",
	"type_text",
	"press_keys",
	"invoke_menu",
	"set_window_frame",
	"clipboard_write",
] as const;

/**
 * The step shape a client sees: one flat object listing every step field once, so the published schema stays
 * small. It is deliberately permissive; {@link parseRunSteps} checks each step against the strict per-type
 * {@link runStepSchema} before anything is dispatched.
 */
export const compactStepSchema = z.object({
	type: z
		.enum(STEP_TYPES)
		.describe(
			"Element steps use element_index or target, not both; target resolves before dispatch. reveal only scrolls.",
		),
	element_index: elementIndexSchema.optional(),
	target: compactQuerySchema.optional(),
	target_index: z.number().int().nonnegative().optional(),
	find: compactFindSchema.optional(),
	x: coordinateSchema.optional().describe("click: screenshot x; set_window_frame: window x."),
	y: coordinateSchema.optional(),
	click_count: z.number().int().positive().optional(),
	mouse_button: z.enum(["left", "right", "middle"]).optional(),
	context: z.boolean().optional().describe("click: tool/color pick, re-applied in a shared window."),
	modifiers: modifiersSchema,
	action: z.string().optional(),
	value: z.string().optional(),
	text: z.string().optional(),
	prefix: z.string().optional(),
	suffix: z.string().optional(),
	selection: z.enum(["text", "before", "after"]).optional(),
	from_x: coordinateSchema.optional(),
	from_y: coordinateSchema.optional(),
	to_x: coordinateSchema.optional(),
	to_y: coordinateSchema.optional(),
	duration_ms: dragFields.duration_ms,
	waypoints: z
		.array(z.object({ x: z.number().finite(), y: z.number().finite() }).strict())
		.max(MAX_DRAG_WAYPOINTS)
		.optional()
		.describe("Screenshot-local drag waypoints."),
	direction: directions.optional(),
	pages: z.number().positive().optional(),
	gone: z.boolean().optional(),
	window_title: z.string().optional(),
	timeout_ms: z.number().int().positive().optional(),
	keys: z.array(keySequenceEntrySchema).optional(),
	hold_seconds: z.number().nonnegative().optional(),
	interval_seconds: z.number().nonnegative().optional(),
	path: z.array(z.string()).optional().describe('Menu path, e.g. ["File","New Tab"].'),
	width: z.number().optional(),
	height: z.number().optional(),
	image_path: z.string().optional(),
	file_path: z.string().optional(),
});

export type CompactStep = z.infer<typeof compactStepSchema>;

export const compactStepsSchema = z.array(compactStepSchema).min(1).max(MAX_RUN_STEPS);
const workerStepsSchema = z.array(z.unknown()).min(1).max(MAX_RUN_STEPS);

/**
 * Validate every step of a batch against the strict per-type schema, before anything is dispatched. A bad step
 * refuses the whole call (an invalid-params error naming where it sits and what is wrong) instead of failing midway.
 */
export function parseRunSteps(steps: readonly unknown[], tool: string, where = "steps"): RunStep[] {
	return steps.map((step, index) => {
		const parsed = runStepSchema.safeParse(step);
		if (parsed.success) {
			return parsed.data;
		}
		const issues = parsed.error.issues
			.map((issue) => `${issue.path.length === 0 ? "" : `${issue.path.join(".")}: `}${issue.message}`)
			.join("; ");
		const type =
			typeof step === "object" && step !== null && "type" in step && typeof step.type === "string"
				? step.type
				: "unknown";
		throw new McpError(
			ErrorCode.InvalidParams,
			`Input validation error: Invalid arguments for tool ${tool}: ${where}[${index}] (${type}): ${issues}`,
		);
	});
}

export const runStepsSchema = z.object({
	app: appSchema,
	observation_token: observationTokenSchema,
	steps: compactStepsSchema,
	expect: verifyExpectSchema.optional(),
	pace: paceSchema,
	full_state: fullStateSchema,
	include_screenshot: includeScreenshotSchema,
});

/**
 * One human-like batch: separate keyboard and pointer lanes plus an optional vision capture,
 * scheduled over explicit resources. The published step shape stays on `run_steps`; each lane
 * is validated against the strict per-type schema before any input is dispatched.
 */
export const runHandsSchema = z
	.object({
		app: appSchema,
		observation_token: observationTokenSchema,
		keyboard: workerStepsSchema
			.describe("Same step objects as run_steps.steps; only type_text and press_keys.")
			.optional(),
		pointer: workerStepsSchema
			.describe("Same step objects as run_steps.steps; only click, drag, and scroll with explicit targets.")
			.optional(),
		vision: z
			.object({
				include_screenshot: includeScreenshotSchema.describe("default true"),
				settle_ms: z.number().int().nonnegative().optional(),
				max_elements: z.number().int().positive().optional(),
			})
			.optional(),
		overlap: z
			.enum(["auto", "never", "always"])
			.optional()
			.describe(
				"auto (default) overlaps lanes with disjoint resources; never serializes; always is refused when lanes share a resource.",
			),
		outcome: z
			.enum(["live", "deferred"])
			.optional()
			.describe(
				"deferred (default) skips the result read; the next token's element ids predate the action. live reads the result state as before.",
			),
		expect: verifyExpectSchema.optional(),
		full_state: fullStateSchema,
		include_screenshot: includeScreenshotSchema,
	})
	.refine((input) => input.keyboard !== undefined || input.pointer !== undefined || input.vision !== undefined, {
		message: "run_hands needs at least one of keyboard, pointer, or vision",
	});

function hasControlCharacter(value: string): boolean {
	return Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

/** Worker names become cursor owners, so they follow the same rule withCursorIdentity enforces. */
const workerIdSchema = z
	.string()
	.min(1)
	.max(128)
	.refine((value) => value.trim().length > 0 && !hasControlCharacter(value), {
		message: "must not be blank or contain control characters",
	});
const agentNameSchema = z
	.string()
	.trim()
	.min(1)
	.max(128)
	.refine((value) => !hasControlCharacter(value), { message: "must not contain control characters" });

const workerAssignmentsSchema = z
	.array(
		z.object({
			worker_id: workerIdSchema,
			task: z.string().min(1),
			app: appSchema,
			agent_name: agentNameSchema.optional(),
			parent_agent_name: agentNameSchema.optional(),
			region: z
				.object({
					x: z.number().finite(),
					y: z.number().finite(),
					width: z.number().finite().positive(),
					height: z.number().finite().positive(),
				})
				.optional()
				.describe("Shared surface: disjoint pointer box, screenshot px like click x/y."),
		}),
	)
	.min(1)
	.max(6);

const workerSessionFields = {
	session_id: z.string().min(1).max(128).optional(),
};
const workerObservationFields = {
	include_screenshot: includeScreenshotSchema,
	max_elements: z.number().int().positive().optional(),
	diff_only: z.boolean().optional(),
	element_format: z.enum(["json", "table"]).optional(),
};

export const manageWorkersSchema = z.object({
	...workerSessionFields,
	op: z.enum(["assign", "status", "observe", "release", "release_session", "pause", "stop", "resume"]),
	assignments: workerAssignmentsSchema.optional(),
	worker_id: z.string().min(1).optional(),
	...workerObservationFields,
});

/** The published schema stays flat; each operation is checked before coordinator state changes. */
export const workerManagementRequestSchema = z.discriminatedUnion("op", [
	z.object({
		...workerSessionFields,
		op: z.literal("assign"),
		assignments: workerAssignmentsSchema,
		...workerObservationFields,
	}),
	z.object({ ...workerSessionFields, op: z.literal("status") }),
	z.object({
		...workerSessionFields,
		op: z.literal("observe"),
		worker_id: z.string().min(1),
		...workerObservationFields,
	}),
	z.object({ ...workerSessionFields, op: z.literal("release"), worker_id: z.string().min(1) }),
	z.object({ ...workerSessionFields, op: z.literal("release_session") }),
	z.object({ ...workerSessionFields, op: z.literal("pause"), worker_id: z.string().min(1) }),
	z.object({ ...workerSessionFields, op: z.literal("stop"), worker_id: z.string().min(1) }),
	z.object({ ...workerSessionFields, op: z.literal("resume"), worker_id: z.string().min(1) }),
]);

export const runWorkerSchema = z.object({
	...workerSessionFields,
	worker_id: z.string().min(1),
	observation_token: observationTokenSchema,
	steps: workerStepsSchema,
	expect: verifyExpectSchema.optional(),
	pace: paceSchema,
	full_state: fullStateSchema,
	include_screenshot: includeScreenshotSchema,
});

/** Upper bound for the apps one parallel call observes or drives. */
const MAX_PARALLEL_APPS = 6;

export const observeAppsSchema = z.object({
	apps: z.array(appSchema).min(2).max(MAX_PARALLEL_APPS),
	include_screenshot: includeScreenshotSchema,
	diff_only: z.boolean().optional(),
	max_elements: z.number().int().positive().optional(),
	element_format: z.enum(["json", "table"]).optional(),
});

export const runParallelSchema = z.object({
	batches: z
		.array(
			z.object({
				app: appSchema,
				observation_token: observationTokenSchema,
				// The step shape is published once, on run_steps; every batch step is still checked strictly before any
				// batch runs (parseRunSteps), exactly as run_worker does, so the list does not carry it twice.
				steps: workerStepsSchema.describe("Same step objects as run_steps.steps."),
				expect: verifyExpectSchema.optional(),
			}),
		)
		.min(2)
		.max(MAX_PARALLEL_APPS)
		.refine((batches) => new Set(batches.map((batch) => batch.app)).size === batches.length, {
			message: "each batch must drive a different app",
		}),
	pace: paceSchema,
	full_state: fullStateSchema,
	include_screenshot: includeScreenshotSchema,
});

export type ClickInput = z.infer<typeof clickSchema>;
export type DragInput = z.infer<typeof dragSchema>;
export type PressKeysInput = z.infer<typeof pressKeysSchema>;
export type SelectTextInput = z.infer<typeof selectTextSchema>;
export type RunStep = z.infer<typeof runStepSchema>;
export type RunStepsInput = z.infer<typeof runStepsSchema>;
export type RunHandsInput = z.infer<typeof runHandsSchema>;

export type ClickActionInput = Omit<ClickInput, "app" | "observation_token" | "full_state">;
export type DragActionInput = Omit<DragInput, "app" | "observation_token" | "full_state">;
export type PressKeysActionInput = Omit<PressKeysInput, "app" | "observation_token" | "full_state">;
export type SelectTextActionInput = Omit<SelectTextInput, "app" | "observation_token" | "full_state">;
