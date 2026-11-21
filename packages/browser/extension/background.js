const DEFAULT_PORT = 47953;
const MAX_MESSAGE = 4_000_000;
const CHECKPOINT_TIMEOUT_MS = 10_000;
import { pageRuntime } from "./page-runtime.js";

const PAGE_RUNTIME = String(pageRuntime);
const tabsOwned = new Map();
const queues = new Map();
let agentWindowId;
let agentBlankTabId;
let openingWindow;
let socket;
let ready = false;
let stopped = true;
let heartbeat;
let connecting = false;
let reconnectRequested = false;
let pausedByUser = false;
let givingBack = false;
const checkpoints = new Map();

function send(value) {
	if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

function rejectCheckpoints(reason) {
	for (const waiter of checkpoints.values()) {
		clearTimeout(waiter.timer);
		waiter.reject(new Error(reason));
	}
	checkpoints.clear();
}

function stopLocally() {
	stopped = true;
	rejectCheckpoints("Actions stopped");
	for (const state of tabsOwned.values()) state.cancelled = true;
	void chrome.storage.session.set({
		bridgeConnected: ready,
		bridgeStopped: true,
		bridgePausedByUser: pausedByUser,
	});
}

async function localConnection() {
	const connection = await chrome.runtime.sendNativeMessage("com.browser_skill_omo.bridge", {
		method: "connection",
	});
	if (
		!isRecord(connection) ||
		!Number.isInteger(connection.port) ||
		connection.port < 1 ||
		connection.port > 65535 ||
		typeof connection.token !== "string" ||
		!/^[0-9a-f]{64}$/i.test(connection.token)
	)
		throw new Error("Install the local Browser-Skill-OmO service before connecting.");
	return { port: connection.port, token: connection.token };
}

// The daemon refused the stored token (its connection file was reset). Store the native host's current token once;
// the storage change reconnects. An unchanged token is left for the next alarm, so a refusal never loops.
async function refreshPairing(rejectedToken) {
	try {
		const connection = await localConnection();
		if (connection.token !== rejectedToken) await chrome.storage.local.set(connection);
	} catch {
		// Without a native host, manual pairing from the options page stays the way to recover.
	}
}

async function connect() {
	if (connecting || (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)))
		return;
	connecting = true;
	let settings;
	try {
		settings = await chrome.storage.local.get(["port", "token", "pausedByUser"]);
		if (!settings.token) {
			try {
				const connection = await localConnection();
				await chrome.storage.local.set(connection);
				settings = { ...settings, port: connection.port, token: connection.token };
			} catch {
				// Manual pairing remains available when no native host is installed.
				return;
			}
		}
		pausedByUser = pausedByUser || settings.pausedByUser === true;
	} finally {
		connecting = false;
	}
	const { port = DEFAULT_PORT, token } = settings;
	if (typeof token !== "string" || !token) return;
	const ws = new WebSocket(`ws://127.0.0.1:${port}`);
	socket = ws;
	ready = false;
	stopped = true;
	ws.addEventListener("open", () => ws.send(JSON.stringify({ token })));
	ws.addEventListener("message", (event) => {
		if (typeof event.data !== "string" || event.data.length > MAX_MESSAGE) {
			ws.close(1009, "Invalid message size");
			return;
		}
		let message;
		try {
			message = JSON.parse(event.data);
		} catch {
			ws.close(1007, "Invalid JSON");
			return;
		}
		if (!isRecord(message)) return;
		if (message.ready === true) {
			ready = true;
			stopped = pausedByUser;
			void chrome.storage.session.set({
				bridgeConnected: true,
				bridgeStopped: stopped,
				bridgePausedByUser: pausedByUser,
			});
			if (stopped) {
				send({ event: "stop" });
				if (pausedByUser) sendControl("human", "taken_over");
			}
			clearInterval(heartbeat);
			heartbeat = setInterval(() => send({ event: "heartbeat" }), 20000);
			return;
		}
		if (typeof message.checkpoint === "string" && typeof message.allowed === "boolean") {
			const waiter = checkpoints.get(message.checkpoint);
			if (waiter) {
				clearTimeout(waiter.timer);
				checkpoints.delete(message.checkpoint);
				waiter.resolve(message.allowed);
			}
			return;
		}
		if (typeof message.id === "string" && isRecord(message.command)) {
			const command = { ...message.command, command: message.command.method, id: message.id };
			if (validCommand(command)) void handleCommand(command);
			else send({ id: message.id, ok: false, error: "Invalid command" });
		}
	});
	ws.addEventListener("close", (event) => {
		if (socket === ws) {
			socket = undefined;
			ready = false;
			clearInterval(heartbeat);
			stopLocally();
			void chrome.storage.session.set({ bridgeConnected: false });
			if (event.code === 1008 && event.reason === "Invalid pairing") {
				void refreshPairing(token);
			} else if (reconnectRequested) {
				reconnectRequested = false;
				void connect();
			}
		}
	});
	ws.addEventListener("error", () => ws.close());
}

