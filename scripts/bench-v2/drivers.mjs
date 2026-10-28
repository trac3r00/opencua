import { accountPayload } from "./metrics.mjs";

const text = (result) =>
	(result?.content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
const parsed = (result) => {
	const block = (result?.content ?? []).find((b) => b.type === "text" && b.text.trim().startsWith("{"));
	return block === undefined ? {} : JSON.parse(block.text);
};

/** Harness step -> Peekaboo MCP tool (pinned in pins.json; names checked against fixtures/peekaboo-tools.json). */
export const PEEKABOO_TOOLS = {
	windows: "window",
	observe: "see",
	"click-label": "click",
	type: "type",
	key: "press",
	scroll: "scroll",
	menu: "menu",
};

/** Peekaboo's `window` list prints one `N. "title" [ID: 123, ON-SCREEN, ...]` line per window. */
export const peekabooWindows = (answer) =>
	[...answer.matchAll(/^\d+\. "(.*)" \[ID: (\d+), (ON|OFF)-SCREEN/gm)].map((match) => ({
		title: match[1],
		window_id: Number(match[2]),
		on_screen: match[3] === "ON",
	}));

export class Driver {
	/** `toolNames`, when given, is the server's tools/list; a call outside it fails before any round trip. */
	constructor(kind, client, toolNames) {
		this.kind = kind;
		// "apple" drives opencua the way its instructions recommend (compact table observations, no
		// screenshot, described-element clicks); "apple-legacy" keeps the pre-2026-09-23 call pattern
		// (screenshot + menu bar + JSON tree, observe before every click) as the before baseline.
		this.apple = kind === "apple" || kind === "apple-legacy";
		this.efficient = kind === "apple";
		// "peekaboo" drives Peekaboo's MCP server: `see` snapshots of the exact window, then snapshot-bound input.
		this.peekaboo = kind === "peekaboo";
		this.toolNames = toolNames;
		/**
		 * Peekaboo snapshot per app as `{ id, window }`, bound to the window it observed and consumed by each
		 * mutation (menu included), since its docs ask to observe the target again before the next one.
		 */
		this.snapshots = new Map();
		/** Peekaboo inputs it dispatched but could not confirm (`dispatched_unverified`); the oracle decides. */
		this.unverified_dispatches = 0;
		this.client = client;
		this.calls = 0;
		this.call_ms = [];
		this.seconds = 0;
		this.text_bytes = 0;
		this.image_base64_bytes = 0;
		this.estimated_tokens = 0;
		this.image_tokens = 0;
		this.claimed = false;
		this.human_ask = false;
		this.gave_up = false;
		this.keyboard_fallbacks = 0;
		this.trace = [];
		this.last = "";
		this.tokens = new Map();
		/** Apps whose observation said window content is unreachable (a session off the console). */
		this.remoteApps = new Set();
		this.windows = new Map();
	}
	async call(name, args, allowAmbiguity = false) {
		if (this.toolNames !== undefined && !this.toolNames.has(name))
			throw new Error(`driver-error: ${this.kind} server lists no tool named ${JSON.stringify(name)}`);
		const start = performance.now();
		this.calls++;
		let result;
		try {
			result = await this.client.callTool(name, args);
		} finally {
			const elapsed = performance.now() - start;
			this.call_ms.push(elapsed);
			this.seconds += elapsed / 1000;
		}
		const payload = accountPayload(result);
		this.text_bytes += payload.text_bytes;
		this.image_base64_bytes += payload.image_base64_bytes;
		this.estimated_tokens += payload.estimated_tokens;
		this.image_tokens += payload.image_tokens;
		const answer = text(result);
		this.last = answer;
		if (process.env.BENCH_TRACE === "1")
			this.trace.push({
				name,
				args,
				error: result?.isError === true,
				answer: answer.slice(0, Number(process.env.BENCH_TRACE_CHARS ?? 600)),
			});
		this.claimed ||=
			!["get_app_state", "get_window_state", "list_windows", "see", "window"].includes(name) &&
			/\b(verified|success|completed)\b/i.test(answer) &&
			!/not verified|unverifiable/i.test(answer) &&
			!result?.isError;
		this.human_ask ||= /ask the user|needs_user|elicitation/i.test(answer);
		this.gave_up ||= /\b(refus(ed|al)|timed? out|timeout)\b/i.test(answer);
		// Peekaboo reports a dispatched input whose effect it cannot confirm as an error with
		// state=dispatched_unverified and escalation=observe_before_retry: the input was sent, so per its docs the
		// caller observes again (every Peekaboo mutation here does) instead of retrying or treating it as failed.
		const unverified =
			this.peekaboo &&
			result?._meta?.state === "dispatched_unverified" &&
			result._meta.mutation_dispatched === true &&
			result._meta.escalation === "observe_before_retry";
		if (result?.isError && unverified) {
			this.unverified_dispatches += 1;
			return result;
		}
		if (result?.isError && !(allowAmbiguity && answer.includes("same_pid_keyboard_ambiguity")))
			throw new Error(`tool-error: ${answer.slice(0, 300)}`);
		return result;
	}
	async window(app, title) {
		const result = await this.call("list_windows", {});
		const candidates = (result.structuredContent?.windows ?? []).filter((w) => w.app_name === app && w.is_on_screen);
		const window = title ? candidates.find((w) => w.title === title) : candidates[0];
		if (!window) throw new Error(`target-missing: ${app} ${title ?? ""}`);
		this.windows.set(app, window);
		return window;
	}
	async peekabooWindow(app, title) {
		const result = await this.call(PEEKABOO_TOOLS.windows, { action: "list", app });
		const candidates = peekabooWindows(text(result)).filter((w) => w.on_screen);
		// Untitled on-screen rows are menu-bar and desktop surfaces; without a title, take the first document window.
		const window = title
			? candidates.find((w) => w.title === title)
			: (candidates.find((w) => w.title !== "") ?? candidates[0]);
		if (!window) throw new Error(`target-missing: ${app} ${title ?? ""}`);
		this.windows.set(app, window);
		return window;
	}
	async observe(app, title) {
		if (this.peekaboo) {
			const cached = this.windows.get(app);
			const window =
				cached !== undefined && (!title || cached.title === title) ? cached : await this.peekabooWindow(app, title);
			const result = await this.call(PEEKABOO_TOOLS.observe, {
				app_target: app,
				window_id: window.window_id,
				include_elements: true,
			});
			const snapshot = result?._meta?.snapshot_id ?? text(result).match(/\bps1_[0-9a-f]{32}\b/)?.[0];
			if (typeof snapshot !== "string" || snapshot === "")
				throw new Error("driver-error: peekaboo see returned no snapshot_id");
			this.snapshots.set(app, { id: snapshot, window });
			return result;
		}
		if (this.apple) {
			const args = this.efficient
				? { app, include_screenshot: false, element_format: "table" }
				: { app, include_screenshot: true, include_menu_bar: true };
			let result = await this.call("get_app_state", args);
			let state = parsed(result);
			// With several windows the focused one may not be the asked-for one; opencua lists them
			// all in windowCandidates, so pick the titled window by id, as an agent would.
			const candidate = (state.windowCandidates ?? []).find((window) => window.title === title);
			if (title && state.windowTitle !== title && candidate !== undefined) {
				result = await this.call("get_app_state", { ...args, window_id: candidate.id });
				state = parsed(result);
			}
			if (title && state.windowTitle !== title)
				throw new Error(`target-missing: expected ${title}, observed ${state.windowTitle}`);
			this.tokens.set(app, state.observation_token);
			if (state.windowContentUnavailable === true) this.remoteApps.add(app);
			return result;
		}
		const window = await this.window(app, title);
		return this.call("get_window_state", { pid: window.pid, window_id: window.window_id, include_screenshot: true });
	}
	async act(step, appleArgs, cuaArgs, peekabooArgs) {
		const { app, title } = step;
		if (this.peekaboo) {
			const tool = PEEKABOO_TOOLS[step.op];
			const held = this.snapshots.get(app);
			// A snapshot authorizes input only to the window it observed: another title means observing that one.
			if (held === undefined || (title && held.window.title !== title)) await this.observe(app, title);
			const snapshot = this.snapshots.get(app).id;
			this.snapshots.delete(app);
			// `menu` takes no snapshot, but it is a mutation too: observe before it and consume the observation.
			if (step.op === "menu") return this.call(tool, { action: "click", app, ...peekabooArgs });
			return this.call(tool, { snapshot, ...peekabooArgs });
		}
		const name = {
			type: ["type_text", "type_text"],
			key: ["press_keys", "press_key"],
			"click-label": ["click", "click"],
			menu: ["invoke_menu", "invoke_menu"],
		}[step.op];
		if (this.apple) {
			if (!this.tokens.get(app)) await this.observe(app, title);
			let result;
			try {
				result = await this.call(name[0], { app, observation_token: this.tokens.get(app), ...appleArgs });
			} catch (error) {
				// opencua refuses input when the observed window changed since the observation (a sheet
				// opened or closed) and asks for a fresh one; an agent re-observes and retries once.
				if (!/"needsExplicitObservation":\s*true/.test(String(error))) throw error;
				await this.observe(app, title);
				result = await this.call(name[0], { app, observation_token: this.tokens.get(app), ...appleArgs });
			}
			this.tokens.set(app, parsed(result).observation_token);
			return result;
		}
		const window = this.windows.get(app) ?? (await this.window(app, title));
		const args = { pid: window.pid, window_id: window.window_id, ...cuaArgs };
		let result = await this.call(name[1], args, true);
		if (result?.isError && text(result).includes("same_pid_keyboard_ambiguity"))
			result = await this.call(name[1], { ...args, delivery_mode: "foreground" });
		return result;
	}
	/**
	 * A click or menu step that fails falls back to the scenario's keyboard route, the way an agent
	 * does when pointer input cannot land (a session off the physical console). Every driver gets the
	 * same fallback, the oracle is unchanged, and each use is counted in keyboard_fallbacks.
	 */
	async step(step) {
		if (!step.keyboard || !["click-label", "menu"].includes(step.op)) return this.primaryStep(step);
		// opencua's windowContentNote tells the agent to use keyboard routes when window content is
		// unreachable, because window-level menu items can report success there and change nothing.
		if (!this.remoteApps.has(step.app)) {
			try {
				return await this.primaryStep(step);
			} catch (error) {
				if (String(error).includes("server-exit")) throw error;
				this.tokens.delete(step.app);
				this.snapshots.delete(step.app);
			}
		}
		this.keyboard_fallbacks += 1;
		let result;
		for (const key of step.keyboard)
			result = await this.primaryStep({ op: "key", app: step.app, title: step.title, ...key });
		return result;
	}

	async primaryStep(step) {
		const { app, title } = step;
		switch (step.op) {
			case "observe":
				return this.observe(app, title);
			case "type":
				return this.act(step, { text: step.value }, { text: step.value }, { text: step.value });
			case "menu":
				return this.act(step, { path: step.path }, { path: step.path }, { path: step.path.join(" > ") });
			case "scroll":
				// Only the Peekaboo mapping defines scroll; the other drivers keep rejecting it as before.
				if (!this.peekaboo) throw new Error(`unknown-step: ${step.op}`);
				{
					// Background scroll needs an element `on` from the snapshot it names: the labelled element when the
					// step names one, else the window's first scroll area.
					const elements = (await this.observe(app, title))?._meta?.ui_elements ?? [];
					const target = step.value
						? elements.find((e) => String(e.label ?? e.title ?? e.value ?? "").includes(step.value))
						: elements.find((e) => e.ax_role === "AXScrollArea" || /scroll/i.test(String(e.role ?? "")));
					if (!target) throw new Error(`element-missing: ${step.value ?? "scroll area"}`);
					return this.act(
						step,
						{},
						{},
						{ on: String(target.id), direction: step.direction, amount: step.amount ?? 3 },
					);
				}
			case "key":
				return this.act(
					step,
					{ keys: [step.apple ?? step.value] },
					{ key: step.cua ?? step.value, ...(step.modifiers ? { modifiers: step.modifiers } : {}) },
					{ keys: [step.apple ?? step.value] },
				);
			case "click-label": {
				if (this.efficient) {
					// `text` matches a label or a value: Finder names its list rows only in a text field's value.
					let result;
					try {
						result = await this.call("click_target", { app, query: { text: step.value } });
					} catch (error) {
						// Refused because the window moved since the last read (it was still settling after
						// opening); an agent re-observes and retries once.
						if (!/"needsExplicitObservation":\s*true/.test(String(error))) throw error;
						await this.observe(app, title);
						result = await this.call("click_target", { app, query: { text: step.value } });
					}
					const answer = parsed(result);
					// found=false is an honest non-error answer, but nothing was clicked: the step failed.
					if (answer.found === false || answer.actionDispatched === false)
						throw new Error(`element-missing: ${step.value}`);
					this.tokens.set(app, answer.observation_token);
					return result;
				}
				const observation = await this.observe(app, title);
				const elements = this.peekaboo
					? (observation?._meta?.ui_elements ?? [])
					: this.apple
						? (parsed(observation).elements ?? [])
						: (observation.structuredContent?.elements ?? []);
				const candidate = elements.find((e) =>
					String(e.label ?? e.title ?? e.name ?? e.value ?? "").includes(step.value),
				);
				if (!candidate) throw new Error(`element-missing: ${step.value}`);
				return this.act(
					step,
					{ element_index: String(candidate.id ?? candidate.index) },
					{ element_token: candidate.element_token },
					{ on: String(candidate.id) },
				);
			}
			default:
				throw new Error(`unknown-step: ${step.op}`);
		}
	}
}
