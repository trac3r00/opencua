import type { AXTreeElement, AppInfo, AppState, WindowInventoryEntry } from "../../accessibility/types.js";
import type { ComputerInterface, ScreenshotResult } from "../../computer/interface.js";
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
import { type AudioStream, readPactlSinkInputs, readPwDump, streamsOfProcessTree } from "../audio-sessions.js";
import { LinuxBackendError, type LinuxClientOptions, LinuxHelperClient, record } from "./client.js";
import { app, array, boolean, element, point, rect, size, text, window } from "./protocol.js";

export { LINUX_INSTALL_HINTS, LinuxBackendError } from "./client.js";
export type { LinuxHelperEvents, LinuxHelperFactory, LinuxHelperTransport } from "./client.js";

export interface LinuxHostComputerOptions extends LinuxClientOptions {
	/** Explicit opt-in to global physical input. Never inferred from DISPLAY or an available tool. */
	readonly physical?: boolean;
}

export interface LinuxElementRef {
	readonly pid: number;
	readonly snapshotId: string;
	readonly elementId: number;
}

export interface LinuxScreenshotResult extends ScreenshotResult {
	readonly scope: "screen" | "window";
	readonly captureNotice?: string;
}

export interface LinuxAppState extends AppState {
	readonly captureScope?: "screen" | "window";
	readonly captureNotice?: string;
}

/** Standard semantic verbs or an action name advertised by the toolkit. */
export type LinuxSemanticAction = string;

interface Observation {
	readonly key: string;
	readonly elements: readonly AXTreeElement[];
	readonly epoch: number;
	readonly viewport?: ScreenshotViewport;
}

/** No method activates an application or window, including in physical mode. */
export class LinuxHostComputer implements ComputerInterface {
	readonly capabilities = {
		supportsScreenshot: true,
		supportsInput: true,
		supportsAccessibility: true,
		supportsClipboard: false,
	};
	readonly delivery: "background" | "attended";
	private readonly client: LinuxHelperClient;
	private readonly physical: boolean;
	private targetPid: number | undefined;
	private readonly observations = new Map<number, Observation>();

	constructor(options: LinuxHostComputerOptions = {}) {
		this.physical = options.physical === true;
		this.delivery = this.physical ? "attended" : "background";
		this.client = new LinuxHelperClient(options);
	}

	setTarget(pid?: number): void {
		this.targetPid = pid;
	}

	async screenshot(options?: ScreenshotOptions): Promise<LinuxScreenshotResult> {
		return this.capture({ options });
	}

	private async capture(params: Readonly<Record<string, unknown>>): Promise<LinuxScreenshotResult> {
		const response = record(await this.client.request("screenshot", params));
		const mimeType = text(response["mimeType"]);
		const scope = text(response["scope"]);
		if ((mimeType !== "image/png" && mimeType !== "image/jpeg") || (scope !== "screen" && scope !== "window")) {
			throw new LinuxBackendError("PROTOCOL_ERROR", "Invalid capture format or scope");
		}
		return {
			data: Buffer.from(text(response["data"]), "base64"),
			mimeType,
			...size(response),
			scope,
			...(scope === "screen" ? { captureNotice: "Full-screen capture; not scoped to the target window" } : {}),
		};
	}

	private async physicalInput(operation: string, params: Readonly<Record<string, unknown>>): Promise<void> {
		if (!this.physical) {
			throw new LinuxBackendError("PHYSICAL_INPUT_REQUIRED", `${operation} requires explicit physical: true`);
		}
		await this.client.request("physical", { operation, physical: true, ...params });
	}

	async move(position: Point): Promise<void> {
		await this.physicalInput("move", { position });
	}

	private target(): number {
		if (this.targetPid === undefined) throw new LinuxBackendError("NO_TARGET", "Call setTarget(pid) before input");
		return this.targetPid;
	}

	private atPosition(pid: number, position: Point): LinuxElementRef | undefined {
		const observation = this.observations.get(pid);
		if (!observation) return undefined;
		const candidates = observation.elements.filter(({ frame }) => {
			return (
				position.x >= frame.x &&
				position.y >= frame.y &&
				position.x < frame.x + frame.width &&
				position.y < frame.y + frame.height
			);
		});
		// Most specific observed control, not a fresh hit-test that might name a replacement.
		candidates.sort((a, b) => a.frame.width * a.frame.height - b.frame.width * b.frame.height);
		const candidate = candidates[0];
		return candidate ? { pid, snapshotId: observation.key, elementId: candidate.id } : undefined;
	}

