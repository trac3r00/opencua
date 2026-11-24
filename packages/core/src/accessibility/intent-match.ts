/** Groups of labels that mean the same control to a person. Lowercase; compared after whitespace collapse. */
const INTENT_SYNONYM_GROUPS: readonly (readonly string[])[] = [
	["ok", "done", "confirm", "확인"],
	["cancel", "dismiss", "취소"],
	["close", "×", "x", "닫기"],
	["send", "submit", "post", "보내기", "전송"],
	["save", "저장"],
	["delete", "remove", "trash", "삭제"],
	["search", "find", "검색"],
	["next", "continue", "다음", "계속"],
	["back", "previous", "이전", "뒤로"],
	["sign in", "log in", "login", "로그인"],
	["sign up", "register", "가입"],
	["settings", "preferences", "설정"],
	["add", "new", "+", "추가"],
	["edit", "편집"],
	["share", "공유"],
	["more", "…", "⋯", "더보기"],
];

const NUMERIC_TOKEN = /^\p{N}+$/u;
const SCORE_SYNONYM = 30;
const SCORE_TOKEN_OVERLAP = 20;

const GROUPS_BY_TERM: ReadonlyMap<string, ReadonlySet<number>> = (() => {
	const byTerm = new Map<string, Set<number>>();
	INTENT_SYNONYM_GROUPS.forEach((group, index) => {
		for (const term of group) {
			byTerm.set(term, (byTerm.get(term) ?? new Set<number>()).add(index));
		}
	});
	return byTerm;
})();

/** Whole words only: JS `\b` is ASCII-bound and never fires after Hangul. */
function tokenize(text: string): readonly string[] {
	return text.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 0);
}

/** Both inputs are already normalized (lowercase, collapsed whitespace). */
export function areSynonyms(left: string, right: string): boolean {
	const leftGroups = GROUPS_BY_TERM.get(left);
	const rightGroups = GROUPS_BY_TERM.get(right);
	if (leftGroups === undefined || rightGroups === undefined) {
		return false;
	}
	for (const group of leftGroups) {
		if (rightGroups.has(group)) {
			return true;
		}
	}
	return false;
}

export interface IntentHit {
	readonly score: number;
	readonly via: "synonym" | "token_overlap";
}

/**
 * How well `candidate` serves the intent `wanted` when neither equals nor contains the other:
 * a synonym scores 30, shared whole words score 20 times their share of the longer phrase.
 * A number the candidate lacks names a different item (row-23 is not row-0), so it vetoes the hit.
 * Both inputs are already normalized.
 */
export function intentHit(wanted: string, candidate: string): IntentHit | undefined {
	if (areSynonyms(wanted, candidate)) {
		return { score: SCORE_SYNONYM, via: "synonym" };
	}
	const wantedTokens = new Set(tokenize(wanted));
	const candidateTokens = new Set(tokenize(candidate));
	let shared = 0;
	for (const token of wantedTokens) {
		if (candidateTokens.has(token)) {
			shared += 1;
		} else if (NUMERIC_TOKEN.test(token)) {
			return undefined;
		}
	}
	if (shared === 0) {
		return undefined;
	}
	return {
		score: (shared / Math.max(wantedTokens.size, candidateTokens.size)) * SCORE_TOKEN_OVERLAP,
		via: "token_overlap",
	};
}
