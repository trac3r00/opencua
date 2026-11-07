import {
	InputOutsideRegion,
	axScrollActionFor,
	currentInputRegion,
	describeQuery,
	matchElements,
	suggestNearMisses,
} from "@opencua/core";
import type {
	AXTreeElement,
	ElementQuery,
	GuardedComputerInterface,
	InputObservation,
	OcrTextEntry,
	Point,
	Rect,
	WindowTextRead,
} from "@opencua/core";
import type { RunStepReport } from "./tool-result.js";

export type FindDirection = "up" | "down" | "left" | "right";
/** auto: accessibility first, then the pixels of the window; off: accessibility only; only: pixels only. */
export type FindVision = "auto" | "off" | "only";

/** How a step looks for its target past the edge of the window: the scrollable area, the way, the budget. */
export interface StepFind {
	readonly scrollWithin?: { readonly elementIndex: number } | { readonly query: ElementQuery };
	readonly direction: FindDirection;
	readonly maxPages: number;
	readonly vision: FindVision;
}

export type FindEvidence = NonNullable<RunStepReport["found"]>;

/** What a fast chain keeps between its steps; scroll-until-found reads and updates it. */
export interface ScrollFindChain {
	elements: ReadonlyMap<number, AXTreeElement> | undefined;
	changed: boolean;
	/** The frames in `elements` were moved by a scroll this chain made, so they no longer say where things are. */
	framesStale: boolean;
	/** `elements` came from a read of one scroll area, so its ids are not those of the observation's tree. */
	idsRebased: boolean;
	readonly keep: boolean;
	readonly read: () => Promise<{ readonly elements: ReadonlyMap<number, AXTreeElement>; readonly changed: boolean }>;
}

export interface Interruption {
	readonly message: string;
	/** The refusal reason when the run was halted by a refusal (the stop switch, a window guard). */
	readonly refused?: string;
}

export interface ScrollFindContext {
	readonly computer: GuardedComputerInterface;
	readonly pid: number;
	/** The observation the chain's steps are dispatched against. */
	readonly observation: InputObservation;
	/** Why the search must stop before touching the app again, or nothing. `scrolled` is true once a page moved. */
	readonly interrupted: (scrolled: boolean) => Promise<Interruption | undefined>;
}

export type ScrollFindResult =
	| {
			readonly found: { readonly kind: "element"; readonly element: AXTreeElement; readonly centre: Point };
			readonly evidence: FindEvidence;
	  }
	| {
			readonly found: { readonly kind: "point"; readonly point: Point; readonly text: string };
			readonly evidence: FindEvidence;
	  }
	| { readonly missing: string; readonly refused?: string; readonly evidence: FindEvidence };

/** How long a page that did not change is given to finish animating before it counts as the end. */
const END_OF_CONTENT_SETTLE_MILLISECONDS = 120;
/** Accessibility quiet window after a page scroll, before the cheap re-read. */
const PAGE_SETTLE_MILLISECONDS = 120;
const MAX_NEAR_MISSES = 5;
const MAX_ANCESTOR_STEPS = 64;
const MAX_SIGNATURE_ELEMENTS = 5_000;

interface Viewport {
	readonly bounds: Rect;
	readonly width: number;
	readonly height: number;
}

interface Page {
	readonly elements: ReadonlyMap<number, AXTreeElement>;
	readonly area: AXTreeElement | undefined;
	readonly axSignature: string;
	readonly axReadable: boolean;
	ocr: (WindowTextRead | { readonly unavailable: "not-supported" }) | undefined;
	parents: ReadonlyMap<number, number> | undefined;
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, milliseconds);
	});
}