function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validLimits(value) {
	return (
		isRecord(value) &&
		Number.isInteger(value.maxChars) &&
		value.maxChars >= 256 &&
		value.maxChars <= 20_000 &&
		Number.isInteger(value.maxElements) &&
		value.maxElements >= 1 &&
		value.maxElements <= 200 &&
		typeof value.fullPage === "boolean" &&
		(value.profile === undefined || ["interactive", "content", "all"].includes(value.profile)) &&
		(value.maxNameChars === undefined ||
			(Number.isInteger(value.maxNameChars) && value.maxNameChars >= 40 && value.maxNameChars <= 500)) &&
		(value.query === undefined || (typeof value.query === "string" && value.query.length <= 200))
	);
}

function validTargetQuery(value) {
	return (
		isRecord(value) &&
		(value.role === undefined || (typeof value.role === "string" && value.role.length <= 60)) &&
		(value.name === undefined || (typeof value.name === "string" && value.name.length <= 500)) &&
		(value.text === undefined || (typeof value.text === "string" && value.text.length <= 500)) &&
		(value.role !== undefined || value.name !== undefined || value.text !== undefined)
	);
}

function validStep(step) {
	if (!isRecord(step)) return false;
	if (step.action === "scroll") return Number.isFinite(step.deltaY) && Math.abs(step.deltaY) <= 5000;
	if (step.action === "wait")
		return (
			(step.text === undefined ||
				(typeof step.text === "string" && step.text.length >= 1 && step.text.length <= 500)) &&
			(step.selector === undefined ||
				(typeof step.selector === "string" && step.selector.length >= 1 && step.selector.length <= 500)) &&
			(step.text !== undefined || step.selector !== undefined) &&
			Number.isInteger(step.timeoutMs) &&
			step.timeoutMs >= 1 &&
			step.timeoutMs <= 10_000
		);
	const hasRef = Number.isInteger(step.ref) && step.ref > 0;
	const hasTarget = validTargetQuery(step.target);
	if (!hasRef && !hasTarget) return false;
	if (step.action === "click") return true;
	if (step.action === "fill") return typeof step.text === "string" && step.text.length <= 10_000;
	if (step.action === "select") {
		const choice = step.choice;
		if (!isRecord(choice)) return false;
		const provided = [choice.value, choice.label, choice.index].filter((item) => item !== undefined).length;
		if (provided !== 1) return false;
		if (choice.value !== undefined && (typeof choice.value !== "string" || choice.value.length > 2000)) return false;
		if (choice.label !== undefined && (typeof choice.label !== "string" || choice.label.length > 2000)) return false;
		if (choice.index !== undefined)
			return Number.isInteger(choice.index) && choice.index >= 0 && choice.index <= 100_000;
		return true;
	}
	return step.action === "press" && ["Enter", "Tab", "Escape", "ArrowDown", "ArrowUp"].includes(step.key);
}

