import { runInInputScope } from "../computer/input-scope.js";
import { modifierFlags, virtualKeyCodeFor } from "./macos-keycodes.js";
import type { TartGuestTransport } from "./tart-guest-transport.js";

export interface GuestPointerStep {
	readonly x: number;
	readonly y: number;
	readonly buttons: number;
}

const SPECIAL_KEYS = new Map<number, string>([
	[0xff08, "backspace"],
	[0xff09, "tab"],
	[0xff0d, "return"],
	[0xff1b, "escape"],
	[0xff50, "home"],
	[0xff51, "left"],
	[0xff52, "up"],
	[0xff53, "right"],
	[0xff54, "down"],
	[0xff55, "pageup"],
	[0xff56, "pagedown"],
	[0xff57, "end"],
	[0xffff, "forwarddelete"],
	[0xff8d, "return"],
	[0xffe1, "shift"],
	[0xffe2, "shift"],
	[0xffe3, "control"],
	[0xffe4, "control"],
	// RFB clients send Command as Meta or Super, left or right.
	[0xffe7, "command"],
	[0xffe8, "command"],
	[0xffeb, "command"],
	[0xffec, "command"],
	[0xffe9, "option"],
	[0xffea, "option"],
	[0x20, "space"],
]);

/** Runs only through an owned VM command transport; never imports host native bindings. */
export class GuestNativeInput {
	private readonly transport: Pick<TartGuestTransport, "execute">;
	private heldButton = 0;
	private clickCount = 0;
	private lastPointer: { x: number; y: number; width: number; height: number } | undefined;
	private virtualMacVerified = false;
	private readonly heldKeys = new Map<number, { code: number; flag: number }>();

	constructor(transport: Pick<TartGuestTransport, "execute">) {
		this.transport = transport;
	}

	async checkPermissions(): Promise<void> {
		await this.run("");
	}

	beginPointerSequence(): void {
		this.clickCount = 0;
	}

	async pointer(x: number, y: number, buttons: number, width: number, height: number): Promise<void> {
		if (buttons >= 8) {
			await this.pointers([{ x, y, buttons }], width, height);
			return;
		}
		if (
			![0, 1, 2, 4].includes(buttons) ||
			!Number.isSafeInteger(x) ||
			!Number.isSafeInteger(y) ||
			x < 0 ||
			y < 0 ||
			x >= width ||
			y >= height
		)
			throw new Error("Invalid guest pointer event.");
		// One button at a time: release the held button here before pressing a different one.
		if (buttons !== 0 && this.heldButton !== 0 && this.heldButton !== buttons)
			await this.pointer(x, y, 0, width, height);
		const previous = this.heldButton;
		const releasing = buttons === 0 && previous !== 0;
		const mask = releasing ? previous : buttons;
		const button = mask === 4 ? 1 : mask === 2 ? 2 : 0;
		const kind = releasing
			? [2, 4, 26][button]
			: buttons === 0
				? 5
				: previous === buttons
					? [6, 7, 27][button]
					: [1, 3, 25][button];
		if (buttons !== 0) this.heldButton = buttons;
		if (buttons !== 0 && previous === 0) this.clickCount++;
		const send = () =>
			this.run(`
const screen = $.NSScreen.mainScreen.frame.size;
const point = $.CGPointMake(${x} * screen.width / ${width}, ${y} * screen.height / ${height});
const event = $.CGEventCreateMouseEvent(source, ${kind}, point, ${button});
$.CGEventSetIntegerValueField(event, 1, ${this.clickCount});
post(event, 0);`);
		if (releasing) await runInInputScope({}, send);
		else await send();
		this.heldButton = buttons;
		this.lastPointer = { x, y, width, height };
	}

