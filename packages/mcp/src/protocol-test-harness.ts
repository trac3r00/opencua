import { UrlBlockedError } from "@opencua/core";
import { currentInputScope } from "@opencua/core";
import type {
	AXTreeElement,
	AppState,
	AppStateOptions,
	ClipboardWriteInput,
	ClipboardWriteResult,
	ComputerCapabilities,
	DragOptions,
	GuardedComputerInterface,
	InputObservation,
	InvokeMenuResult,
	KeyOptions,
	Point,
	PointerOptions,
	PreflightOptions,
	PreflightResult,
	Rect,
	ScreenshotOptions,
	ScreenshotResult,
	ScrollOptions,
	SelectTextOptions,
	SystemPrompt,
	WindowTextRead,
} from "@opencua/core";

/** The scroll area and first row of the scrollable list the fake can model (see `scrollList`). */
const SCROLL_AREA_ID = 200;
const FIRST_ROW_ID = 201;
const ROW_HEIGHT = 20;
const AREA_FRAME = { x: 0, y: 100, width: 300, height: 100 };

export type Effect =
	| { readonly kind: "performAction"; readonly pid: number; readonly id: number; readonly action: string }
	| { readonly kind: "setValue"; readonly pid: number; readonly id: number; readonly value: string }
	| { readonly kind: "selectText"; readonly pid: number; readonly id: number }
	| { readonly kind: "click"; readonly point: Point; readonly modifiers?: PointerOptions["modifiers"] }
	| { readonly kind: "drag"; readonly options: DragOptions }
	| { readonly kind: "scroll"; readonly options: ScrollOptions }
	| { readonly kind: "move"; readonly point: Point }
	| { readonly kind: "scrollIntoView"; readonly pid: number; readonly id: number }
	| { readonly kind: "type"; readonly text: string }
	| { readonly kind: "key"; readonly key: string }
	| { readonly kind: "invokeMenu"; readonly pid: number; readonly path: readonly string[] }
	| { readonly kind: "clipboardWrite"; readonly input: ClipboardWriteInput }
	| { readonly kind: "openUrl"; readonly pid: number; readonly url: string }
	| { readonly kind: "close" };

function clickEffect(point: Point, options: PointerOptions | undefined): Effect {
	return options?.modifiers === undefined
		? { kind: "click", point }
		: { kind: "click", point, modifiers: options.modifiers };
}

function diffElements(
	before: readonly AXTreeElement[],
	after: readonly AXTreeElement[],
): { added: AXTreeElement[]; removed: AXTreeElement[]; changed: { before: AXTreeElement; after: AXTreeElement }[] } {
	const beforeById = new Map(before.map((element) => [element.id, element] as const));
	const afterById = new Map(after.map((element) => [element.id, element] as const));
	const added = after.filter((element) => !beforeById.has(element.id));
	const removed = before.filter((element) => !afterById.has(element.id));
	const changed = after.flatMap((element) => {
		const previous = beforeById.get(element.id);
		return previous !== undefined && JSON.stringify(previous) !== JSON.stringify(element)
			? [{ before: previous, after: element }]
			: [];
	});
	return { added, removed, changed };
}

/** The subtree of one element with ids restarting at 0, and which original id each new id stands for. */
function rebaseSubtree(
	elements: readonly AXTreeElement[],
	rootId: number,
): { elements: AXTreeElement[]; ids: ReadonlyMap<number, number> } {
	const byId = new Map(elements.map((element) => [element.id, element] as const));
	const order: AXTreeElement[] = [];
	const visit = (id: number): void => {
		const element = byId.get(id);
		if (element !== undefined) {
			order.push(element);
			for (const child of element.children) {
				visit(child);
			}
		}
	};
	visit(rootId);
	const renumbered = new Map(order.map((element, index) => [element.id, index] as const));
	return {
		elements: order.map((element) => ({
			...element,
			id: renumbered.get(element.id) ?? element.id,
			children: element.children.flatMap((child) => {
				const id = renumbered.get(child);
				return id === undefined ? [] : [id];
			}),
		})),
		ids: new Map(order.map((element, index) => [index, element.id] as const)),
	};
}