function validCommand(command) {
	if (typeof command.id !== "string" || command.id.length < 1 || command.id.length > 128) return false;
	if (command.command === "stop") return true;
	if (command.command === "handoff")
		return typeof command.reason === "string" && command.reason.length >= 1 && command.reason.length <= 300;
	if (command.command === "open")
		return typeof command.url === "string" && command.url.length <= 8192 && /^https?:\/\//i.test(command.url);
	if (command.command === "close" || command.command === "observe") {
		return (
			Number.isInteger(command.tabId) &&
			command.tabId > 0 &&
			(command.command === "close" || validLimits(command.limits))
		);
	}
	if (command.command === "find")
		return (
			Number.isInteger(command.tabId) &&
			command.tabId > 0 &&
			validTargetQuery(command.query) &&
			Number.isInteger(command.limit) &&
			command.limit >= 1 &&
			command.limit <= 50
		);
	if (command.command === "read")
		return (
			Number.isInteger(command.tabId) &&
			command.tabId > 0 &&
			Number.isInteger(command.maxChars) &&
			command.maxChars >= 200 &&
			command.maxChars <= 40_000 &&
			typeof command.includeLinks === "boolean"
		);
	if (command.command === "wait")
		return (
			Number.isInteger(command.tabId) &&
			command.tabId > 0 &&
			(command.text === undefined || (typeof command.text === "string" && command.text.length <= 500)) &&
			(command.selector === undefined || (typeof command.selector === "string" && command.selector.length <= 500)) &&
			(command.text !== undefined || command.selector !== undefined) &&
			Number.isInteger(command.timeoutMs) &&
			command.timeoutMs >= 1 &&
			command.timeoutMs <= 10_000
		);
	if (command.command === "screenshot")
		return Number.isInteger(command.tabId) && command.tabId > 0 && typeof command.fullPage === "boolean";
	return (
		command.command === "run" &&
		Number.isInteger(command.tabId) &&
		command.tabId > 0 &&
		typeof command.revision === "string" &&
		command.revision.length <= 256 &&
		Array.isArray(command.steps) &&
		command.steps.length >= 1 &&
		command.steps.length <= 20 &&
		command.steps.every(validStep) &&
		validLimits(command.limits) &&
		(command.expect === undefined ||
			(isRecord(command.expect) &&
				typeof command.expect.text === "string" &&
				command.expect.text.length >= 1 &&
				command.expect.text.length <= 500 &&
				Number.isInteger(command.expect.timeoutMs) &&
				command.expect.timeoutMs >= 1 &&
				command.expect.timeoutMs <= 10_000))
	);
}

function enqueue(tabId, action) {
	const previous = queues.get(tabId) ?? Promise.resolve();
	const current = previous.then(action, action);
	queues.set(tabId, current);
	return current.finally(() => {
		if (queues.get(tabId) === current) queues.delete(tabId);
	});
}

async function handleCommand(message) {
	if (!ready || !socket || socket.readyState !== WebSocket.OPEN) return;
	try {
		const value = await dispatch(message);
		send({ id: message.id, ok: true, value });
	} catch (error) {
		send({
			id: message.id,
			ok: false,
			error: error instanceof Error ? error.message.slice(0, 2000) : "Extension error",
		});
	}
}

