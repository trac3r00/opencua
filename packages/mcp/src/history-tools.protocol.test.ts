import { afterEach, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type HistorySkillDetection, type HistorySkillDraft, detectHistorySkillCandidates } from "@opencua/core";
import { vi } from "@opencua/test-support";
import { z } from "zod/v4";
import {
	type HistoryMemoryFile,
	type HistoryObservationSettings,
	type HistoryStatus,
	type HistoryTimeline,
	type HistoryToolSource,
	registerHistoryTools,
} from "./history-tools.js";
import { createHarness } from "./protocol-client-harness.js";
import { HISTORY_TOOL_NAMES, toolNamesFor } from "./tool-names.js";

const DEFAULTS: HistoryObservationSettings = {
	defaultApplicationBehavior: "observe",
	defaultURLBehavior: "observe",
	observePrivateBrowsing: false,
	rules: [],
};

class FakeHistory implements HistoryToolSource {
	state: HistoryStatus["state"] = "running";
	settings: HistoryObservationSettings = DEFAULTS;

	status(): HistoryStatus {
		return {
			state: this.state,
			eventStreamRootPath: "/root",
			summariesPath: "/summaries",
			memoriesPath: "/root/memories",
			retentionHours: 6,
			currentSegmentId: "2026-10-29T04-00-00Z",
		};
	}

	getSettings(): HistoryObservationSettings {
		return this.settings;
	}

	updateSettings(settings: HistoryObservationSettings): HistoryObservationSettings {
		this.settings = settings;
		return this.settings;
	}

	pause(): void {
		this.state = "paused";
	}

	resume(): void {
		this.state = "running";
	}

	saved: HistorySkillDraft[] = [];

	async suggestSkills(options: { readonly limit: number }): Promise<HistorySkillDetection> {
		// A repeated Mail send with different recipients and subjects, in two recording sessions.
		const mail = { name: "Mail", bundleIdentifier: "com.apple.mail" };
		const typed = (field: string, text: string) => ({
			kind: "keyboard.text_input",
			timestamp: "2026-11-01T10:00:00Z",
			app: mail,
			keyboard: { text },
			element: { role: "AXTextField", title: field },
		});
		const send = {
			kind: "keyboard.shortcut",
			timestamp: "2026-11-01T10:00:00Z",
			app: mail,
			keyboard: { keyEquivalent: "d", modifiers: ["command", "shift"] },
		};
		const flow = (to: string, subject: string) => [typed("To", to), typed("Subject", subject), send];
		return detectHistorySkillCandidates(
			[
				{ id: "2026-11-01T10-00-00Z", events: [...flow("ann@x.io", "Invoice 1"), ...flow("bo@x.io", "Invoice 2")] },
				{ id: "2026-11-02T10-00-00Z", events: flow("cy@x.io", "Invoice 3") },
			],
			options,
		);
	}

	async saveSkill(draft: HistorySkillDraft): Promise<string> {
		this.saved.push(draft);
		return `/skills/${draft.name}/SKILL.md`;
	}

	timelineCalls: { readonly day?: string; readonly limit: number }[] = [];
	memories: HistoryTimeline["entries"] = [];

	async timeline(options: { readonly day?: string; readonly limit: number }): Promise<HistoryTimeline> {
		this.timelineCalls.push(options);
		return { memoriesPath: "/root/memories", entries: this.memories.slice(0, options.limit), skipped: 0 };
	}

	async readMemory(path: string): Promise<HistoryMemoryFile> {
		if (path !== "2026-11-23/0930-invoices.md") throw new Error(`No memory ${path}`);
		return { path, bytes: 6, truncated: false, text: "# Paid" };
	}
}

async function connect(source: HistoryToolSource): Promise<Client> {
	const server = new McpServer({ name: "test", version: "0.0.0" });
	registerHistoryTools(server, source);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test-client", version: "0.0.0" });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return client;
}

function payload(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
	const content = z.array(z.looseObject({ type: z.string(), text: z.string().optional() })).parse(result.content);
	const text = content.find((item) => item.type === "text")?.text ?? "{}";
	return z.record(z.string(), z.unknown()).parse(JSON.parse(text));
}

