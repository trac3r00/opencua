import {
	AX_PRESS_ACTION,
	clickPoint,
	normalizeModifiers,
	parseElementIndex,
	pressElement,
	pressKeySequence,
	scrollElement,
	withTargetedApp,
} from "@opencua/core";
import type {
	ComputerInterface,
	ComputerUseMouseButton,
	InputObservation,
	KeyModifierName,
	KeySequenceEntry,
	KeySequenceOptions,
	Point,
	Rect,
	ScrollOptions,
} from "@opencua/core";
import { observedPointToScreen, validateElement, validatePoint } from "./guarded-session.js";
import type { ActionDelivery, ActionDispatch } from "./tool-result.js";
import { keySequenceEntries } from "./tool-schemas.js";
import type { ClickActionInput, DragActionInput, PressKeysActionInput, SelectTextActionInput } from "./tool-schemas.js";

export function validateClick(input: ClickActionInput, observation: InputObservation): void {
	if (input.element_index !== undefined) {
		validateElement(observation, parseElementIndex(input.element_index));
		return;
	}
	validatePoint(observation, clickPointInput(input.x, input.y));
}

export async function click(
	computer: ComputerInterface,
	targetPid: number,
	observation: InputObservation,
	input: ClickActionInput,
	actions?: readonly string[],
): Promise<ActionDispatch> {
	const pressCount = Math.max(1, Math.trunc(input.click_count ?? 1));
	const button = input.mouse_button ?? "left";
	const modifiers = normalizeModifiers(input.modifiers);
	if (input.element_index !== undefined) {
		const index = parseElementIndex(input.element_index);
		if (computer.delivery === "attended") {
			// Attended delivery drives the real pointer: the element's centre is clicked through the HID tap.
			const centre = await elementCentre(computer, targetPid, index, "click");
			return await clickScreenPoint(computer, targetPid, centre, button, pressCount, modifiers, false);
		}
		if (button === "right" && modifiers.length === 0 && pressCount === 1 && actions?.includes("AXShowMenu")) {
			await computer.performAction(targetPid, index, "AXShowMenu");
			return { route: "accessibility", delivery: "background" };
		}
		if (modifiers.length > 0 || button !== "left") {
			// AXPress is a plain left press: it carries no modifiers and cannot be a right or middle click (pressing
			// a Delete button instead of opening its context menu). Without AXShowMenu, aim the pointer at its centre.
			const gesture = button === "left" ? "click with modifiers" : `${button}-click`;
			const centre = await elementCentre(computer, targetPid, index, gesture);
			return await clickScreenPoint(computer, targetPid, centre, button, pressCount, modifiers);
		}
		if (
			computer.delivery === "background" &&
			computer.isWebElement !== undefined &&
			(await computer.isWebElement(targetPid, index))
		) {
			const centre = await elementCentre(computer, targetPid, index, "click");
			return await clickScreenPoint(computer, targetPid, centre, button, pressCount, modifiers, false);
		}
		try {
			await pressElement(computer, targetPid, index);
		} catch (error: unknown) {
			const centre = await unsupportedPressFallbackPoint(computer, targetPid, index, error);
			const dispatch = await clickScreenPoint(computer, targetPid, centre, button, pressCount, modifiers);
			return { ...dispatch, fallback: { from: "accessibility", reason: errorMessage(error) } };
		}
		for (let pressIndex = 1; pressIndex < pressCount; pressIndex += 1) {
			await pressElement(computer, targetPid, index);
		}
		return { route: "accessibility", delivery: "background" };
	}
	const point = observedPointToScreen(observation, clickPointInput(input.x, input.y));
	return await clickScreenPoint(computer, targetPid, point, button, pressCount, modifiers);
}

/**
 * The on-screen centre of an observed element, for gestures accessibility actions cannot perform
 * (they carry no modifier keys and no wheel). Refuses when the element has no frame to aim at.
 */
