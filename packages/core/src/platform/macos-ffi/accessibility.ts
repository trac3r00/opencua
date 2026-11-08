import type { KoffiFunc } from "koffi";
import type { AXTreeElement } from "../../accessibility/types.js";
import { AX_ERROR_CANNOT_COMPLETE, resolveAxMessagingTimeoutSeconds } from "./ax-timeout.js";
import {
	type CFArrayRef,
	type CFStringRef,
	type CFTypeRef,
	cfArrayLength,
	cfArrayValueAt,
	cfBooleanTrue,
	cfGetTypeId,
	cfRelease,
	cfRetain,
	fromCFBoolean,
	fromCFNumber,
	fromCFString,
	isCFArray,
	isCFBoolean,
	isCFNull,
	isCFNumber,
	isCFString,
	toCFNumber,
	toCFString,
	withCFArray,
	withCFString,
} from "./corefoundation.js";
import { koffi } from "./koffi.js";

export {
	DEFAULT_AX_MESSAGING_TIMEOUT_SECONDS,
	resolveAxMessagingTimeoutSeconds,
} from "./ax-timeout.js";

export type AXUIElementRef = CFTypeRef;
type AXValueRef = CFTypeRef;

export const K_AX_PRESS_ACTION = "AXPress";
export const K_AX_VALUE_ATTRIBUTE = "AXValue";
const K_AX_FOCUSED_UI_ELEMENT_ATTRIBUTE = "AXFocusedUIElement";
export const K_AX_ROLE_ATTRIBUTE = "AXRole";
export const K_AX_TITLE_ATTRIBUTE = "AXTitle";
export const K_AX_DESCRIPTION_ATTRIBUTE = "AXDescription";
const K_AX_POSITION_ATTRIBUTE = "AXPosition";
const K_AX_SIZE_ATTRIBUTE = "AXSize";
export const K_AX_CHILDREN_ATTRIBUTE = "AXChildren";
const K_AX_SELECTED_TEXT_ATTRIBUTE = "AXSelectedText";
export const K_AX_SELECTED_TEXT_RANGE_ATTRIBUTE = "AXSelectedTextRange";

const AX_SUCCESS = 0;
const AX_VALUE_CG_POINT = 1;
const AX_VALUE_CG_SIZE = 2;
const DOUBLE_SIZE = 8;
const CG_PAIR_SIZE = DOUBLE_SIZE * 2;

interface AXElementSnapshot {
	readonly maxDepth: number;
	readonly maxElements: number;
	readonly scope: AXWalkScope;
	readonly elements: readonly AXUIElementRef[];
	/** What each observed id looked like, so an action can prove it still is that control. */
	readonly identity: readonly ObservedElementShape[];
	/** Bumped for every installed snapshot, so a caller can prove its ids are still current. */
	readonly generation: number;
}

interface ObservedElementShape {
	readonly role: string;
	readonly label: string | null;
	readonly y: number;
}

/**
 * Which part of the application tree a walk covered. Element ids are ordinals of one
 * exact traversal, so any later re-walk (refetching an element for an action) has to
 * repeat the same traversal or the ids would silently mean different controls.
 */
interface AXWalkScope {
	readonly windowId: number | undefined;
	readonly includeMenuBar: boolean;
	readonly scoped: boolean;
	readonly subtreeOf: number | undefined;
	/** Lists, tables and outlines were walked by the rows they show, so ordinals skip the rows they hold. */
	readonly visibleOnly: boolean;
}

const UNMATCHED_WINDOW_SCOPE: AXWalkScope = {
	windowId: undefined,
	includeMenuBar: true,
	scoped: false,
	subtreeOf: undefined,
	visibleOnly: false,
};

function walkKeyFor(scope: AXWalkScope, maxDepth: number, maxElements: number): string {
	return JSON.stringify([
		scope.scoped,
		scope.windowId ?? null,
		scope.includeMenuBar,
		scope.subtreeOf ?? null,
		maxDepth,
		maxElements,
		...(scope.visibleOnly ? [true] : []),
	]);
}

function unavailableWalkKey(maxDepth: number, maxElements: number): string {
	return `unavailable|${maxDepth}|${maxElements}`;
}

/** Roles that cannot carry an action, so their action list is not worth an extra AX round trip. */
const NON_ACTIONABLE_ROLES: ReadonlySet<string> = new Set([
	"AXApplication",
	"AXGroup",
	"AXImage",
	"AXLayoutArea",
	"AXLayoutItem",
	"AXMenu",
	"AXMenuBar",
	"AXScrollArea",
	"AXSplitter",
	"AXStaticText",
	"AXUnknown",
	"AXWindow",
]);

/** Attributes read in a single AX round trip per element, children included so the walk
 * does not spend a second round trip discovering them. */
const ELEMENT_FACT_ATTRIBUTES = [
	K_AX_ROLE_ATTRIBUTE,
	K_AX_TITLE_ATTRIBUTE,
	K_AX_DESCRIPTION_ATTRIBUTE,
	K_AX_VALUE_ATTRIBUTE,
	K_AX_POSITION_ATTRIBUTE,
	K_AX_SIZE_ATTRIBUTE,
	K_AX_CHILDREN_ATTRIBUTE,
] as const;

interface AXElementFacts {
	readonly role: string;
	readonly label: string | null;
	readonly value: string | null;
	readonly frame: AXTreeElement["frame"];
	/** Retained child elements; the caller releases each one. */
	readonly children: readonly AXUIElementRef[];
}

const elementSnapshots = new Map<number, AXElementSnapshot>();
let nextSnapshotGeneration = 0;

const applicationServices = koffi.load("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices");
const AX_UI_ELEMENT_REF = koffi.pointer("AXUIElementRef", koffi.opaque());
const AX_VALUE_REF = koffi.pointer("AXValueRef", koffi.opaque());

const AXIsProcessTrusted = applicationServices.func("AXIsProcessTrusted", "bool", []) as KoffiFunc<() => boolean>;

const AXUIElementGetTypeID = applicationServices.func("AXUIElementGetTypeID", "ulong", []) as KoffiFunc<() => number>;

const AXValueGetTypeID = applicationServices.func("AXValueGetTypeID", "ulong", []) as KoffiFunc<() => number>;

const AXValueGetType = applicationServices.func("AXValueGetType", "int32_t", [AX_VALUE_REF]) as KoffiFunc<
	(value: AXValueRef) => number
>;

const AXValueGetValue = applicationServices.func("AXValueGetValue", "bool", [
	AX_VALUE_REF,
	"int32_t",
	"void *",
]) as KoffiFunc<(value: AXValueRef, type: number, buffer: Buffer) => boolean>;

const AXUIElementCreateApplication = applicationServices.func("AXUIElementCreateApplication", AX_UI_ELEMENT_REF, [
	"int32_t",
]) as KoffiFunc<(pid: number) => AXUIElementRef | null>;

const AXUIElementCreateSystemWide = applicationServices.func(
	"AXUIElementCreateSystemWide",
	AX_UI_ELEMENT_REF,
	[],
) as KoffiFunc<() => AXUIElementRef | null>;

const AXUIElementCopyElementAtPosition = applicationServices.func(
	"int32_t AXUIElementCopyElementAtPosition(void *element, float x, float y, _Out_ void **target)",
) as KoffiFunc<(application: AXUIElementRef, x: number, y: number, target: Array<AXUIElementRef | null>) => number>;

const AXUIElementGetPid = applicationServices.func(
	"int32_t AXUIElementGetPid(void *element, _Out_ int32_t *pid)",
) as KoffiFunc<(element: AXUIElementRef, pidOut: Int32Array) => number>;

const AXUIElementPerformAction = applicationServices.func("AXUIElementPerformAction", "int32_t", [
	AX_UI_ELEMENT_REF,
	"void *",
]) as KoffiFunc<(element: AXUIElementRef, action: CFStringRef) => number>;

const AXUIElementSetAttributeValue = applicationServices.func("AXUIElementSetAttributeValue", "int32_t", [
	AX_UI_ELEMENT_REF,
	"void *",
	"void *",
]) as KoffiFunc<(element: AXUIElementRef, attribute: CFStringRef, value: CFTypeRef) => number>;

const AXUIElementCopyAttributeValue = applicationServices.func(
	"int32_t AXUIElementCopyAttributeValue(void *element, void *attribute, _Out_ void **value)",
) as KoffiFunc<(element: AXUIElementRef, attribute: CFStringRef, value: Array<CFTypeRef | null>) => number>;

const AXUIElementCopyActionNames = applicationServices.func(
	"int32_t AXUIElementCopyActionNames(void *element, _Out_ void **actions)",
) as KoffiFunc<(element: AXUIElementRef, actions: Array<CFArrayRef | null>) => number>;

const AXUIElementCopyMultipleAttributeValues = applicationServices.func(
	"int32_t AXUIElementCopyMultipleAttributeValues(void *element, void *attributes, uint32_t options, _Out_ void **values)",
) as KoffiFunc<
	(element: AXUIElementRef, attributes: CFArrayRef, options: number, values: Array<CFArrayRef | null>) => number
>;

/**
 * Private SPI that maps an AX window element to its CGWindowID, the same one the
 * reference driver uses. Optional: when it is unavailable the walk keeps working
 * unscoped instead of guessing which AX window matches a WindowServer window.
 */
const AXUIElementGetWindowSpi = (() => {
	try {
		return applicationServices.func(
			"int32_t _AXUIElementGetWindow(void *element, _Out_ uint32_t *windowId)",
		) as KoffiFunc<(element: AXUIElementRef, windowId: Uint32Array) => number>;
	} catch {
		return null;
	}
})();