export class Deferred<T> {
	readonly promise: Promise<T>;
	private resolvePromise: ((value: T) => void) | undefined;

	constructor() {
		this.promise = new Promise<T>((resolve) => {
			this.resolvePromise = resolve;
		});
	}

	resolve(value: T): void {
		const resolve = this.resolvePromise;
		if (resolve === undefined) {
			throw new Error("deferred promise was already resolved");
		}
		this.resolvePromise = undefined;
		resolve(value);
	}
}

export class FakeGuardedComputer implements GuardedComputerInterface {
	readonly capabilities: ComputerCapabilities = {
		supportsScreenshot: true,
		supportsInput: true,
		supportsAccessibility: true,
		supportsClipboard: true,
	};
	readonly effects: Effect[] = [];
	readonly stateOptions: (AppStateOptions | undefined)[] = [];
	readonly preflightExpected: InputObservation[] = [];
	preflightResult: PreflightResult = { ok: true };
	readonly preflightOptions: (PreflightOptions | undefined)[] = [];
	preflightGate: Deferred<PreflightResult> | undefined;
	preflightEntered: Deferred<void> | undefined;
	stateGate: Deferred<void> | undefined;
	stateError: Error | undefined;
	inputError: Error | undefined;
	postActionSummary: AppState["axChangeSummary"] = { added: 1, removed: 0, changed: 0 };
	readonly hiddenElementIds = new Set<number>();
	readonly elementLabelOverrides = new Map<number, string>();
	readonly elementActions = new Map<number, readonly string[]>();
	readonly extraElements: AXTreeElement[] = [];
	readonly fieldValues = new Map<number, string | null>([
		[20, "draft"],
		[21, "queued"],
	]);
	valueWriteEffect: "apply" | "ignore" = "apply";
	/** Extra synthetic rows, used to model a mutation that changes many controls at once. */
	syntheticRowCount = 0;
	/** When true, state reports that the accessibility walk stopped at its element budget. */
	elementsTruncated = false;
	/** Called at the start of every accessibility walk, so a test can change the tree between polls. */
	onStateCall: ((call: number) => void) | undefined;
	/** Delivery mode the fake computer reports, mirroring the native driver's default. */
	delivery: "attended" | "background" = "background";
	frontmost = true;
	/** When set, every accessibility action throws it, modelling a control that rejects AXPress. */
	performActionError: Error | undefined;
	readonly elementFrames = new Map<number, Rect>();
	windowId = 71;
	windowIdAfterAction: number | undefined;
	windowBounds = { x: 300, y: 150, width: 1000, height: 800 };
	/** macOS dialogs the fake reports on screen, as the native driver does with systemPrompts. */
	systemPrompts: readonly SystemPrompt[] = [];
	/** Fields merged into every observed state, for states the plain fake never produces. */
	stateExtras: Partial<AppState> = {};
	/** When true, the fake behaves like a server without Screen Recording: no image, and why. */
	screenCaptureDenied = false;
	/**
	 * A scrollable list: page-scroll actions on its scroll area (id 200) move the rows in view, `visibleRows` at a
	 * time. A virtualized list walks only the rows in view; otherwise every row is in the tree, clipped by the area.
	 */
	scrollList:
		| { readonly rows: readonly string[]; readonly visibleRows: number; readonly virtualized: boolean }
		| undefined;
	/** Index of the first row in view. */
	scrollOffset = 0;
	/** Rows are drawn and readable from pixels but absent from the accessibility tree. */
	axHidesRows = false;
	/** The options of every window-text read, in order. */
	readonly recognizeOptions: ({ readonly region?: Rect } | undefined)[] = [];
	/** Rows advertise AXScrollToVisible, which scrollElementIntoView then performs. */
	scrollIntoViewAdvertised = false;
	/** Rows advertise AXPress, so a click on a found row goes through its element id. */
	rowsPressable = false;
	/** How many elements each probe read (a scroll-until-found page check) returned, in order. */
	readonly probeElementCounts: number[] = [];
	/** Called after each page-scroll action with the pages scrolled so far. */
	onScrollPage: ((pagesScrolled: number) => void) | undefined;
	/** Where the drawn agent cursor was asked to glide, in order. */
	readonly pointerHints: Point[] = [];
	/** Options passed to typeIntoFocused, in order, for write-settlement tests. */
	readonly typeOptions: ({ readonly settleWrite?: boolean } | undefined)[] = [];
	/**
	 * Every synthetic keyboard and pointer input, with the app and window it went to: the input scope's target when
	 * it went out, else the default setTarget left, which is where a native computer would deliver it.
	 */
	readonly targetedInputs: {
		readonly effect: Effect;
		readonly pid: number | undefined;
		readonly windowId: number | undefined;
	}[] = [];
	/**
	 * Awaited by each synthetic input before its target is read, as the native driver awaits its window lookup: a
	 * test holds one app's input here while another app's runs.
	 */
	inputGate: ((effect: Effect) => Promise<void>) | undefined;
	private defaultTarget: number | undefined;
	private pagesScrolled = 0;
	private subtreeIds: ReadonlyMap<number, number> | undefined;
	private generation = 0;
	/** How many app-state reads the fake has answered; tests compare it before and after an action. */
	stateCalls = 0;
	private readonly observations = new Map<number, InputObservation>();
	private actionDispatched = false;