describe("#given cua-history tools #when status is called #then it returns state and paths", () => {
	it("reports the state, segment root, and summaries path", async () => {
		const client = await connect(new FakeHistory());
		const result = payload(await client.callTool({ name: "cua_history_status", arguments: {} }));
		expect(result).toMatchObject({ state: "running", eventStreamRootPath: "/root", retentionHours: 6 });
	});
});

describe("#given a running recorder #when pause then resume are called #then the state flips and back", () => {
	it("pauses and resumes", async () => {
		const client = await connect(new FakeHistory());
		expect(payload(await client.callTool({ name: "cua_history_pause", arguments: {} }))["state"]).toBe("paused");
		expect(payload(await client.callTool({ name: "cua_history_resume", arguments: {} }))["state"]).toBe("running");
	});
});

describe("#given new settings #when update_settings is called #then the whole document is replaced", () => {
	it("replaces settings and reads them back", async () => {
		const fake = new FakeHistory();
		const client = await connect(fake);
		const next: HistoryObservationSettings = {
			defaultApplicationBehavior: "do_not_observe",
			defaultURLBehavior: "observe",
			observePrivateBrowsing: false,
			rules: [{ scope: "app", bundleID: "com.apple.Terminal", behavior: "observe" }],
		};

		await client.callTool({ name: "cua_history_update_settings", arguments: next });
		const read = payload(await client.callTool({ name: "cua_history_get_settings", arguments: {} }));
		expect(read).toMatchObject({ defaultApplicationBehavior: "do_not_observe" });
		expect(fake.settings.rules).toHaveLength(1);
	});

	it("rejects an invalid rule scope", async () => {
		const client = await connect(new FakeHistory());
		const result = await client.callTool({
			name: "cua_history_update_settings",
			arguments: {
				defaultApplicationBehavior: "observe",
				defaultURLBehavior: "observe",
				observePrivateBrowsing: false,
				rules: [{ scope: "folder", bundleID: "x", behavior: "observe" }],
			},
		});
		expect(result.isError).toBe(true);
	});
});

describe("#given repeated recorded workflows #when suggest_skills is called #then candidates come back inline", () => {
	it("returns a numbered candidate with readable steps and next-step guidance", async () => {
		const client = await connect(new FakeHistory());
		const result = payload(await client.callTool({ name: "cua_history_suggest_skills", arguments: { limit: 3 } }));
		expect(result["candidates"]).toEqual([
			expect.objectContaining({
				number: 1,
				occurrences: 3,
				apps: ["Mail"],
				steps: [
					expect.stringContaining("to"),
					expect.stringContaining("subject"),
					expect.stringContaining("shift+cmd+d"),
				],
			}),
		]);
		const text = JSON.stringify(result);
		for (const typedValue of ["ann@x.io", "Invoice 2", "cy@x.io"]) expect(text).not.toContain(typedValue);
		expect(String(result["next"])).toContain("cua_history_save_skill");
	});
});

describe("#given a description a small model wrote earlier #when suggest_skills is called #then the candidate carries it", () => {
	it("returns the model's name, title and summary next to the raw steps", async () => {
		const fake = new FakeHistory();
		const id = (await fake.suggestSkills({ limit: 1 })).candidates[0]?.id ?? "";
		const description = {
			name: "invoice-to-ledger",
			title: "Move an invoice into the ledger",
			summary: "Opens the invoice, the ledger and a mail draft in turn.",
			whenToUse: "When an invoice arrives.",
		};
		const described = Object.assign(fake, { skillDescriptions: async () => ({ [id]: description }) });
		const client = await connect(described);
		const result = payload(await client.callTool({ name: "cua_history_suggest_skills", arguments: { limit: 1 } }));
		expect(result["candidates"]).toEqual([
			expect.objectContaining({ proposedName: "invoice-to-ledger", description, steps: expect.any(Array) }),
		]);
	});
});

