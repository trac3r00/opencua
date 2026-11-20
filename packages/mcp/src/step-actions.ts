import { parseElementIndex, withContextClick } from "@opencua/core";
import type { ElementQuery, GuardedComputerInterface, InputObservation, Point } from "@opencua/core";
import type { RunStepDriver, StepDispatchOptions, StepTarget, StepWait, VerifyRequest } from "./guarded-session.js";
import { validateElement } from "./guarded-session.js";
import {
	click,
	drag,
	pressKeys,
	scroll,
	selectText,
	typeText,
	validateClick,
	validateDrag,
} from "./mutation-actions.js";
import { dispatchPowerStep } from "./power-tools.js";
import type { StepFind } from "./scroll-find.js";
import type { StepDispatch } from "./tool-result.js";
import { DEFAULT_FIND_PAGES } from "./tool-schemas.js";
import type { RunStep, RunStepsInput } from "./tool-schemas.js";

const DEFAULT_WAIT_MILLISECONDS = 2_000;

type TargetQueryInput = NonNullable<Extract<RunStep, { type: "click" }>["target"]>;

function toElementQuery(input: TargetQueryInput): ElementQuery {
	return {
		...(input.role === undefined ? {} : { role: input.role }),
		...(input.label === undefined ? {} : { label: input.label }),
		...(input.label_contains === undefined ? {} : { labelContains: input.label_contains }),
		...(input.value_contains === undefined ? {} : { valueContains: input.value_contains }),
		...(input.text === undefined ? {} : { text: input.text }),
	};
}

export function expectFromInput(expect: RunStepsInput["expect"]): VerifyRequest | undefined {
	if (expect === undefined) {
		return undefined;
	}
	return {
		...(expect.checks === undefined ? {} : { checks: expect.checks }),
		...(expect.window_title === undefined ? {} : { windowTitle: expect.window_title }),
		...(expect.timeout_ms === undefined ? {} : { timeoutMs: expect.timeout_ms }),
	};
}

function stepElementIndex(step: RunStep): number | undefined {
	return "element_index" in step && step.element_index !== undefined
		? parseElementIndex(step.element_index)
		: undefined;
}

type FindInput = NonNullable<Extract<RunStep, { type: "click" }>["find"]>;

function toStepFind(input: FindInput): StepFind {
	const within = input.scroll_within;
	return {
		...(within === undefined
			? {}
			: {
					scrollWithin:
						typeof within === "string"
							? { elementIndex: parseElementIndex(within) }
							: { query: toElementQuery(within) },
				}),
		direction: input.direction ?? "down",
		maxPages: input.max_pages ?? DEFAULT_FIND_PAGES,
		vision: input.vision ?? "auto",
	};
}

function stepTarget(step: RunStep): StepTarget | undefined {
	if (step.type === "wait_for" || !("target" in step) || step.target === undefined) {
		return undefined;
	}
	return {
		query: toElementQuery(step.target),
		index: step.target_index ?? 0,
		...(step.find === undefined
			? step.type === "reveal"
				? { find: toStepFind({}) }
				: {}
			: { find: toStepFind(step.find) }),
	};
}

function stepWait(step: RunStep): StepWait | undefined {
	if (step.type !== "wait_for") {
		return undefined;
	}
	return {
		...(step.target === undefined ? {} : { query: toElementQuery(step.target) }),
		gone: step.gone === true,
		...(step.window_title === undefined ? {} : { windowTitle: step.window_title }),
		timeoutMs: step.timeout_ms ?? DEFAULT_WAIT_MILLISECONDS,
	};
}

function resolveStepElement(step: RunStep, elementIndex: number): RunStep {
	return "target" in step && step.type !== "wait_for" && step.type !== "reveal"
		? { ...step, element_index: String(elementIndex), target: undefined, find: undefined }
		: step;
}

/**
 * The step aimed at a screen point where text was read from the window's pixels. Only a click can act on
 * a point: every other step needs the element behind it.
 */
