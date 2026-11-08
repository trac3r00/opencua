import { readFile } from "node:fs/promises";
import type { TartGuestTransport } from "./tart-guest-transport.js";

export interface GuestAccessibilityElement {
	readonly role: string;
	readonly title?: string;
	readonly value?: string;
	readonly depth: number;
	/** [x, y, width, height] in screenshot pixels, the coordinates actions take. */
	readonly frame?: readonly [number, number, number, number];
}

export interface GuestAccessibility {
	readonly app: string;
	readonly elements: readonly GuestAccessibilityElement[];
}

type GuestCommands = Pick<TartGuestTransport, "execute">;

const GUEST_HELPER = "/tmp/opencua-guest-axdump";
const installed = new WeakSet<GuestCommands>();

export function guestAccessibilityHelperPath(): string {
	return new URL("../../native/guest-axdump", import.meta.url).pathname;
}

/**
 * Reads the guest's front window through the guest-axdump helper, installed into the guest once per transport, and
 * converts element frames from guest screen points to pixels of a screenshot of the given size.
 */
export async function readGuestAccessibility(
	transport: GuestCommands,
	image: { readonly width: number; readonly height: number },
	helper: () => Promise<Buffer> = () => readFile(guestAccessibilityHelperPath()),
): Promise<GuestAccessibility> {
	if (!installed.has(transport)) {
		const encoded = (await helper()).toString("base64");
		await transport.execute(
			["/bin/sh", "-c", `/usr/bin/base64 -D -o ${GUEST_HELPER} && /bin/chmod 700 ${GUEST_HELPER}`],
			encoded,
		);
		installed.add(transport);
	}
	const output = (await transport.execute([GUEST_HELPER])).toString("utf8");
	return parseGuestAccessibility(output, image);
}

function parseGuestAccessibility(
	output: string,
	image: { readonly width: number; readonly height: number },
): GuestAccessibility {
	let parsed: unknown;
	try {
		parsed = JSON.parse(output);
	} catch {
		throw new Error("The guest accessibility helper returned no JSON.");
	}
	if (typeof parsed !== "object" || parsed === null)
		throw new Error("The guest accessibility reply is not an object.");
	const record = parsed as Record<string, unknown>;
	if (record["trusted"] !== 1 && record["trusted"] !== true)
		throw new Error("The guest has no accessibility permission for its agent.");
	const screen = record["screen"];
	if (
		!Array.isArray(screen) ||
		typeof screen[0] !== "number" ||
		typeof screen[1] !== "number" ||
		screen[0] <= 0 ||
		screen[1] <= 0
	)
		throw new Error("The guest accessibility reply has no screen size.");
	const scaleX = image.width / screen[0];
	const scaleY = image.height / screen[1];
	const elements: GuestAccessibilityElement[] = [];
	for (const item of Array.isArray(record["elements"]) ? record["elements"] : []) {
		if (typeof item !== "object" || item === null) continue;
		const entry = item as Record<string, unknown>;
		const role = entry["role"];
		const depth = entry["depth"];
		if (typeof role !== "string" || typeof depth !== "number") continue;
		const box = frameOf(entry["frame"]);
		const title = entry["title"];
		const value = entry["value"];
		elements.push({
			role,
			depth,
			...(typeof title === "string" ? { title } : {}),
			...(typeof value === "string" ? { value } : {}),
			...(box === undefined
				? {}
				: {
						frame: [
							Math.round(box[0] * scaleX),
							Math.round(box[1] * scaleY),
							Math.round(box[2] * scaleX),
							Math.round(box[3] * scaleY),
						] as const,
					}),
		});
	}
	return { app: typeof record["app"] === "string" ? record["app"] : "", elements };
}

function frameOf(value: unknown): readonly [number, number, number, number] | undefined {
	if (!Array.isArray(value) || value.length !== 4) return undefined;
	const [x, y, width, height] = value;
	return typeof x === "number" && typeof y === "number" && typeof width === "number" && typeof height === "number"
		? [x, y, width, height]
		: undefined;
}
