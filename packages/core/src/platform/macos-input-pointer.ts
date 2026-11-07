import { setTimeout as sleep } from "node:timers/promises";
import type { DragOptions, Point, Rect } from "../types/index.js";
import type { MouseButton } from "./macos-ffi/coregraphics.js";
import type { SkyLightTargetWindow } from "./macos-ffi/skylight.js";
import { dragSteps, interpolatePointDrag, pointerTravelDuration } from "./macos-input-drag.js";
import { type GestureSleepOptions, runFocusLeasedGesture } from "./macos-targeted-gesture.js";
import { isOwnedSurfacePid } from "./owned-surfaces.js";

/** `flags` is the held-modifier CGEventFlags mask to stamp on the event; undefined leaves the flags alone. */
export type MousePost = (
	kind: "move" | "down" | "up" | "drag",
	position: Point,
	button: MouseButton,
	clickState: number | undefined,
	targetWindow: SkyLightTargetWindow | undefined,
	flags?: number,
) => Promise<void>;

/** Every display and on-screen window in global points: what the activation primer must not land on. */
export interface ScreenLayout {
	readonly displays: readonly Rect[];
	readonly windows: readonly Rect[];
}

/** Just above and left of the main display, which is clear on most arrangements. */
const PRIMER_USUAL_POSITION: Point = { x: -1, y: -1 };
const PRIMER_GAP_MILLISECONDS = 1;
const PRIMER_SETTLE_MILLISECONDS_DEFAULT = 40;

export function gesturePrimerSettleMilliseconds(): number {
	const raw = process.env["OPENCUA_GESTURE_PRIMER_SETTLE_MS"]?.trim();
	if (raw === undefined || raw.length === 0) {
		return PRIMER_SETTLE_MILLISECONDS_DEFAULT;
	}
	const value = Number(raw);
	return Number.isInteger(value) && value >= 0 ? value : PRIMER_SETTLE_MILLISECONDS_DEFAULT;
}

/**
 * Where the activation primer can click without landing on anything: a point inside no display and no on-screen
 * window. That is (-1, -1) unless a display arranged above or left of the main one, or a window, covers it; then it is
 * the point just above and left of every display and window. Undefined when no point is provably clear: the layout is
 * unknown, names no display, or holds a bound that is not a finite rectangle.
 */
export function primerPosition(layout: ScreenLayout | undefined): Point | undefined {
	if (layout === undefined || layout.displays.length === 0) {
		return undefined;
	}
	const rects = [...layout.displays, ...layout.windows];
	if (!rects.every(isFiniteRect)) {
		return undefined;
	}
	let candidate = PRIMER_USUAL_POSITION;
	if (rects.some((rect) => covers(rect, PRIMER_USUAL_POSITION))) {
		candidate = {
			x: Math.min(...rects.map((rect) => rect.x)) - 1,
			y: Math.min(...rects.map((rect) => rect.y)) - 1,
		};
	}
	// Checked again rather than trusted: past 2^53 subtracting 1 no longer moves a coordinate.
	return rects.some((rect) => covers(rect, candidate)) ? undefined : candidate;
}