	async getAppState(targetPid = 1234, options?: AppStateOptions): Promise<AppState> {
		this.stateCalls += 1;
		this.onStateCall?.(this.stateCalls);
		this.stateOptions.push(options);
		const gate = this.stateGate;
		if (gate !== undefined) {
			this.stateGate = undefined;
			await gate.promise;
		}
		const error = this.stateError;
		if (error !== undefined) {
			this.stateError = undefined;
			this.observations.delete(targetPid);
			throw error;
		}
		const app = targetPid === 5678 ? "Other" : "Finder";
		const bundleId = targetPid === 5678 ? "com.example.other" : "com.apple.finder";
		const captureTree = options?.includeAccessibilityTree !== false;
		const probe = options?.probe === true;
		let elements = captureTree ? this.currentElements(options?.visibleOnly === true) : [];
		if (captureTree && options?.subtreeOf !== undefined) {
			const rebased = rebaseSubtree(
				elements,
				// Like the real driver, the id names an element of the previous snapshot: after a subtree read, its own ids.
				this.subtreeIds?.get(options.subtreeOf) ?? options.subtreeOf,
			);
			elements = rebased.elements;
			this.subtreeIds = rebased.ids;
		} else if (captureTree) {
			this.subtreeIds = undefined;
		}
		if (captureTree && probe) {
			this.probeElementCounts.push(elements.length);
		}
		const previous = this.snapshotByPid.get(targetPid);
		const axChanges = previous === undefined || !captureTree || probe ? undefined : diffElements(previous, elements);
		if (captureTree && !probe) {
			this.snapshotByPid.set(targetPid, elements);
		}
		const treeOmitted = options?.diffOnly === true && captureTree && this.sawSnapshot.has(targetPid);
		this.sawSnapshot.add(targetPid);
		const state: AppState = {
			app,
			bundleId,
			pid: targetPid,
			frontmost: this.frontmost,
			axAvailable: true,
			elements: treeOmitted ? [] : elements,
			...(captureTree ? {} : { treeSkipped: true }),
			screenshotBase64:
				options?.includeScreenshot === false || this.screenCaptureDenied
					? ""
					: Buffer.from("png-bytes").toString("base64"),
			screenshotWidth: 500,
			screenshotHeight: 400,
			screenshotMimeType: "image/png",
			display: { width: 1920, height: 1080, scaleFactor: 2 },
			windowBounds: { ...this.windowBounds },
			...(treeOmitted ? { treeOmitted: true } : {}),
			...(this.elementsTruncated ? { elementsTruncated: true } : {}),
			...(this.screenCaptureDenied && options?.includeScreenshot !== false
				? { screenshotUnavailable: "screen-recording-permission" as const }
				: {}),
			...(this.systemPrompts.length > 0 ? { systemPrompts: this.systemPrompts } : {}),
			...(this.actionDispatched && this.postActionSummary !== undefined
				? {
						axChangeSummary: this.postActionSummary,
						...(axChanges === undefined ? {} : { axChanges }),
					}
				: {}),
			...this.stateExtras,
		};
		if (captureTree && !probe) {
			this.generation += 1;
			this.observations.set(targetPid, {
				generation: this.generation,
				pid: targetPid,
				bundleId,
				windowId: this.windowId,
				windowBounds: { ...this.windowBounds },
				screenshotViewport: { width: 500, height: 400, bounds: { ...this.windowBounds } },
				observedElementIds: new Set(elements.map((element) => element.id)),
			});
		}
		return state;
	}