	async key(keysym: number, down: boolean): Promise<void> {
		const key = resolveKey(keysym);
		const releasing = !down && this.heldKeys.has(keysym);
		if (!down && !releasing) throw new Error("Cannot release a guest key that is not held.");
		if (down) this.heldKeys.set(keysym, key);
		let flags = 0;
		for (const [symbol, held] of this.heldKeys) {
			if (down || symbol !== keysym) flags |= held.flag;
		}
		const send = () =>
			this.run(`
const event = $.CGEventCreateKeyboardEvent(source, ${key.code}, ${down});
${key.flag === 0 ? "" : "$.CGEventSetType(event, 12);"}
post(event, ${flags});`);
		if (releasing) await runInInputScope({}, send);
		else await send();
		if (!down) this.heldKeys.delete(keysym);
	}

	async pointers(steps: readonly GuestPointerStep[], width: number, height: number): Promise<void> {
		if (
			steps.length === 0 ||
			steps.length > 512 ||
			!Number.isSafeInteger(width) ||
			width < 1 ||
			!Number.isSafeInteger(height) ||
			height < 1 ||
			steps.some(
				({ x, y, buttons }) =>
					!Number.isSafeInteger(x) ||
					!Number.isSafeInteger(y) ||
					x < 0 ||
					y < 0 ||
					x >= width ||
					y >= height ||
					![0, 1, 2, 4, 8, 16, 32, 64].includes(buttons),
			)
		)
			throw new Error("Invalid guest pointer sequence.");
		// Continue from a button that pointer() left held; the script releases everything before it returns.
		const last = this.lastPointer;
		const seed =
			this.heldButton !== 0 && last !== undefined
				? `let held = ${this.heldButton};\nlet last = $.CGPointMake(${last.x} * screen.width / ${last.width}, ${last.y} * screen.height / ${last.height});`
				: "let held = 0;\nlet last = null;";
		try {
			await this.run(`
const steps = ${JSON.stringify(steps)};
const screen = $.NSScreen.mainScreen.frame.size;
${seed}
let clickCount = 0;
// JXA's standard delay; absent only in non-guest script evaluation.
const pace = typeof delay === "function" ? () => delay(0.012) : () => undefined;
function mouse(kind, point, button, count) {
	const event = $.CGEventCreateMouseEvent(source, kind, point, button);
	$.CGEventSetIntegerValueField(event, 1, count);
	post(event, 0);
}
function release() {
	if (held !== 0 && last !== null) {
		pace();
		const button = held === 1 ? 0 : held === 4 ? 1 : 2;
		mouse(button === 0 ? 2 : button === 1 ? 4 : 26, last, button, clickCount);
		held = 0;
	}
}
try {
	for (const step of steps) {
		const point = $.CGPointMake(step.x * screen.width / ${width}, step.y * screen.height / ${height});
		if (step.buttons >= 8) {
			release();
			mouse(5, point, 0, 0);
			const vertical = step.buttons === 8 ? 40 : step.buttons === 16 ? -40 : 0;
			const horizontal = step.buttons === 32 ? 40 : step.buttons === 64 ? -40 : 0;
			const event = $.CGEventCreateScrollWheelEvent(source, 0, 2, vertical, horizontal);
			$.CGEventSetIntegerValueField(event, 88, 1);
			post(event, 0);
		} else if (step.buttons === 0) {
			last = point;
			if (held !== 0) release();
			else mouse(5, point, 0, 0);
		} else {
			if (held !== 0 && held !== step.buttons) release();
			const button = step.buttons === 1 ? 0 : step.buttons === 4 ? 1 : 2;
			const dragging = held === step.buttons;
			if (!dragging) clickCount++;
			// Paced like a hand so AppKit tracking loops see a real drag.
			else pace();
			held = step.buttons;
			last = point;
			mouse(dragging ? (button === 0 ? 6 : button === 1 ? 7 : 27) :
				(button === 0 ? 1 : button === 1 ? 3 : 25), point, button, clickCount);
		}
	}
} finally { release(); }`);
		} finally {
			this.heldButton = 0;
		}
		const end = steps[steps.length - 1];
		if (end !== undefined) this.lastPointer = { x: end.x, y: end.y, width, height };
	}