describe("#given an approved draft #when save_skill is called #then the source saves it and returns the path", () => {
	it("saves valid drafts and rejects an invalid name", async () => {
		const fake = new FakeHistory();
		const client = await connect(fake);
		const draft = { name: "invoice-ledger", description: "Copy invoice totals into the ledger", body: "# Steps" };
		expect(payload(await client.callTool({ name: "cua_history_save_skill", arguments: draft }))["path"]).toBe(
			"/skills/invoice-ledger/SKILL.md",
		);
		const bad = await client.callTool({ name: "cua_history_save_skill", arguments: { ...draft, name: "Bad Name" } });
		expect(bad.isError).toBe(true);
		expect(fake.saved).toEqual([draft]);
	});
});

describe("#given memories #when cua_history_timeline is called #then entries come back with the default limit", () => {
	it("passes day and the default limit through and returns the entries", async () => {
		const fake = new FakeHistory();
		fake.memories = [
			{ path: "2026-11-23/0930-invoices.md", title: "Invoices", apps: ["Safari"], segments: [], summary: "Paid." },
		];
		const client = await connect(fake);

		const result = payload(await client.callTool({ name: "cua_history_timeline", arguments: { day: "2026-11-23" } }));

		expect(fake.timelineCalls).toEqual([{ day: "2026-11-23", limit: 20 }]);
		expect(result).toMatchObject({ memoriesPath: "/root/memories", entries: fake.memories, skipped: 0 });
		expect(result["next"]).toBeUndefined();
	});

	it("points at the raw segments when there are no memories", async () => {
		const client = await connect(new FakeHistory());
		const result = payload(await client.callTool({ name: "cua_history_timeline", arguments: { limit: 5 } }));
		expect(result["entries"]).toEqual([]);
		expect(String(result["next"])).toContain("cua_history_status");
	});

	it("rejects a malformed day and an out-of-range limit", async () => {
		const fake = new FakeHistory();
		const client = await connect(fake);
		expect((await client.callTool({ name: "cua_history_timeline", arguments: { day: "../x" } })).isError).toBe(true);
		expect((await client.callTool({ name: "cua_history_timeline", arguments: { limit: 101 } })).isError).toBe(true);
		expect(fake.timelineCalls).toEqual([]);
	});
});

describe("#given a memory path #when cua_history_read_memory is called #then the file or the refusal comes back", () => {
	it("returns the memory text and surfaces a refused path as an error", async () => {
		const client = await connect(new FakeHistory());
		const read = payload(
			await client.callTool({ name: "cua_history_read_memory", arguments: { path: "2026-11-23/0930-invoices.md" } }),
		);
		expect(read).toEqual({ path: "2026-11-23/0930-invoices.md", bytes: 6, truncated: false, text: "# Paid" });
		const refused = await client.callTool({ name: "cua_history_read_memory", arguments: { path: "../state.json" } });
		expect(refused.isError).toBe(true);
	});
});

describe("#given the OPENCUA_HISTORY gate #when the server lists tools #then history tools appear only when it is on", () => {
	const cleanup: (() => Promise<void>)[] = [];
	afterEach(async () => {
		vi.unstubAllEnvs();
		for (const close of cleanup.splice(0)) await close();
	});

	it.each(["0", "1"])("lists exactly the gated tool names for OPENCUA_HISTORY=%s", async (flag) => {
		vi.stubEnv("OPENCUA_HISTORY", flag);
		vi.stubEnv("OPENCUA_UTM", "0");
		vi.stubEnv("OPENCUA_BROWSER", "off");
		const harness = await createHarness(undefined, undefined, undefined, {
			serverOptions: { toolset: "lean", iphone: false },
		});
		cleanup.push(harness.close);
		const names = (await harness.client.listTools()).tools.map((tool) => tool.name);
		expect(names.sort()).toEqual([...toolNamesFor("lean", false, false, false, flag === "1")].sort());
		for (const name of HISTORY_TOOL_NAMES) expect(names.includes(name)).toBe(flag === "1");
		expect(names.includes("cua_history_timeline")).toBe(flag === "1");
	});
});