/**
 * Bounds how long one accessibility message may wait for its app to answer. Without it a busy app
 * — one that is loading a page or sitting on a modal sheet — leaves the AX call blocked with no
 * reply, which is the wedge that made every later observation of that app time out as well.
 * Optional: when the symbol is unavailable the system default applies.
 */
const AXUIElementSetMessagingTimeout = (() => {
	try {
		return applicationServices.func(
			"int32_t AXUIElementSetMessagingTimeout(void *element, float seconds)",
		) as KoffiFunc<(element: AXUIElementRef, seconds: number) => number>;
	} catch {
		return null;
	}
})();

function applyMessagingTimeout(element: AXUIElementRef): void {
	if (AXUIElementSetMessagingTimeout === null) {
		return;
	}
	const seconds = resolveAxMessagingTimeoutSeconds();
	if (seconds <= 0) {
		return;
	}
	AXUIElementSetMessagingTimeout(element, seconds);
}

/**
 * An app that cannot answer its own role is not an app without an accessibility tree: it is an app
 * that did not reply. Every per-attribute read in the walk is best-effort and swallows its error, so
 * without this probe that condition arrives as an empty tree after grinding through hundreds of
 * timed-out messages, indistinguishable from an app that genuinely publishes nothing. One message
 * up front turns it into a fast, named failure.
 */
function assertAppAnswersAccessibility(root: AXUIElementRef, pid: number): void {
	const error = withCFString(K_AX_ROLE_ATTRIBUTE, (attributeReference) => {
		const outValue: Array<CFTypeRef | null> = [null];
		return AXUIElementCopyAttributeValue(root, attributeReference, outValue);
	});
	if (error === AX_ERROR_CANNOT_COMPLETE) {
		throw new Error(
			`the app (pid ${pid}) did not answer within the accessibility messaging timeout of ${resolveAxMessagingTimeoutSeconds()}s; it may be busy loading, or showing a sheet only a person can clear`,
		);
	}
}

export interface AccessibilityTreeResult {
	readonly elements: AXTreeElement[];
	readonly axAvailable: boolean;
	/** Title of the exactly matched AX window, never borrowed from an unmatched app-wide walk. */
	readonly windowTitle?: string;
	/** True when the walk stopped at the element budget, so the tree is a partial view. */
	readonly truncated: boolean;
	/**
	 * Identifies the exact traversal that produced these element ids. Two walks are only
	 * comparable (same ids, same coverage) when their keys match, so diffs must not cross
	 * keys.
	 */
	readonly walkKey: string;
	/**
	 * True when the app answered with application elements where its windows should be. That is
	 * what a session without the physical console (fast user switching, Screen Sharing) gets: the
	 * window content is not reachable over accessibility at all, only the menu bar is.
	 */
	readonly windowContentUnavailable?: boolean;
}

export function createApplicationElement(pid: number): AXUIElementRef {
	const element = AXUIElementCreateApplication(pid);
	if (element === null) {
		throw new Error(`AXUIElementCreateApplication returned null for pid ${pid}`);
	}
	applyMessagingTimeout(element);
	return element;
}

export function releaseAXElement(element: AXUIElementRef | null): void {
	cfRelease(element);
}

const K_AX_FOCUSED_WINDOW_ATTRIBUTE = "AXFocusedWindow";

/**
 * WindowServer id of the window the app currently considers focused, the same window the
 * user sees, so a multi-window app is not resolved by an arbitrary window order. Returns
 * undefined when the app has no focused window or the private SPI is unavailable.
 */
export function focusedWindowIdForPid(pid: number): number | undefined {
	return readFocusedWindowIds(pid, false).focusedWindowId;
}

/**
 * Focused window identity for app-state observation. When focus is an AXSheet and AX exposes
 * its owning AXWindow ancestor, return both ids so a caller can prefer the owner while retaining
 * the focused sheet as the safe fallback.
 */
export function focusedWindowIdsForObservationPid(pid: number): {
	readonly focusedWindowId: number | undefined;
	readonly sheetOwnerWindowId: number | undefined;
} {
	return readFocusedWindowIds(pid, true);
}

function readFocusedWindowIds(
	pid: number,
	resolveSheetOwner: boolean,
): { readonly focusedWindowId: number | undefined; readonly sheetOwnerWindowId: number | undefined } {
	if (!isRunning(pid) || AXUIElementGetWindowSpi === null) {
		return { focusedWindowId: undefined, sheetOwnerWindowId: undefined };
	}
	let root: AXUIElementRef | null = null;
	let focused: CFTypeRef | null = null;
	try {
		root = createApplicationElement(pid);
		focused = copyOptionalAttributeValue(root, K_AX_FOCUSED_WINDOW_ATTRIBUTE);
		if (focused === null || !cfGetTypeId(focused)) {
			return { focusedWindowId: undefined, sheetOwnerWindowId: undefined };
		}
		const focusedElement = focused as AXUIElementRef;
		const focusedWindowId = windowIdOf(focusedElement);
		if (!resolveSheetOwner || copyStringAttribute(focusedElement, K_AX_ROLE_ATTRIBUTE) !== "AXSheet") {
			return { focusedWindowId, sheetOwnerWindowId: undefined };
		}
		let ancestor = copyOptionalAttributeValue(focusedElement, "AXParent");
		try {
			for (let depth = 0; ancestor !== null && depth < MAX_FILE_PANEL_ANCESTORS; depth += 1) {
				const ancestorElement = ancestor as AXUIElementRef;
				if (copyStringAttribute(ancestorElement, K_AX_ROLE_ATTRIBUTE) === "AXWindow") {
					const sheetOwnerWindowId = windowIdOf(ancestorElement);
					return {
						focusedWindowId,
						sheetOwnerWindowId:
							sheetOwnerWindowId !== undefined && sheetOwnerWindowId > 0 ? sheetOwnerWindowId : undefined,
					};
				}
				const parent = copyOptionalAttributeValue(ancestorElement, "AXParent");
				cfRelease(ancestor);
				ancestor = parent;
			}
			return { focusedWindowId, sheetOwnerWindowId: undefined };
		} finally {
			cfRelease(ancestor);
		}
	} catch {
		return { focusedWindowId: undefined, sheetOwnerWindowId: undefined };
	} finally {
		if (focused !== null) {
			cfRelease(focused);
		}
		if (root !== null) {
			releaseAXElement(root);
		}
	}
}

const MODAL_WINDOW_SUBROLES: ReadonlySet<string> = new Set(["AXDialog", "AXSystemDialog"]);

/**
 * True when the app's focused window is a sheet or dialog (a Save panel, an alert). Keys belong to
 * that modal UI, so it must not be raised over; the caller's document window is its owner anyway.
 */
export function focusedWindowIsModal(pid: number): boolean {
	if (!isRunning(pid)) {
		return false;
	}
	let root: AXUIElementRef | null = null;
	let focused: CFTypeRef | null = null;
	try {
		root = createApplicationElement(pid);
		focused = copyOptionalAttributeValue(root, K_AX_FOCUSED_WINDOW_ATTRIBUTE);
		if (focused === null) {
			return false;
		}
		const window = focused as AXUIElementRef;
		if (copyStringAttribute(window, K_AX_ROLE_ATTRIBUTE) === "AXSheet") {
			return true;
		}
		const subrole = copyStringAttribute(window, "AXSubrole");
		return subrole !== null && MODAL_WINDOW_SUBROLES.has(subrole);
	} catch {
		return false;
	} finally {
		cfRelease(focused);
		if (root !== null) {
			releaseAXElement(root);
		}
	}
}

const FILE_PANEL_SHEET_LABELS: ReadonlySet<string> = new Set(["save", "open"]);
const MAX_FILE_PANEL_ANCESTORS = 8;

function isFilePanelSheet(element: AXUIElementRef): boolean {
	if (copyStringAttribute(element, K_AX_ROLE_ATTRIBUTE) !== "AXSheet") {
		return false;
	}
	const label =
		copyStringAttribute(element, K_AX_DESCRIPTION_ATTRIBUTE) ?? copyStringAttribute(element, K_AX_TITLE_ATTRIBUTE);
	return label !== null && FILE_PANEL_SHEET_LABELS.has(label);
}

/** True when the app's focused window is showing AppKit's Save or Open panel (sheet "save"/"open"). */
export function focusedWindowShowsFilePanel(pid: number): boolean {
	if (!isRunning(pid)) {
		return false;
	}
	let root: AXUIElementRef | null = null;
	let focused: CFTypeRef | null = null;
	let children: CFTypeRef | null = null;
	try {
		root = createApplicationElement(pid);
		focused = copyOptionalAttributeValue(root, K_AX_FOCUSED_WINDOW_ATTRIBUTE);
		if (focused === null) {
			return false;
		}
		// The panel's own sheets (Go to Folder) become the focused window while they are open, so a
		// file panel among the focused window's ancestors counts as well as one among its children.
		let ancestor: CFTypeRef | null = cfRetain(focused);
		try {
			for (let depth = 0; ancestor !== null && depth < MAX_FILE_PANEL_ANCESTORS; depth++) {
				if (isFilePanelSheet(ancestor as AXUIElementRef)) {
					return true;
				}
				const parent = copyOptionalAttributeValue(ancestor as AXUIElementRef, "AXParent");
				cfRelease(ancestor);
				ancestor = parent;
			}
		} finally {
			cfRelease(ancestor);
		}
		children = copyOptionalAttributeValue(focused as AXUIElementRef, "AXChildren");
		if (children === null || !isCFArray(children)) {
			return false;
		}
		for (let index = 0; index < cfArrayLength(children); index++) {
			const child = cfArrayValueAt(children, index);
			if (child !== null && isFilePanelSheet(child as AXUIElementRef)) {
				return true;
			}
		}
		return false;
	} catch {
		return false;
	} finally {
		cfRelease(children);
		cfRelease(focused);
		if (root !== null) {
			releaseAXElement(root);
		}
	}
}