async function elementCentre(
	computer: ComputerInterface,
	targetPid: number,
	index: number,
	gesture: string,
): Promise<Point> {
	const frame = await elementFrame(computer, targetPid, index, gesture);
	return { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
}

async function elementFrame(
	computer: ComputerInterface,
	targetPid: number,
	index: number,
	gesture: string,
): Promise<Rect> {
	const frame = computer.elementFrame === undefined ? undefined : await computer.elementFrame(targetPid, index);
	if (
		frame === undefined ||
		!Number.isFinite(frame.x) ||
		!Number.isFinite(frame.y) ||
		!Number.isFinite(frame.width) ||
		!Number.isFinite(frame.height) ||
		frame.width <= 0 ||
		frame.height <= 0
	) {
		throw new Error(`cannot ${gesture}: element ${index} has no on-screen frame to aim the pointer at`);
	}
	return frame;
}

/** Accessibility refusals of the press itself (not identity or safety refusals) can fall back to a click. */
const AX_PRESS_FAILURE = /failed with AXError -?\d+/;

/**
 * The next rung when a control rejects AXPress: its on-screen centre, so the same element is
 * clicked through the pointer route instead of the action failing. Anything that is not an
 * accessibility refusal of the press — a recycled control, an unobserved id — is rethrown, because
 * falling back there would click something the caller never observed.
 */
async function unsupportedPressFallbackPoint(
	computer: ComputerInterface,
	targetPid: number,
	index: number,
	error: unknown,
): Promise<Point> {
	if (!AX_PRESS_FAILURE.test(errorMessage(error)) || computer.elementFrame === undefined) {
		throw error;
	}
	const frame = await computer.elementFrame(targetPid, index);
	if (frame === undefined || frame.width <= 0 || frame.height <= 0) {
		throw error;
	}
	return { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
}

async function clickScreenPoint(
	computer: ComputerInterface,
	targetPid: number,
	point: Point,
	button: ComputerUseMouseButton,
	pressCount: number,
	modifiers: ReadonlyArray<KeyModifierName>,
	allowAccessibilityHitTest = true,
): Promise<ActionDispatch> {
	// An accessibility press at the point cannot carry modifiers, so a modified click is always a pointer click.
	// Attended delivery always clicks with the real pointer.
	if (allowAccessibilityHitTest && computer.delivery !== "attended" && button === "left" && modifiers.length === 0) {
		let pressedAll = true;
		for (let pressIndex = 0; pressIndex < pressCount; pressIndex += 1) {
			if (!(await computer.pressAtPosition(targetPid, point))) {
				pressedAll = false;
				break;
			}
		}
		if (pressedAll) {
			return { route: "synthetic_events", delivery: "background" };
		}
	}
	await withTargetedApp(computer, targetPid, async () => {
		await clickPoint(computer, point, button, pressCount, modifiers);
	});
	return { route: "synthetic_events", delivery: syntheticDelivery(computer) };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** One control a caller described instead of naming by id, with the traits the route decision needs. */
export interface ResolvedTargetClick {
	readonly elementIndex: number;
	readonly actions: readonly string[];
	readonly frame: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
	readonly press?: "auto" | "accessibility" | "pointer" | undefined;
	readonly hoverFirst?: boolean | undefined;
	readonly clickCount?: number | undefined;
	readonly mouseButton?: "left" | "right" | "middle" | undefined;
}

/**
 * Click a control the caller resolved by description rather than by id: hover to it first when
 * asked, then press it through its accessibility action when the control advertises one and the
 * caller did not ask for the pointer route, or click its centre otherwise. Coordinates are only
 * resolved on the routes that need them, so an offscreen but pressable control still works.
 */
export async function clickResolvedTarget(
	computer: ComputerInterface,
	targetPid: number,
	observation: InputObservation,
	target: ResolvedTargetClick,
): Promise<ActionDispatch> {
	const pressCount = Math.max(1, Math.trunc(target.clickCount ?? 1));
	const button: ComputerUseMouseButton = target.mouseButton ?? "left";
	// Attended delivery clicks with the real pointer unless the caller explicitly asked for the accessibility press.
	const attendedPointer = computer.delivery === "attended" && target.press !== "accessibility";
	if (
		button === "right" &&
		pressCount === 1 &&
		target.press !== "pointer" &&
		!attendedPointer &&
		target.actions.includes("AXShowMenu")
	) {
		if (target.hoverFirst === true) {
			await computer.move(
				observedPointToScreen(observation, {
					x: target.frame.x + target.frame.width / 2,
					y: target.frame.y + target.frame.height / 2,
				}),
			);
		}
		await computer.performAction(targetPid, target.elementIndex, "AXShowMenu");
		return { route: "accessibility", delivery: "background" };
	}
	const webElementRoute =
		button === "left" &&
		(target.press === undefined || target.press === "auto") &&
		computer.delivery === "background" &&
		computer.isWebElement !== undefined &&
		(await computer.isWebElement(targetPid, target.elementIndex));
	const pointerRoute = target.press === "pointer" || button !== "left" || webElementRoute || attendedPointer;
	if (
		pointerRoute &&
		(!Number.isFinite(target.frame.x) ||
			!Number.isFinite(target.frame.y) ||
			!Number.isFinite(target.frame.width) ||
			!Number.isFinite(target.frame.height) ||
			target.frame.width <= 0 ||
			target.frame.height <= 0)
	) {
		throw new Error(`cannot click: element ${target.elementIndex} has no usable on-screen frame`);
	}
	const accessibilityRoute =
		button === "left" &&
		(target.press === "accessibility" || (!pointerRoute && target.actions.includes(AX_PRESS_ACTION)));
	const centre = {
		x: target.frame.x + target.frame.width / 2,
		y: target.frame.y + target.frame.height / 2,
	};
	if (accessibilityRoute) {
		if (target.hoverFirst === true) {
			await computer.move(observedPointToScreen(observation, centre));
		}
		for (let pressIndex = 0; pressIndex < pressCount; pressIndex += 1) {
			await pressElement(computer, targetPid, target.elementIndex);
		}
		return { route: "accessibility", delivery: "background" };
	}
	const centreScreen = webElementRoute
		? await elementCentre(computer, targetPid, target.elementIndex, "click")
		: observedPointToScreen(observation, centre);
	if (target.hoverFirst === true) {
		await computer.move(centreScreen);
	}
	if (button === "left" && target.press !== "pointer" && !webElementRoute && !attendedPointer) {
		let pressedAll = true;
		for (let pressIndex = 0; pressIndex < pressCount; pressIndex += 1) {
			if (!(await computer.pressAtPosition(targetPid, centreScreen))) {
				pressedAll = false;
				break;
			}
		}
		if (pressedAll) {
			return { route: "synthetic_events", delivery: "background" };
		}
	}
	await withTargetedApp(computer, targetPid, async () => {
		await clickPoint(computer, centreScreen, button, pressCount);
	});
	return { route: "synthetic_events", delivery: syntheticDelivery(computer) };
}

export function validateDrag(input: DragActionInput, observation: InputObservation): void {
	validatePoint(observation, { x: input.from_x, y: input.from_y });
	for (const waypoint of input.waypoints ?? []) {
		validatePoint(observation, waypoint);
	}
	validatePoint(observation, { x: input.to_x, y: input.to_y });
}

export async function drag(
	computer: ComputerInterface,
	targetPid: number,
	observation: InputObservation,
	input: DragActionInput,
): Promise<ActionDispatch> {
	const from = observedPointToScreen(observation, { x: input.from_x, y: input.from_y });
	const waypoints = input.waypoints?.map((point) => observedPointToScreen(observation, point));
	const to = observedPointToScreen(observation, { x: input.to_x, y: input.to_y });
	const modifiers = normalizeModifiers(input.modifiers);
	await withTargetedApp(computer, targetPid, async () => {
		await computer.drag({
			from,
			to,
			...(waypoints === undefined ? {} : { waypoints }),
			...(input.mouse_button === undefined ? {} : { button: input.mouse_button }),
			...(input.duration_ms === undefined ? {} : { duration: input.duration_ms }),
			...(modifiers.length === 0 ? {} : { modifiers }),
		});
	});
	return { route: "synthetic_events", delivery: syntheticDelivery(computer) };
}

/**
 * Why a scroll with modifier keys is refused. Verified live against a Finder list in the background: wheel
 * events posted to the app's process with modifier flags do not scroll it, yet the post itself reports
 * success, so sending them would claim a scroll that never happened.
 */
const SCROLL_MODIFIERS_REFUSAL =
	"scroll with modifiers is refused: wheel events with modifier keys do not scroll a background app's view (they are accepted and then ignored), so nothing was sent. Scroll without modifiers (a page-scroll accessibility action), or use `find` on a target to scroll until it is shown.";

/**
 * Scroll an observed element by pages through its page-scroll accessibility action, which works while the
 * app is in the background. Modifier keys cannot ride on an accessibility action, and the wheel route that
 * could carry them does not scroll a background app, so a scroll with modifiers is refused before anything
 * is dispatched.
 */
export async function scroll(
	computer: ComputerInterface,
	targetPid: number,
	elementIndex: number,
	input: {
		readonly direction: ScrollOptions["direction"];
		readonly pages?: number | undefined;
		readonly modifiers?: ReadonlyArray<KeyModifierName> | undefined;
	},
): Promise<ActionDispatch> {
	const modifiers = normalizeModifiers(input.modifiers);
	if (computer.delivery === "attended") {
		// Attended delivery scrolls with the real wheel: the pointer goes to the element's centre and each page is
		// nine tenths of the element's height, in pixels.
		const frame = await elementFrame(computer, targetPid, elementIndex, "scroll");
		const pages = Math.max(1, Math.trunc(input.pages ?? 1));
		await withTargetedApp(computer, targetPid, async () => {
			await computer.scroll({
				direction: input.direction,
				amount: Math.max(1, Math.round(frame.height * 0.9)) * pages,
				position: { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 },
				...(modifiers.length === 0 ? {} : { modifiers }),
			});
		});
		return { route: "synthetic_events", delivery: syntheticDelivery(computer) };
	}
	if (modifiers.length > 0) {
		throw new Error(SCROLL_MODIFIERS_REFUSAL);
	}
	await scrollElement(computer, targetPid, elementIndex, input.direction, input.pages ?? 1);
	return { route: "accessibility", delivery: "background" };
}

export async function typeText(
	computer: ComputerInterface,
	targetPid: number,
	text: string,
	options?: { readonly settleWrite?: boolean },
): Promise<ActionDispatch> {
	// The published core declaration can lag the source during a workspace typecheck. The
	// implementation accepts the optional settle option; this adapter keeps that call typed
	// without depending on a rebuilt declaration file.
	const typeIntoFocused: (
		targetPid: number,
		text: string,
		options?: { readonly settleWrite?: boolean },
	) => Promise<boolean> = computer.typeIntoFocused.bind(computer);
	// Attended delivery types through the HID tap into the focused element; background writes it through accessibility.
	if (computer.delivery !== "attended" && (await typeIntoFocused(targetPid, text, options))) {
		return { route: "accessibility", delivery: "background" };
	}
	await withTargetedApp(computer, targetPid, async () => {
		await computer.type(text);
	});
	return { route: "synthetic_events", delivery: syntheticDelivery(computer) };
}

export async function selectText(
	computer: ComputerInterface,
	targetPid: number,
	elementIndex: number,
	input: SelectTextActionInput,
): Promise<ActionDispatch> {
	await computer.selectText(targetPid, elementIndex, {
		selection: input.selection ?? "text",
		...(input.text !== undefined ? { text: input.text } : {}),
		...(input.prefix !== undefined ? { prefix: input.prefix } : {}),
		...(input.suffix !== undefined ? { suffix: input.suffix } : {}),
	});
	return { route: "accessibility", delivery: "background" };
}

export async function pressKeys(
	computer: ComputerInterface,
	targetPid: number,
	input: PressKeysActionInput,
): Promise<ActionDispatch> {
	await withTargetedApp(computer, targetPid, async () => {
		await pressKeySequence(
			computer,
			keySequenceEntries(input.keys).map(keySequenceEntryFromInput),
			keySequenceOptions(input),
		);
	});
	return { route: "synthetic_events", delivery: syntheticDelivery(computer) };
}

/**
 * Delivery label for a synthetic-events action that travels through the input controller's
 * target routing: attended delivery leases the foreground for it, background delivery posts to
 * the target process without touching the frontmost app. Which route ran is decided above;
 * this only names how the input travelled.
 */
function syntheticDelivery(computer: ComputerInterface): ActionDelivery {
	return computer.delivery === "attended" ? "foreground" : "background";
}

function clickPointInput(x: number | undefined, y: number | undefined): Point {
	if (x === undefined || y === undefined) {
		throw new Error("click requires either element_index or x and y coordinates");
	}
	return { x, y };
}

function keySequenceEntryFromInput(input: PressKeysActionInput["keys"][number]): KeySequenceEntry {
	if (typeof input === "string") {
		return { key: input };
	}
	return input.hold_seconds === undefined ? { key: input.key } : { key: input.key, holdSeconds: input.hold_seconds };
}

function keySequenceOptions(input: PressKeysActionInput): KeySequenceOptions | undefined {
	const holdSeconds = input.hold_seconds;
	const intervalSeconds = input.interval_seconds;
	if (holdSeconds !== undefined && intervalSeconds !== undefined) {
		return { holdSeconds, intervalSeconds };
	}
	if (holdSeconds !== undefined) {
		return { holdSeconds };
	}
	return intervalSeconds === undefined ? undefined : { intervalSeconds };
}
