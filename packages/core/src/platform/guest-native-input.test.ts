import { describe, expect, it } from "bun:test";
import { runInNewContext } from "node:vm";
import { assertInputMayContinue, currentInputScope, runInInputScope } from "../computer/input-scope.js";
import { GuestNativeInput } from "./guest-native-input.js";

interface Event {
	kind: number;
	code?: number;
	down?: boolean;
	point?: { x: number; y: number };
	button?: number;
	flags: number;
	timestamp: number;
	fields: Record<number, number>;
}

function fixture(options: { model?: string; trusted?: boolean; failAt?: number } = {}) {
	const events: Event[] = [];
	const clipboard: string[] = [];
	let attempts = 0;
	let commands = 0;
	let hardwareChecks = 0;
	const event = (kind: number): Event => ({ kind, flags: -1, timestamp: -1, fields: {} });
	const bridge = Object.assign((value: string) => value, {
		AXIsProcessTrusted: () => options.trusted ?? true,
		CGEventSourceCreate: (state: number) => {
			expect(state).toBe(1);
			return {};
		},
		NSScreen: { mainScreen: { frame: { size: { width: 512, height: 384 } } } },
		NSPasteboard: {
			generalPasteboard: {
				clearContents: 0,
				setStringForType: (text: string) => {
					clipboard.push(text);
					return true;
				},
			},
		},
		NSPasteboardTypeString: "public.utf8-plain-text",
		CGPointMake: (x: number, y: number) => ({ x, y }),
		CGEventCreateMouseEvent: (_source: object, kind: number, point: { x: number; y: number }, button: number) => ({
			...event(kind),
			point,
			button,
		}),
		CGEventCreateKeyboardEvent: (_source: object, code: number, down: boolean) => ({
			...event(down ? 10 : 11),
			code,
			down,
		}),
		CGEventCreateScrollWheelEvent: (_source: object, unit: number, axes: number, y: number, x: number) => {
			expect([unit, axes]).toEqual([0, 2]);
			return { ...event(22), point: { x, y } };
		},
		CGEventSetIntegerValueField: (value: Event, field: number, number: number) => {
			value.fields[field] = number;
		},
		CGEventSetType: (value: Event, kind: number) => {
			value.kind = kind;
		},
		CGEventSetFlags: (value: Event, flags: number) => {
			value.flags = flags;
		},
		CGEventSetTimestamp: (value: Event, timestamp: number) => {
			value.timestamp = timestamp;
		},
		clock_gettime_nsec_np: () => 123456,
		CGEventPost: (tap: number, value: Event) => {
			expect(tap).toBe(0);
			attempts++;
			if (attempts === options.failAt) throw new Error("Injected dispatch failure");
			events.push(value);
		},
	});
	const input = new GuestNativeInput({
		async execute(args, script) {
			assertInputMayContinue(currentInputScope());
			commands++;
			expect(args).toEqual(["/usr/bin/osascript", "-l", "JavaScript"]);
			if (script === undefined) throw new Error("Missing guest script");
			runInNewContext(
				script,
				{
					Application: {
						currentApplication: () => ({
							doShellScript: () => {
								hardwareChecks++;
								return options.model ?? "VirtualMac2,1";
							},
						}),
					},
					ObjC: { import: () => undefined, bindFunction: () => undefined },
					$: bridge,
				},
				{ timeout: 5_000 },
			);
			return Buffer.alloc(0);
		},
	});
	return { input, events, clipboard, commands: () => commands, hardwareChecks: () => hardwareChecks };
}

