import { beforeEach, describe, expect, it } from "bun:test";
import { vi } from "@opencua/test-support";

const ffi = vi.hoisted(() => {
	type Ref = {
		readonly kind: "array" | "dictionary" | "number" | "string";
		readonly values?: readonly Ref[];
		readonly entries?: Readonly<Record<string, Ref>>;
		readonly value?: number | string;
	};
	const ref = {
		array: (...values: readonly Ref[]): Ref => ({ kind: "array", values }),
		dictionary: (entries: Readonly<Record<string, Ref>>): Ref => ({ kind: "dictionary", entries }),
		number: (value: number): Ref => ({ kind: "number", value }),
		string: (value: string): Ref => ({ kind: "string", value }),
	};
	const current = ref.dictionary({ ManagedSpaceID: ref.number(10), type: ref.number(0) });
	const regular = ref.dictionary({ ManagedSpaceID: ref.number(10), type: ref.number(0), uuid: ref.string("a") });
	const nested = ref.dictionary({ TileSpaces: ref.array(regular), WallSpace: regular });
	const secondCurrent = ref.dictionary({ id64: ref.number(20), type: ref.number(0) });
	const secondSpace = ref.dictionary({ id64: ref.number(20), type: ref.number(0) });
	const displays = ref.array(
		ref.dictionary({
			"Display Identifier": ref.string("display-a"),
			"Current Space": current,
			Spaces: ref.array(regular, nested),
		}),
		ref.dictionary({
			"Display Identifier": ref.string("display-b"),
			"Current Space": secondCurrent,
			Spaces: ref.array(secondSpace),
		}),
	);
	let managedResult: Ref | null = displays;
	/** What SLSCopySpacesForWindows answers per window id; a window missing here answers null. */
	const windowSpaces = new Map<number, Ref>();
	const sky = {
		SLSMainConnectionID: vi.fn(() => 7),
		SLSGetActiveSpace: vi.fn(() => 10),
		SLSCopyManagedDisplaySpaces: vi.fn(() => managedResult),
		SLSSpaceGetType: vi.fn(() => 0),
		SLSCopySpacesForWindows: vi.fn((_connection: number, _mask: number, windows: Ref) => {
			const [only] = windows.values ?? [];
			// Window ids are uint32; the binding hands them over as SInt32, so map the signed value back.
			return typeof only?.value === "number" ? (windowSpaces.get(only.value >>> 0) ?? null) : null;
		}),
	};
	const core = {
		CFRelease: vi.fn(),
	};
	const func = vi.fn((name: string) => {
		const symbol = name.startsWith("SLS") ? sky[name as keyof typeof sky] : core[name as keyof typeof core];
		if (symbol === undefined) throw new Error(`unexpected function: ${name}`);
		return symbol;
	});
	const koffi = {
		load: vi.fn((path: string) => (path.includes("SkyLight") ? { func } : { func })),
		pointer: vi.fn(() => ({})),
		opaque: vi.fn(() => ({})),
	};
	return {
		ref,
		sky,
		core,
		koffi,
		windowSpaces,
		get managedResult() {
			return managedResult;
		},
		set managedResult(value: Ref | null) {
			managedResult = value;
		},
	};
});

vi.mock("koffi", () => ffi.koffi);
vi.mock("./corefoundation.js", () => ({
	cfArrayLength: (reference: { values?: readonly unknown[] }) => reference.values?.length ?? 0,
	cfArrayValueAt: (reference: { values?: readonly unknown[] }, index: number) => reference.values?.[index] ?? null,
	cfDictionaryValue: (dictionary: { entries?: Readonly<Record<string, unknown>> }, key: { value: string }) =>
		dictionary.entries?.[key.value] ?? null,
	cfRelease: (reference: object | null) => ffi.core.CFRelease(reference),
	fromCFNumber: (reference: { value?: number }) => reference.value ?? 0,
	fromCFString: (reference: { value?: string }) => reference.value ?? "",
	isCFArray: (reference: { kind?: string }): boolean => reference.kind === "array",
	isCFDictionary: (reference: { kind?: string }): boolean => reference.kind === "dictionary",
	isCFNumber: (reference: { kind?: string }): boolean => reference.kind === "number",
	isCFString: (reference: { kind?: string }): boolean => reference.kind === "string",
	toCFInt32Number: (value: number) => ffi.ref.number(value),
	withCFArray: <T>(values: readonly unknown[], callback: (reference: unknown) => T): T =>
		callback({ kind: "array", values }),
	withCFString: <T>(value: string, callback: (reference: { value: string }) => T): T => callback({ value }),
}));

