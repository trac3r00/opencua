import type { ToolResult } from "./tool-result.js";

export class StaleElementRef extends Error {
	constructor() {
		super("STALE_REF: the element ref does not belong to the supplied observation_token; observe again.");
		this.name = "StaleElementRef";
	}
}

/** Numeric strings remain supported; explicit refs bind the id to the exact one-use observation. */
export function resolveSnapshotRefs(input: unknown): unknown {
	if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
	const fields = Object.fromEntries(Object.entries(input));
	const token = fields["observation_token"];
	const visit = (value: unknown, key: string): unknown => {
		if (key === "element_index" && typeof value === "string" && value.startsWith("@")) {
			const match = /^@([^:]+):e(\d+)$/.exec(value);
			if (match === null || match[1] !== token) throw new StaleElementRef();
			return match[2];
		}
		if (Array.isArray(value)) return value.map((item) => visit(item, ""));
		if (typeof value === "object" && value !== null) {
			return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, visit(item, field)]));
		}
		return value;
	};
	return visit(fields, "");
}

/**
 * Say how to write a ref for the ids this result names: `@<token>:e<id>`, which binds an id to this exact observation.
 * One template instead of one ref per id: the map repeated the 36-character token for every element and was a third of
 * an observation's bytes.
 */
export function withSnapshotRefs(result: ToolResult): ToolResult {
	const content = result.content.map((item) => {
		if (item.type !== "text") return item;
		let parsed: unknown;
		try {
			parsed = JSON.parse(item.text);
		} catch {
			return item;
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return item;
		const payload = Object.fromEntries(Object.entries(parsed));
		const token = payload["observation_token"];
		if (typeof token !== "string") return item;
		const ids = new Set<number>();
		const collect = (value: unknown): void => {
			if (Array.isArray(value)) {
				for (const entry of value) collect(entry);
			} else if (typeof value === "object" && value !== null) {
				for (const [key, entry] of Object.entries(value)) {
					if (key === "id" || key === "element_index") {
						const id = typeof entry === "string" && /^\d+$/.test(entry) ? Number(entry) : entry;
						if (typeof id === "number" && Number.isSafeInteger(id) && id >= 0) ids.add(id);
					} else collect(entry);
				}
			} else if (typeof value === "string" && /^\d+\t/.test(value)) {
				ids.add(Number(value.split("\t", 1)[0]));
			}
		};
		for (const field of ["elements", "matches", "nearMisses"]) collect(payload[field]);
		const changes = payload["axChanges"];
		if (typeof changes === "object" && changes !== null) {
			if ("added" in changes) collect(changes.added);
			if ("changed" in changes && Array.isArray(changes.changed)) {
				for (const change of changes.changed) {
					if (typeof change === "object" && change !== null && "after" in change) collect(change.after);
				}
			}
		}
		const rows = payload["element_rows"];
		if (Array.isArray(rows)) {
			for (const row of rows) {
				if (typeof row !== "string") continue;
				const id = Number(row.split("\t", 1)[0]);
				if (Number.isSafeInteger(id) && id >= 0) ids.add(id);
			}
		}
		if (ids.size === 0) return item;
		return {
			...item,
			text: JSON.stringify({
				...payload,
				element_ref_format: `@${token}:e{id}`,
			}),
		};
	});
	return { ...result, content };
}
