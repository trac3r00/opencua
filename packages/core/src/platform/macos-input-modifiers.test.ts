import { describe, expect, it } from "bun:test";
import { vi } from "@opencua/test-support";

import { normalizeModifiers } from "../computer/modifiers.js";
import { pointerModifierFlags, withHeldModifiers } from "./macos-input-modifiers.js";

const SHIFT = 0x00020000;
const CONTROL = 0x00040000;
const OPTION = 0x00080000;
const COMMAND = 0x00100000;

describe("#given modifier names with aliases", () => {
	it("#when normalized #then aliases become canonical names in first-given order without duplicates", () => {
		expect(normalizeModifiers(["cmd", "SHIFT", "alt", "opt", "ctrl", "command"])).toEqual([
			"command",
			"shift",
			"option",
			"control",
		]);
	});

	it("#when normalized with nothing #then there are no modifiers", () => {
		expect(normalizeModifiers(undefined)).toEqual([]);
		expect(normalizeModifiers([])).toEqual([]);
	});

	it("#when a name is unknown #then it is refused instead of dropped", () => {
		expect(() => normalizeModifiers(["command", "hyper"])).toThrow("unsupported modifier: hyper");
	});
});

describe("#given modifier flag masks", () => {
	it.each([
		[["command"], COMMAND],
		[["cmd"], COMMAND],
		[["shift"], SHIFT],
		[["option"], OPTION],
		[["alt"], OPTION],
		[["opt"], OPTION],
		[["control"], CONTROL],
		[["ctrl"], CONTROL],
		[["cmd", "shift"], COMMAND | SHIFT],
		[["cmd", "shift", "alt", "ctrl"], COMMAND | SHIFT | OPTION | CONTROL],
		[[], 0],
	] as const)("#when the mask for %o is read #then it is %i", (modifiers, expected) => {
		expect(pointerModifierFlags(modifiers)).toBe(expected);
	});
});

describe("#given a gesture that holds modifiers", () => {
	it("#when it runs #then each key goes down with the cumulative flags, the gesture sees them all, and keys release in reverse", async () => {
		const post = vi.fn<(keyCode: number, keyDown: boolean, flags: number) => void>();
		const gesture = vi.fn(async (flags: number | undefined) => {
			expect(post).toHaveBeenCalledTimes(2);
			return flags;
		});

		const result = await withHeldModifiers(["cmd", "shift"], post, gesture);

		expect(result).toBe(COMMAND | SHIFT);
		expect(post.mock.calls).toEqual([
			[55, true, COMMAND],
			[56, true, COMMAND | SHIFT],
			[56, false, COMMAND],
			[55, false, 0],
		]);
	});

	it("#when the gesture throws #then every key is still released and the gesture's error surfaces", async () => {
		const post = vi.fn<(keyCode: number, keyDown: boolean, flags: number) => void>();

		await expect(
			withHeldModifiers(["option", "control"], post, async () => {
				throw new Error("click failed");
			}),
		).rejects.toThrow("click failed");

		expect(post.mock.calls).toEqual([
			[58, true, OPTION],
			[59, true, OPTION | CONTROL],
			[59, false, OPTION],
			[58, false, 0],
		]);
	});

	it("#when a key release fails as well #then the other keys are still released and the gesture's error wins", async () => {
		const post = vi.fn((keyCode: number, keyDown: boolean) => {
			if (!keyDown && keyCode === 59) {
				throw new Error("release failed");
			}
		});

		await expect(
			withHeldModifiers(["option", "control"], post, async () => {
				throw new Error("click failed");
			}),
		).rejects.toThrow("click failed");

		expect(post).toHaveBeenCalledWith(58, false, 0);
	});

	it("#when the gesture succeeds but a release fails #then the failure is reported after releasing the rest", async () => {
		const post = vi.fn((keyCode: number, keyDown: boolean) => {
			if (!keyDown && keyCode === 59) {
				throw new Error("release failed");
			}
		});

		await expect(withHeldModifiers(["option", "control"], post, async () => "done")).rejects.toThrow(
			"release failed",
		);

		expect(post).toHaveBeenCalledWith(58, false, 0);
	});

	it("#when a key cannot be pressed #then it and the keys already down are released, last first", async () => {
		const post = vi.fn((keyCode: number, keyDown: boolean, _flags: number) => {
			if (keyDown && keyCode === 56) {
				throw new Error("press failed");
			}
		});
		const gesture = vi.fn(async () => "done");

		await expect(withHeldModifiers(["command", "shift"], post, gesture)).rejects.toThrow("press failed");

		expect(gesture).not.toHaveBeenCalled();
		expect(post.mock.calls).toEqual([
			[55, true, COMMAND],
			[56, true, COMMAND | SHIFT],
			[56, false, COMMAND],
			[55, false, 0],
		]);
	});

	it("#when a key is sent but its post still throws #then that key goes back up too", async () => {
		const down = new Set<number>();
		const post = vi.fn((keyCode: number, keyDown: boolean, _flags: number) => {
			if (keyDown) down.add(keyCode);
			else down.delete(keyCode);
			if (keyDown && keyCode === 56) {
				throw new Error("cleanup after send failed");
			}
		});

		await expect(withHeldModifiers(["command", "shift"], post, async () => "done")).rejects.toThrow(
			"cleanup after send failed",
		);

		expect([...down]).toEqual([]);
	});

	it("#when no modifiers are given #then no key is posted and the gesture has no flags to stamp", async () => {
		const post = vi.fn<(keyCode: number, keyDown: boolean, flags: number) => void>();

		const result = await withHeldModifiers(undefined, post, async (flags) => flags);

		expect(result).toBeUndefined();
		expect(post).not.toHaveBeenCalled();
	});
});