function normalizeText(value: string | null | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function toScreenRect(rect: Rect, viewport: Viewport): Rect {
	const scaleX = viewport.bounds.width / viewport.width;
	const scaleY = viewport.bounds.height / viewport.height;
	return {
		x: viewport.bounds.x + rect.x * scaleX,
		y: viewport.bounds.y + rect.y * scaleY,
		width: rect.width * scaleX,
		height: rect.height * scaleY,
	};
}

function centreOf(rect: Rect): Point {
	return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/**
 * A confined worker may scroll only a container that lies wholly inside its region: scrolling one that reaches past it
 * moves content in other workers' parts of the window. Unconfined searches are not checked.
 */
function assertScrollAreaInRegion(area: Rect, viewport: Viewport): void {
	const region = currentInputRegion();
	if (region === undefined) return;
	const screen = toScreenRect(area, viewport);
	const inside =
		screen.x >= region.x &&
		screen.y >= region.y &&
		screen.x + screen.width <= region.x + region.width &&
		screen.y + screen.height <= region.y + region.height;
	if (!inside) {
		throw new InputOutsideRegion(
			`searching would scroll the area at (${Math.round(screen.x)}, ${Math.round(screen.y)}, ${Math.round(screen.width)}x${Math.round(screen.height)})`,
		);
	}
}

function contains(rect: Rect, point: Point): boolean {
	return point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height;
}

function parentMap(elements: ReadonlyMap<number, AXTreeElement>): ReadonlyMap<number, number> {
	const parents = new Map<number, number>();
	for (const element of elements.values()) {
		for (const child of element.children) {
			parents.set(child, element.id);
		}
	}
	return parents;
}

/** What the area shows, as a string that changes when its content moves or changes. */
function areaSignature(elements: ReadonlyMap<number, AXTreeElement>, rootId: number): string {
	const parts: string[] = [];
	const pending = [rootId];
	while (pending.length > 0 && parts.length < MAX_SIGNATURE_ELEMENTS) {
		const id = pending.pop();
		const element = id === undefined ? undefined : elements.get(id);
		if (element === undefined) {
			continue;
		}
		parts.push(
			`${element.role}|${element.label ?? ""}|${normalizeText(element.value)}|${Math.round(element.frame.x)}|${Math.round(element.frame.y)}`,
		);
		pending.push(...element.children);
	}
	return parts.join("\n");
}

/** Enough labelled elements under the area that its text is readable through accessibility. */
const AX_READABLE_MIN_TEXTS = 3;

function areaHasReadableText(elements: ReadonlyMap<number, AXTreeElement>, rootId: number): boolean {
	let texts = 0;
	const pending = [...(elements.get(rootId)?.children ?? [])];
	while (pending.length > 0) {
		const id = pending.pop();
		const element = id === undefined ? undefined : elements.get(id);
		if (element === undefined) {
			continue;
		}
		if ((element.label ?? "").trim() !== "" || (element.value ?? "").trim() !== "") {
			texts += 1;
			if (texts >= AX_READABLE_MIN_TEXTS) {
				return true;
			}
		}
		pending.push(...element.children);
	}
	return false;
}

function ocrSignature(entries: readonly OcrTextEntry[]): string {
	return entries.map((entry) => `${entry.text}|${Math.round(entry.frame.x)}|${Math.round(entry.frame.y)}`).join("\n");
}

/** How many whole pages, which way, bring a point outside the clip into its first page of view. */
function pagesToward(centre: Point, clip: Rect): { readonly direction: FindDirection; readonly count: number } {
	if (centre.y >= clip.y + clip.height) {
		return { direction: "down", count: Math.max(1, Math.floor((centre.y - clip.y) / clip.height)) };
	}
	if (centre.y < clip.y) {
		return { direction: "up", count: Math.max(1, Math.ceil((clip.y - centre.y) / clip.height)) };
	}
	if (centre.x >= clip.x + clip.width) {
		return { direction: "right", count: Math.max(1, Math.floor((centre.x - clip.x) / clip.width)) };
	}
	return { direction: "left", count: Math.max(1, Math.ceil((clip.x - centre.x) / clip.width)) };
}

function resolveArea(
	find: StepFind,
	elements: ReadonlyMap<number, AXTreeElement>,
	viewport: Viewport,
): AXTreeElement | undefined {
	const within = find.scrollWithin;
	if (within !== undefined) {
		return "elementIndex" in within
			? elements.get(within.elementIndex)
			: matchElements([...elements.values()], within.query)[0]?.element;
	}
	let largest: AXTreeElement | undefined;
	for (const element of elements.values()) {
		// Finder lists its desktop as a scroll area of the window's tree, far outside the window: only an area
		// that sits inside the window can be the content the person means.
		const inside =
			element.frame.x >= -1 &&
			element.frame.y >= -1 &&
			element.frame.x + element.frame.width <= viewport.width + 1 &&
			element.frame.y + element.frame.height <= viewport.height + 1;
		if (element.role !== "AXScrollArea" || element.frame.width <= 0 || element.frame.height <= 0 || !inside) {
			continue;
		}
		const area = element.frame.width * element.frame.height;
		if (largest === undefined || area > largest.frame.width * largest.frame.height) {
			largest = element;
		}
	}
	return largest;
}

interface TextNeedle {
	readonly exact: string | undefined;
	readonly contains: readonly string[];
}

/** The text a query can be read for from pixels, or nothing when it names only a role. */
function textNeedle(query: ElementQuery): TextNeedle | undefined {
	const exact = query.label === undefined ? undefined : normalizeText(query.label);
	const contained = [query.labelContains, query.valueContains, query.text]
		.map((value) => normalizeText(value))
		.filter((value) => value.length > 0);
	if ((exact === undefined || exact.length === 0) && contained.length === 0) {
		return undefined;
	}
	return { exact: exact === undefined || exact.length === 0 ? undefined : exact, contains: contained };
}

function matchRecognizedText(
	entries: readonly OcrTextEntry[],
	needle: TextNeedle,
	index: number,
	region: Rect,
): OcrTextEntry | undefined {
	const wanted = needle.exact ?? needle.contains[0] ?? "";
	const matches = entries.filter((entry) => {
		const text = normalizeText(entry.text);
		return (
			(needle.exact === undefined || text === needle.exact) &&
			needle.contains.every((part) => text.includes(part)) &&
			contains(region, centreOf(entry.frame))
		);
	});
	matches.sort((left, right) => {
		const leftExact = normalizeText(left.text) === wanted ? 0 : 1;
		const rightExact = normalizeText(right.text) === wanted ? 0 : 1;
		return (
			leftExact - rightExact ||
			left.text.length - right.text.length ||
			right.confidence - left.confidence ||
			left.frame.y - right.frame.y ||
			left.frame.x - right.frame.x
		);
	});
	return matches[index];
}

function describeNearMisses(page: Page, query: ElementQuery, needle: TextNeedle | undefined): string {
	const names = suggestNearMisses([...page.elements.values()], query, MAX_NEAR_MISSES).map(
		(element) => `${element.role} "${element.label ?? element.value ?? ""}"`,
	);
	const entries = page.ocr !== undefined && "entries" in page.ocr ? page.ocr.entries : [];
	const words = [needle?.exact, ...(needle?.contains ?? [])]
		.flatMap((part) => (part ?? "").split(" "))
		.filter((word) => word.length >= 3);
	for (const entry of entries) {
		const text = normalizeText(entry.text);
		if (names.length < MAX_NEAR_MISSES * 2 && words.some((word) => text.includes(word))) {
			names.push(`text "${entry.text}"`);
		}
	}
	return names.length === 0 ? "" : ` Near misses: ${names.join("; ")}.`;
}

/**
 * Find the element a step names even when it is past the edge of the window, the way a person would: look at
 * what is shown (accessibility, and the pixels of the window), and when it is not there scroll the area one
 * page and look again, stopping at the first sighting. Background-only: a page is an accessibility action on
 * the scroll area, never the real wheel or pointer. An element that exists but sits outside its scroll area is
 * scrolled into view (AXScrollToVisible) instead of paging toward it.
 */
export async function findByScrolling(
	ctx: ScrollFindContext,
	chain: ScrollFindChain,
	query: ElementQuery,
	index: number,
	find: StepFind,
): Promise<ScrollFindResult> {
	const viewport: Viewport = {
		bounds: ctx.observation.screenshotViewport.bounds,
		width: ctx.observation.screenshotViewport.width,
		height: ctx.observation.screenshotViewport.height,
	};
	const windowRect = ctx.observation.windowBounds;
	const needle = textNeedle(query);
	let pages = 0;
	let scrolledIntoView = false;
	let visionNote: string = find.vision === "off" ? "off" : "not-needed";

	const evidence = (extra: Partial<FindEvidence> = {}): FindEvidence => ({
		pages_scrolled: pages,
		direction: find.direction,
		vision: visionNote,
		...(scrolledIntoView ? { scrolled_into_view: true } : {}),
		...extra,
	});
	const missing = (message: string, refused?: string): ScrollFindResult => ({
		missing: message,
		...(refused === undefined ? {} : { refused }),
		evidence: evidence(),
	});

	const makePage = (elements: ReadonlyMap<number, AXTreeElement>, area: AXTreeElement | undefined): Page => ({
		elements,
		area,
		axSignature: area === undefined ? "" : areaSignature(elements, area.id),
		axReadable: area !== undefined && areaHasReadableText(elements, area.id),
		ocr: undefined,
		parents: undefined,
	});

	const readOcr = async (page: Page): Promise<NonNullable<Page["ocr"]>> => {
		if (page.ocr === undefined) {
			// Only the scroll area is searched, so only its pixels are read; without an area the window is.
			const region = page.area === undefined ? undefined : toScreenRect(page.area.frame, viewport);
			const read = await ctx.computer.recognizeWindowText?.(ctx.pid, region === undefined ? undefined : { region });
			page.ocr = read ?? { unavailable: "not-supported" };
			visionNote = "entries" in page.ocr ? "used" : `skipped: ${page.ocr.unavailable}`;
		}
		return page.ocr;
	};

	/**
	 * One cheap read of just the scroll area: ids restart at 0 inside it, the area itself is id 0. A list is read by
	 * the rows it shows, not every row it holds, so a page costs a page of rows however long the list is; a row that
	 * is found keeps its id in this read, which is the one the click that follows resolves against.
	 */
	const readPage = async (areaId: number): Promise<Page> => {
		const state = await ctx.computer.getAppState(ctx.pid, {
			requireWindow: true,
			includeScreenshot: false,
			settleMs: PAGE_SETTLE_MILLISECONDS,
			windowId: ctx.observation.windowId,
			subtreeOf: areaId,
			probe: true,
			visibleOnly: true,
		});
		const elements = new Map(state.elements.map((element) => [element.id, element] as const));
		chain.elements = chain.keep ? elements : undefined;
		chain.framesStale = false;
		chain.idsRebased = true;
		return makePage(elements, elements.get(0));
	};

	const scrollAreaOf = (page: Page, element: AXTreeElement): AXTreeElement | undefined => {
		page.parents ??= parentMap(page.elements);
		let id = element.id;
		for (let step = 0; step < MAX_ANCESTOR_STEPS; step += 1) {
			const parent = page.parents.get(id);
			const ancestor = parent === undefined ? undefined : page.elements.get(parent);
			if (parent === undefined || ancestor === undefined) {
				return undefined;
			}
			if (ancestor.role === "AXScrollArea") {
				return ancestor;
			}
			id = parent;
		}
		return undefined;
	};

	type Placement =
		| { readonly kind: "ready"; readonly centre: Point }
		| { readonly kind: "interrupted"; readonly interruption: Interruption }
		| { readonly kind: "refresh" }
		| { readonly kind: "scroll" };

	/**
	 * An element accessibility lists but its scroll area clips (a list that exposes every row): page the area
	 * toward it by the distance it is away, re-reading only that element's frame, instead of walking the tree
	 * once per page.
	 */
	const approach = async (element: AXTreeElement, area: AXTreeElement): Promise<Placement | undefined> => {
		const refresh = ctx.computer.refreshElementFrame;
		if (refresh === undefined) {
			return undefined;
		}
		const clip = toScreenRect(area.frame, viewport);
		assertScrollAreaInRegion(area.frame, viewport);
		let live = await refresh.call(ctx.computer, ctx.pid, element.id);
		while (live !== undefined && live.width > 0 && live.height > 0 && !contains(clip, centreOf(live))) {
			const step = pagesToward(centreOf(live), clip);
			const count = Math.min(step.count, find.maxPages - pages);
			if (count <= 0) {
				return undefined;
			}
			const interruption = await ctx.interrupted(pages > 0);
			if (interruption !== undefined) {
				return { kind: "interrupted", interruption };
			}
			ctx.computer.showPointerAt?.(centreOf(clip), false);
			for (let page = 0; page < count; page += 1) {
				await ctx.computer.performAction(ctx.pid, area.id, axScrollActionFor(step.direction));
				pages += 1;
			}
			chain.changed = true;
			chain.framesStale = true;
			live = await refresh.call(ctx.computer, ctx.pid, element.id);
		}
		return live !== undefined && live.width > 0 && live.height > 0
			? { kind: "ready", centre: centreOf(live) }
			: undefined;
	};

	/** Make an accessibility match actionable: its frame must be on screen and current. */
	const place = async (page: Page, element: AXTreeElement): Promise<Placement> => {
		const area = scrollAreaOf(page, element);
		const clip = area?.frame;
		const visible =
			element.frame.width > 0 &&
			element.frame.height > 0 &&
			(clip === undefined || contains(clip, centreOf(element.frame)));
		if (visible && !chain.framesStale) {
			return { kind: "ready", centre: centreOf(toScreenRect(element.frame, viewport)) };
		}
		// Scrolling an element into view moves whichever ancestors it must, which a region cannot bound.
		if (ctx.computer.scrollElementIntoView !== undefined && currentInputRegion() === undefined) {
			try {
				const frame = await ctx.computer.scrollElementIntoView(ctx.pid, element.id);
				if (frame !== undefined) {
					chain.framesStale = true;
					chain.changed = true;
					scrolledIntoView = true;
					return { kind: "ready", centre: centreOf(frame) };
				}
			} catch {
				// The element refused (it was recycled, or the app declined): page toward it instead.
			}
		}
		if (!visible && area !== undefined) {
			try {
				const approached = await approach(element, area);
				if (approached !== undefined) {
					return approached;
				}
			} catch {
				// Paging toward the element failed (it was recycled): look for it again from a fresh read.
			}
		}
		return visible ? { kind: "refresh" } : { kind: "scroll" };
	};

	const samePage = async (before: Page, after: Page): Promise<boolean> => {
		if (before.axSignature !== after.axSignature) {
			return false;
		}
		// In auto mode a list whose text accessibility already exposes has its content change told by that signature.
		if (find.vision === "off" || (find.vision === "auto" && before.axReadable && after.axReadable)) {
			return true;
		}
		const left = await readOcr(before);
		const right = await readOcr(after);
		return (
			!("entries" in left) || !("entries" in right) || ocrSignature(left.entries) === ocrSignature(right.entries)
		);
	};

	let elements = chain.elements;
	// Ids from an earlier scroll-find in this chain belong to its one scroll area, whose root is id 0.
	const resumed = elements !== undefined && chain.idsRebased;
	if (elements === undefined) {
		const base = await chain.read();
		chain.changed = chain.changed || base.changed;
		chain.framesStale = false;
		chain.idsRebased = false;
		elements = base.elements;
		chain.elements = chain.keep ? elements : undefined;
	}
	let page = makePage(elements, resumed ? elements.get(0) : resolveArea(find, elements, viewport));

	for (;;) {
		const interruption = await ctx.interrupted(pages > 0);
		if (interruption !== undefined) {
			return missing(interruption.message, interruption.refused);
		}

		let offscreenMatch = false;
		if (find.vision !== "only") {
			const match = matchElements([...page.elements.values()], query)[index];
			if (match !== undefined) {
				const placed = await place(page, match.element);
				if (placed.kind === "interrupted") {
					return missing(placed.interruption.message, placed.interruption.refused);
				}
				if (placed.kind === "ready") {
					ctx.computer.showPointerAt?.(placed.centre, false);
					return {
						found: { kind: "element", element: match.element, centre: placed.centre },
						evidence: evidence({ found_by: "accessibility" }),
					};
				}
				if (placed.kind === "refresh" && page.area !== undefined) {
					page = await readPage(chain.idsRebased ? 0 : page.area.id);
					continue;
				}
				offscreenMatch = true;
			}
		}

		// Auto mode reads pixels only where accessibility cannot see the text: a list it already reads would not
		// show the target to OCR either, and OCR costs about 220 ms a page.
		const needsVision = find.vision === "only" || (find.vision === "auto" && !page.axReadable);
		if (needsVision && !offscreenMatch) {
			if (needle === undefined) {
				visionNote = "skipped: the target names no text to read from the window";
				if (find.vision === "only") {
					return missing('vision "only" needs a target with label, label_contains, value_contains, or text');
				}
			} else {
				const read = await readOcr(page);
				if (!("entries" in read)) {
					if (find.vision === "only") {
						return missing(
							read.unavailable === "isolated-session-required"
								? `vision "only" cannot read the window: host capture is refused by design (isolated-session-required); use vision "auto" with an accessibility target, or an agent-owned isolated desktop`
								: `vision "only" cannot read the window (${read.unavailable}); grant Screen Recording to the app that runs this server, or use vision "auto" with an accessibility target`,
						);
					}
				} else {
					const region = page.area === undefined ? windowRect : toScreenRect(page.area.frame, viewport);
					const hit = matchRecognizedText(read.entries, needle, index, region);
					if (hit !== undefined) {
						const point = centreOf(hit.frame);
						ctx.computer.showPointerAt?.(point, false);
						return {
							found: { kind: "point", point, text: hit.text },
							evidence: evidence({ found_by: "vision", matched_text: hit.text }),
						};
					}
				}
			}
		}

		if (pages >= find.maxPages) {
			return missing(
				`no element matching ${describeQuery(query)} after scrolling ${pages} page(s) ${find.direction} (max_pages reached).${describeNearMisses(page, query, needle)}`,
			);
		}
		if (page.area === undefined) {
			return missing(
				`no element matching ${describeQuery(query)} is shown and there is no scrollable area to search; give find.scroll_within.${describeNearMisses(page, query, needle)}`,
			);
		}

		assertScrollAreaInRegion(page.area.frame, viewport);
		ctx.computer.showPointerAt?.(centreOf(toScreenRect(page.area.frame, viewport)), false);
		try {
			await ctx.computer.performAction(ctx.pid, page.area.id, axScrollActionFor(find.direction));
		} catch (error: unknown) {
			return missing(
				`could not scroll the area ${find.direction}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		pages += 1;
		chain.changed = true;
		const before = page;
		page = await readPage(chain.idsRebased ? 0 : page.area.id);
		if (await samePage(before, page)) {
			// A page that did not move may just be animating; the end of the content is a page that stays put.
			await delay(END_OF_CONTENT_SETTLE_MILLISECONDS);
			page = await readPage(0);
			if (await samePage(before, page)) {
				return missing(
					`no element matching ${describeQuery(query)}: scrolled ${pages} page(s) ${find.direction} and reached the end of the content (it stopped changing).${describeNearMisses(page, query, needle)}`,
				);
			}
		}
	}
}