async function dispatch(command) {
	if (command.command === "handoff") {
		await chrome.storage.session.set({ handoffRequest: { reason: command.reason, at: Date.now() } });
		await chrome.action.setBadgeText({ text: "!" });
		await chrome.action.setTitle({ title: `Agent asks: ${command.reason}` });
		return null;
	}
	if (command.command === "stop") {
		stopLocally();
		return null;
	}
	const readOnly = ["observe", "close", "find", "read", "wait", "screenshot"].includes(command.command);
	if (!ready || (stopped && !readOnly)) throw new Error("Actions stopped");
	if (command.command === "open") return openTab(command.url);
	if (command.command === "close") {
		const state = tabsOwned.get(command.tabId);
		if (!state) throw new Error("Tab is not agent-owned");
		const tab = await chrome.tabs.get(command.tabId);
		if (tab.windowId !== state.windowId || state.windowId !== agentWindowId)
			throw new Error("Agent tab moved out of its background window");
		state.cancelled = true;
		await chrome.tabs.remove(command.tabId);
		tabsOwned.delete(command.tabId);
		if (tabsOwned.size === 0 && agentWindowId !== undefined && agentBlankTabId !== undefined) {
			const remaining = await chrome.tabs.query({ windowId: agentWindowId });
			if (remaining.length === 1 && remaining[0].id === agentBlankTabId) {
				const windowId = agentWindowId;
				agentWindowId = undefined;
				agentBlankTabId = undefined;
				await chrome.windows.remove(windowId);
			}
		}
		return null;
	}
	return enqueue(command.tabId, async () => {
		const state = requireOwned(command.tabId);
		switch (command.command) {
			case "observe":
				return observe(state, command.limits);
			case "find":
				return evaluate(state, "find", { query: command.query, limit: command.limit });
			case "read":
				return evaluate(state, "read", {
					maxChars: command.maxChars,
					includeLinks: command.includeLinks,
				});
			case "wait":
				return evaluate(state, "wait", {
					text: command.text,
					selector: command.selector,
					timeoutMs: command.timeoutMs,
				});
			case "screenshot":
				return screenshot(state, command.fullPage);
			case "run":
				return runSteps(state, command);
			default:
				throw new Error("Unsupported command");
		}
	});
}

function sendControl(owner, reason) {
	void chrome.storage.session.set({ bridgeControl: owner });
	send({ event: "control", owner, ...(reason ? { reason } : {}) });
}

async function takeOver() {
	pausedByUser = true;
	await chrome.storage.local.set({ pausedByUser: true });
	stopLocally();
	sendControl("human", "taken_over");
	if (agentWindowId !== undefined) await chrome.windows.update(agentWindowId, { state: "normal", focused: true });
}

async function giveBack() {
	givingBack = true;
	try {
		if (agentWindowId !== undefined) {
			await chrome.windows.update(agentWindowId, { state: "minimized" });
			const window = await chrome.windows.get(agentWindowId);
			if (window.state !== "minimized" || window.focused)
				throw new Error("Could not return the agent window to the background");
		}
		await chrome.action.setBadgeText({ text: "" });
		await chrome.storage.session.remove("handoffRequest");
		pausedByUser = false;
		await chrome.storage.local.set({ pausedByUser: false });
		stopped = !(ready && socket?.readyState === WebSocket.OPEN);
		await chrome.storage.session.set({ bridgeStopped: stopped, bridgePausedByUser: false });
		sendControl("agent");
	} finally {
		givingBack = false;
	}
}

async function openTab(url) {
	const parsed = new URL(url);
	if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Only HTTP(S) URLs are allowed");
	if (agentWindowId === undefined) {
		openingWindow ??= chrome.windows
			.create({ url: "about:blank", focused: false, state: "minimized" })
			.then(async (window) => {
				if (!Number.isInteger(window?.id)) throw new Error("Could not create the background agent window");
				// macOS Chromium may ignore state in create(). Apply it before the
				// window becomes an input target and before any page is loaded.
				await chrome.windows.update(window.id, { state: "minimized" });
				const background = await chrome.windows.get(window.id);
				if (background.state !== "minimized" || background.focused) {
					await chrome.windows.remove(window.id);
					throw new Error("Chromium could not create a minimized background window");
				}
				agentWindowId = window.id;
				agentBlankTabId = window.tabs?.[0]?.id;
			});
		try {
			await openingWindow;
		} finally {
			openingWindow = undefined;
		}
	}
	const windowId = agentWindowId;
	if (windowId === undefined) throw new Error("Background agent window was closed");
	const background = await chrome.windows.get(windowId);
	if (background.state !== "minimized" || background.focused)
		throw new Error("Background agent window was revealed. Stop and return it to the background before continuing.");
	if (stopped || !ready || agentWindowId !== windowId) throw new Error("Actions stopped");
	const tab = await chrome.tabs.create({ windowId, url: parsed.href, active: false });
	const state = {
		tabId: tab.id,
		windowId,
		attached: false,
		contextId: undefined,
		contextGeneration: 0,
		frameId: undefined,
		revision: undefined,
		cancelled: false,
	};
	if (typeof tab.id !== "number") throw new Error("Could not create tab");
	tabsOwned.set(tab.id, state);
	try {
		await waitForComplete(tab.id);
		await chrome.debugger.attach({ tabId: tab.id }, "1.3");
		state.attached = true;
		await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.enable");
		await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.enable");
		await chrome.debugger.sendCommand({ tabId: tab.id }, "Emulation.setFocusEmulationEnabled", { enabled: true });
		await ensureContext(state);
		return { tabId: tab.id, url: tab.url ?? parsed.href };
	} catch (error) {
		if (tabsOwned.has(tab.id)) {
			tabsOwned.delete(tab.id);
			try {
				await chrome.tabs.remove(tab.id);
			} catch (cleanupError) {
				throw new Error("Failed to clean up the created tab", { cause: cleanupError });
			}
		}
		throw error;
	}
}