function isFiniteRect(rect: Rect): boolean {
	return [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width >= 0 && rect.height >= 0;
}

/** Edges count as covered, so a point on a window's border is never taken as clear. */
function covers(rect: Rect, point: Point): boolean {
	return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}

/**
 * The first click an app gets after it is told it is active is spent on that activation and does nothing. A click at
 * `position`, a point inside no display and no window (see primerPosition), absorbs it, so the gesture's own first
 * click lands. It goes to the target app's window like the gesture, never to whatever is on screen there.
 */
export async function postActivationPrimer(
	post: MousePost,
	targetWindow: SkyLightTargetWindow,
	position: Point,
	options: GestureSleepOptions = {},
): Promise<void> {
	const wait = options.sleep ?? ((milliseconds) => sleep(milliseconds).then(() => undefined));
	await post("down", position, "left", 1, targetWindow);
	await wait(PRIMER_GAP_MILLISECONDS);
	await post("up", position, "left", 1, targetWindow);
	const primerSettle = gesturePrimerSettleMilliseconds();
	if (primerSettle > 0) await wait(primerSettle);
}

export async function postClick(
	post: MousePost,
	position: Point,
	button: MouseButton,
	clickState: number,
	targetWindow: SkyLightTargetWindow | undefined,
	flags?: number,
): Promise<void> {
	await post("down", position, button, clickState, targetWindow, flags);
	await post("up", position, button, clickState, targetWindow, flags);
}

export async function postDoubleClick(
	post: MousePost,
	position: Point,
	targetWindow: SkyLightTargetWindow | undefined,
	flags?: number,
): Promise<void> {
	await postClick(post, position, "left", 1, targetWindow, flags);
	await postClick(post, position, "left", 2, targetWindow, flags);
}

/**
 * Press at `from`, move to `to` and release. `checkpoint` is called before every move and throws to stop the drag:
 * the button is then released where the pointer is, and nothing else is sent, so the app is never left mid-drag.
 */
export async function postDragSequence(
	post: MousePost,
	options: DragOptions,
	targetWindow: SkyLightTargetWindow | undefined,
	flags?: number,
	checkpoint: () => void = () => undefined,
): Promise<void> {
	const button = options.button ?? "left";
	const points = [options.from, ...(options.waypoints ?? []), options.to];
	const distances = points.slice(1).map((point, index) => {
		const previous = points[index];
		return previous === undefined ? 0 : Math.hypot(point.x - previous.x, point.y - previous.y);
	});
	const totalDistance = distances.reduce((total, distance) => total + distance, 0);
	const duration = options.duration ?? pointerTravelDuration({ x: 0, y: 0 }, { x: totalDistance, y: 0 });
	const stepsForDuration = dragSteps(duration);
	const segmentSteps = distances.map((distance) => {
		const fraction = totalDistance === 0 ? 1 / distances.length : distance / totalDistance;
		return Math.max(1, Math.ceil(stepsForDuration * fraction));
	});
	const totalSteps = segmentSteps.reduce((total, steps) => total + steps, 0);
	await post("down", options.from, button, 1, targetWindow, flags);
	const started = performance.now();
	let completedSteps = 0;
	let at = options.from;
	try {
		for (let segment = 0; segment < segmentSteps.length; segment += 1) {
			const from = points[segment];
			const to = points[segment + 1];
			const steps = segmentSteps[segment];
			if (from === undefined || to === undefined || steps === undefined) {
				continue;
			}
			for (let step = 1; step <= steps; step += 1) {
				completedSteps += 1;
				// Pace against one gesture clock. Sub-ms intervals and native posting time must not
				// accumulate a minimum 1ms timer for every waypoint or every sample.
				const remaining = started + (duration * completedSteps) / totalSteps - performance.now();
				if (remaining > 0) {
					await sleep(Math.ceil(remaining));
				}
				checkpoint();
				const position = interpolatePointDrag(from, to, step / steps);
				await post("drag", position, button, 1, targetWindow, flags);
				at = position;
			}
		}
	} catch (error: unknown) {
		await post("up", at, button, 1, targetWindow, flags);
		throw error;
	}
	await post("up", options.to, button, 1, targetWindow, flags);
}

export async function runFocusLeasedClick(
	targetWindow: SkyLightTargetWindow,
	position: Point,
	button: MouseButton,
	post: MousePost,
	flags?: number,
	options: GestureSleepOptions = {},
): Promise<void> {
	await runLeasedUnlessOwned(
		targetWindow,
		position,
		post,
		() => postClick(post, position, button, 1, targetWindow, flags),
		options,
	);
}

export async function runFocusLeasedDoubleClick(
	targetWindow: SkyLightTargetWindow,
	position: Point,
	post: MousePost,
	flags?: number,
	options: GestureSleepOptions = {},
): Promise<void> {
	await runLeasedUnlessOwned(
		targetWindow,
		position,
		post,
		() => postDoubleClick(post, position, targetWindow, flags),
		options,
	);
}

export async function runFocusLeasedDrag(
	targetWindow: SkyLightTargetWindow,
	dragOptions: DragOptions,
	post: MousePost,
	flags?: number,
	checkpoint?: () => void,
	sleepOptions: GestureSleepOptions = {},
): Promise<void> {
	await runLeasedUnlessOwned(
		targetWindow,
		dragOptions.from,
		post,
		() => postDragSequence(post, dragOptions, targetWindow, flags, checkpoint),
		sleepOptions,
	);
}

/**
 * An owned surface accepts the first click without becoming key, so its gestures skip the focus lease; the
 * person's frontmost app is never touched. Every other target still goes through the lease.
 */
async function runLeasedUnlessOwned(
	targetWindow: SkyLightTargetWindow,
	hoverPosition: Point,
	post: MousePost,
	body: () => Promise<void>,
	options: GestureSleepOptions,
): Promise<void> {
	if (options.targetPid !== undefined && isOwnedSurfacePid(options.targetPid)) {
		await body();
		return;
	}
	await runFocusLeasedGesture(targetWindow, hoverPosition, post, body, options);
}
