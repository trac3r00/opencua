import { describe, expect, it } from "bun:test";
import { normalizeToolError } from "./tool-errors.js";

describe("tool error normalization", () => {
	it("#given a successful payload #when normalizing #then its object and fields are unchanged", () => {
		const result = { content: [{ type: "text" as const, text: '{"verified":false}' }] };
		expect(normalizeToolError(result)).toBe(result);
	});

	it("#given a post-dispatch observation failure #when normalizing #then retry is unsafe and evidence survives", () => {
		const result = normalizeToolError({
			content: [
				{ type: "text", text: '{"actionDispatched":true,"observationStatus":"error","error":"read failed"}' },
			],
		});
		const text = result.content[0];
		expect(result.isError).toBe(true);
		expect(text?.type === "text" && JSON.parse(text.text)).toMatchObject({
			ok: false,
			error: "read failed",
			actionDispatched: true,
			code: "POST_ACTION_ERROR",
			retry: "unsafe",
			disposition: { retry: "unsafe" },
		});
	});

	it("#given a stop refusal after input went out #when normalizing #then it keeps the refusal code and never retries", () => {
		const result = normalizeToolError({
			isError: true,
			content: [{ type: "text", text: '{"reason":"user-stopped","actionDispatched":true,"error":"stopped"}' }],
		});
		const text = result.content[0];
		expect(text?.type === "text" && JSON.parse(text.text)).toMatchObject({
			code: "USER_STOPPED",
			retry: "never",
			disposition: { retry: "never" },
		});
		expect(text?.type === "text" && JSON.parse(text.text).suggestion).toContain("may already have been delivered");
	});

	it("#given an unconfirmed delivery #when normalizing #then only an explicit actionDispatched false is safe", () => {
		const retryFor = (payload: string): unknown => {
			const result = normalizeToolError({ isError: true, content: [{ type: "text", text: payload }] });
			const text = result.content[0];
			return text?.type === "text" ? JSON.parse(text.text).retry : undefined;
		};
		expect(retryFor('{"reason":"window-missing","actionDispatched":false}')).toBe("safe");
		expect(retryFor('{"reason":"window-missing","actionDispatched":"unknown"}')).toBe("unsafe");
		expect(retryFor('{"reason":"window-missing"}')).toBe("unsafe");
	});

	it("#given an app that is not running #when normalizing #then nothing was sent and the agent is told to open it", () => {
		const result = normalizeToolError({
			isError: true,
			content: [{ type: "text", text: '{"error":"No running app matched \\"Aside\\""}' }],
		});
		const text = result.content[0];
		const payload = text?.type === "text" ? JSON.parse(text.text) : undefined;
		expect(payload).toMatchObject({
			ok: false,
			code: "APP_NOT_RUNNING",
			retry: "safe",
			disposition: { retry: "safe" },
		});
		expect(payload.suggestion).toContain("open_app");
		// get_app_state's real payload carries no actionDispatched (app resolution runs before any input);
		// an explicit false reaches the same code.
		const explicit = normalizeToolError({
			isError: true,
			content: [{ type: "text", text: '{"actionDispatched":false,"error":"No running app matched \\"Aside\\""}' }],
		});
		const explicitText = explicit.content[0];
		expect(explicitText?.type === "text" && JSON.parse(explicitText.text)).toMatchObject({
			code: "APP_NOT_RUNNING",
			retry: "safe",
		});
		// Input that already went out keeps the post-dispatch envelope even when the app then vanished.
		const after = normalizeToolError({
			isError: true,
			content: [{ type: "text", text: '{"actionDispatched":true,"error":"No running app matched pid 42"}' }],
		});
		const afterText = after.content[0];
		expect(afterText?.type === "text" && JSON.parse(afterText.text).code).toBe("POST_ACTION_ERROR");
	});

	it("#given a report appended after the failure #when normalizing #then the error payload is the one annotated", () => {
		const result = normalizeToolError({
			isError: true,
			content: [
				{ type: "text", text: '{"reason":"window-missing","actionDispatched":false,"error":"no window"}' },
				{ type: "text", text: '{"clipboardClear":{"bytes":0}}' },
			],
		});
		const first = result.content[0];
		const second = result.content[1];
		expect(first?.type === "text" && JSON.parse(first.text)).toMatchObject({
			ok: false,
			code: "WINDOW_MISSING",
			retry: "safe",
			error: "no window",
		});
		expect(second?.type === "text" && JSON.parse(second.text)).toEqual({ clipboardClear: { bytes: 0 } });
	});
});