	assertObservationCurrent(): void {}

	getInputObservation(targetPid: number): InputObservation | undefined {
		return this.observations.get(targetPid);
	}

	async preflightInput(expected: InputObservation, options?: PreflightOptions): Promise<PreflightResult> {
		this.preflightExpected.push(expected);
		this.preflightOptions.push(options);
		const entered = this.preflightEntered;
		this.preflightEntered = undefined;
		entered?.resolve(undefined);
		const gate = this.preflightGate;
		this.preflightGate = undefined;
		return gate === undefined ? this.preflightResult : await gate.promise;
	}

	async listApps() {
		return [
			{ name: "Finder", bundleId: "com.apple.finder", pid: 1234, isRunning: true },
			{ name: "Other", bundleId: "com.example.other", pid: 5678, isRunning: true },
		];
	}

	async performAction(pid: number, observedId: number, action: string): Promise<void> {
		if (this.performActionError !== undefined) {
			throw this.performActionError;
		}
		const id = this.subtreeIds?.get(observedId) ?? observedId;
		this.dispatch({ kind: "performAction", pid, id, action });
		const list = this.scrollList;
		if (list !== undefined && id === SCROLL_AREA_ID && action.endsWith("ByPage")) {
			const last = Math.max(0, list.rows.length - list.visibleRows);
			this.scrollOffset =
				action === "AXScrollUpByPage"
					? Math.max(0, this.scrollOffset - list.visibleRows)
					: Math.min(last, this.scrollOffset + list.visibleRows);
			this.pagesScrolled += 1;
			this.onScrollPage?.(this.pagesScrolled);
		}
	}
	async elementFrame(_pid: number, observedId: number): Promise<Rect | undefined> {
		const id = this.subtreeIds?.get(observedId) ?? observedId;
		return id >= FIRST_ROW_ID ? this.globalRowFrame(id) : this.elementFrames.get(id);
	}
	async refreshElementFrame(_pid: number, observedId: number): Promise<Rect | undefined> {
		const id = this.subtreeIds?.get(observedId) ?? observedId;
		return id >= FIRST_ROW_ID ? this.globalRowFrame(id) : undefined;
	}
	async scrollElementIntoView(pid: number, observedId: number): Promise<Rect | undefined> {
		const id = this.subtreeIds?.get(observedId) ?? observedId;
		const list = this.scrollList;
		if (list === undefined || !this.scrollIntoViewAdvertised || id < FIRST_ROW_ID) {
			return undefined;
		}
		this.dispatch({ kind: "scrollIntoView", pid, id });
		this.scrollOffset = Math.min(Math.max(0, list.rows.length - list.visibleRows), id - FIRST_ROW_ID);
		return this.globalRowFrame(id);
	}
	async recognizeWindowText(_pid?: number, options?: { readonly region?: Rect }): Promise<WindowTextRead> {
		this.recognizeOptions.push(options);
		if (this.screenCaptureDenied) {
			return { unavailable: "screen-recording-permission" };
		}
		const region = options?.region;
		const list = this.scrollList;
		const entries = (list?.rows ?? [])
			.map((text, index) => ({ text, index }))
			.filter(({ index }) => index >= this.scrollOffset && index < this.scrollOffset + (list?.visibleRows ?? 0))
			.map(({ text, index }) => ({
				text,
				confidence: 0.9,
				frame: this.globalRowFrame(FIRST_ROW_ID + index),
			}))
			// Like the native driver, read only the requested region: text outside it is never recognised.
			.filter(
				({ frame }) =>
					region === undefined ||
					(frame.x + frame.width / 2 >= region.x &&
						frame.x + frame.width / 2 < region.x + region.width &&
						frame.y + frame.height / 2 >= region.y &&
						frame.y + frame.height / 2 < region.y + region.height),
			);
		return { entries };
	}
	showPointerAt(position: Point): void {
		this.pointerHints.push(position);
	}
	async setValue(pid: number, id: number, value: string): Promise<void> {
		this.dispatch({ kind: "setValue", pid, id, value });
		if (this.valueWriteEffect === "apply") {
			this.fieldValues.set(id, value);
		}
	}
	async selectText(pid: number, id: number, _options: SelectTextOptions): Promise<void> {
		this.dispatch({ kind: "selectText", pid, id });
	}
	async pressAtPosition(_pid: number, _position: Point): Promise<boolean> {
		return false;
	}
	async typeIntoFocused(_pid: number, _text: string, options?: { readonly settleWrite?: boolean }): Promise<boolean> {
		this.typeOptions.push(options);
		return false;
	}
	async click(point: Point, options?: PointerOptions): Promise<void> {
		await this.deliver(clickEffect(point, options));
	}
	async drag(options: DragOptions): Promise<void> {
		await this.deliver({ kind: "drag", options });
	}
	async type(text: string): Promise<void> {
		await this.deliver({ kind: "type", text });
	}
	async key(key: string, _options?: KeyOptions): Promise<void> {
		await this.deliver({ kind: "key", key });
	}
	async invokeMenu(pid: number, path: readonly string[]): Promise<InvokeMenuResult> {
		this.dispatch({ kind: "invokeMenu", pid, path });
		return { resolvedPath: path, action: "AXPress" };
	}

