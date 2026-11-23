import type { KoffiFunc } from "koffi";
import type { ElementHit } from "../../computer/interface.js";
import type { Point } from "../../types/index.js";
import {
	type AXUIElementRef,
	copyOptionalAttributeValue,
	createApplicationElement,
	refetchElement,
	releaseAXElement,
} from "./accessibility.js";
import { type CFTypeRef, cfRelease, cfRetain, fromCFString, isCFString } from "./corefoundation.js";
import { koffi } from "./koffi.js";

const MAX_ANCESTORS = 64;
const AX_SUCCESS = 0;
const COVERING_ROLES = new Set(["AXSheet", "AXPopover", "AXDrawer"]);

interface HitTestBindings {
	readonly copyElementAtPosition: (
		application: AXUIElementRef,
		x: number,
		y: number,
		target: Array<AXUIElementRef | null>,
	) => number;
	readonly equal: (left: CFTypeRef, right: CFTypeRef) => boolean;
}

let bindings: HitTestBindings | undefined;

/** Bound on first use, so importing this module loads no native symbol. */
function hitTestBindings(): HitTestBindings {
	if (bindings !== undefined) return bindings;
	const applicationServices = koffi.load(
		"/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices",
	);
	const coreFoundation = koffi.load("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation");
	bindings = {
		copyElementAtPosition: applicationServices.func(
			"int32_t AXUIElementCopyElementAtPosition(void *element, float x, float y, _Out_ void **target)",
		) as KoffiFunc<HitTestBindings["copyElementAtPosition"]>,
		equal: coreFoundation.func("bool CFEqual(void *left, void *right)") as KoffiFunc<HitTestBindings["equal"]>,
	};
	return bindings;
}

/**
 * Whether the element an app hit-tests at a point is the intended element or part of the same control. `hitChain`
 * is the hit element followed by its ancestors, `targetChain` the target followed by its ancestors. The hit counts as
 * the target when it is the target or lies inside it (a button's own label or icon), or when it is one of the
 * target's ancestors (the control's container answered for it). Anything else, a sheet, popover or overlay in
 * another branch of the tree, covers the target.
 */
function hitRelation<T>(
	hitChain: readonly T[],
	targetChain: readonly T[],
	same: (left: T, right: T) => boolean,
): "target" | "covered" {
	const [hit] = hitChain;
	const [target] = targetChain;
	if (hit === undefined || target === undefined) return "target";
	if (hitChain.some((element) => same(element, target))) return "target";
	if (targetChain.some((element) => same(element, hit))) return "target";
	return "covered";
}

/** The element followed by up to MAX_ANCESTORS ancestors, each retained; release with releaseChain. */
function ancestorChain(element: AXUIElementRef): AXUIElementRef[] {
	const chain: AXUIElementRef[] = [cfRetain(element)];
	let current = element;
	while (chain.length <= MAX_ANCESTORS) {
		const parent = copyOptionalAttributeValue(current, "AXParent");
		if (parent === null) break;
		chain.push(parent);
		current = parent;
	}
	return chain;
}

function releaseChain(chain: readonly AXUIElementRef[]): void {
	for (const element of chain) cfRelease(element);
}

function stringAttribute(element: AXUIElementRef, attribute: string): string | undefined {
	const value = copyOptionalAttributeValue(element, attribute);
	if (value === null) return undefined;
	try {
		if (!isCFString(value)) return undefined;
		const text = fromCFString(value).trim();
		return text.length > 0 ? text : undefined;
	} finally {
		cfRelease(value);
	}
}

/**
 * Hit-test `pid`'s own windows at `point` (global logical points) and say whether the observed element `elementIndex`
 * is what a click there would reach. The hit test is the app's, over its windows only, so another app's window in
 * front does not answer: only something of this app that covers the element does. `unknown` when accessibility
 * cannot answer at that point.
 */
export function elementHitAtPoint(pid: number, elementIndex: number, point: Point): ElementHit {
	const { copyElementAtPosition, equal } = hitTestBindings();
	const target = refetchElement(pid, elementIndex);
	const app = createApplicationElement(pid);
	try {
		const out: Array<AXUIElementRef | null> = [null];
		const hit = copyElementAtPosition(app, point.x, point.y, out) === AX_SUCCESS ? out[0] : null;
		if (hit === null || hit === undefined) return { hit: "unknown" };
		const hitChain = ancestorChain(hit);
		const targetChain = ancestorChain(target);
		try {
			if (hitRelation(hitChain, targetChain, equal) === "target") return { hit: "target" };
			const role = stringAttribute(hit, "AXRole") ?? "an element";
			const label = stringAttribute(hit, "AXTitle") ?? stringAttribute(hit, "AXDescription");
			const within = hitChain
				.map((element) => stringAttribute(element, "AXRole"))
				.find((candidate) => candidate !== undefined && COVERING_ROLES.has(candidate));
			return {
				hit: "covered",
				role,
				...(label === undefined ? {} : { label }),
				...(within === undefined ? {} : { within }),
			};
		} finally {
			releaseChain(hitChain);
			releaseChain(targetChain);
			releaseAXElement(hit);
		}
	} finally {
		releaseAXElement(app);
		releaseAXElement(target);
	}
}
