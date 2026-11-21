import { AX_PRESS_ACTION } from "../computer/actions.js";
import { areSynonyms, intentHit } from "./intent-match.js";
import type { AXTreeElement } from "./types.js";

/**
 * What a caller means when it names a control: any combination of constraints, all of which
 * must hold. Roles are matched without the AX prefix and without case, labels are compared
 * with whitespace collapsed, and the text needles are case-insensitive substrings.
 */
export interface ElementQuery {
	readonly role?: string;
	readonly label?: string;
	readonly labelContains?: string;
	readonly valueContains?: string;
	readonly text?: string;
}

export interface ElementMatch {
	readonly element: AXTreeElement;
	readonly score: number;
	/** Which constraints this element satisfied, plus the traits that lifted its rank. */
	readonly matchedBy: readonly string[];
}

const ROLE_PREFIX = "ax";
const SCORE_LABEL = 40;
const SCORE_LABEL_CONTAINS = 25;
const SCORE_TEXT_ON_LABEL = 18;
const SCORE_TEXT_ON_VALUE = 14;
const SCORE_VALUE_CONTAINS = 12;
const SCORE_ROLE = 6;
const SCORE_PRESSABLE = 8;
const SCORE_ACTIONS = 2;
const SCORE_VISIBLE = 5;
const SCORE_LABEL_SYNONYM = 30;
const MIN_TOKEN_LENGTH = 3;