	/** The fake host blocks every `blocked:` URL, standing in for a configured urlBlocklist. */
	assertUrlAllowed(url: string): void {
		if (url.startsWith("blocked:")) {
			throw new UrlBlockedError(`Computer Use is not allowed to open this URL: ${url}`);
		}
	}

	async openUrl(pid: number, url: string): Promise<{ readonly bundleId: string; readonly url: string }> {
		this.dispatch({ kind: "openUrl", pid, url });
		return { bundleId: "com.apple.finder", url };
	}

	writeClipboard(input: ClipboardWriteInput): ClipboardWriteResult {
		this.dispatch({ kind: "clipboardWrite", input });
		return { overwritten: true, writtenType: input.type, types: ["public.utf8-plain-text"] };
	}

	async close(): Promise<void> {
		this.effects.push({ kind: "close" });
	}

	setTarget(pid?: number): void {
		this.defaultTarget = pid;
	}
	async screenshot(_options?: ScreenshotOptions): Promise<ScreenshotResult> {
		return { data: Buffer.from("png"), mimeType: "image/png", width: 1, height: 1 };
	}
	async move(position: Point): Promise<void> {
		await this.deliver({ kind: "move", point: position });
	}
	async rightClick(point: Point, options?: PointerOptions): Promise<void> {
		await this.deliver(clickEffect(point, options));
	}
	async middleClick(point: Point, options?: PointerOptions): Promise<void> {
		await this.deliver(clickEffect(point, options));
	}
	async doubleClick(point: Point, options?: PointerOptions): Promise<void> {
		await this.deliver(clickEffect(point, options));
	}
	async scroll(options: ScrollOptions): Promise<void> {
		await this.deliver({ kind: "scroll", options });
	}
	async getCursorPosition(): Promise<Point> {
		return { x: 0, y: 0 };
	}
	async getScreenSize(): Promise<{ width: number; height: number }> {
		return { width: 1920, height: 1080 };
	}
	async getScreenshotViewport() {
		return undefined;
	}

	private readonly sawSnapshot = new Set<number>();
	private readonly snapshotByPid = new Map<number, AXTreeElement[]>();

