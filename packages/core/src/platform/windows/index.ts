import type { AXTreeElement, AppState, WindowInventoryEntry } from "../../accessibility/types.js";
import type { OcrTextEntry } from "../../accessibility/types.js";
import type { ComputerInterface, ScreenshotResult, WindowTextRead } from "../../computer/interface.js";
import { type ScreenshotViewport, screenRectToScreenshot } from "../../computer/viewport.js";
import type {
	AppStateOptions,
	DragOptions,
	KeyOptions,
	Point,
	PointerOptions,
	Rect,
	ScreenshotOptions,
	ScrollOptions,
	SelectTextOptions,
} from "../../types/index.js";
import { type AudioStream, readWasapiSessions, streamsOfProcessTree } from "../audio-sessions.js";
import { windowsAudioSource } from "./audio-helper.js";
import { type GpuCaptureRunner, readGpuCapture } from "./gpu-capture.js";
import {
	type MessageClick,
	type MessageModifier,
	type WindowMessage,
	clickMessages,
	dragMessages,
} from "./messages.js";
import { windowsOcrSource } from "./ocr-helper.js";
import { readWindowsOcr } from "./ocr.js";
import {
	PowerShellTransport,
	type PowerShellTransportOptions,
	WindowsHostError,
	type WindowsTransport,
} from "./transport.js";
import * as wire from "./wire.js";

/** Longest recording: the helper's 15 s request timeout must cover activation plus the recording. */
const MAX_RECORD_SECONDS = 10;

export { WindowsHostError } from "./transport.js";
export type { WindowsProcess, WindowsProcessFactory, WindowsTransport } from "./transport.js";

export interface WindowsHostComputerOptions extends PowerShellTransportOptions {
	readonly transport?: WindowsTransport;
	/** OpenCuaCapture runner: GPU window capture (Windows.Graphics.Capture) before PrintWindow. */
	readonly gpuCapture?: GpuCaptureRunner;
}

interface Observation {
	readonly state: AppState;
	readonly generation: number;
	readonly frames: ReadonlyMap<number, Rect>;
	readonly refs: ReadonlyMap<number, number>;
}

/** UIA-only by default. Unsupported gestures fail rather than falling back to physical input. */
export class WindowsHostComputer implements ComputerInterface {
	readonly capabilities = {
		supportsScreenshot: true,
		supportsInput: true,
		supportsAccessibility: true,
		supportsClipboard: false,
	};
	readonly delivery: "attended" | "background";
	private readonly transport: WindowsTransport;
	/** OCR needs Windows PowerShell 5.1 (its WinRT projection), so it gets its own helper unless one was injected. */
	private ocrTransport: WindowsTransport | undefined;
	private target: number | undefined;
	private logicalCursor: Point = { x: 0, y: 0 };
	private readonly observations = new Map<number, Observation>();
	private nextRef = 0;

	constructor(private readonly options: WindowsHostComputerOptions = {}) {
		this.transport = options.transport ?? new PowerShellTransport(options);
		this.delivery = options.physical === true ? "attended" : "background";
	}

	setTarget(pid?: number): void {
		this.target = pid;
	}