function waitForComplete(tabId) {
	return new Promise((resolve, reject) => {
		const listener = (changedId, changeInfo) => {
			if (changedId === tabId && changeInfo.status === "complete") {
				chrome.tabs.onUpdated.removeListener(listener);
				resolve();
			}
		};
		chrome.tabs.onUpdated.addListener(listener);
		chrome.tabs.get(tabId).then(
			(tab) => {
				if (tab.status === "complete") {
					chrome.tabs.onUpdated.removeListener(listener);
					resolve();
				}
			},
			(error) => {
				chrome.tabs.onUpdated.removeListener(listener);
				reject(error);
			},
		);
	});
}

async function ensureContext(state) {
	if (!state.attached) throw new Error("Debugger detached");
	if (state.contextId !== undefined) return state.contextId;
	const tree = await chrome.debugger.sendCommand({ tabId: state.tabId }, "Page.getFrameTree");
	const frame = tree?.frameTree?.frame;
	if (!frame || typeof frame.id !== "string") throw new Error("Main frame unavailable");
	if (state.frameId !== frame.id || !state.contextId) {
		const world = await chrome.debugger.sendCommand({ tabId: state.tabId }, "Page.createIsolatedWorld", {
			frameId: frame.id,
			worldName: "openCuaBridge",
			grantUniveralAccess: false,
		});
		if (!Number.isInteger(world?.executionContextId)) throw new Error("Isolated context unavailable");
		state.frameId = frame.id;
		state.contextId = world.executionContextId;
		state.contextGeneration++;
		state.revision = undefined;
		const installed = await chrome.debugger.sendCommand({ tabId: state.tabId }, "Runtime.evaluate", {
			expression: `globalThis.__openCuaPageRuntime = (${PAGE_RUNTIME}); void 0`,
			contextId: state.contextId,
		});
		if (installed.exceptionDetails) throw new Error("Could not install the isolated page runtime");
	}
	return state.contextId;
}

async function evaluate(state, method, args = {}) {
	const contextId = await ensureContext(state);
	const expression = `globalThis.__openCuaPageRuntime(${JSON.stringify({ method, ...args })})`;
	const result = await chrome.debugger.sendCommand({ tabId: state.tabId }, "Runtime.evaluate", {
		expression,
		contextId,
		awaitPromise: true,
		returnByValue: true,
	});
	if (result.exceptionDetails) throw new Error("Page runtime failed");
	return result.result?.value;
}

async function observe(state, limits) {
	const result = await evaluate(state, "observe", { limits });
	if (!isRecord(result) || typeof result.revision !== "string") throw new Error("Invalid page observation");
	state.revision = result.revision;
	return result;
}