	/** `visibleOnly` walks the list by the rows it shows, like the driver does for a scroll-until-found page check. */
	private currentElements(visibleOnly: boolean): AXTreeElement[] {
		const elements: AXTreeElement[] = [
			{
				id: 9,
				role: "AXButton",
				label: this.elementLabelOverrides.get(9) ?? "Open",
				value: null,
				frame: { x: 10, y: 20, width: 30, height: 40 },
				actions: [...(this.elementActions.get(9) ?? ["AXPress"])],
				children: [],
			},
			{
				id: 20,
				role: "AXTextField",
				label: this.elementLabelOverrides.get(20) ?? "Note",
				value: this.fieldValues.get(20) ?? null,
				frame: { x: 10, y: 70, width: 120, height: 24 },
				actions: ["AXSetValue"],
				children: [],
			},
			{
				id: 21,
				role: "AXTextField",
				label: this.elementLabelOverrides.get(21) ?? "Status",
				value: this.fieldValues.get(21) ?? null,
				frame: { x: 10, y: 100, width: 120, height: 24 },
				actions: ["AXSetValue"],
				children: [],
			},
		];
		for (let row = 0; row < this.syntheticRowCount; row += 1) {
			elements.push({
				id: 100 + row,
				role: "AXStaticText",
				label: `result row ${row} with a realistic descriptive label`,
				value: null,
				frame: { x: 0, y: row, width: 240, height: 18 },
				actions: [],
				children: [],
			});
		}
		return [...elements, ...this.extraElements, ...this.scrollListElements(visibleOnly)].filter(
			(element) => !this.hiddenElementIds.has(element.id),
		);
	}

	private rowFrame(index: number): Rect {
		return { x: 10, y: AREA_FRAME.y + (index - this.scrollOffset) * ROW_HEIGHT, width: 200, height: ROW_HEIGHT };
	}

	/** The row's frame on screen: the window screenshot (500x400) maps onto the window bounds at 2x. */
	private globalRowFrame(id: number): Rect {
		const frame = this.rowFrame(id - FIRST_ROW_ID);
		return {
			x: this.windowBounds.x + frame.x * 2,
			y: this.windowBounds.y + frame.y * 2,
			width: frame.width * 2,
			height: frame.height * 2,
		};
	}

	private scrollListElements(visibleOnly: boolean): AXTreeElement[] {
		const list = this.scrollList;
		if (list === undefined) {
			return [];
		}
		const inView = (index: number): boolean =>
			index >= this.scrollOffset && index < this.scrollOffset + list.visibleRows;
		const rows = list.rows
			.map((label, index) => ({ label, index }))
			.filter(({ index }) => !this.axHidesRows && (!(list.virtualized || visibleOnly) || inView(index)));
		return [
			{
				id: SCROLL_AREA_ID,
				role: "AXScrollArea",
				label: null,
				value: null,
				frame: { ...AREA_FRAME },
				actions: [],
				children: rows.map(({ index }) => FIRST_ROW_ID + index),
			},
			...rows.map(({ label, index }) => ({
				id: FIRST_ROW_ID + index,
				role: "AXStaticText",
				label,
				value: null,
				frame: this.rowFrame(index),
				actions: this.rowsPressable ? ["AXPress"] : this.scrollIntoViewAdvertised ? ["AXScrollToVisible"] : [],
				children: [],
			})),
		];
	}

	/** Synthetic input: wait at the gate, then record it with the target it went to, then apply it. */
	private async deliver(effect: Effect): Promise<void> {
		await this.inputGate?.(effect);
		const target = currentInputScope()?.target;
		this.targetedInputs.push({ effect, pid: target?.pid ?? this.defaultTarget, windowId: target?.windowId });
		this.dispatch(effect);
	}

	private dispatch(effect: Effect): void {
		const error = this.inputError;
		if (error !== undefined) {
			this.inputError = undefined;
			throw error;
		}
		this.actionDispatched = true;
		this.effects.push(effect);
		if (this.windowIdAfterAction !== undefined) {
			this.windowId = this.windowIdAfterAction;
		}
	}
}