/**
 * Make `windowId` the app's focused window so keyboard input posted to the process lands there:
 * AppKit hands key events to the key window whatever window the event names. AXRaise orders the
 * window front inside its own app without activating the app, so the user's frontmost app keeps
 * focus. Returns false when the window is not reachable over accessibility.
 */
export function raiseWindowInApp(pid: number, windowId: number): boolean {
	if (!isRunning(pid) || AXUIElementGetWindowSpi === null) {
		return false;
	}
	let root: AXUIElementRef | null = null;
	let windows: CFTypeRef | null = null;
	try {
		root = createApplicationElement(pid);
		windows = copyOptionalAttributeValue(root, "AXWindows");
		if (windows === null || !isCFArray(windows)) {
			return false;
		}
		for (let index = 0; index < cfArrayLength(windows); index++) {
			const window = cfArrayValueAt(windows, index);
			if (window !== null && windowIdOf(window) === windowId) {
				performAction(window, "AXRaise");
				return true;
			}
		}
		return false;
	} catch {
		return false;
	} finally {
		cfRelease(windows);
		if (root !== null) {
			releaseAXElement(root);
		}
	}
}

/** Returns the AXMinimized state for a reachable window, or undefined when unavailable. */
export function windowMinimizedForPid(pid: number, windowId: number): boolean | undefined {
	if (!isRunning(pid) || AXUIElementGetWindowSpi === null) {
		return undefined;
	}
	let root: AXUIElementRef | null = null;
	let windows: CFTypeRef | null = null;
	let minimized: CFTypeRef | null = null;
	let matchedWindow: AXUIElementRef | null = null;
	try {
		root = createApplicationElement(pid);
		windows = copyOptionalAttributeValue(root, "AXWindows");
		if (windows !== null && isCFArray(windows)) {
			for (let index = 0; index < cfArrayLength(windows); index++) {
				const window = cfArrayValueAt(windows, index);
				if (window !== null && windowIdOf(window) === windowId) {
					matchedWindow = cfRetain(window);
					break;
				}
			}
		}
		matchedWindow ??= copyFocusedWindowForId(root, windowId);
		if (matchedWindow === null) {
			return undefined;
		}
		minimized = copyOptionalAttributeValue(matchedWindow, "AXMinimized");
		return minimized !== null && isCFBoolean(minimized) ? fromCFBoolean(minimized) : undefined;
	} catch {
		return undefined;
	} finally {
		cfRelease(minimized);
		cfRelease(matchedWindow);
		cfRelease(windows);
		if (root !== null) {
			releaseAXElement(root);
		}
	}
}

/**
 * The title of each of the app's windows, by WindowServer window id, read from the app's own
 * accessibility windows. The WindowServer hides window titles from a process without Screen Recording
 * permission, while the app still names its windows. Empty when the app exposes no windows over
 * accessibility or the id lookup SPI is unavailable.
 */
export function windowTitlesForPid(pid: number): ReadonlyMap<number, string> {
	const titles = new Map<number, string>();
	if (!isRunning(pid) || AXUIElementGetWindowSpi === null) {
		return titles;
	}
	let root: AXUIElementRef | null = null;
	let windows: CFTypeRef | null = null;
	try {
		root = createApplicationElement(pid);
		windows = copyOptionalAttributeValue(root, "AXWindows");
		if (windows === null || !isCFArray(windows)) {
			return titles;
		}
		for (let index = 0; index < cfArrayLength(windows); index++) {
			const window = cfArrayValueAt(windows, index);
			if (window === null) {
				continue;
			}
			const id = windowIdOf(window);
			const title = copyStringAttribute(window, K_AX_TITLE_ATTRIBUTE);
			if (id !== undefined && title !== null) {
				titles.set(id, title);
			}
		}
		return titles;
	} catch {
		return titles;
	} finally {
		cfRelease(windows);
		if (root !== null) {
			releaseAXElement(root);
		}
	}
}

export function releaseAccessibilitySnapshot(pid: number): void {
	replaceElementSnapshot(pid, undefined);
}

export function releaseSnapshotsForExitedPids(runningPids: readonly number[]): number {
	const runningPidSet = new Set(runningPids);
	let released = 0;
	for (const pid of elementSnapshots.keys()) {
		if (!runningPidSet.has(pid)) {
			releaseAccessibilitySnapshot(pid);
			released += 1;
		}
	}
	return released;
}

export function performAction(element: AXUIElementRef, action: string): void {
	withCFString(action, (actionReference) => {
		assertAXSuccess("AXUIElementPerformAction", AXUIElementPerformAction(element, actionReference));
	});
}

export function setAttributeValue(element: AXUIElementRef, attribute: string, value: CFTypeRef): void {
	withCFString(attribute, (attributeReference) => {
		assertAXSuccess("AXUIElementSetAttributeValue", AXUIElementSetAttributeValue(element, attributeReference, value));
	});
}

function setStringAttributeValue(element: AXUIElementRef, attribute: string, value: string): void {
	const valueReference = toCFString(value);
	try {
		setAttributeValue(element, attribute, valueReference);
	} finally {
		cfRelease(valueReference);
	}
}