function requireOwned(tabId) {
	const state = tabsOwned.get(tabId);
	if (!state || !state.attached) throw new Error("Tab is not an attached agent-owned tab");
	return state;
}

function checkpoint(commandId, step) {
	if (stopped || !ready) return Promise.resolve(false);
	const id = commandId;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			checkpoints.delete(id);
			reject(new Error("Stop checkpoint timed out"));
		}, CHECKPOINT_TIMEOUT_MS);
		checkpoints.set(id, { resolve, reject, timer });
		send({ event: "checkpoint", id, step });
	});
}

function pageFailure(result, fallback) {
	if (isRecord(result) && typeof result.error === "string") {
		if (result.error === "stale") return new Error("Stale observation revision");
		return new Error(result.error);
	}
	return new Error(fallback);
}

async function screenshot(state, fullPage) {
	const metrics = await chrome.debugger.sendCommand({ tabId: state.tabId }, "Page.getLayoutMetrics");
	const viewport = metrics?.cssVisualViewport ?? metrics?.cssLayoutViewport;
	const content = metrics?.cssContentSize;
	const width = Math.max(1, Math.min(Math.ceil(content?.width ?? viewport?.clientWidth ?? 1), 2000));
	const height = Math.max(1, Math.min(Math.ceil(content?.height ?? viewport?.clientHeight ?? 1), 8000));
	const clip = fullPage ? { x: 0, y: 0, width, height, scale: 1 } : undefined;
	const image = await chrome.debugger.sendCommand({ tabId: state.tabId }, "Page.captureScreenshot", {
		format: "jpeg",
		quality: 60,
		fromSurface: true,
		...(clip === undefined ? {} : { captureBeyondViewport: true, clip }),
	});
	if (!isRecord(image) || typeof image.data !== "string" || image.data.length === 0)
		throw new Error("Screenshot capture returned no image");
	return { data: image.data, mimeType: "image/jpeg", width, height };
}

async function runSteps(state, command) {
	const tab = await chrome.tabs.get(state.tabId);
	if (tab.windowId !== state.windowId || state.windowId !== agentWindowId)
		throw new Error("Agent tab moved out of its background window");
	const window = await chrome.windows.get(state.windowId);
	if (window.focused || window.state !== "minimized")
		throw new Error("Background agent window was revealed. Stop and return it to the background before continuing.");
	const initialRevision = await evaluate(state, "revision");
	if (initialRevision !== command.revision) throw new Error("Stale observation revision");
	const contextGeneration = state.contextGeneration;
	let completedSteps = 0;
	for (let index = 0; index < command.steps.length; index++) {
		if (stopped || state.cancelled) throw new Error("Actions stopped");
		const step = command.steps[index];
		if (step.action === "wait") {
			const waited = await evaluate(state, "wait", {
				text: step.text,
				selector: step.selector,
				timeoutMs: step.timeoutMs,
			});
			if (!isRecord(waited) || waited.matched !== true) throw new Error("Wait timed out");
			completedSteps++;
			continue;
		}
		if (step.action === "scroll") {
			const prepared = await evaluate(state, "prepareScroll", { deltaY: step.deltaY });
			if (prepared?.ok !== true) throw new Error("Scroll preparation failed");
			if (prepared.needed) {
				if (stopped || state.cancelled) throw new Error("Actions stopped");
				await trustedScroll(state, step.deltaY);
			}
			const scrolled = await evaluate(state, "scrollComplete");
			if (scrolled?.ok !== true) throw new Error("Document scroll was not verified");
		} else if (step.action === "select") {
			const selected = await evaluate(state, "selectOption", {
				revision: command.revision,
				ref: step.ref,
				query: step.target,
				choice: step.choice,
				allowStaleRevision: true,
			});
			if (selected?.ok !== true) throw pageFailure(selected, "Option could not be selected");
		} else {
			if (step.action === "fill") {
				const prepared = await evaluate(state, "prepareFill", {
					revision: command.revision,
					ref: step.ref,
					query: step.target,
					text: step.text,
					allowStaleRevision: true,
				});
				if (prepared?.ok !== true) throw pageFailure(prepared, "Fill target is not a permitted editable field");
				if (stopped || state.cancelled) throw new Error("Actions stopped");
				if (step.text === "") await pressKey(state, "Backspace");
				else await chrome.debugger.sendCommand({ tabId: state.tabId }, "Input.insertText", { text: step.text });
				const filled = await evaluate(state, "fillComplete");
				if (filled?.ok !== true) throw new Error("Filled value did not match the requested text");
			} else {
				const target = await evaluate(state, "target", {
					revision: command.revision,
					ref: step.ref,
					query: step.target,
					allowStaleRevision: true,
				});
				if (isRecord(target) && target.error !== undefined)
					throw pageFailure(target, "Stale or missing element reference");
				if (!isRecord(target) || !Number.isFinite(target.x) || !Number.isFinite(target.y))
					throw new Error("Stale or missing element reference");
				if (stopped || state.cancelled) throw new Error("Actions stopped");
				if (step.action === "click") {
					try {
						await mouse(state, "mousePressed", target.x, target.y);
					} finally {
						await mouse(state, "mouseReleased", target.x, target.y);
					}
				} else {
					const focus = await evaluate(state, "focus", {
						revision: command.revision,
						ref: step.ref,
						query: step.target,
						allowStaleRevision: true,
					});
					if (focus?.ok !== true) throw pageFailure(focus, "Focus refused");
					if (stopped || state.cancelled) throw new Error("Actions stopped");
					await pressKey(state, step.key);
				}
			}
		}
		completedSteps++;
		if (state.contextId === undefined || state.frameId === undefined || state.contextGeneration !== contextGeneration)
			throw new Error("Document changed during batch; observe before continuing");
	}
	const verification = command.expect
		? await evaluate(state, "verify", { text: command.expect.text, timeoutMs: command.expect.timeoutMs })
		: null;
	const observation = await observe(state, command.limits);
	return { observation, verified: verification === null ? null : verification?.ok === true, completedSteps };
}