const { activeSpaceId, managedDisplaySpaces, parseWindowSpaceResults, spaceTypeFor, spacesForWindows } = await import(
	"./sls-spaces.js"
);

beforeEach(() => {
	ffi.windowSpaces.clear();
	ffi.sky.SLSCopySpacesForWindows.mockClear();
	ffi.managedResult = ffi.ref.array(
		ffi.ref.dictionary({
			"Display Identifier": ffi.ref.string("display-a"),
			"Current Space": ffi.ref.dictionary({ ManagedSpaceID: ffi.ref.number(10), type: ffi.ref.number(0) }),
			Spaces: ffi.ref.array(
				ffi.ref.dictionary({
					ManagedSpaceID: ffi.ref.number(10),
					type: ffi.ref.number(0),
					uuid: ffi.ref.string("a"),
				}),
				ffi.ref.dictionary({
					TileSpaces: ffi.ref.array(ffi.ref.dictionary({ ManagedSpaceID: ffi.ref.number(11) })),
				}),
			),
		}),
		ffi.ref.dictionary({
			"Display Identifier": ffi.ref.string("display-b"),
			"Current Space": ffi.ref.dictionary({ id64: ffi.ref.number(20), type: ffi.ref.number(0) }),
			Spaces: ffi.ref.array(ffi.ref.dictionary({ id64: ffi.ref.number(20), type: ffi.ref.number(0) })),
		}),
	);
});

describe("#given managed display dictionaries #when parsing spaces #then each display and regular space is returned", () => {
	it("maps two displays and skips nested tiled-space dictionaries", () => {
		expect(managedDisplaySpaces()).toEqual([
			{
				displayIdentifier: "display-a",
				currentSpaceId: 10,
				spaces: [{ id: 10, type: 0, uuid: "a" }],
			},
			{ displayIdentifier: "display-b", currentSpaceId: 20, spaces: [{ id: 20, type: 0 }] },
		]);
	});
});

describe("#given SkyLight returns no managed-space array #when queried #then an empty result is returned", () => {
	it("returns no displays and still exposes scalar query results", () => {
		ffi.managedResult = null;

		expect(managedDisplaySpaces()).toEqual([]);
		expect(activeSpaceId()).toBe(10);
		expect(spaceTypeFor(10)).toBe(0);
	});

	it("returns undefined when the active-space native query fails", () => {
		ffi.sky.SLSGetActiveSpace.mockImplementation(() => {
			throw new Error("native query failed");
		});

		expect(activeSpaceId()).toBeUndefined();
	});
});

describe("#given window IDs #when requesting their spaces #then each window is asked on its own with mask 7", () => {
	it("#given two windows on known spaces #when queried #then each maps to its own space list", () => {
		ffi.windowSpaces.set(123, ffi.ref.array(ffi.ref.number(10)));
		ffi.windowSpaces.set(456, ffi.ref.array(ffi.ref.number(20), ffi.ref.number(21)));

		expect(spacesForWindows([123, 456])).toEqual(
			new Map([
				[123, [10]],
				[456, [20, 21]],
			]),
		);
		expect(ffi.sky.SLSCopySpacesForWindows).toHaveBeenCalledTimes(2);
		expect(ffi.sky.SLSCopySpacesForWindows.mock.calls.map(([, mask]) => mask)).toEqual([7, 7]);
	});

	it("#given an unknown window, an empty list, or a non-array answer #when queried #then the window is left out", () => {
		ffi.windowSpaces.set(5, ffi.ref.array());
		ffi.windowSpaces.set(6, ffi.ref.number(10));

		expect(spacesForWindows([4, 5, 6])).toEqual(new Map());
	});

	it("#given a window id at or above 2^31 #when queried #then it still maps to its spaces", () => {
		ffi.windowSpaces.set(0x80000001, ffi.ref.array(ffi.ref.number(30)));

		expect(spacesForWindows([0x80000001])).toEqual(new Map([[0x80000001, [30]]]));
	});

	it("#given an invalid window id #when queried #then nothing is asked natively", () => {
		expect(spacesForWindows([0])).toEqual(new Map());
		expect(spacesForWindows([2 ** 32])).toEqual(new Map());
		expect(ffi.sky.SLSCopySpacesForWindows).not.toHaveBeenCalled();
	});

	it("maps injected per-window CF space lists to their window IDs", () => {
		expect(parseWindowSpaceResults([123, 456], [[10, 11], [20]])).toEqual(
			new Map([
				[123, [10, 11]],
				[456, [20]],
			]),
		);
	});
});