function resolveStepAtPoint(step: RunStep, observation: InputObservation, point: Point): RunStep {
	if (step.type === "reveal") {
		// Revealing OCR text sends no input, so the point is not needed.
		return step;
	}
	if (step.type !== "click") {
		throw new Error(
			`${step.type} cannot act on text found only in the window's pixels (no accessibility element matched); use find.vision "off" or a target accessibility can match`,
		);
	}
	const viewport = observation.screenshotViewport;
	const x = ((point.x - viewport.bounds.x) / viewport.bounds.width) * viewport.width;
	const y = ((point.y - viewport.bounds.y) / viewport.bounds.height) * viewport.height;
	return {
		...step,
		element_index: undefined,
		target: undefined,
		find: undefined,
		x: Math.min(Math.max(0, x), viewport.width - 1),
		y: Math.min(Math.max(0, y), viewport.height - 1),
	};
}

function validateStep(step: RunStep, observation: InputObservation): void {
	if (step.type === "wait_for") {
		if (step.target === undefined && step.window_title === undefined) {
			throw new Error("wait_for needs a target, a window_title, or both");
		}
		return;
	}
	if ("find" in step && step.find !== undefined && step.target === undefined) {
		throw new Error(`${step.type} gives find, which needs a target to look for`);
	}
	if ("target" in step && step.target !== undefined) {
		const clickPoint = step.type === "click" && (step.x !== undefined || step.y !== undefined);
		if (("element_index" in step && step.element_index !== undefined) || clickPoint) {
			throw new Error(`${step.type} names its element with target, so it must not also give element_index or x/y`);
		}
		const within = step.find?.scroll_within;
		if (typeof within === "string") {
			validateElement(observation, parseElementIndex(within));
		}
		return;
	}
	switch (step.type) {
		case "click":
			validateClick(step, observation);
			return;
		case "drag":
			validateDrag(step, observation);
			return;
		case "perform_secondary_action":
		case "set_value":
		case "select_text":
		case "scroll":
			validateElement(observation, requiredElementIndex(step));
			return;
		case "open_url":
			if (!URL.canParse(step.url)) {
				throw new Error("open_url needs an absolute URL with a scheme (zoommtg://..., https://...)");
			}
			return;
		case "clipboard_write":
			if ([step.text, step.image_path, step.file_path].filter((value) => value !== undefined).length !== 1) {
				throw new Error("clipboard_write requires exactly one of text, image_path, or file_path");
			}
			return;
		default:
			return;
	}
}

function requiredElementIndex(step: RunStep): number {
	const index = stepElementIndex(step);
	if (index === undefined) {
		throw new Error(`${step.type} needs element_index or target`);
	}
	return index;
}

async function dispatchStep(
	computer: GuardedComputerInterface,
	step: RunStep,
	targetPid: number,
	observation: InputObservation,
	actions?: readonly string[],
	options?: StepDispatchOptions,
): Promise<StepDispatch> {
	const power = await dispatchPowerStep(computer, step, targetPid, observation);
	if (power !== undefined) {
		return power;
	}
	switch (step.type) {
		case "click":
			return step.context === true
				? await withContextClick(() => click(computer, targetPid, observation, step, actions))
				: await click(computer, targetPid, observation, step, actions);
		case "perform_secondary_action":
			await computer.performAction(targetPid, requiredElementIndex(step), step.action);
			return { route: "accessibility", delivery: "background" };
		case "set_value":
			await computer.setValue(targetPid, requiredElementIndex(step), step.value);
			return { route: "accessibility", delivery: "background" };
		case "select_text": {
			const index = requiredElementIndex(step);
			return await selectText(computer, targetPid, index, { ...step, element_index: String(index) });
		}
		case "drag":
			return await drag(computer, targetPid, observation, step);
		case "scroll":
			return await scroll(computer, targetPid, requiredElementIndex(step), step);
		case "reveal":
			// The guarded find already scrolled the target into view; revealing never acts on it.
			return { route: "accessibility", delivery: "background" };
		case "type_text":
			return await typeText(computer, targetPid, step.text, options);
		case "press_keys":
			return await pressKeys(computer, targetPid, step);
		default:
			throw new Error(`run_steps does not dispatch step type ${step.type}`);
	}
}

export function createRunStepDriver(computer: GuardedComputerInterface): RunStepDriver {
	return {
		elementIndex: stepElementIndex,
		target: stepTarget,
		wait: stepWait,
		resolve: resolveStepElement,
		resolveAtPoint: resolveStepAtPoint,
		validate: validateStep,
		dispatch: async (step, targetPid, observation, actions, options) =>
			await dispatchStep(computer, step, targetPid, observation, actions, options),
	};
}
