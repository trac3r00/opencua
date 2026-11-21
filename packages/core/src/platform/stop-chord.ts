import type { StopStatusSource, StopSwitch } from "./stop-switch.js";

/** CGEventFlags modifier masks (the same values as the K_CG_EVENT_FLAG_MASK_* constants). */
const FLAG_SHIFT = 0x00020000;
const FLAG_CONTROL = 0x00040000;
const FLAG_ALTERNATE = 0x00080000;
const FLAG_COMMAND = 0x00100000;

export const STOP_CHORD_MASK = FLAG_CONTROL | FLAG_ALTERNATE | FLAG_COMMAND;
/** The buddy's push-to-talk chord, Control+Option; Command or Shift held with it means another shortcut. */
export const TALK_CHORD_MASK = FLAG_CONTROL | FLAG_ALTERNATE;
export const TALK_CHORD_FORBIDDEN_MASK = FLAG_SHIFT | FLAG_COMMAND;
export const STOP_CHORD_LABEL = "keyboard chord Control+Option+Command";
const STOP_CHORD_POLL_MS = 50;
/** Consecutive samples the chord must be held for (3 x 50 ms = ~150 ms). */
const STOP_CHORD_REQUIRED_SAMPLES = 3;

/** Starts a repeating callback and returns the function that cancels it. */
export type StopChordTimer = (callback: () => void, milliseconds: number) => () => void;

export interface StopChordDetectorOptions {
	/** Reads the current modifier flags of the physical keyboard (CGEventFlags bitmask). */
	readonly readFlags: () => number;
	/** Called once per press, after the chord has been held for the required samples. */
	readonly onChord: () => void;
	/** Called once when a chord that fired is let go. */
	readonly onRelease?: () => void;
	/** Called on the first sample of a press, before it is confirmed, so work can start without waiting. */
	readonly onEngage?: () => void;
	/** Called when an engaged press is let go before it was confirmed. */
	readonly onAbandon?: () => void;
	readonly onError?: (error: unknown) => void;
	/** Modifiers that must all be held (default Control+Option+Command). */
	readonly mask?: number;
	/** Modifiers that must not be held (default Shift). */
	readonly forbiddenMask?: number;
	readonly intervalMs?: number;
	readonly requiredSamples?: number;
	readonly timer?: StopChordTimer;
}

/** The real timer is unref'd so the detector never keeps the process alive. */
const SYSTEM_TIMER: StopChordTimer = (callback, milliseconds) => {
	const handle = setInterval(callback, milliseconds);
	handle.unref();
	return () => clearInterval(handle);
};

/**
 * Detects Control+Option+Command held together (Shift not held, so common shortcuts that add
 * Shift never trigger it). The flags are read from the HID system state, which reflects the
 * physical keyboard: opencua's own per-pid background events do not move it. Limitation:
 * foreground (attended) delivery posts events through the HID tap, so a batch that itself
 * presses all three modifiers for >= 150 ms could trip the chord; no opencua action holds
 * that combination.
 */
export class StopChordDetector {
	private readonly readFlags: () => number;
	private readonly onChord: () => void;
	private readonly onRelease: (() => void) | undefined;
	private readonly onEngage: (() => void) | undefined;
	private readonly onAbandon: (() => void) | undefined;
	private readonly onError: (error: unknown) => void;
	private readonly mask: number;
	private readonly forbiddenMask: number;
	private readonly intervalMs: number;
	private readonly requiredSamples: number;
	private readonly timer: StopChordTimer;
	private cancel: (() => void) | undefined;
	private heldSamples = 0;
	private armed = true;
	private reportedError = false;

	constructor(options: StopChordDetectorOptions) {
		this.readFlags = options.readFlags;
		this.onChord = options.onChord;
		this.onRelease = options.onRelease;
		this.onEngage = options.onEngage;
		this.onAbandon = options.onAbandon;
		this.mask = options.mask ?? STOP_CHORD_MASK;
		this.forbiddenMask = options.forbiddenMask ?? FLAG_SHIFT;
		this.onError = options.onError ?? defaultOnError;
		this.intervalMs = options.intervalMs ?? STOP_CHORD_POLL_MS;
		this.requiredSamples = options.requiredSamples ?? STOP_CHORD_REQUIRED_SAMPLES;
		this.timer = options.timer ?? SYSTEM_TIMER;
	}

	start(): void {
		if (this.cancel === undefined) {
			this.cancel = this.timer(() => this.sample(), this.intervalMs);
		}
	}

	stop(): void {
		this.cancel?.();
		this.cancel = undefined;
	}

	/** Take one reading; the timer calls this, and tests drive it directly. */
	sample(): void {
		let flags: number;
		try {
			flags = this.readFlags();
		} catch (error: unknown) {
			if (!this.reportedError) {
				this.reportedError = true;
				this.onError(error);
			}
			return;
		}
		const held = (flags & this.mask) === this.mask && (flags & this.forbiddenMask) === 0;
		if (!held) {
			const fired = !this.armed;
			const engaged = this.heldSamples > 0;
			this.heldSamples = 0;
			this.armed = true;
			if (fired) this.onRelease?.();
			else if (engaged) this.onAbandon?.();
			return;
		}
		this.heldSamples += 1;
		if (this.armed && this.heldSamples === 1) this.onEngage?.();
		if (this.armed && this.heldSamples >= this.requiredSamples) {
			this.armed = false;
			this.onChord();
		}
	}
}

function defaultOnError(error: unknown): void {
	const details = error instanceof Error ? error.message : String(error);
	process.stderr.write(`opencua stop chord detector could not read the keyboard state: ${details}\n`);
}

/**
 * Wire a detector to a stop switch and start it. A chord while already stopped keeps the first
 * stop's time and reason.
 */
export function startStopChordDetector(
	stopSwitch: Pick<StopSwitch, "stop"> & StopStatusSource,
	readFlags: () => number,
	options: Pick<StopChordDetectorOptions, "intervalMs" | "requiredSamples" | "timer" | "onError"> = {},
): StopChordDetector {
	const detector = new StopChordDetector({
		...options,
		readFlags,
		onChord: () => {
			if (!stopSwitch.status().stopped) {
				stopSwitch.stop(STOP_CHORD_LABEL, "chord");
			}
		},
	});
	detector.start();
	return detector;
}
