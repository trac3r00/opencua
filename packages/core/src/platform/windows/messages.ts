import type { Point } from "../../types/index.js";

/**
 * Window messages that deliver pointer input to one window without moving the person's mouse or
 * taking focus (PostMessage). Win32, WPF and most native controls act on them; apps that read raw
 * input (Chromium, Electron, DirectInput games) ignore them, so callers must observe the result.
 */
export interface WindowMessage {
	readonly message: number;
	readonly wParam: number;
	readonly lParam: number;
}

export const WM = {
	MOUSEMOVE: 0x0200,
	LBUTTONDOWN: 0x0201,
	LBUTTONUP: 0x0202,
	LBUTTONDBLCLK: 0x0203,
	RBUTTONDOWN: 0x0204,
	RBUTTONUP: 0x0205,
	MBUTTONDOWN: 0x0207,
	MBUTTONUP: 0x0208,
	MOUSEWHEEL: 0x020a,
} as const;

export const MK = { LBUTTON: 0x0001, RBUTTON: 0x0002, SHIFT: 0x0004, CONTROL: 0x0008, MBUTTON: 0x0010 } as const;

export type MessageModifier = "shift" | "ctrl";

/** MAKELPARAM of a client point: x in the low word, y in the high word, each a signed 16-bit value. */
export function pointLParam(point: Point): number {
	const x = Math.round(point.x);
	const y = Math.round(point.y);
	if (x < -32768 || x > 32767 || y < -32768 || y > 32767) {
		throw new RangeError("client point does not fit a 16-bit window message coordinate");
	}
	return (((y & 0xffff) << 16) | (x & 0xffff)) >>> 0;
}

function keyState(modifiers: readonly MessageModifier[]): number {
	return (modifiers.includes("shift") ? MK.SHIFT : 0) | (modifiers.includes("ctrl") ? MK.CONTROL : 0);
}

export type MessageClick = "left" | "right" | "middle" | "double";

/** The messages of one click at a client point: a hover, then press and release (double: two presses). */
export function clickMessages(
	kind: MessageClick,
	point: Point,
	modifiers: readonly MessageModifier[] = [],
): WindowMessage[] {
	const lParam = pointLParam(point);
	const keys = keyState(modifiers);
	const [down, up, held] =
		kind === "right"
			? [WM.RBUTTONDOWN, WM.RBUTTONUP, MK.RBUTTON]
			: kind === "middle"
				? [WM.MBUTTONDOWN, WM.MBUTTONUP, MK.MBUTTON]
				: [WM.LBUTTONDOWN, WM.LBUTTONUP, MK.LBUTTON];
	const messages: WindowMessage[] = [
		{ message: WM.MOUSEMOVE, wParam: keys, lParam },
		{ message: down, wParam: keys | held, lParam },
		{ message: up, wParam: keys, lParam },
	];
	if (kind === "double") {
		messages.push(
			{ message: WM.LBUTTONDBLCLK, wParam: keys | MK.LBUTTON, lParam },
			{ message: WM.LBUTTONUP, wParam: keys, lParam },
		);
	}
	return messages;
}

/** A left-button drag through client points: press at the first, moves with the button held, release at the last. */
export function dragMessages(path: readonly Point[], modifiers: readonly MessageModifier[] = []): WindowMessage[] {
	const first = path[0];
	const last = path.at(-1);
	if (first === undefined || last === undefined || path.length < 2) {
		throw new RangeError("a drag needs at least two points");
	}
	const keys = keyState(modifiers);
	return [
		{ message: WM.MOUSEMOVE, wParam: keys, lParam: pointLParam(first) },
		{ message: WM.LBUTTONDOWN, wParam: keys | MK.LBUTTON, lParam: pointLParam(first) },
		...path
			.slice(1)
			.map((point) => ({ message: WM.MOUSEMOVE, wParam: keys | MK.LBUTTON, lParam: pointLParam(point) })),
		{ message: WM.LBUTTONUP, wParam: keys, lParam: pointLParam(last) },
	];
}

/**
 * One WM_MOUSEWHEEL notch run: the wheel delta (120 per notch, positive away from the user) is the
 * high word of wParam, and lParam carries the point in screen coordinates, unlike the other messages.
 */
export function wheelMessages(
	screenPoint: Point,
	notches: number,
	modifiers: readonly MessageModifier[] = [],
): WindowMessage[] {
	if (!Number.isSafeInteger(notches) || notches === 0 || Math.abs(notches) > 273) {
		throw new RangeError("notches must be a nonzero integer whose delta fits 16 bits");
	}
	const keys = keyState(modifiers);
	const wParam = ((((notches * 120) & 0xffff) << 16) | keys) >>> 0;
	return [{ message: WM.MOUSEWHEEL, wParam, lParam: pointLParam(screenPoint) }];
}