async function mouse(state, type, x, y) {
	await chrome.debugger.sendCommand({ tabId: state.tabId }, "Input.dispatchMouseEvent", {
		type,
		x,
		y,
		button: "left",
		clickCount: 1,
	});
}

async function trustedScroll(state, deltaY) {
	const metrics = await chrome.debugger.sendCommand({ tabId: state.tabId }, "Page.getLayoutMetrics");
	const viewport = metrics?.cssVisualViewport ?? metrics?.cssLayoutViewport;
	if (!viewport || !Number.isFinite(viewport.clientWidth) || !Number.isFinite(viewport.clientHeight)) {
		throw new Error("Viewport unavailable");
	}
	if (stopped || state.cancelled) throw new Error("Actions stopped");
	await chrome.debugger.sendCommand({ tabId: state.tabId }, "Input.dispatchMouseEvent", {
		type: "mouseWheel",
		x: viewport.clientWidth / 2,
		y: viewport.clientHeight / 2,
		deltaX: 0,
		deltaY,
	});
}

const KEY_CODES = {
	Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
	Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
	Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
	ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
	ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
	Control: { key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17 },
	A: { key: "a", code: "KeyA", windowsVirtualKeyCode: 65 },
	Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
};

async function keyEvent(state, type, key, modifiers = 0) {
	const values = KEY_CODES[key];
	await chrome.debugger.sendCommand({ tabId: state.tabId }, "Input.dispatchKeyEvent", {
		type,
		...values,
		modifiers,
	});
}

async function pressKey(state, key) {
	try {
		await keyEvent(state, "keyDown", key);
	} finally {
		await keyEvent(state, "keyUp", key);
	}
}

chrome.debugger.onEvent.addListener((source, method, params) => {
	if (source.tabId === undefined) return;
	const state = tabsOwned.get(source.tabId);
	if (!state) return;
	if (
		(method === "Page.frameNavigated" && params?.frame && !params.frame.parentId) ||
		method === "Runtime.executionContextsCleared"
	) {
		state.contextId = undefined;
		state.frameId = undefined;
		state.revision = undefined;
	}
	if (method === "Inspector.detached") {
		state.attached = false;
		state.contextId = undefined;
		state.cancelled = true;
	}
});

