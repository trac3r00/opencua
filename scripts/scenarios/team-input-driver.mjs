import { performance } from "node:perf_hooks";

export const responseText = (result) =>
	(result?.content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
const state = (result) => {
	if (result.structuredContent) return result.structuredContent;
	const block = (result.content ?? []).find((item) => item.type === "text" && item.text.trim().startsWith("{"));
	return block ? JSON.parse(block.text) : {};
};

/** No retries or foreground fallbacks: refusals remain visible in the trial. */
export class IsolationDriver {
	constructor(kind, client, target, now = () => performance.now()) {
		this.kind = kind;
		this.client = client;
		this.target = target;
		this.now = now;
		this.trace = [];
		this.refusals = 0;
	}

	async call(name, args) {
		const started = this.now();
		const entry = { name, args, started_ms: started };
		this.trace.push(entry);
		try {
			const result = await this.client.callTool(name, args);
			entry.result = result;
			const answer = responseText(result);
			entry.refusal = answer.includes("input-lock-busy");
			if (entry.refusal) this.refusals++;
			const dispatchedUnverified =
				this.kind === "peekaboo" &&
				result._meta?.state === "dispatched_unverified" &&
				result._meta.mutation_dispatched === true &&
				result._meta.escalation === "observe_before_retry";
			if (result.isError && !dispatchedUnverified) throw new Error(`tool-error: ${answer}`);
			return result;
		} catch (error) {
			entry.error = String(error);
			if (!entry.refusal && String(error).includes("input-lock-busy")) this.refusals++;
			throw error;
		} finally {
			entry.wall_ms = this.now() - started;
		}
	}

	async observe() {
		const { app, pid, window_id } = this.target;
		switch (this.kind) {
			case "apple": {
				const result = await this.call("get_app_state", {
					app: String(pid),
					window_id,
					include_screenshot: false,
					element_format: "json",
				});
				this.token = state(result).observation_token;
				if (!this.token) throw new Error("cannot target: apple observation has no token");
				return result;
			}
			case "cua":
				return this.call("get_window_state", { pid, window_id, include_screenshot: false });
			case "peekaboo": {
				const result = await this.call("see", { app_target: app, window_id, include_elements: true });
				this.snapshot = result._meta?.snapshot_id ?? responseText(result).match(/\bps1_[0-9a-f]{32}\b/)?.[0];
				if (!this.snapshot) throw new Error("cannot target: Peekaboo returned no window-bound snapshot");
				return result;
			}
			default:
				throw new Error(`unknown driver: ${this.kind}`);
		}
	}

	async input(op, value) {
		const observation = await this.observe();
		const { pid, window_id } = this.target;
		switch (this.kind) {
			case "apple": {
				const result = await this.call(op === "type" ? "type_text" : op === "key" ? "press_keys" : "click", {
					app: String(pid),
					observation_token: this.token,
					...(op === "type" ? { text: value } : op === "key" ? { keys: [value] } : { x: value.x, y: value.y }),
				});
				this.token = state(result).observation_token;
				return result;
			}
			case "cua":
				return this.call(op === "type" ? "type_text" : op === "key" ? "press_key" : "click", {
					pid,
					window_id,
					...(op === "type"
						? { text: value }
						: op === "key"
							? { key: "end", modifiers: ["cmd"] }
							: { x: value.x, y: value.y }),
				});
			case "peekaboo": {
				// Same snapshot-bound call shapes as bench-v2 at cef6196; no branch merge.
				if (op === "type") return this.call("type", { snapshot: this.snapshot, text: value });
				if (op === "key") return this.call("press", { snapshot: this.snapshot, keys: [value] });
				const elements = observation._meta?.ui_elements ?? [];
				const element = elements.find((item) => {
					if (value.editor) return item.role === "AXTextArea" || item.role === "textArea";
					const label = String(item.label ?? item.title ?? item.name ?? item.value ?? "");
					return label === value.label;
				});
				if (!element) throw new Error(`cannot target: Peekaboo element ${value.label}`);
				return this.call("click", { snapshot: this.snapshot, on: String(element.id) });
			}
			default:
				throw new Error(`unknown driver: ${this.kind}`);
		}
	}
}