export interface AXElementFrame {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/**
 * The frame an AX element reports on screen, or undefined when it reports neither a position nor
 * a size. Opaque content — a video stream drawn into a window, for example — still has an AX
 * window element with a frame, which is what makes it matchable against the WindowServer's own
 * window list.
 */
export function elementFrame(element: AXUIElementRef): AXElementFrame | undefined {
	const position = copyPointAttribute(element, K_AX_POSITION_ATTRIBUTE);
	const size = copySizeAttribute(element, K_AX_SIZE_ATTRIBUTE);
	if (position === null || size === null) {
		return undefined;
	}
	return { x: position.x, y: position.y, width: size.width, height: size.height };
}

/** Screen frame of the app's focused element, or undefined when it has none or cannot answer. */
export function focusedElementFrame(pid: number): AXElementFrame | undefined {
	if (!AXIsProcessTrusted() || !isRunning(pid)) {
		return undefined;
	}
	const app = createApplicationElement(pid);
	try {
		const focused = copyOptionalAttributeValue(app, K_AX_FOCUSED_UI_ELEMENT_ATTRIBUTE);
		if (focused === null) {
			return undefined;
		}
		try {
			return elementFrame(focused);
		} finally {
			releaseAXElement(focused);
		}
	} finally {
		releaseAXElement(app);
	}
}

/** Screen frame of an observed element, re-resolved through the same identity check actions use. */
export function elementFrameByIndex(pid: number, elementIndex: number): AXElementFrame | undefined {
	const element = refetchElement(pid, elementIndex);
	try {
		return elementFrame(element);
	} finally {
		releaseAXElement(element);
	}
}

const AX_SCROLL_TO_VISIBLE_ACTION = "AXScrollToVisible";

/**
 * An observed element that is expected to have MOVED since the observation (it is about to be
 * scrolled into view, or an earlier scroll already moved it). The role and label must still read as the
 * observed control, so a recycled row is refused; the y position is not compared, because moving is
 * what scrolling does.
 */
function retainedRelocatableElement(pid: number, elementIndex: number): AXUIElementRef {
	if (!AXIsProcessTrusted()) {
		throw new Error("accessibility permission denied");
	}
	if (!isRunning(pid)) {
		throw new Error(`invalid process or element index: ${pid}:${elementIndex}`);
	}
	const observed = elementSnapshots.get(pid)?.identity[elementIndex];
	const element = retainedElementForIndex(pid, elementIndex);
	if (observed === undefined || element === undefined) {
		throw new Error(`element ${elementIndex} not found in snapshot`);
	}
	try {
		const facts = copyElementFacts(element, {
			useMultipleAttributes: true,
			skippedApplications: 0,
			depthTruncated: false,
			visibleOnly: false,
		});
		for (const child of facts.children) {
			releaseAXElement(child);
		}
		if (facts.role !== observed.role || facts.label !== observed.label) {
			throw new Error(
				`element ${elementIndex} is now ${facts.role} "${facts.label ?? ""}", not the observed control; observe the app again before acting`,
			);
		}
		return element;
	} catch (error) {
		releaseAXElement(element);
		throw error;
	}
}

/**
 * Ask an observed element to scroll itself into view (AXScrollToVisible), which moves its enclosing
 * scroll area without any pointer or keyboard. False when the element does not advertise the action.
 */
export function scrollToVisibleByIndex(pid: number, elementIndex: number): boolean {
	const element = retainedRelocatableElement(pid, elementIndex);
	try {
		if (!copyActionNames(element).includes(AX_SCROLL_TO_VISIBLE_ACTION)) {
			return false;
		}
		performAction(element, AX_SCROLL_TO_VISIBLE_ACTION);
		return true;
	} finally {
		releaseAXElement(element);
	}
}

/** The live frame of an observed element that may have moved since it was observed. */
export function relocatedElementFrame(pid: number, elementIndex: number): AXElementFrame | undefined {
	const element = retainedRelocatableElement(pid, elementIndex);
	try {
		return elementFrame(element);
	} finally {
		releaseAXElement(element);
	}
}

/**
 * Accept the element's current position as its observed position, so actions on its id pass the
 * moved-control check after a deliberate scroll. Only this one id is re-baselined.
 */
export function rebaselineObservedElement(pid: number, elementIndex: number): void {
	const snapshot = elementSnapshots.get(pid);
	const frame = relocatedElementFrame(pid, elementIndex);
	if (snapshot === undefined || frame === undefined) {
		return;
	}
	elementSnapshots.set(pid, {
		...snapshot,
		identity: snapshot.identity.map((shape, index) =>
			index === elementIndex ? { ...shape, y: Math.round(frame.y) } : shape,
		),
	});
}

export function copyAttributeValue(element: AXUIElementRef, attribute: string): CFTypeRef | null {
	return withCFString(attribute, (attributeReference) => {
		const outValue: Array<CFTypeRef | null> = [null];
		const error = AXUIElementCopyAttributeValue(element, attributeReference, outValue);
		assertAXSuccess("AXUIElementCopyAttributeValue", error);
		const value = outValue[0];
		return value === undefined ? null : value;
	});
}

export interface AccessibilityTreeOptions {
	/** Maximum tree depth to walk. */
	readonly maxDepth?: number;
	readonly maxElements?: number;
	/**
	 * Scope the walk to an exact WindowServer id, including a matching AXWindows or
	 * AXFocusedWindow root off-Space. A match includes non-window top-level children
	 * (sheets, panels, popovers); a missing match keeps only app-level popup menus.
	 * If window identity cannot be read, return no elements, never unrelated windows.
	 */
	readonly windowId?: number | undefined;
	/** Include the menu bar, which is app-level rather than window content. Default false. */
	readonly includeMenuBar?: boolean;
	/**
	 * Poll for change detection instead of observing. The walk still returns the capped
	 * signature, but it does not replace the retained snapshot, so element ids from the last
	 * real observation (including a `subtreeOf` anchor) keep resolving. Settle polls use this.
	 */
	readonly signatureOnly?: boolean;
	/**
	 * Walk only the subtree rooted at this element index from the previous observation of
	 * the same app, instead of the window or whole application. Ids restart at 0 inside the
	 * subtree, so a large tree can be explored a branch at a time without paying for the
	 * whole tree in elements, latency or model tokens.
	 */
	readonly subtreeOf?: number | undefined;
	/**
	 * Walk an outline, table or list by the rows it shows (AXVisibleRows, AXVisibleChildren) instead of every
	 * row it holds, so a long list costs a page of rows. A list that names no visible rows is walked whole.
	 * Ids number the walk that was made, and an action on one re-walks the same way.
	 */
	readonly visibleOnly?: boolean;
}

export function extractAccessibilityTree(pid: number, options: AccessibilityTreeOptions = {}): AccessibilityTreeResult {
	const maxDepth = options.maxDepth ?? DEFAULT_AX_MAX_DEPTH;
	const maxElements = options.maxElements ?? DEFAULT_AX_MAX_ELEMENTS;
	const keepIndexSpace = options.signatureOnly === true;
	if (!AXIsProcessTrusted() || !isRunning(pid) || maxDepth < 0 || maxElements <= 0) {
		if (!keepIndexSpace) {
			replaceElementSnapshot(pid, undefined);
		}
		return { elements: [], axAvailable: false, truncated: false, walkKey: unavailableWalkKey(maxDepth, maxElements) };
	}

	const root = createApplicationElement(pid);
	const walkRoots: AXUIElementRef[] = [];
	const snapshotElements: AXUIElementRef[] = [];
	let snapshotInstalled = false;
	try {
		assertAppAnswersAccessibility(root, pid);
		const scope =
			options.subtreeOf === undefined
				? resolveWalkScope(root, options)
				: resolveSubtreeWalkScope(pid, options.subtreeOf, options);
		walkRoots.push(...scope.roots);
		const descriptor: AXWalkScope = { ...scope.descriptor, visibleOnly: options.visibleOnly === true };
		if (scope.appChildren === 0) {
			if (!keepIndexSpace) {
				replaceElementSnapshot(pid, undefined);
			}
			return {
				elements: [],
				axAvailable: false,
				truncated: false,
				walkKey: unavailableWalkKey(maxDepth, maxElements),
			};
		}

		const elements: AXTreeElement[] = [];
		// An unscoped walk starts at the application element, whose recursion covers its
		// children, and produces exactly the order this driver has always produced. A scoped
		// walk starts at the matched window because the application element is not part of
		// a window observation.
		const walkInputs = scope.scoped ? scope.roots : [root];
		const walkResult = walkElements(
			walkInputs,
			maxDepth,
			maxElements,
			elements,
			snapshotElements,
			descriptor.visibleOnly,
		);
		const contentUnavailable =
			scope.degenerate > 0 || walkResult.skippedApplications > 0 ? { windowContentUnavailable: true } : {};
		if (elements.length === 0) {
			if (!keepIndexSpace) {
				replaceElementSnapshot(pid, undefined);
			}
			return {
				elements: [],
				axAvailable: false,
				truncated: false,
				walkKey: unavailableWalkKey(maxDepth, maxElements),
				...contentUnavailable,
			};
		}
		if (!keepIndexSpace) {
			replaceElementSnapshot(pid, {
				maxDepth,
				maxElements,
				scope: descriptor,
				elements: snapshotElements,
				identity: elements.map((element) => ({
					role: element.role,
					label: element.label,
					y: Math.round(element.frame.y),
				})),
			});
			snapshotInstalled = true;
		}
		const firstElement = elements[0];
		let windowTitle: string | undefined;
		if (
			scope.descriptor.windowId !== undefined &&
			scope.descriptor.subtreeOf === undefined &&
			firstElement?.role === "AXWindow" &&
			firstElement.label !== null
		) {
			windowTitle = firstElement.label;
		}
		return {
			elements,
			axAvailable: true,
			truncated: elements.length >= maxElements || walkResult.depthTruncated,
			walkKey: walkKeyFor(descriptor, maxDepth, maxElements),
			...(windowTitle === undefined ? {} : { windowTitle }),
			...contentUnavailable,
		};
	} finally {
		if (!snapshotInstalled) {
			for (const element of snapshotElements) {
				releaseAXElement(element);
			}
		}
		for (const element of walkRoots) {
			releaseAXElement(element);
		}
		releaseAXElement(root);
	}
}

// Browser chrome and web layout wrappers can consume ten levels before a
// toolbar button is reached. The element budget still bounds the walk's cost.
const DEFAULT_AX_MAX_DEPTH = 30;
const DEFAULT_AX_MAX_ELEMENTS = 2_000;

interface ResolvedWalkScope {
	/** Top-level elements to walk, excluding the application element itself. Caller releases them. */
	readonly roots: readonly AXUIElementRef[];
	readonly descriptor: AXWalkScope;
	readonly scoped: boolean;
	/** Available app children or an explicitly resolved window root. */
	readonly appChildren: number;
	/** Children that were application elements standing in for windows; see windowContentUnavailable. */
	readonly degenerate: number;
}

/**
 * Decide what to walk. The scoped case walks the matched AX window first and then the
 * app's non-window top-level children (sheets, panels, popovers, popup menus), because those are
 * visible content of the observation; other windows and the menu bar are not. Any
 * failure to match the requested window keeps only app-level popup menus, never another window.
 */
function resolveWalkScope(root: AXUIElementRef, options: AccessibilityTreeOptions): ResolvedWalkScope {
	const children = copyElementChildren(root);
	// Keep ownership until the scope is returned: an AX timeout can interrupt discovery.
	const owned = [...children];
	let transferred: readonly AXUIElementRef[] = [];
	try {
		let appChildren = children.length;
		const includeMenuBar = options.includeMenuBar === true;
		const windowId = options.windowId;
		if (windowId === undefined) {
			transferred = children;
			return { roots: children, descriptor: UNMATCHED_WINDOW_SCOPE, scoped: false, appChildren, degenerate: 0 };
		}
		const requestedScope: AXWalkScope = {
			windowId,
			includeMenuBar,
			scoped: true,
			subtreeOf: undefined,
			visibleOnly: false,
		};
		if (AXUIElementGetWindowSpi === null) {
			return { roots: [], descriptor: requestedScope, scoped: true, appChildren, degenerate: 0 };
		}

		const axWindows = copyOptionalAttributeValue(root, "AXWindows");
		const availableWindows: AXUIElementRef[] = [];
		if (axWindows !== null && isCFArray(axWindows)) {
			for (let index = 0; index < cfArrayLength(axWindows); index++) {
				const window = cfArrayValueAt(axWindows, index);
				if (window !== null) {
					const retained = cfRetain(window);
					availableWindows.push(retained);
					owned.push(retained);
				}
			}
		}
		cfRelease(axWindows);
		const childWindowIds = new Set(children.map((child) => windowIdOf(child)));
		const windowsFromAttribute = availableWindows.filter((window) => {
			return !childWindowIds.has(windowIdOf(window));
		});
		const candidates = [...children, ...windowsFromAttribute];
		const windows: AXUIElementRef[] = [];
		const attached: AXUIElementRef[] = [];
		const degenerate: AXUIElementRef[] = [];
		for (const child of candidates) {
			if (windowIdOf(child) === windowId) {
				windows.push(child);
				continue;
			}
			const role = copyStringAttribute(child, K_AX_ROLE_ATTRIBUTE) ?? "";
			if (role === "AXApplication") {
				degenerate.push(child);
			} else if (!WINDOW_ROLES.has(role) && (includeMenuBar || (role !== "AXMenuBar" && role !== "AXMenuBarItem"))) {
				attached.push(child);
			}
		}
		appChildren = Math.max(appChildren, windows.length);
		// AppKit can omit every application child on another Space while its focused window
		// remains readable. Only the exact requested WindowServer id can supply that root.
		if (windows.length === 0) {
			const focused = copyFocusedWindowForId(root, windowId);
			if (focused !== null) {
				windows.push(focused);
				owned.push(focused);
				appChildren = Math.max(appChildren, 1);
			}
		}

		// Every child handed back as a root is released by the caller, so a child may be released here
		// only when it is left out of the roots. Releasing one and still returning it made the walk read
		// freed elements and release them twice, which crashed the process whenever the window was not
		// among the AX children (a locked screen, another Space, a window replaced mid-navigation).
		if (windows.length === 0) {
			const popupMenus = attached.filter((child) => {
				const role = copyStringAttribute(child, K_AX_ROLE_ATTRIBUTE);
				return role === "AXMenu" || role === "AXMenuItem";
			});
			transferred = popupMenus;
			return {
				roots: popupMenus,
				descriptor: requestedScope,
				scoped: true,
				appChildren,
				degenerate: 0,
			};
		}
		transferred = [...windows, ...attached];
		return {
			roots: transferred,
			descriptor: requestedScope,
			scoped: true,
			appChildren,
			degenerate: degenerate.length,
		};
	} finally {
		// Transfer each owned retain once, including when multiple references name one element.
		for (const element of transferred) {
			const index = owned.indexOf(element);
			if (index !== -1) owned.splice(index, 1);
		}
		for (const element of owned) {
			releaseAXElement(element);
		}
	}
}

function resolveSubtreeWalkScope(pid: number, subtreeOf: number, options: AccessibilityTreeOptions): ResolvedWalkScope {
	if (!Number.isSafeInteger(subtreeOf) || subtreeOf < 0) {
		throw new Error(`subtreeOf must be a non-negative integer, got ${subtreeOf}`);
	}
	const element = retainedElementForIndex(pid, subtreeOf);
	if (element === undefined) {
		throw new Error(
			`element ${subtreeOf} is not part of the current observation of pid ${pid}; observe the app again before drilling into a subtree`,
		);
	}
	return {
		roots: [element],
		descriptor: {
			windowId: options.windowId,
			includeMenuBar: options.includeMenuBar === true,
			scoped: true,
			subtreeOf,
			visibleOnly: false,
		},
		scoped: true,
		appChildren: 1,
		degenerate: 0,
	};
}

function retainedElementForIndex(pid: number, elementIndex: number): AXUIElementRef | undefined {
	const snapshot = elementSnapshots.get(pid);
	const cached = snapshot?.elements[elementIndex];
	return cached === undefined ? undefined : cfRetain(cached);
}

function windowIdOf(element: AXUIElementRef): number | undefined {
	if (AXUIElementGetWindowSpi === null) {
		return undefined;
	}
	const out = new Uint32Array(1);
	return AXUIElementGetWindowSpi(element, out) === AX_SUCCESS ? out[0] : undefined;
}

function copyFocusedWindowForId(root: AXUIElementRef, windowId: number): AXUIElementRef | null {
	const focused = copyOptionalAttributeValue(root, K_AX_FOCUSED_WINDOW_ATTRIBUTE);
	if (focused === null || windowIdOf(focused) === windowId) {
		return focused;
	}
	cfRelease(focused);
	return null;
}

const WINDOW_ROLES: ReadonlySet<string> = new Set(["AXWindow", "AXSheet", "AXDialog"]);
function walkElements(
	roots: readonly AXUIElementRef[],
	maxDepth: number,
	maxElements: number,
	elements: AXTreeElement[],
	snapshotElements: AXUIElementRef[],
	visibleOnly: boolean,
): { skippedApplications: number; depthTruncated: boolean } {
	const state: WalkState = {
		useMultipleAttributes: true,
		skippedApplications: 0,
		depthTruncated: false,
		visibleOnly,
	};
	for (const root of roots) {
		if (elements.length >= maxElements) {
			break;
		}
		appendAXElement(root, 0, maxDepth, maxElements, elements, snapshotElements, state);
	}
	return { skippedApplications: state.skippedApplications, depthTruncated: state.depthTruncated };
}

interface WalkState {
	useMultipleAttributes: boolean;
	/** Nested application elements left out of the walk; see windowContentUnavailable. */
	skippedApplications: number;
	depthTruncated: boolean;
	readonly visibleOnly: boolean;
}

/** An application element below the root is the app answering for a window it cannot expose. */
function isNestedApplication(element: AXUIElementRef): boolean {
	return copyStringAttribute(element, K_AX_ROLE_ATTRIBUTE) === "AXApplication";
}

const TEXT_ENTRY_ROLES: ReadonlySet<string> = new Set(["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]);

export function performActionByIndex(pid: number, elementIndex: number, action: string): void {
	const element = refetchElement(pid, elementIndex);
	try {
		// A text view or a list lists no page-scroll action itself (AXError -25205), and the scroll area
		// around it refuses the action while its app is in the background; moving the scroll area's
		// scroll bar by one visible page works in both cases without bringing the app forward.
		// A list can advertise the page action yet refuse it (AXError -25205) or accept it and do nothing while
		// its app is in the background (Finder's list view does both), so the scroll bar is moved first; the
		// action itself is the fallback for scroll areas without a settable bar.
		if (action in SCROLL_PAGE_DIRECTIONS && scrollOnePageWithScrollBar(element, action)) {
			return;
		}
		performAction(element, action);
		// Pressing a text field in web content does not move keyboard focus to it, so typing that
		// follows would land wherever focus was (Safari's address bar). A click focuses the field, so
		// focus it explicitly; a field that refuses focus keeps the press alone.
		webFieldFocusedByPress.delete(pid);
		if (
			action === K_AX_PRESS_ACTION &&
			TEXT_ENTRY_ROLES.has(copyStringAttribute(element, K_AX_ROLE_ATTRIBUTE) ?? "")
		) {
			try {
				setAttributeValue(element, "AXFocused", cfBooleanTrue());
				if (isInsideWebArea(element)) {
					webFieldFocusedByPress.add(pid);
				}
			} catch {
				/* Not focusable over accessibility; the press already happened. */
			}
		}
	} finally {
		releaseAXElement(element);
	}
}

/**
 * Apps whose web text field this driver last focused by pressing it. Safari answers no focused
 * element at all while it is in the background, so that press is the evidence left to go on.
 */
const webFieldFocusedByPress = new Set<number>();

/** True when the app's focused element is inside a web page. */
export function focusedElementInWebArea(pid: number): boolean {
	if (!isRunning(pid)) {
		return false;
	}
	const app = createApplicationElement(pid);
	try {
		const focused = copyOptionalAttributeValue(app, K_AX_FOCUSED_UI_ELEMENT_ATTRIBUTE);
		if (focused === null) {
			return webFieldFocusedByPress.has(pid);
		}
		try {
			return isInsideWebArea(focused);
		} finally {
			releaseAXElement(focused);
		}
	} catch {
		return false;
	} finally {
		releaseAXElement(app);
	}
}

const SCROLL_PAGE_DIRECTIONS: Readonly<Record<string, { readonly vertical: boolean; readonly sign: 1 | -1 }>> = {
	AXScrollDownByPage: { vertical: true, sign: 1 },
	AXScrollUpByPage: { vertical: true, sign: -1 },
	AXScrollRightByPage: { vertical: false, sign: 1 },
	AXScrollLeftByPage: { vertical: false, sign: -1 },
};
const MAX_SCROLL_AREA_ANCESTORS = 8;
const SCROLL_SETTLE_POLLS = 20;
const SCROLL_SETTLE_POLL_MILLISECONDS = 10;
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

/** Where a scroll area is scrolled to along one axis: its visible extent, how far it can scroll, and 0..1 progress. */
interface ScrollMetrics {
	readonly visible: number;
	readonly scrollable: number;
	readonly position: number;
}

/**
 * Read the scroll position from geometry: how far the content has moved relative to the scroll area. Finder's
 * list scroll bar keeps reporting the value it was last given, so reading the bar (and adding a page to it) made
 * every page after the first repeat the first; the content frame always says where the content really is.
 */
function scrollMetrics(scrollArea: AXUIElementRef, vertical: boolean): ScrollMetrics | null {
	const area = elementFrame(scrollArea);
	const content = largestContentFrame(scrollArea);
	if (area === undefined || content === null) {
		return null;
	}
	const visible = vertical ? area.height : area.width;
	const scrollable = (vertical ? content.height : content.width) - visible;
	const offset = vertical ? area.y - content.y : area.x - content.x;
	return { visible, scrollable, position: scrollable > 0 ? Math.min(1, Math.max(0, offset / scrollable)) : 0 };
}

/** The scroll bar is set asynchronously; wait, bounded, until the content has moved to where it was told to. */
function awaitScrollPosition(scrollArea: AXUIElementRef, vertical: boolean, wanted: number): void {
	for (let attempt = 0; attempt < SCROLL_SETTLE_POLLS; attempt += 1) {
		const metrics = scrollMetrics(scrollArea, vertical);
		if (metrics === null || metrics.scrollable <= 0 || Math.abs(metrics.position - wanted) * metrics.scrollable < 1) {
			return;
		}
		Atomics.wait(SLEEP_CELL, 0, 0, SCROLL_SETTLE_POLL_MILLISECONDS);
	}
}

/**
 * Scroll by one visible page by moving the enclosing scroll area's scroll bar (AXValue 0..1). The scroll bar spans
 * the content minus the visible part, so one page is visible / (content - visible). False when there is no scroll
 * area or scroll bar to move.
 */
function scrollOnePageWithScrollBar(element: AXUIElementRef, action: string): boolean {
	const direction = SCROLL_PAGE_DIRECTIONS[action];
	if (direction === undefined) {
		return false;
	}
	const scrollArea = selfOrAncestorWithRole(element, "AXScrollArea");
	if (scrollArea === null) {
		return false;
	}
	try {
		const bar = copyOptionalAttributeValue(
			scrollArea,
			direction.vertical ? "AXVerticalScrollBar" : "AXHorizontalScrollBar",
		) as AXUIElementRef | null;
		if (bar === null) {
			return false;
		}
		try {
			const metrics = scrollMetrics(scrollArea, direction.vertical);
			if (metrics === null) {
				return false;
			}
			if (metrics.scrollable <= 0) {
				return true;
			}
			const next = Math.min(
				1,
				Math.max(0, metrics.position + (direction.sign * metrics.visible) / metrics.scrollable),
			);
			const value = toCFNumber(next);
			try {
				setAttributeValue(bar, K_AX_VALUE_ATTRIBUTE, value);
			} finally {
				cfRelease(value);
			}
			awaitScrollPosition(scrollArea, direction.vertical, next);
			return true;
		} finally {
			releaseAXElement(bar);
		}
	} finally {
		releaseAXElement(scrollArea);
	}
}

function selfOrAncestorWithRole(element: AXUIElementRef, role: string): AXUIElementRef | null {
	let current: AXUIElementRef | null = cfRetain(element) as AXUIElementRef;
	try {
		for (let depth = 0; current !== null && depth <= MAX_SCROLL_AREA_ANCESTORS; depth++) {
			if (copyStringAttribute(current, K_AX_ROLE_ATTRIBUTE) === role) {
				const matched = current;
				current = null;
				return matched;
			}
			const parent = copyOptionalAttributeValue(current, "AXParent") as AXUIElementRef | null;
			releaseAXElement(current);
			current = parent;
		}
		return null;
	} finally {
		releaseAXElement(current);
	}
}

/** The frame of the scrolled content: the largest child of the scroll area that is not a scroll bar. */
function largestContentFrame(scrollArea: AXUIElementRef): AXElementFrame | null {
	let largest: AXElementFrame | null = null;
	const children = copyElementChildren(scrollArea);
	try {
		for (const child of children) {
			if (copyStringAttribute(child, K_AX_ROLE_ATTRIBUTE) === "AXScrollBar") {
				continue;
			}
			const frame = elementFrame(child);
			if (frame !== undefined && (largest === null || frame.width * frame.height > largest.width * largest.height)) {
				largest = frame;
			}
		}
		return largest;
	} finally {
		for (const child of children) {
			releaseAXElement(child);
		}
	}
}

const MAX_WEB_AREA_ANCESTORS = 40;

/** Read the ancestry of the current observed control, never an unobserved coordinate hit. */
export function isWebElementByIndex(pid: number, elementIndex: number): boolean {
	const element = refetchElement(pid, elementIndex);
	try {
		return isInsideWebArea(element);
	} finally {
		releaseAXElement(element);
	}
}

/** True when the element sits inside a web page, whose input handlers only see real key events. */
function isInsideWebArea(element: AXUIElementRef): boolean {
	let current: CFTypeRef | null = cfRetain(element);
	try {
		for (let depth = 0; current !== null && depth < MAX_WEB_AREA_ANCESTORS; depth++) {
			if (copyStringAttribute(current as AXUIElementRef, K_AX_ROLE_ATTRIBUTE) === "AXWebArea") {
				return true;
			}
			const parent = copyOptionalAttributeValue(current as AXUIElementRef, "AXParent");
			cfRelease(current);
			current = parent;
		}
		return false;
	} finally {
		cfRelease(current);
	}
}

/**
 * The app's focused element when it is a native text-entry field (not web content, whose fields
 * only react to real key events), retained for the caller to release; null otherwise.
 */
export function focusedTextEntryElement(pid: number): AXUIElementRef | null {
	if (!AXIsProcessTrusted() || !isRunning(pid)) {
		return null;
	}
	const app = createApplicationElement(pid);
	try {
		const focused = copyOptionalAttributeValue(app, K_AX_FOCUSED_UI_ELEMENT_ATTRIBUTE);
		if (focused === null) {
			return null;
		}
		let transferred = false;
		try {
			if (
				TEXT_ENTRY_ROLES.has(copyStringAttribute(focused, K_AX_ROLE_ATTRIBUTE) ?? "") &&
				!isInsideWebArea(focused)
			) {
				transferred = true;
				return focused;
			}
			return null;
		} finally {
			if (!transferred) releaseAXElement(focused);
		}
	} finally {
		releaseAXElement(app);
	}
}

export function typeIntoFocusedAXElement(targetPid: number, text: string): boolean {
	if (!AXIsProcessTrusted() || !isRunning(targetPid) || text.length === 0) {
		return false;
	}
	const app = createApplicationElement(targetPid);
	try {
		const focused = copyOptionalAttributeValue(app, K_AX_FOCUSED_UI_ELEMENT_ATTRIBUTE);
		if (focused === null) {
			return false;
		}
		try {
			// A web page's field accepts the accessibility write but its input and change events never
			// fire, so the page never sees the text; real key events are the route that reaches it.
			// Only a text field takes typed text as a value; a list or outline (Finder's file list)
			// accepts the write and does nothing, where real keys would select an item by name.
			if (
				!TEXT_ENTRY_ROLES.has(copyStringAttribute(focused, K_AX_ROLE_ATTRIBUTE) ?? "") ||
				isInsideWebArea(focused)
			) {
				return false;
			}
			if (trySetSelectedText(focused, text)) {
				return true;
			}
			return tryAppendValue(focused, text);
		} finally {
			releaseAXElement(focused);
		}
	} finally {
		releaseAXElement(app);
	}
}

function trySetSelectedText(element: AXUIElementRef, text: string): boolean {
	return withCFString(K_AX_SELECTED_TEXT_ATTRIBUTE, (attributeReference) => {
		const valueReference = toCFString(text);
		try {
			return AXUIElementSetAttributeValue(element, attributeReference, valueReference) === AX_SUCCESS;
		} finally {
			cfRelease(valueReference);
		}
	});
}

function tryAppendValue(element: AXUIElementRef, text: string): boolean {
	const current = copyStringAttribute(element, K_AX_VALUE_ATTRIBUTE) ?? "";
	return withCFString(K_AX_VALUE_ATTRIBUTE, (attributeReference) => {
		const valueReference = toCFString(`${current}${text}`);
		try {
			return AXUIElementSetAttributeValue(element, attributeReference, valueReference) === AX_SUCCESS;
		} finally {
			cfRelease(valueReference);
		}
	});
}

const MAX_WINDOW_ANCESTORS = 64;

/**
 * The WindowServer ids of the windows containing `element`, innermost first: a control in a sheet answers the sheet,
 * then the window the sheet belongs to. Empty when the window-id lookup is unavailable.
 */
function containingWindowIds(element: AXUIElementRef): number[] {
	const ids: number[] = [];
	if (AXUIElementGetWindowSpi === null) {
		return ids;
	}
	let current: CFTypeRef | null = cfRetain(element);
	try {
		for (let depth = 0; current !== null && depth < MAX_WINDOW_ANCESTORS; depth++) {
			const id = windowIdOf(current);
			if (id !== undefined && id !== 0 && ids.at(-1) !== id) {
				ids.push(id);
			}
			const parent = copyOptionalAttributeValue(current, "AXParent");
			cfRelease(current);
			current = parent;
		}
		return ids;
	} finally {
		cfRelease(current);
	}
}

/**
 * The windows containing the element `pid` shows at a screen point, innermost first (see containingWindowIds). The
 * hit test is the app's own, over its windows only, so another app's window covering the point does not answer.
 * undefined when accessibility cannot tell.
 */
export function windowIdsAtScreenPoint(pid: number, x: number, y: number): readonly number[] | undefined {
	if (!AXIsProcessTrusted() || !isRunning(pid) || AXUIElementGetWindowSpi === null) {
		return undefined;
	}
	let app: AXUIElementRef | null = null;
	try {
		app = createApplicationElement(pid);
		const out: Array<AXUIElementRef | null> = [null];
		if (AXUIElementCopyElementAtPosition(app, x, y, out) !== AX_SUCCESS) {
			return undefined;
		}
		const element = out[0];
		if (element === null || element === undefined) {
			return undefined;
		}
		try {
			return containingWindowIds(element);
		} finally {
			releaseAXElement(element);
		}
	} catch {
		return undefined;
	} finally {
		if (app !== null) {
			releaseAXElement(app);
		}
	}
}

/**
 * Press the element at a screen point when it belongs to `targetPid` and advertises AXPress. With `windowId` (the
 * observed window the press is bound to) the element must also lie in that window: where another window of the same
 * app covers it, the control there is not the one the caller observed, so nothing is pressed and false comes back.
 */
export function pressElementAtScreenPoint(targetPid: number, x: number, y: number, windowId?: number): boolean {
	if (!AXIsProcessTrusted() || !isRunning(targetPid)) {
		return false;
	}
	const systemwide = AXUIElementCreateSystemWide();
	if (systemwide === null) {
		return false;
	}
	applyMessagingTimeout(systemwide);
	try {
		const out: Array<AXUIElementRef | null> = [null];
		const error = AXUIElementCopyElementAtPosition(systemwide, x, y, out);
		if (error !== AX_SUCCESS) {
			return false;
		}
		const element = out[0];
		if (element === null || element === undefined) {
			return false;
		}
		try {
			const pidBuffer = new Int32Array(1);
			const pidError = AXUIElementGetPid(element, pidBuffer);
			if (pidError !== AX_SUCCESS || pidBuffer[0] !== targetPid) {
				return false;
			}
			if (windowId !== undefined && !containingWindowIds(element).includes(windowId)) {
				return false;
			}
			const actions = copyActionNames(element);
			if (!actions.includes(K_AX_PRESS_ACTION)) {
				return false;
			}
			performAction(element, K_AX_PRESS_ACTION);
			return true;
		} finally {
			releaseAXElement(element);
		}
	} finally {
		releaseAXElement(systemwide);
	}
}

export function setValueByIndex(pid: number, elementIndex: number, value: string): void {
	const element = refetchElement(pid, elementIndex);
	try {
		setStringAttributeValue(element, K_AX_VALUE_ATTRIBUTE, value);
	} finally {
		releaseAXElement(element);
	}
}

export function refetchElement(
	pid: number,
	elementIndex: number,
	maxDepth = DEFAULT_AX_MAX_DEPTH,
	maxElements = DEFAULT_AX_MAX_ELEMENTS,
): AXUIElementRef {
	if (!AXIsProcessTrusted()) {
		replaceElementSnapshot(pid, undefined);
		throw new Error("accessibility permission denied");
	}
	if (!isRunning(pid)) {
		replaceElementSnapshot(pid, undefined);
		throw new Error(`invalid process or element index: ${pid}:${elementIndex}`);
	}
	if (elementIndex < 0 || elementIndex >= maxElements) {
		throw new Error(`invalid process or element index: ${pid}:${elementIndex}`);
	}

	const snapshot = elementSnapshots.get(pid);
	if (snapshot?.maxDepth === maxDepth && snapshot.maxElements === maxElements) {
		const cached = snapshot.elements[elementIndex];
		if (cached === undefined) {
			throw new Error(`element ${elementIndex} not found in snapshot`);
		}
		const retained = cfRetain(cached);
		try {
			assertStillObservedControl(retained, snapshot.identity[elementIndex], elementIndex);
			return retained;
		} catch (error) {
			releaseAXElement(retained);
			throw error;
		}
	}

	const root = createApplicationElement(pid);
	const walkRoots: AXUIElementRef[] = [];
	try {
		const scope: AXWalkScope = snapshot?.scope ?? UNMATCHED_WINDOW_SCOPE;
		if (scope.subtreeOf !== undefined) {
			const subtreeRoot = retainedElementForIndex(pid, 0);
			if (subtreeRoot === undefined) {
				throw new Error(`element ${elementIndex} not found`);
			}
			walkRoots.push(subtreeRoot);
			const cursor = { value: 0 };
			const matched = findAXElement(subtreeRoot, elementIndex, 0, maxDepth, maxElements, cursor, scope.visibleOnly);
			if (matched !== null) {
				try {
					assertStillObservedControl(matched, snapshot?.identity[elementIndex], elementIndex);
					return matched;
				} catch (error) {
					releaseAXElement(matched);
					throw error;
				}
			}
			throw new Error(`element ${elementIndex} not found`);
		}
		const resolved = resolveWalkScope(root, {
			windowId: scope.windowId,
			includeMenuBar: scope.includeMenuBar,
		});
		walkRoots.push(...resolved.roots);
		const walkInputs = resolved.scoped ? resolved.roots : [root];
		const cursor = { value: 0 };
		for (const walkInput of walkInputs) {
			const matched = findAXElement(walkInput, elementIndex, 0, maxDepth, maxElements, cursor, scope.visibleOnly);
			if (matched !== null) {
				try {
					assertStillObservedControl(matched, snapshot?.identity[elementIndex], elementIndex);
					return matched;
				} catch (error) {
					releaseAXElement(matched);
					throw error;
				}
			}
		}
		throw new Error(`element ${elementIndex} not found`);
	} finally {
		for (const element of walkRoots) {
			releaseAXElement(element);
		}
		releaseAXElement(root);
	}
}

function appendAXElement(
	element: AXUIElementRef,
	depth: number,
	maxDepth: number,
	maxElements: number,
	elements: AXTreeElement[],
	snapshotElements: AXUIElementRef[],
	state: WalkState,
): number | undefined {
	if (depth > maxDepth || elements.length >= maxElements) {
		return undefined;
	}

	const facts = copyElementFacts(element, state);
	if (depth > 0 && facts.role === "AXApplication") {
		state.skippedApplications += 1;
		for (const child of facts.children) {
			releaseAXElement(child);
		}
		return undefined;
	}
	const children = walkChildren(element, facts, state.visibleOnly);
	try {
		const id = elements.length;
		snapshotElements.push(cfRetain(element));
		elements.push({
			id,
			role: facts.role,
			label: facts.label,
			value: facts.value,
			frame: facts.frame,
			actions: copyActionsForRole(element, facts.role),
			children: [],
		});

		const childIds: number[] = [];
		if (depth < maxDepth) {
			for (const child of children) {
				if (elements.length >= maxElements) {
					break;
				}
				const childId = appendAXElement(child, depth + 1, maxDepth, maxElements, elements, snapshotElements, state);
				if (childId !== undefined) {
					childIds.push(childId);
				}
			}
		} else {
			state.depthTruncated ||= children.length > 0;
		}

		const current = elements[id];
		if (current === undefined) {
			throw new Error(`AX tree cursor lost element ${id}`);
		}
		elements[id] = { ...current, children: childIds };
		return id;
	} finally {
		for (const child of children) {
			releaseAXElement(child);
		}
	}
}

/**
 * Read every fact about one element in as few AX round trips as possible.
 *
 * `AXUIElementCopyMultipleAttributeValues` returns the requested attributes in one
 * round trip (measured ~5x cheaper than six single reads), which dominates walk cost
 * for large applications. Unsupported calls fall back to single reads; a messaging timeout
 * aborts instead of multiplying the same unresponsive-app wait across every attribute.
 */
function copyElementFacts(element: AXUIElementRef, state: WalkState): AXElementFacts {
	if (!state.useMultipleAttributes) {
		return copyElementFactsOneByOne(element);
	}

	const attributeReferences = ELEMENT_FACT_ATTRIBUTES.map((attribute) => toCFString(attribute));
	let facts: AXElementFacts | undefined;
	try {
		facts = withCFArray(attributeReferences, (attributes) => {
			const outValues: Array<CFArrayRef | null> = [null];
			const error = AXUIElementCopyMultipleAttributeValues(element, attributes, 0, outValues);
			if (error === AX_ERROR_CANNOT_COMPLETE) {
				assertAXSuccess("AXUIElementCopyMultipleAttributeValues", error);
			}
			const values = outValues[0];
			if (error !== AX_SUCCESS || values === undefined || values === null) {
				return undefined;
			}
			try {
				return factsFromValues(values);
			} finally {
				cfRelease(values);
			}
		});
	} finally {
		for (const reference of attributeReferences) {
			cfRelease(reference);
		}
	}

	if (facts === undefined) {
		state.useMultipleAttributes = false;
		return copyElementFactsOneByOne(element);
	}
	return facts;
}

function copyElementFactsOneByOne(element: AXUIElementRef): AXElementFacts {
	const label =
		copyStringAttribute(element, K_AX_TITLE_ATTRIBUTE) ?? copyStringAttribute(element, K_AX_DESCRIPTION_ATTRIBUTE);
	return {
		role: copyStringAttribute(element, K_AX_ROLE_ATTRIBUTE) ?? "",
		label,
		value: copyStringValueAttribute(element),
		frame: copyFrame(element),
		children: copyElementChildren(element),
	};
}

function factsFromValues(values: CFArrayRef): AXElementFacts {
	const valueAt = (index: number): CFTypeRef | null => {
		if (index >= cfArrayLength(values)) {
			return null;
		}
		const value = cfArrayValueAt(values, index);
		return value === null || isCFNull(value) ? null : value;
	};

	const title = stringOrNull(valueAt(1));
	const descriptionValue = title === null ? stringOrNull(valueAt(2)) : null;
	return {
		role: stringOrNull(valueAt(0)) ?? "",
		label: title ?? descriptionValue,
		value: stringOrNull(valueAt(3)),
		frame: {
			...(pointFromValue(valueAt(4)) ?? { x: 0, y: 0 }),
			...(sizeFromValue(valueAt(5)) ?? { width: 0, height: 0 }),
		},
		children: childrenFromValue(valueAt(6)),
	};
}

function childrenFromValue(value: CFTypeRef | null): AXUIElementRef[] {
	if (value === null) {
		return [];
	}
	// Some applications hand back a single element instead of an array for AXChildren.
	if (cfGetTypeId(value) === AXUIElementGetTypeID()) {
		return [cfRetain(value)];
	}
	if (!isCFArray(value)) {
		return [];
	}
	const children: AXUIElementRef[] = [];
	for (let index = 0; index < cfArrayLength(value); index += 1) {
		const child = cfArrayValueAt(value, index);
		if (child !== null && cfGetTypeId(child) === AXUIElementGetTypeID()) {
			children.push(cfRetain(child));
		}
	}
	return children;
}

function stringOrNull(value: CFTypeRef | null): string | null {
	return value === null ? null : stringFromValue(value);
}

/** Roles that cannot act do not need their action list fetched over AX. */
function copyActionsForRole(element: AXUIElementRef, role: string): string[] {
	return NON_ACTIONABLE_ROLES.has(role) ? [] : copyActionNames(element);
}

function replaceElementSnapshot(pid: number, snapshot: Omit<AXElementSnapshot, "generation"> | undefined): void {
	const previous = elementSnapshots.get(pid);
	if (previous !== undefined) {
		for (const element of previous.elements) {
			releaseAXElement(element);
		}
	}
	if (snapshot === undefined) {
		elementSnapshots.delete(pid);
	} else {
		nextSnapshotGeneration += 1;
		elementSnapshots.set(pid, { ...snapshot, generation: nextSnapshotGeneration });
	}
}

/**
 * Key of the observation currently backing element ids for one app. A caller holds the key from
 * the state it read ids out of and can then prove those ids still belong to that observation,
 * which is what stops an index outliving the tree it was derived from.
 */
export function currentObservationKey(pid: number): string | undefined {
	const snapshot = elementSnapshots.get(pid);
	if (snapshot === undefined) {
		return undefined;
	}
	return `${snapshot.generation}:${walkKeyFor(snapshot.scope, snapshot.maxDepth, snapshot.maxElements)}`;
}

/**
 * An id only means the control the observation saw if the live element behind it still reads
 * as that control. Virtualised lists destroy and rebuild rows, and a retained reference can
 * outlive the row it described, so acting on an unverified id is how input lands on the wrong
 * control. Refusing here costs one attribute read; mis-targeting costs the user's trust.
 */
function assertStillObservedControl(
	element: AXUIElementRef,
	observed: ObservedElementShape | undefined,
	elementIndex: number,
): void {
	if (observed === undefined) {
		return;
	}
	const facts = copyElementFacts(element, {
		useMultipleAttributes: true,
		skippedApplications: 0,
		depthTruncated: false,
		visibleOnly: false,
	});
	for (const child of facts.children) {
		releaseAXElement(child);
	}
	if (facts.role === observed.role && facts.label === observed.label && Math.round(facts.frame.y) === observed.y) {
		return;
	}
	throw new Error(
		`element ${elementIndex} is now ${facts.role} "${facts.label ?? ""}", not the observed control; observe the app again before acting`,
	);
}

function findAXElement(
	element: AXUIElementRef,
	targetIndex: number,
	depth: number,
	maxDepth: number,
	maxElements: number,
	cursor: { value: number },
	visibleOnly: boolean,
): AXUIElementRef | null {
	if (depth > maxDepth || cursor.value >= maxElements) {
		return null;
	}
	if (cursor.value === targetIndex) {
		return cfRetain(element);
	}
	cursor.value += 1;

	if (depth >= maxDepth) {
		return null;
	}

	const children = copyWalkChildren(element, visibleOnly);
	try {
		for (const child of children) {
			// Mirrors the walk, which leaves nested application elements out, so ids stay aligned.
			if (isNestedApplication(child)) {
				continue;
			}
			const matched = findAXElement(child, targetIndex, depth + 1, maxDepth, maxElements, cursor, visibleOnly);
			if (matched !== null) {
				return matched;
			}
			if (cursor.value >= maxElements) {
				break;
			}
		}
		return null;
	} finally {
		for (const child of children) {
			releaseAXElement(child);
		}
	}
}

function copyStringAttribute(element: AXUIElementRef, attribute: string): string | null {
	const value = copyOptionalAttributeValue(element, attribute);
	if (value === null) {
		return null;
	}
	try {
		return stringFromValue(value);
	} finally {
		cfRelease(value);
	}
}

function copyStringValueAttribute(element: AXUIElementRef): string | null {
	const value = copyOptionalAttributeValue(element, K_AX_VALUE_ATTRIBUTE);
	if (value === null) {
		return null;
	}
	try {
		return stringFromValue(value);
	} finally {
		cfRelease(value);
	}
}

function stringFromValue(value: CFTypeRef): string | null {
	if (isCFString(value)) {
		return fromCFString(value);
	}
	if (isCFNumber(value)) {
		return String(fromCFNumber(value));
	}
	if (isCFBoolean(value)) {
		return String(fromCFBoolean(value));
	}
	return null;
}

function copyFrame(element: AXUIElementRef): AXTreeElement["frame"] {
	const position = copyPointAttribute(element, K_AX_POSITION_ATTRIBUTE) ?? { x: 0, y: 0 };
	const size = copySizeAttribute(element, K_AX_SIZE_ATTRIBUTE) ?? { width: 0, height: 0 };
	return { ...position, ...size };
}

function copyPointAttribute(element: AXUIElementRef, attribute: string): { x: number; y: number } | null {
	const value = copyOptionalAttributeValue(element, attribute);
	if (value === null) {
		return null;
	}
	try {
		return pointFromValue(value);
	} finally {
		cfRelease(value);
	}
}

function pointFromValue(value: CFTypeRef | null): { x: number; y: number } | null {
	if (value === null || !isAXValue(value) || AXValueGetType(value) !== AX_VALUE_CG_POINT) {
		return null;
	}
	const buffer = Buffer.alloc(CG_PAIR_SIZE);
	if (!AXValueGetValue(value, AX_VALUE_CG_POINT, buffer)) {
		return null;
	}
	return { x: buffer.readDoubleLE(0), y: buffer.readDoubleLE(DOUBLE_SIZE) };
}

function copySizeAttribute(element: AXUIElementRef, attribute: string): { width: number; height: number } | null {
	const value = copyOptionalAttributeValue(element, attribute);
	if (value === null) {
		return null;
	}
	try {
		return sizeFromValue(value);
	} finally {
		cfRelease(value);
	}
}

function sizeFromValue(value: CFTypeRef | null): { width: number; height: number } | null {
	if (value === null || !isAXValue(value) || AXValueGetType(value) !== AX_VALUE_CG_SIZE) {
		return null;
	}
	const buffer = Buffer.alloc(CG_PAIR_SIZE);
	if (!AXValueGetValue(value, AX_VALUE_CG_SIZE, buffer)) {
		return null;
	}
	return { width: buffer.readDoubleLE(0), height: buffer.readDoubleLE(DOUBLE_SIZE) };
}

function copyElementChildren(element: AXUIElementRef): AXUIElementRef[] {
	const value = copyOptionalAttributeValue(element, K_AX_CHILDREN_ATTRIBUTE);
	if (value === null) {
		return [];
	}
	try {
		return childrenFromValue(value);
	} finally {
		cfRelease(value);
	}
}

/** The attribute that names the rows a list, table or outline shows, by role. */
const VISIBLE_CHILDREN_ATTRIBUTES: ReadonlyMap<string, string> = new Map([
	["AXOutline", "AXVisibleRows"],
	["AXTable", "AXVisibleRows"],
	["AXList", "AXVisibleChildren"],
]);

/** The rows a list shows, or undefined when its role or app does not name them (the caller walks it whole). */
function copyVisibleChildren(element: AXUIElementRef, role: string): AXUIElementRef[] | undefined {
	const attribute = VISIBLE_CHILDREN_ATTRIBUTES.get(role);
	if (attribute === undefined) {
		return undefined;
	}
	const value = copyOptionalAttributeValue(element, attribute);
	if (value === null) {
		return undefined;
	}
	try {
		const visible = childrenFromValue(value);
		return visible.length === 0 ? undefined : visible;
	} finally {
		cfRelease(value);
	}
}

/** The children a walk descends into: the shown rows of a list when asked, else everything it holds. */
function walkChildren(element: AXUIElementRef, facts: AXElementFacts, visibleOnly: boolean): readonly AXUIElementRef[] {
	if (!visibleOnly) {
		return facts.children;
	}
	let visible: AXUIElementRef[] | undefined;
	try {
		visible = copyVisibleChildren(element, facts.role);
	} catch (error) {
		for (const child of facts.children) {
			releaseAXElement(child);
		}
		throw error;
	}
	if (visible === undefined) {
		return facts.children;
	}
	for (const child of facts.children) {
		releaseAXElement(child);
	}
	return visible;
}

/** The same children as {@link walkChildren}, for a re-walk that has no facts read yet. */
function copyWalkChildren(element: AXUIElementRef, visibleOnly: boolean): AXUIElementRef[] {
	if (visibleOnly) {
		const visible = copyVisibleChildren(element, copyStringAttribute(element, K_AX_ROLE_ATTRIBUTE) ?? "");
		if (visible !== undefined) {
			return visible;
		}
	}
	return copyElementChildren(element);
}

function copyActionNames(element: AXUIElementRef): string[] {
	const outActions: Array<CFArrayRef | null> = [null];
	const error = AXUIElementCopyActionNames(element, outActions);
	if (error === AX_ERROR_CANNOT_COMPLETE) {
		assertAXSuccess("AXUIElementCopyActionNames", error);
	}
	if (error !== AX_SUCCESS) {
		return [];
	}
	const actions = outActions[0];
	if (actions === undefined || actions === null) {
		return [];
	}
	try {
		const names: string[] = [];
		for (let index = 0; index < cfArrayLength(actions); index += 1) {
			const value = cfArrayValueAt(actions, index);
			if (value !== null && isCFString(value)) {
				names.push(fromCFString(value));
			}
		}
		return names;
	} finally {
		cfRelease(actions);
	}
}

/**
 * Attribute read that answers "not there" for unavailable attributes, but propagates messaging
 * timeouts so a walk cannot turn one stalled app into hundreds of waits. Prefer {@link copyAttributeValue}
 * where the attribute is part of the contract, and this one where its absence is simply how a
 * leaf element looks — AXChildren on a text label, for instance.
 */
export function copyOptionalAttributeValue(element: AXUIElementRef, attribute: string): CFTypeRef | null {
	return withCFString(attribute, (attributeReference) => {
		const outValue: Array<CFTypeRef | null> = [null];
		const error = AXUIElementCopyAttributeValue(element, attributeReference, outValue);
		if (error === AX_ERROR_CANNOT_COMPLETE) {
			assertAXSuccess("AXUIElementCopyAttributeValue", error);
		}
		if (error !== AX_SUCCESS) {
			return null;
		}
		const value = outValue[0];
		return value === undefined ? null : value;
	});
}

function isAXValue(value: CFTypeRef): value is AXValueRef {
	return cfGetTypeId(value) === AXValueGetTypeID();
}

function isRunning(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) {
		return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function assertAXSuccess(operation: string, error: number): void {
	if (error !== AX_SUCCESS) {
		const hint =
			error === AX_ERROR_CANNOT_COMPLETE
				? " - the app did not answer within the accessibility messaging timeout; it may be busy loading, or showing a sheet only a person can clear"
				: "";
		throw new Error(`${operation} failed with AXError ${error}${hint}`);
	}
}