function normalizeText(value: string | null | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeRole(role: string): string {
	const normalized = normalizeText(role);
	return normalized.startsWith(ROLE_PREFIX) ? normalized.slice(ROLE_PREFIX.length) : normalized;
}

function roleMatches(elementRole: string, queryRole: string): boolean {
	return normalizeRole(elementRole) === normalizeRole(queryRole);
}

function hasConstraint(query: ElementQuery): boolean {
	for (const value of [query.role, query.label, query.labelContains, query.valueContains, query.text]) {
		if (value !== undefined && normalizeText(value).length > 0) {
			return true;
		}
	}
	return false;
}

function matchOne(element: AXTreeElement, query: ElementQuery): ElementMatch | undefined {
	const label = normalizeText(element.label);
	const value = normalizeText(element.value);
	const matchedBy: string[] = [];
	let score = 0;

	if (query.role !== undefined) {
		if (!roleMatches(element.role, query.role)) {
			return undefined;
		}
		matchedBy.push("role");
		score += SCORE_ROLE;
	}
	if (query.label !== undefined) {
		const wanted = normalizeText(query.label);
		if (wanted.length === 0) {
			return undefined;
		}
		if (label === wanted) {
			matchedBy.push("label");
			score = Math.max(score, SCORE_LABEL);
		} else {
			// An exact label names one control: only a true synonym (OK for Done) may stand in. Shared words do not:
			// "Unmute tab" must never land on "Mute tab".
			if (!areSynonyms(wanted, label)) {
				return undefined;
			}
			matchedBy.push("label_synonym");
			score = Math.max(score, SCORE_LABEL_SYNONYM);
		}
	}
	if (query.labelContains !== undefined) {
		const wanted = normalizeText(query.labelContains);
		if (wanted.length === 0 || !label.includes(wanted)) {
			return undefined;
		}
		matchedBy.push("label_contains");
		score = Math.max(score, SCORE_LABEL_CONTAINS);
	}
	if (query.valueContains !== undefined) {
		const wanted = normalizeText(query.valueContains);
		if (wanted.length === 0 || !value.includes(wanted)) {
			return undefined;
		}
		matchedBy.push("value_contains");
		score = Math.max(score, SCORE_VALUE_CONTAINS);
	}
	if (query.text !== undefined) {
		const wanted = normalizeText(query.text);
		if (wanted.length === 0) {
			return undefined;
		}
		const onLabel = label.includes(wanted);
		if (onLabel || value.includes(wanted)) {
			matchedBy.push("text");
			score = Math.max(score, onLabel ? SCORE_TEXT_ON_LABEL : SCORE_TEXT_ON_VALUE);
		} else {
			const hit = [intentHit(wanted, label), intentHit(wanted, value)]
				.filter((candidate) => candidate !== undefined)
				.sort((left, right) => right.score - left.score)[0];
			if (hit === undefined) {
				return undefined;
			}
			matchedBy.push(`text_${hit.via}`);
			score = Math.max(score, hit.score);
		}
	}

	if (element.actions.includes(AX_PRESS_ACTION)) {
		matchedBy.push("pressable");
		score += SCORE_PRESSABLE;
	} else if (element.actions.length > 0) {
		score += SCORE_ACTIONS;
	}
	if (element.frame.width > 0 && element.frame.height > 0) {
		score += SCORE_VISIBLE;
	}
	return { element, score, matchedBy };
}

function readingOrder(left: AXTreeElement, right: AXTreeElement): number {
	const vertical = left.frame.y - right.frame.y;
	if (vertical !== 0) {
		return vertical;
	}
	const horizontal = left.frame.x - right.frame.x;
	if (horizontal !== 0) {
		return horizontal;
	}
	return left.id - right.id;
}

/**
 * Every element that satisfies the query, best first. Ranking is deterministic: score, then
 * reading order, so the same screen always resolves the same target and a repeated call cannot
 * drift onto a different control. An empty query matches nothing, so no caller can click
 * "whatever is first".
 */
export function matchElements(elements: readonly AXTreeElement[], query: ElementQuery): readonly ElementMatch[] {
	if (!hasConstraint(query)) {
		return [];
	}
	const matches: ElementMatch[] = [];
	for (const element of elements) {
		const match = matchOne(element, query);
		if (match !== undefined) {
			matches.push(match);
		}
	}
	return matches.sort((left, right) => right.score - left.score || readingOrder(left.element, right.element));
}

function queryTokens(query: ElementQuery): readonly string[] {
	const words = [query.label, query.labelContains, query.valueContains, query.text]
		.filter((value): value is string => value !== undefined)
		.join(" ")
		.split(" ")
		.map((word) => normalizeText(word))
		.filter((word) => word.length >= MIN_TOKEN_LENGTH);
	return [...new Set(words)];
}

/**
 * The candidates worth naming when a query found nothing: elements carrying words the query
 * used, or, when a role was given, that role's own controls in reading order, so the caller
 * learns what the screen actually offers instead of guessing again.
 */
export function suggestNearMisses(
	elements: readonly AXTreeElement[],
	query: ElementQuery,
	limit: number,
): readonly AXTreeElement[] {
	if (limit <= 0 || !hasConstraint(query)) {
		return [];
	}
	const candidates =
		query.role === undefined
			? [...elements]
			: elements.filter((element) => roleMatches(element.role, query.role ?? ""));
	const tokens = queryTokens(query);
	const phrases = [query.label, query.labelContains, query.text].map(normalizeText);
	const overlapping = candidates
		.map((element) => {
			const label = normalizeText(element.label);
			const value = normalizeText(element.value);
			const haystack = `${label} ${value}`;
			const synonymous = phrases.some((phrase) => areSynonyms(phrase, label) || areSynonyms(phrase, value));
			return {
				element,
				overlap: tokens.filter((token) => haystack.includes(token)).length + (synonymous ? 1 : 0),
			};
		})
		.filter((candidate) => candidate.overlap > 0)
		.sort((left, right) => right.overlap - left.overlap || readingOrder(left.element, right.element));
	if (overlapping.length > 0) {
		return overlapping.slice(0, limit).map((candidate) => candidate.element);
	}
	if (query.role !== undefined) {
		return candidates.sort(readingOrder).slice(0, limit);
	}
	return [];
}

/** One stable line naming the constraints an answer was matched against. */
export function describeQuery(query: ElementQuery): string {
	const parts: string[] = [];
	if (query.role !== undefined) {
		parts.push(`role=${query.role}`);
	}
	if (query.label !== undefined) {
		parts.push(`label=${JSON.stringify(query.label)}`);
	}
	if (query.labelContains !== undefined) {
		parts.push(`label_contains=${JSON.stringify(query.labelContains)}`);
	}
	if (query.valueContains !== undefined) {
		parts.push(`value_contains=${JSON.stringify(query.valueContains)}`);
	}
	if (query.text !== undefined) {
		parts.push(`text=${JSON.stringify(query.text)}`);
	}
	return parts.join(" ");
}