	async chord(keysyms: readonly number[]): Promise<void> {
		if (keysyms.length === 0 || keysyms.length > 8 || new Set(keysyms).size !== keysyms.length)
			throw new Error("Invalid guest key chord.");
		const keys = keysyms.map(resolveKey);
		await this.run(keyboardScript(keys));
	}

	async paste(text: string): Promise<void> {
		if (text.length > 1_000_000) throw new Error("Guest text exceeds its limit.");
		const pasteChord = keyboardScript([
			{ code: 55, flag: 0x100000 },
			{ code: 9, flag: 0 },
		]);
		await this.run(`
const board = $.NSPasteboard.generalPasteboard;
board.clearContents;
if (!board.setStringForType($(${JSON.stringify(text)}), $.NSPasteboardTypeString))
	throw new Error("Guest clipboard write failed.");
${pasteChord}`);
	}

	private async run(body: string): Promise<void> {
		// The pinned transport cannot change machines, so one passing hardware check covers later events.
		const hardware = this.virtualMacVerified
			? ""
			: `
if (!/^VirtualMac[0-9]+,[0-9]+$/.test(self.doShellScript("/usr/sbin/sysctl -n hw.model").trim()))
	throw new Error("Guest input requires a virtual Mac.");`;
		await this.transport.execute(
			["/usr/bin/osascript", "-l", "JavaScript"],
			`
const self = Application.currentApplication();
self.includeStandardAdditions = true;${hardware}
ObjC.import("AppKit");
ObjC.import("ApplicationServices");
ObjC.import("CoreGraphics");
if (!$.AXIsProcessTrusted()) throw new Error("Guest accessibility permission is unavailable.");
ObjC.bindFunction("clock_gettime_nsec_np", ["unsigned long long", ["int"]]);
const source = $.CGEventSourceCreate(1);
function post(event, flags) {
	$.CGEventSetFlags(event, flags);
	$.CGEventSetTimestamp(event, $.clock_gettime_nsec_np(8));
	$.CGEventPost(0, event);
}
${body}`,
		);
		this.virtualMacVerified = true;
	}
}

function resolveKey(keysym: number): { code: number; flag: number } {
	if (!Number.isSafeInteger(keysym)) throw new Error("Invalid guest keysym.");
	if (keysym >= 0x41 && keysym <= 0x5a)
		throw new Error("Unsupported uppercase keysym; use Shift with a lowercase base key, or type text.");
	const name =
		SPECIAL_KEYS.get(keysym) ??
		(keysym >= 0x21 && keysym <= 0x7e
			? String.fromCharCode(keysym)
			: keysym >= 0xffbe && keysym <= 0xffce
				? `f${keysym - 0xffbd}`
				: undefined);
	if (name === undefined) throw new Error("Unsupported guest keysym.");
	const flag =
		name === "shift" || name === "control" || name === "command" || name === "option" ? modifierFlags([name]) : 0;
	return { code: virtualKeyCodeFor(name), flag };
}

function keyboardScript(keys: readonly { readonly code: number; readonly flag: number }[]): string {
	return `
const keys = ${JSON.stringify(keys)};
const held = [];
let flags = 0;
function key(item, down) {
	const event = $.CGEventCreateKeyboardEvent(source, item.code, down);
	if (item.flag !== 0) $.CGEventSetType(event, 12);
	post(event, flags);
}
try {
	for (const item of keys) {
		flags |= item.flag;
		held.push(item);
		key(item, true);
	}
} finally {
	const errors = [];
	for (const item of held.reverse()) {
		flags &= ~item.flag;
		try { key(item, false); } catch (error) { errors.push(String(error)); }
	}
	if (errors.length > 0) throw new Error(errors.join("; "));
}`;
}
