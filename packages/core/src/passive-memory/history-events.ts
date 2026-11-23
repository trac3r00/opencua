export interface HistoryApp {
	readonly bundleIdentifier: string;
	readonly name: string;
	readonly processIdentifier: number;
}

export interface HistoryWindow {
	readonly windowID: number;
	readonly title: string;
	readonly url?: string;
}

export interface HistoryElement {
	readonly role: string;
	readonly subrole?: string;
	readonly title?: string;
	readonly description?: string;
	readonly identifier?: string;
	readonly placeholder?: string;
	readonly value?: string;
}

/** The document or page the event happened in, when accessibility exposes it. */
export interface HistoryDocument {
	readonly url?: string;
	readonly path?: string;
}

export interface HistoryAx {
	readonly mode: "fullTree" | "diffFromPrevious";
	readonly text: string;
}

export type HistoryEventKind =
	| "session.started"
	| "window.changed"
	| "selection.changed"
	| "keyboard.text_input"
	| "keyboard.shortcut"
	| "mouse.click"
	| "mouse.drag";

interface HistoryEventBase {
	readonly id: number;
	readonly kind: HistoryEventKind;
	readonly timestamp: string;
}

/** What an app event acted on. Events from older recorders carry neither field. */
interface HistoryTarget {
	readonly element?: HistoryElement;
	readonly document?: HistoryDocument;
}

export interface SessionStartedEvent extends HistoryEventBase {
	readonly kind: "session.started";
}

export interface WindowChangedEvent extends HistoryEventBase, HistoryTarget {
	readonly kind: "window.changed";
	readonly app: HistoryApp;
	readonly window: HistoryWindow;
	readonly ax?: HistoryAx;
}

export interface SelectionChangedEvent extends HistoryEventBase {
	readonly kind: "selection.changed";
	readonly app: HistoryApp;
	readonly window?: HistoryWindow;
	readonly selection: { readonly target: HistoryElement; readonly text?: string };
}

/** One typed run into one field; older recorders wrote one event per character. */
export interface KeyboardTextInputEvent extends HistoryEventBase, HistoryTarget {
	readonly kind: "keyboard.text_input";
	readonly app: HistoryApp;
	readonly window?: HistoryWindow;
	readonly keyboard: { readonly text: string; readonly target?: HistoryElement };
}

export interface KeyboardShortcutEvent extends HistoryEventBase, HistoryTarget {
	readonly kind: "keyboard.shortcut";
	readonly app: HistoryApp;
	readonly window?: HistoryWindow;
	readonly keyboard: {
		readonly keyEquivalent: string;
		/** Held modifiers such as "command" or "shift"; absent in older events, which always held Command or Control. */
		readonly modifiers?: readonly string[];
		readonly target?: HistoryElement;
	};
}

export interface MouseClickEvent extends HistoryEventBase, HistoryTarget {
	readonly kind: "mouse.click";
	readonly app: HistoryApp;
	readonly window?: HistoryWindow;
	readonly mouse: { readonly button: string; readonly target?: HistoryElement };
	readonly ax?: HistoryAx;
}

export interface MouseDragEvent extends HistoryEventBase {
	readonly kind: "mouse.drag";
	readonly app: HistoryApp;
	readonly window?: HistoryWindow;
	readonly mouse: {
		readonly button: string;
		readonly clickCount?: number;
		readonly origin: { readonly app: HistoryApp; readonly window?: HistoryWindow; readonly element?: HistoryElement };
		readonly destination: {
			readonly app: HistoryApp;
			readonly window?: HistoryWindow;
			readonly element?: HistoryElement;
		};
	};
}

export type HistoryEvent =
	| SessionStartedEvent
	| WindowChangedEvent
	| SelectionChangedEvent
	| KeyboardTextInputEvent
	| KeyboardShortcutEvent
	| MouseClickEvent
	| MouseDragEvent;

export function encodeHistoryEvent(event: HistoryEvent): string {
	return JSON.stringify(event);
}