	private pid(pid = this.target): number {
		if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) {
			throw new WindowsHostError("TARGET_REQUIRED", "Set a target process id before input or capture");
		}
		return pid;
	}

	private observation(pid: number): Observation {
		const observation = this.observations.get(pid);
		if (!observation || observation.generation !== this.transport.generation || observation.state.treeSkipped) {
			throw new WindowsHostError("STALE_REF", "Observe the target app again");
		}
		return observation;
	}

	assertObservationCurrent(pid: number, key: string): void {
		if (this.observation(pid).state.observationKey !== key) {
			throw new WindowsHostError("STALE_REF", "Observation key expired; observe again");
		}
	}

	private async action(pid: number, ref: number, action: string, params: Record<string, unknown> = {}): Promise<void> {
		const observation = this.observation(pid);
		if (!observation.frames.has(ref)) throw new WindowsHostError("STALE_REF", "Unknown element ref");
		await this.transport.request("action", {
			...params,
			pid,
			ref: observation.refs.get(ref),
			action,
			snapshot: observation.state.observationKey,
		});
	}

	async getAppState(targetPid?: number, options: AppStateOptions = {}): Promise<AppState> {
		const pid = this.pid(targetPid);
		if (options.diffOnly || options.includeMenuBar || options.visibleOnly || options.settleMs !== undefined) {
			throw new WindowsHostError("UNSUPPORTED", "Windows snapshots do not support diff/menu/visible/settle options");
		}
		if (
			options.maxElements !== undefined &&
			(!Number.isSafeInteger(options.maxElements) || options.maxElements < 1)
		) {
			throw new WindowsHostError("INVALID_ARGUMENT", "maxElements must be a positive integer");
		}
		if (options.timeoutMs !== undefined) {
			throw new WindowsHostError("UNSUPPORTED", "Set timeoutMs on WindowsHostComputerOptions instead");
		}
		if (options.subtreeOf !== undefined && !this.observation(pid).refs.has(options.subtreeOf)) {
			throw new WindowsHostError("STALE_REF", "Unknown subtree ref; observe again");
		}
		try {
			const previous = this.observations.get(pid);
			const state = wire.state(
				await this.transport.request("snapshot", {
					pid,
					options: {
						...options,
						...(options.subtreeOf === undefined
							? {}
							: { subtreeOf: this.observation(pid).refs.get(options.subtreeOf) }),
					},
					windowId: options.windowId,
					previous: previous?.state.observationKey,
				}),
			);
			const clientRefs = new Map(state.elements.map((element) => [element.id, this.nextRef++]));
			if (clientRefs.size !== state.elements.length) {
				throw new WindowsHostError("PROTOCOL", "Duplicate element ids");
			}
			const refs = new Map<number, number>();
			state.elements = state.elements.map((element) => {
				const id = clientRefs.get(element.id);
				if (id === undefined) throw new WindowsHostError("PROTOCOL", "Missing element id");
				refs.set(id, element.id);
				return {
					...element,
					id,
					children: element.children.map((child) => {
						const ref = clientRefs.get(child);
						if (ref === undefined) throw new WindowsHostError("PROTOCOL", "Unknown child id");
						return ref;
					}),
				};
			});
			const frames = new Map(state.elements.map((element) => [element.id, element.frame]));
			const viewport = this.viewport(state);
			if (viewport) {
				state.elements = state.elements.map((element) => ({
					...element,
					frame: screenRectToScreenshot(element.frame, viewport),
				}));
			}
			if (!options.probe) {
				this.observations.set(pid, { state, frames, refs, generation: this.transport.generation });
			}
			return state;
		} catch (error) {
			if (!options.probe) this.observations.delete(pid);
			throw error;
		}
	}

	private viewport(state: AppState): ScreenshotViewport | undefined {
		if (!state.windowBounds) return undefined;
		return {
			windowBounds: state.windowBounds,
			screenshotWidth: state.screenshotWidth,
			screenshotHeight: state.screenshotHeight,
		};
	}

	async getScreenshotViewport(pid: number): Promise<ScreenshotViewport | undefined> {
		const observation = this.observations.get(pid);
		return observation ? this.viewport(observation.state) : undefined;
	}

	/** Starts an app on the helper's owned desktop (transport option `desktop`); refused on the person's desktop. */
	async launchApp(path: string, args: readonly string[] = []): Promise<number> {
		if (path.length === 0 || path.includes("\0") || args.some((arg) => arg.includes("\0"))) {
			throw new WindowsHostError("INVALID_ARGUMENT", "path and args must be nonempty strings without NUL");
		}
		return wire.number(wire.record(await this.transport.request("launch", { path, args }))["pid"]);
	}

	private ocrGeneration: number | undefined;

	/** Text of the app's window read from its pixels with the built-in Windows OCR, in screen frames. */
	async readWindowText(pid: number, windowId?: number): Promise<OcrTextEntry[]> {
		return readWindowsOcr(await this.ocrResponse(pid, windowId));
	}

	private async ocrResponse(pid: number, windowId?: number): Promise<unknown> {
		if (this.ocrTransport === undefined) {
			this.ocrTransport =
				this.options.transport ?? new PowerShellTransport({ ...this.options, executable: "powershell.exe" });
		}
		const transport = this.ocrTransport;
		if (this.ocrGeneration !== transport.generation) {
			await transport.request("loadOcr", { source: windowsOcrSource });
			this.ocrGeneration = transport.generation;
		}
		return transport.request("ocr", { pid: this.pid(pid), windowId });
	}

	/**
	 * The shared OCR entry point: text of the app's window, optionally only inside `region` (pixels of the window's
	 * screenshot, like click coordinates). Failures are reported as unavailable, never thrown.
	 */
	async recognizeWindowText(targetPid: number, options?: { readonly region?: Rect }): Promise<WindowTextRead> {
		let response: unknown;
		try {
			response = await this.ocrResponse(targetPid);
		} catch (error) {
			if (error instanceof WindowsHostError && error.code === "NO_WINDOW") return { unavailable: "no-window" };
			return { unavailable: "recognition-failed" };
		}
		const entries = readWindowsOcr(response);
		const region = options?.region;
		if (region === undefined) return { entries };
		const result = wire.record(response);
		const bounds = wire.rect(result["bounds"]);
		const scaleX = wire.number(result["width"]) / bounds.width;
		const scaleY = wire.number(result["height"]) / bounds.height;
		return {
			entries: entries.filter(({ frame }) => {
				const x = (frame.x + frame.width / 2 - bounds.x) * scaleX;
				const y = (frame.y + frame.height / 2 - bounds.y) * scaleY;
				return x >= region.x && x < region.x + region.width && y >= region.y && y < region.y + region.height;
			}),
		};
	}

	private audioGeneration: number | undefined;

	/** A restarted helper has a new generation and has not compiled the audio code yet. */
	private async loadAudio(): Promise<void> {
		if (this.audioGeneration === this.transport.generation) return;
		await this.transport.request("loadAudio", { source: windowsAudioSource });
		this.audioGeneration = this.transport.generation;
	}

	/** WASAPI sessions (default output device) of an app and its child processes, with meter peaks. */
	async getAudioStreams(pid: number): Promise<AudioStream[]> {
		await this.loadAudio();
		const report = wire.record(await this.transport.request("audio"));
		const parents = new Map<number, number>();
		for (const [child, parent] of Object.entries(wire.record(report["parents"]))) {
			if (typeof parent === "number") parents.set(Number(child), parent);
		}
		const streams = readWasapiSessions(JSON.stringify(wire.array(report["sessions"])));
		return streamsOfProcessTree(streams, pid, parents);
	}

	/** Process-loopback recording of an app and its child processes (Windows 10 20348+ / 11), as WAV. */
	async recordAudio(pid: number, seconds: number): Promise<{ mimeType: "audio/wav"; data: Buffer }> {
		if (!Number.isSafeInteger(pid) || pid <= 0)
			throw new WindowsHostError("INVALID_ARGUMENT", "pid must be a process id");
		if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_RECORD_SECONDS) {
			throw new WindowsHostError(
				"INVALID_ARGUMENT",
				`seconds must be more than 0 and at most ${MAX_RECORD_SECONDS}`,
			);
		}
		await this.loadAudio();
		const response = wire.record(await this.transport.request("audioRecord", { pid, seconds }));
		const data = response["data"];
		if (typeof data !== "string") throw new WindowsHostError("PROTOCOL", "audioRecord returned no data");
		return { mimeType: "audio/wav", data: Buffer.from(data, "base64") };
	}

	async listApps() {
		return wire.array(await this.transport.request("listApps")).map(wire.app);
	}

	async listAppIdentities() {
		return this.listApps();
	}

	async listWindows(pid?: number): Promise<WindowInventoryEntry[]> {
		return wire.array(await this.transport.request("listWindows", { pid })).map(wire.windowEntry);
	}

	async screenshot(options: ScreenshotOptions = {}): Promise<ScreenshotResult> {
		if (options.region || options.quality !== undefined) {
			throw new WindowsHostError("UNSUPPORTED", "Window capture does not support region or quality");
		}
		const pid = this.pid();
		const windowId = this.observations.get(pid)?.state.windowId;
		const gpu = this.options.gpuCapture;
		if (
			gpu !== undefined &&
			windowId !== undefined &&
			options.targetSize === undefined &&
			options.format !== "jpeg"
		) {
			const { exitCode, stdout } = await gpu(windowId);
			const captured = readGpuCapture(exitCode, stdout);
			if (captured !== "fallback") return captured;
		}
		const result = wire.record(
			await this.transport.request("screenshot", {
				...options,
				pid,
				windowId: this.observations.get(pid)?.state.windowId,
			}),
		);
		const mime = wire.string(result["mimeType"]);
		if (mime !== "image/png" && mime !== "image/jpeg") throw new WindowsHostError("PROTOCOL", "Invalid image type");
		return {
			data: Buffer.from(wire.string(result["data"]), "base64"),
			width: wire.number(result["width"]),
			height: wire.number(result["height"]),
			mimeType: mime,
		};
	}

	async move(position: Point): Promise<void> {
		if (this.options.physical) await this.physical("move", position);
		this.logicalCursor = { ...position };
	}

	private hit(pid: number, position: Point, action?: string): AXTreeElement | undefined {
		const observation = this.observation(pid);
		return [...observation.state.elements].reverse().find((element) => {
			const frame = observation.frames.get(element.id);
			return (
				frame !== undefined &&
				(!action ||
					(action === "press"
						? element.actions.some((name) => ["press", "toggle", "select", "expand"].includes(name))
						: element.actions.includes(action))) &&
				position.x >= frame.x &&
				position.y >= frame.y &&
				position.x < frame.x + frame.width &&
				position.y < frame.y + frame.height
			);
		});
	}

	private checkModifiers(options?: PointerOptions): void {
		if (options?.modifiers?.length) {
			throw new WindowsHostError("UNSUPPORTED", "Pointer modifiers are not supported; use explicit key input");
		}
	}

	/** Background modifiers: window messages carry Shift and Ctrl in wParam; other keys need real key state. */
	private messageModifiers(options?: PointerOptions): MessageModifier[] {
		const modifiers: MessageModifier[] = [];
		for (const modifier of options?.modifiers ?? []) {
			if (modifier === "shift") modifiers.push("shift");
			else if (modifier === "ctrl" || modifier === "control") modifiers.push("ctrl");
			else throw new WindowsHostError("UNSUPPORTED", `Background pointer input cannot hold ${modifier}`);
		}
		return modifiers;
	}

	/**
	 * Posts pointer messages to the deepest child window under the first screen point, in that
	 * window's client coordinates. The person's mouse and focus stay where they are.
	 */
	private async postPointer(points: readonly Point[], build: (client: Point[]) => WindowMessage[]): Promise<void> {
		const first = points[0];
		if (first === undefined) throw new WindowsHostError("INVALID_ARGUMENT", "No pointer position");
		const target = wire.record(
			await this.transport.request("postTarget", { pid: this.pid(), x: first.x, y: first.y }),
		);
		const originX = wire.number(target["originX"]);
		const originY = wire.number(target["originY"]);
		const client = points.map((point) => ({ x: point.x - originX, y: point.y - originY }));
		let messages: WindowMessage[];
		try {
			messages = build(client);
		} catch (error) {
			throw new WindowsHostError("INVALID_ARGUMENT", error instanceof Error ? error.message : String(error));
		}
		await this.transport.request("post", { hwnd: wire.number(target["hwnd"]), messages });
	}

	private async pointer(kind: MessageClick, position: Point, options?: PointerOptions): Promise<void> {
		if (this.options.physical) {
			this.checkModifiers(options);
			const button = kind === "right" || kind === "middle" ? { button: kind } : {};
			await this.physical(kind === "double" ? "doubleClick" : "click", position, button);
			return;
		}
		const modifiers = this.messageModifiers(options);
		await this.postPointer([position], ([client]) => (client ? clickMessages(kind, client, modifiers) : []));
		this.logicalCursor = { ...position };
	}

	async click(position: Point, options?: PointerOptions): Promise<void> {
		const pid = this.pid();
		const element = options?.modifiers?.length ? undefined : this.hit(pid, position, "press");
		if (element) {
			await this.action(pid, element.id, "press");
		} else await this.pointer("left", position, options);
	}

	async rightClick(position: Point, options?: PointerOptions): Promise<void> {
		await this.pointer("right", position, options);
	}

	async middleClick(position: Point, options?: PointerOptions): Promise<void> {
		await this.pointer("middle", position, options);
	}

	async doubleClick(position: Point, options?: PointerOptions): Promise<void> {
		await this.pointer("double", position, options);
	}

	async drag(options: DragOptions): Promise<void> {
		if (this.options.physical) {
			this.checkModifiers(options);
			if (options.waypoints?.length || options.duration !== undefined) {
				throw new WindowsHostError("UNSUPPORTED", "Timed drags and waypoints are not supported");
			}
			await this.physical("drag", options.from, { to: options.to, button: options.button });
			return;
		}
		if (options.duration !== undefined) {
			throw new WindowsHostError("UNSUPPORTED", "Background drags are posted at once; duration is not supported");
		}
		if (options.button !== undefined && options.button !== "left") {
			throw new WindowsHostError("UNSUPPORTED", "Background drags use the left button");
		}
		const modifiers = this.messageModifiers(options);
		const path = [options.from, ...(options.waypoints ?? []), options.to];
		await this.postPointer(path, (client) => dragMessages(client, modifiers));
		this.logicalCursor = { ...options.to };
	}

	private async physical(kind: string, position: Point, params: Record<string, unknown> = {}): Promise<void> {
		if (!this.options.physical) {
			throw new WindowsHostError("PHYSICAL_INPUT_REQUIRED", `${kind} requires explicit physical: true`);
		}
		await this.transport.request("physical", { ...params, kind, ...position });
	}

	async type(text: string): Promise<void> {
		await this.typeIntoFocused(this.pid(), text);
	}

	async typeIntoFocused(pid: number, text: string, _options?: { readonly settleWrite?: boolean }): Promise<boolean> {
		return wire.boolean(await this.transport.request("type", { pid: this.pid(pid), text }));
	}

	async key(key: string, options: KeyOptions = {}): Promise<void> {
		if (options.holdMilliseconds !== undefined) {
			throw new WindowsHostError("UNSUPPORTED", "Held keys are not supported");
		}
		await this.physical("key", this.logicalCursor, { key, modifiers: options.modifiers });
	}

	async scroll(options: ScrollOptions): Promise<void> {
		this.checkModifiers(options);
		if (!Number.isSafeInteger(options.amount) || options.amount < 0 || options.amount > 100) {
			throw new WindowsHostError("INVALID_ARGUMENT", "Scroll amount must be an integer from 0 to 100");
		}
		const pid = this.pid();
		const element = options.position
			? this.hit(pid, options.position, "scroll")
			: this.observation(pid).state.elements.find((element) => element.actions.includes("scroll"));
		if (!element) throw new WindowsHostError("UNSUPPORTED", "No observed ScrollPattern element");
		await this.action(pid, element.id, "scroll", { direction: options.direction, amount: options.amount });
	}

	async getCursorPosition(): Promise<Point> {
		return this.options.physical ? wire.point(await this.transport.request("cursor")) : { ...this.logicalCursor };
	}

	async getScreenSize(): Promise<{ width: number; height: number }> {
		const result = wire.record(await this.transport.request("screen"));
		return { width: wire.number(result["width"]), height: wire.number(result["height"]) };
	}

	async setValue(pid: number, ref: number, value: string): Promise<void> {
		await this.action(pid, ref, "setValue", { value });
	}

	async selectText(pid: number, ref: number, options: SelectTextOptions): Promise<void> {
		if (options.prefix !== undefined || options.suffix !== undefined) {
			throw new WindowsHostError("UNSUPPORTED", "Text prefix/suffix disambiguation is not supported");
		}
		await this.action(pid, ref, "selectText", { ...options });
	}

	async performAction(pid: number, ref: number, action: string): Promise<void> {
		await this.action(pid, ref, action === "AXPress" ? "press" : action);
	}

	async pressAtPosition(pid: number, position: Point): Promise<boolean> {
		const element = this.hit(pid, position, "press");
		if (!element) return false;
		await this.action(pid, element.id, "press");
		return true;
	}

	async elementFrame(pid: number, ref: number): Promise<Rect | undefined> {
		return this.observation(pid).frames.get(ref);
	}

	async close(): Promise<void> {
		this.observations.clear();
		await this.transport.close();
		if (this.ocrTransport !== undefined && this.ocrTransport !== this.transport) await this.ocrTransport.close();
	}
}

export function createWindowsHostComputer(options: WindowsHostComputerOptions = {}): WindowsHostComputer {
	return new WindowsHostComputer(options);
}
