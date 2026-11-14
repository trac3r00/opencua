import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DRAG_PANEL_BINARY, nativeDragPanel } from "./permission-drag.js";

describe("#given a checkout without a usable permission-drag binary #when the guide asks for the panel #then there is none and the guide falls back", () => {
	it("returns no panel when the binary is missing or not executable, without spawning anything", () => {
		const nativeDir = mkdtempSync(join(tmpdir(), "opencua-drag-"));
		try {
			const printed: string[] = [];
			const launcher = nativeDragPanel((text) => printed.push(text), nativeDir);

			expect(launcher.show("/Applications/opencua-mcp.app", "title")).toBeUndefined();

			writeFileSync(join(nativeDir, DRAG_PANEL_BINARY), "not a program");
			chmodSync(join(nativeDir, DRAG_PANEL_BINARY), 0o644);
			expect(launcher.show("/Applications/opencua-mcp.app", "title")).toBeUndefined();
			expect(printed).toEqual([]);
		} finally {
			rmSync(nativeDir, { recursive: true, force: true });
		}
	});
});