	private async pointer(action: string, position: Point, options?: PointerOptions): Promise<void> {
		if (this.physical) return this.physicalInput(action, { position, options });
		if (options?.modifiers?.length) {
			throw new LinuxBackendError("PHYSICAL_INPUT_REQUIRED", "Modifiers cannot be delivered through AT-SPI Action");
		}
		const ref = this.atPosition(this.target(), position);
		if (!ref) throw new LinuxBackendError("STALE_REF", "No observed element at that position; observe again");
		await this.act(ref, action);
	}

	async click(position: Point, options?: PointerOptions): Promise<void> {
		await this.pointer("click", position, options);
	}

	async rightClick(position: Point, options?: PointerOptions): Promise<void> {
		await this.pointer("rightClick", position, options);
	}

	async middleClick(position: Point, options?: PointerOptions): Promise<void> {
		await this.pointer("middleClick", position, options);
	}

	async doubleClick(position: Point, options?: PointerOptions): Promise<void> {
		await this.pointer("doubleClick", position, options);
	}

	async type(content: string): Promise<void> {
		if (this.physical) return this.physicalInput("type", { text: content });
		if (!(await this.typeIntoFocused(this.target(), content))) {
			throw new LinuxBackendError(
				"UNSUPPORTED_ACTION",
				"No already-focused AT-SPI EditableText; use an element ref",
			);
		}
	}

	async key(key: string, options?: KeyOptions): Promise<void> {
		await this.physicalInput("key", { key, options });
	}

	async scroll(options: ScrollOptions): Promise<void> {
		if (this.physical) return this.physicalInput("scroll", { options });
		if (!options.position || options.modifiers?.length) {
			throw new LinuxBackendError(
				"PHYSICAL_INPUT_REQUIRED",
				"Background scroll requires an observed element position",
			);
		}
		if (!Number.isInteger(options.amount) || options.amount < 0 || options.amount > 100) {
			throw new LinuxBackendError("INVALID_ARGUMENT", "Semantic scroll amount must be an integer from 0 to 100");
		}
		const ref = this.atPosition(this.target(), options.position);
		if (!ref) throw new LinuxBackendError("STALE_REF", "No observed scroll element");
		for (let i = 0; i < options.amount; ++i) await this.act(ref, `scroll ${options.direction}`);
	}

	async drag(options: DragOptions): Promise<void> {
		await this.physicalInput("drag", { options });
	}

	async getCursorPosition(): Promise<Point> {
		return point(await this.client.request("cursor"));
	}

	async getScreenSize(): Promise<{ width: number; height: number }> {
		return size(await this.client.request("screenSize"));
	}

	/** The audio streams of an app and its child processes, from PipeWire (or PulseAudio). */
	async getAudioStreams(pid: number): Promise<AudioStream[]> {
		const report = record(await this.client.request("audio"));
		const source = text(report["source"]);
		const output = text(report["text"]);
		const parents = new Map<number, number>();
		for (const [child, parent] of Object.entries(record(report["parents"]))) {
			if (typeof parent === "number") parents.set(Number(child), parent);
		}
		const streams = source === "pw-dump" ? readPwDump(output) : readPactlSinkInputs(output);
		return streamsOfProcessTree(streams, pid, parents);
	}