chrome.debugger.onDetach.addListener((source) => {
	if (source.tabId === undefined) return;
	const state = tabsOwned.get(source.tabId);
	if (state) {
		state.attached = false;
		state.contextId = undefined;
		state.cancelled = true;
	}
});

chrome.tabs.onRemoved.addListener((tabId) => {
	const state = tabsOwned.get(tabId);
	if (state) {
		state.cancelled = true;
		tabsOwned.delete(tabId);
	}
});

chrome.windows.onRemoved.addListener((windowId) => {
	if (windowId === agentWindowId) agentWindowId = undefined;
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
	if (windowId !== agentWindowId || givingBack) return;
	const window = await chrome.windows.get(windowId);
	if (!window.focused) return;
	pausedByUser = true;
	await chrome.storage.local.set({ pausedByUser: true });
	stopLocally();
	sendControl("human", "window_revealed");
});

chrome.windows.onBoundsChanged.addListener(async (window) => {
	if (window.id !== agentWindowId || window.state === "minimized" || givingBack) return;
	const current = await chrome.windows.get(window.id);
	if (current.state === "minimized" && !current.focused) return;
	pausedByUser = true;
	await chrome.storage.local.set({ pausedByUser: true });
	stopLocally();
	sendControl("human", "window_revealed");
});

chrome.tabs.onAttached.addListener((tabId, info) => {
	const state = tabsOwned.get(tabId);
	if (!state || info.newWindowId === state.windowId) return;
	pausedByUser = true;
	chrome.storage.local.set({ pausedByUser: true });
	stopLocally();
	sendControl("human", "window_revealed");
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
	if (changeInfo.status !== "loading") return;
	const state = tabsOwned.get(tabId);
	if (state) {
		state.contextId = undefined;
		state.frameId = undefined;
		state.revision = undefined;
	}
});

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
	if (message?.type === "connect-local") {
		localConnection()
			.then(async (connection) => {
				await chrome.storage.local.set({ ...connection, pausedByUser: false });
				pausedByUser = false;
				if (socket) {
					reconnectRequested = true;
					socket.close();
				} else await connect();
				respond({ ok: true });
			})
			.catch((error) =>
				respond({ ok: false, error: error instanceof Error ? error.message : "Local pairing failed" }),
			);
		return true;
	}
	if (message?.type === "stop") {
		pausedByUser = true;
		void chrome.storage.local.set({ pausedByUser: true });
		stopLocally();
		send({ event: "stop" });
		respond({ ok: true });
		return;
	}
	if (message?.type === "take-over") {
		takeOver()
			.then(() => respond({ ok: true }))
			.catch((error) => respond({ ok: false, error: error instanceof Error ? error.message : "Take over failed" }));
		return true;
	}
	if (message?.type === "give-back") {
		giveBack()
			.then(() => respond({ ok: true }))
			.catch((error) => respond({ ok: false, error: error instanceof Error ? error.message : "Give back failed" }));
		return true;
	}
	if (message?.type === "connect") {
		chrome.storage.local.set({ pausedByUser: false }).then(() => {
			pausedByUser = false;
			if (socket) {
				reconnectRequested = true;
				socket.close();
			} else void connect();
		});
		respond({ ok: true });
	}
});

chrome.storage.onChanged.addListener((changes, area) => {
	if (area === "local" && ("port" in changes || "token" in changes)) {
		reconnectRequested = true;
		if (socket) socket.close();
		ready = false;
		stopLocally();
		if (!socket) void connect();
	}
});

chrome.alarms.create("browser-bridge-connect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name !== "browser-bridge-connect") return;
	if (socket?.readyState === WebSocket.OPEN && ready) send({ event: "heartbeat" });
	else void connect();
});

void connect();