describe("private guest native input", () => {
	it("#given the left button held #when the right button is pressed #then the left button is released first", async () => {
		const f = fixture();
		await f.input.pointer(10, 10, 1, 1024, 768);
		await f.input.pointer(10, 10, 4, 1024, 768);
		expect(f.events.map(({ kind, button }) => [kind, button])).toEqual([
			[1, 0],
			[2, 0],
			[3, 1],
		]);
	});

	it("#given a button held by a pointer event #when a pointer sequence runs #then it drags with that button and leaves nothing held", async () => {
		const f = fixture();
		await f.input.pointer(10, 10, 1, 1024, 768);
		await f.input.pointers(
			[
				{ x: 20, y: 20, buttons: 1 },
				{ x: 30, y: 30, buttons: 0 },
			],
			1024,
			768,
		);
		await f.input.pointer(40, 40, 0, 1024, 768);
		expect(f.events.map(({ kind }) => kind)).toEqual([1, 6, 2, 5]);
	});

	it("#given a verified virtual Mac #when more input follows #then the hardware check is not repeated", async () => {
		const f = fixture();
		await f.input.pointer(10, 10, 0, 1024, 768);
		await f.input.pointer(20, 20, 0, 1024, 768);
		await f.input.chord([0x61]);
		expect(f.commands()).toBe(3);
		expect(f.hardwareChecks()).toBe(1);
	});

	it("#given an untrusted guest #when readiness is checked #then input remains unavailable", async () => {
		const f = fixture({ trusted: false });
		await expect(f.input.checkPermissions()).rejects.toThrow("permission");
		expect(f.events).toEqual([]);
	});

	it("#given separate click sequences #when dispatching native events #then double-click counts reset", async () => {
		const f = fixture();
		f.input.beginPointerSequence();
		for (const mask of [1, 0, 1, 0]) await f.input.pointer(1, 1, mask, 10, 10);
		f.input.beginPointerSequence();
		for (const mask of [1, 0]) await f.input.pointer(1, 1, mask, 10, 10);
		expect(f.events.map(({ fields }) => fields[1])).toEqual([1, 1, 2, 2, 1, 1]);
	});

	it("#given a held guest modifier #when stopped #then only its release bypasses the stop", async () => {
		const f = fixture();
		await f.input.key(0xffe7, true);
		await runInInputScope({ interruption: () => "stop" }, async () => {
			await expect(f.input.key(0x61, true)).rejects.toThrow("stop");
			await f.input.key(0xffe7, false);
			await expect(f.input.key(0x62, false)).rejects.toThrow("not held");
		});
		expect(f.events.map(({ code, down, flags }) => [code, down, flags])).toEqual([
			[55, true, 0x100000],
			[55, false, 0],
		]);
	});

	it("#given a held guest button #when stopped #then release retains the last guest coordinates", async () => {
		const f = fixture();
		await f.input.pointer(100, 80, 1, 1024, 768);
		await runInInputScope({ interruption: () => "stop" }, async () => {
			await f.input.pointer(100, 80, 0, 1024, 768);
			await expect(f.input.pointer(100, 80, 0, 1024, 768)).rejects.toThrow("stop");
		});
		expect(f.events.map(({ kind, point }) => [kind, point])).toEqual([
			[1, { x: 50, y: 40 }],
			[2, { x: 50, y: 40 }],
		]);
	});

	it("#given physical hardware #when input is requested #then no native event is created", async () => {
		const f = fixture({ model: "MacBookPro18,1" });
		await expect(f.input.chord([0x61])).rejects.toThrow("virtual Mac");
		expect(f.events).toEqual([]);
	});

	it("#given missing guest permission #when input is requested #then dispatch is refused", async () => {
		const f = fixture({ trusted: false });
		await expect(f.input.chord([0x61])).rejects.toThrow("permission");
		expect(f.events).toEqual([]);
	});

	it("#given a scaled display #when dragging #then coordinates and release reach the guest", async () => {
		const f = fixture();
		await f.input.pointers(
			[
				{ x: 100, y: 80, buttons: 1 },
				{ x: 200, y: 160, buttons: 1 },
			],
			1024,
			768,
		);
		expect(f.events.map(({ kind, point, flags, timestamp }) => ({ kind, point, flags, timestamp }))).toEqual([
			{ kind: 1, point: { x: 50, y: 40 }, flags: 0, timestamp: 123456 },
			{ kind: 6, point: { x: 100, y: 80 }, flags: 0, timestamp: 123456 },
			{ kind: 2, point: { x: 100, y: 80 }, flags: 0, timestamp: 123456 },
		]);
	});

	it("#given a failed drag #when dispatch throws #then the held button is released", async () => {
		const f = fixture({ failAt: 2 });
		await expect(
			f.input.pointers(
				[
					{ x: 1, y: 1, buttons: 4 },
					{ x: 2, y: 2, buttons: 4 },
				],
				10,
				10,
			),
		).rejects.toThrow("Injected dispatch failure");
		expect(f.events.map(({ kind, button }) => [kind, button])).toEqual([
			[3, 1],
			[4, 1],
		]);
	});

	it("#given invalid coordinates #when a batch is requested #then nothing is dispatched", async () => {
		const f = fixture();
		await expect(
			f.input.pointers(
				[
					{ x: 1, y: 1, buttons: 1 },
					{ x: 10, y: 1, buttons: 0 },
				],
				10,
				10,
			),
		).rejects.toThrow("Invalid");
		expect(f.commands()).toBe(0);
	});

	it("#given a double click #when dispatched #then paired clicks have increasing counts", async () => {
		const f = fixture();
		await f.input.pointers(
			[1, 0, 1, 0].map((buttons) => ({ x: 1, y: 1, buttons })),
			10,
			10,
		);
		expect(f.events.map(({ fields }) => fields[1])).toEqual([1, 1, 2, 2]);
	});

	it("#given scrolling #when dispatched #then pixel axes preserve direction", async () => {
		const f = fixture();
		await f.input.pointers(
			[8, 16, 32, 64].map((buttons) => ({ x: 1, y: 1, buttons })),
			10,
			10,
		);
		expect(f.events.filter(({ kind }) => kind === 22).map(({ point, fields }) => [point, fields[88]])).toEqual([
			[{ x: 0, y: 40 }, 1],
			[{ x: 0, y: -40 }, 1],
			[{ x: 40, y: 0 }, 1],
			[{ x: -40, y: 0 }, 1],
		]);
	});

	it("#given Command-Space #when chorded #then the guest receives the Spotlight key codes", async () => {
		const f = fixture();
		await f.input.chord([0xffe7, 0x20]);
		expect(f.events.map(({ code, down, flags }) => [code, down, flags])).toEqual([
			[55, true, 0x100000],
			[49, true, 0x100000],
			[49, false, 0x100000],
			[55, false, 0],
		]);
	});

	it.each([0xffe8, 0xffeb, 0xffec])(
		"#given Command sent as RFB keysym %s #when chorded with s #then the guest receives Command-S",
		async (command) => {
			const f = fixture();
			await f.input.chord([command, 0x73]);
			expect(f.events.map(({ code, down, flags }) => [code, down, flags])).toEqual([
				[55, true, 0x100000],
				[1, true, 0x100000],
				[1, false, 0x100000],
				[55, false, 0],
			]);
		},
	);

	it("#given a failed chord #when dispatch throws #then every pressed key is released", async () => {
		const f = fixture({ failAt: 2 });
		await expect(f.input.chord([0xffe7, 0x76])).rejects.toThrow("Injected dispatch failure");
		expect(f.events.map(({ code, down, flags }) => [code, down, flags])).toEqual([
			[55, true, 0x100000],
			[9, false, 0x100000],
			[55, false, 0],
		]);
	});

	it("#given Unicode and script-like text #when pasted #then text remains data in the guest clipboard", async () => {
		const f = fixture();
		const text = "한글 日本語 😀\n\"); throw new Error('injected'); //";
		await f.input.paste(text);
		expect(f.clipboard).toEqual([text]);
		expect(f.events.map(({ code, down }) => [code, down])).toEqual([
			[55, true],
			[9, true],
			[9, false],
			[55, false],
		]);
	});

	it.each([0x41, 0x123456])(
		"#given unsupported keysym %s #when requested #then the transport is not called",
		async (keysym) => {
			const f = fixture();
			await expect(f.input.chord([keysym])).rejects.toThrow("Unsupported");
			expect(f.commands()).toBe(0);
		},
	);
});