	/**
	 * Records one stream (a `target` from getAudioStreams) for up to 30 seconds as WAV, without
	 * touching other apps' audio. The helper answers nothing else while it records.
	 */
	async recordAudio(target: number, seconds: number): Promise<{ mimeType: "audio/wav"; data: Buffer }> {
		if (!Number.isSafeInteger(target) || target < 0) {
			throw new LinuxBackendError("INVALID_ARGUMENT", "target must be a stream node id");
		}
		if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 30) {
			throw new LinuxBackendError("INVALID_ARGUMENT", "seconds must be more than 0 and at most 30");
		}
		const response = record(await this.client.request("audioRecord", { target, seconds }, seconds * 1000 + 10_000));
		return { mimeType: "audio/wav", data: Buffer.from(text(response["data"]), "base64") };
	}

	async listApps(): Promise<AppInfo[]> {
		return array(await this.client.request("listApps")).map(app);
	}

	async listAppIdentities(): Promise<AppInfo[]> {
		return this.listApps();
	}

	async listWindows(pid: number): Promise<WindowInventoryEntry[]> {
		return array(await this.client.request("listWindows", { pid })).map(window);
	}

	async getAppState(targetPid = this.targetPid, options: AppStateOptions = {}): Promise<LinuxAppState> {
		const pid = targetPid ?? (await this.listApps()).find((item) => item.isFrontmost)?.pid;
		if (pid === undefined) throw new LinuxBackendError("NO_TARGET", "Specify an accessible application pid");
		// Do not silently claim diff semantics or invalidate the input observation for a probe.
		if (options.diffOnly) throw new LinuxBackendError("UNSUPPORTED_OPERATION", "Linux snapshots return full trees");
		try {
			const response = record(await this.client.request("snapshot", { pid, options }, options.timeoutMs));
			const identity = app(response["app"]);
			const elements = array(response["elements"]).map(element);
			const inventory = array(response["windows"]).map(window);
			const selected = response["window"] === null ? undefined : window(response["window"]);
			const key = text(response["snapshotId"]);
			let image: LinuxScreenshotResult | undefined;
			if (options.includeScreenshot !== false) {
				image = await this.capture({
					windowId: selected?.id,
					requireWindow: options.requireWindow === true,
					options: { targetSize: options.screenshotSize },
				});
			}
			const dimensions = image ?? (selected ? selected.bounds : await this.getScreenSize());
			let viewport: ScreenshotViewport | undefined;
			if (selected && image?.scope === "window") {
				viewport = {
					windowBounds: selected.bounds,
					screenshotWidth: image.width,
					screenshotHeight: image.height,
				};
			}
			const mappedElements = viewport
				? elements.map((entry) => ({ ...entry, frame: screenRectToScreenshot(entry.frame, viewport) }))
				: elements;
			if (!options.probe) {
				this.observations.set(pid, {
					key,
					elements,
					epoch: this.client.epoch,
					...(viewport ? { viewport } : {}),
				});
			}
			return {
				app: identity.name,
				bundleId: identity.bundleId,
				pid,
				frontmost: identity.isFrontmost ?? false,
				axAvailable: true,
				elements: mappedElements,
				observationKey: key,
				elementsTruncated: boolean(response["truncated"]),
				treeSkipped: options.includeAccessibilityTree === false,
				screenshotBase64: image?.data.toString("base64") ?? "",
				screenshotWidth: dimensions.width,
				screenshotHeight: dimensions.height,
				screenshotMimeType: image?.mimeType ?? "image/png",
				display: { ...(await this.getScreenSize()), scaleFactor: 1 },
				windowCandidates: inventory,
				...(selected ? { windowId: selected.id, windowTitle: selected.title } : {}),
				...(viewport ? { windowBounds: viewport.windowBounds } : {}),
				...(image ? { captureScope: image.scope } : {}),
				...(image?.captureNotice ? { captureNotice: image.captureNotice } : {}),
			};
		} catch (error) {
			if (!options.probe) this.observations.delete(pid);
			throw error;
		}
	}

	assertObservationCurrent(pid: number, observationKey: string): void {
		const observation = this.observations.get(pid);
		if (!observation || observation.key !== observationKey || observation.epoch !== this.client.epoch) {
			throw new LinuxBackendError("STALE_REF", "Observation is no longer current; observe again");
		}
	}

	async getScreenshotViewport(pid: number): Promise<ScreenshotViewport | undefined> {
		const observation = this.observations.get(pid);
		return observation?.epoch === this.client.epoch ? observation.viewport : undefined;
	}

	elementRef(pid: number, elementId: number): LinuxElementRef {
		const observation = this.observations.get(pid);
		if (!observation || !observation.elements.some((entry) => entry.id === elementId)) {
			throw new LinuxBackendError("STALE_REF", "Element is not in the current observation");
		}
		this.assertObservationCurrent(pid, observation.key);
		return { pid, snapshotId: observation.key, elementId };
	}

	async act(
		ref: LinuxElementRef,
		action: LinuxSemanticAction,
		params: { readonly text?: string; readonly value?: string; readonly options?: SelectTextOptions } = {},
	): Promise<void> {
		this.assertObservationCurrent(ref.pid, ref.snapshotId);
		await this.client.request("act", { ...params, ref, action });
	}

	async setValue(pid: number, elementIndex: number, value: string): Promise<void> {
		await this.act(this.elementRef(pid, elementIndex), "setValue", { value });
	}

	async selectText(pid: number, elementIndex: number, options: SelectTextOptions): Promise<void> {
		await this.act(this.elementRef(pid, elementIndex), "selectText", { options });
	}

	async performAction(pid: number, elementIndex: number, action: string): Promise<void> {
		await this.act(this.elementRef(pid, elementIndex), action);
	}

	async pressAtPosition(pid: number, position: Point): Promise<boolean> {
		const ref = this.atPosition(pid, position);
		if (!ref) return false;
		await this.act(ref, "click");
		return true;
	}

	async elementFrame(pid: number, elementIndex: number): Promise<Rect | undefined> {
		return rect(await this.client.request("act", { ref: this.elementRef(pid, elementIndex), action: "frame" }));
	}

	async typeIntoFocused(pid: number, content: string): Promise<boolean> {
		return boolean(await this.client.request("focusedType", { pid, text: content }));
	}

	async close(): Promise<void> {
		this.observations.clear();
		this.client.close();
	}
}

export function createLinuxHostComputer(options: LinuxHostComputerOptions = {}): LinuxHostComputer {
	return new LinuxHostComputer(options);
}
