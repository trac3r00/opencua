import { describe, expect, it } from "bun:test";
import { vi } from "@opencua/test-support";

vi.mock("node:child_process", () => ({
	spawn: () => {
		throw new Error("A guest flush test attempted to start a process.");
	},
}));

const { flushGuestFileSystem } = await import("./isolated-server.js");

describe("#given an owned guest about to stop #when its desktop closes #then saved guest files are flushed first", () => {
	it("runs the guest's sync before shutdown and reports nothing when it succeeds", async () => {
		const execute = vi.fn(async (_args: readonly string[]) => Buffer.alloc(0));
		const report = vi.fn((_message: string) => undefined);

		await flushGuestFileSystem(async () => ({ execute }), report);

		expect(execute.mock.calls).toEqual([[["/bin/sync"]]]);
		expect(report).not.toHaveBeenCalled();
	});

	it("reports a failed flush with its reason instead of hiding it, and still lets shutdown proceed", async () => {
		const report = vi.fn((_message: string) => undefined);

		await flushGuestFileSystem(async () => {
			throw new Error("guest agent gone");
		}, report);

		expect(report).toHaveBeenCalledTimes(1);
		expect(report.mock.calls[0]?.[0]).toContain("guest agent gone");
	});
});
