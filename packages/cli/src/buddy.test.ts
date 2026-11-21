import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buddyAgentCommand } from "./buddy-commands.js";
import { DEFAULT_BUDDY_SETTINGS } from "./buddy-settings.js";
import { askPrompt, parseHudOutput, parseMarkOption } from "./buddy.js";
import { agentJobPrompt, createJob, listJobs, parseBuddyReply, readJob, routeUtterance, writeJob } from "./buddy.js";
import { needsHelperPermissions } from "./helper-route.js";

const RETINA = { imageWidth: 2880, imageHeight: 1800, screenWidth: 1440, screenHeight: 900 };

describe("parseBuddyReply #given an answer with point tags", () => {
	it("#when tags name image pixels #then points are scaled to screen points and tags leave the speech", () => {
		const reply = parseBuddyReply(
			"Click Save [POINT:2000,100:Save] then Share sheet [POINT:300,1700:Share sheet].",
			RETINA,
		);
		expect(reply.points).toEqual([
			{ x: 1000, y: 50, label: "Save" },
			{ x: 150, y: 850, label: "Share sheet" },
		]);
		expect(reply.speech).toBe("Click Save then Share sheet.");
	});

	it("#when a tag lies outside the image #then it is dropped rather than pointed at", () => {
		const reply = parseBuddyReply("Over there [POINT:5000,10:Nowhere]", RETINA);
		expect(reply.points).toEqual([]);
		expect(reply.speech).toBe("Over there");
	});

	it("#when there are no tags #then the speech is the answer unchanged", () => {
		expect(parseBuddyReply("That is a spreadsheet.", RETINA)).toEqual({
			speech: "That is a spreadsheet.",
			points: [],
		});
	});
});

describe("lasso marks #given what the person drew", () => {
	it("#when the HUD reports marks #then valid ones are kept and junk is dropped", () => {
		const parsed = parseHudOutput(
			'{"marks":[{"kind":"box","x":200,"y":300,"width":300,"height":150},{"kind":"pen","x":1,"y":1,"width":1,"height":1},{"kind":"lasso","x":"a"}],"cancelled":false}',
		);
		expect(parsed).toEqual({ marks: [{ kind: "box", x: 200, y: 300, width: 300, height: 150 }], cancelled: false });
		expect(parseHudOutput('{"marks":[],"cancelled":true}').cancelled).toBe(true);
	});

	it("#when marks reach the prompt #then they are given in screenshot pixels, the space the model reads", () => {
		const prompt = askPrompt("what is this?", RETINA, {
			screenshotPath: "/tmp/s.png",
			marks: [{ kind: "lasso", x: 100, y: 50, width: 40, height: 20 }],
		});
		expect(prompt).toContain("pixels x 200 to 280, y 100 to 140");
		expect(askPrompt("what is this?", RETINA, { screenshotPath: "/tmp/s.png" })).not.toContain("pixels x");
	});

	it("#when --mark is parsed #then it needs four numbers and a positive size", () => {
		expect(parseMarkOption("10, 20,30,40")).toEqual({ kind: "box", x: 10, y: 20, width: 30, height: 40 });
		for (const bad of ["1,2,3", "1,2,3,x", "1,2,0,4", "1,2,3,4,5"]) {
			expect(() => parseMarkOption(bad)).toThrow("--mark takes");
		}
	});
});

describe("routeUtterance #given a transcript", () => {
	it("#when it starts with the agent wake word #then the rest is the agent task", () => {
		expect(routeUtterance("Agent, find me three cafes nearby")).toEqual({
			kind: "agent",
			task: "find me three cafes nearby",
		});
		expect(routeUtterance("hey buddy agent summarize my downloads")).toEqual({
			kind: "agent",
			task: "summarize my downloads",
		});
		expect(routeUtterance("에이전트 오늘 일정 정리해줘")).toEqual({ kind: "agent", task: "오늘 일정 정리해줘" });
	});

	it("#when it is anything else #then it is a question; agent alone or silence does nothing", () => {
		expect(routeUtterance("where is the agent settings page")).toEqual({
			kind: "ask",
			question: "where is the agent settings page",
		});
		expect(routeUtterance("agent")).toBeUndefined();
		expect(routeUtterance("   ")).toBeUndefined();
	});
});

describe("prompts #given where the screen image is and what language was spoken", () => {
	it("#when an agent CLI answers #then it is pointed at the file; an app gets the image attached", () => {
		expect(askPrompt("hi", RETINA, { screenshotPath: "/tmp/s.jpg" })).toContain("image file /tmp/s.jpg (2880x1800");
		const attached = askPrompt("hi", RETINA);
		expect(attached).toContain("attached image (2880x1800 pixels)");
		expect(attached).not.toContain("image file");
	});

	it("#when the question was spoken in Korean #then the answer is asked for in Korean, and nothing is said otherwise", () => {
		expect(askPrompt("이게 뭐야?", RETINA, { language: "Korean" })).toContain("They spoke Korean; answer in Korean.");
		expect(askPrompt("what?", RETINA)).not.toContain("They spoke");
		expect(agentJobPrompt("정리해줘", { language: "Korean" })).toContain("reply in Korean");
	});

	it("#when a job runs in a connected app #then it is not told to use a folder on this Mac", () => {
		expect(agentJobPrompt("x")).toContain("output/");
		expect(agentJobPrompt("x", { remote: true })).not.toContain("output/");
	});
});

describe("agent jobs #given a jobs folder", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("#when jobs are created and finished #then they list newest first and a dead running job reads as failed", () => {
		const root = mkdtempSync(join(tmpdir(), "buddy-jobs-"));
		roots.push(root);
		const first = createJob(root, "older task", new Date("2026-11-20T01:00:00Z"));
		const second = createJob(root, "newer task", new Date("2026-11-20T02:00:00Z"));
		writeJob(root, { ...first, status: "done", summary: "made it" });
		writeJob(root, { ...second, pid: 424242 });
		writeFileSync(join(root, "stray-file"), "x");
		const jobs = listJobs(root, () => false);
		expect(jobs.map((job) => [job.task, job.status])).toEqual([
			["newer task", "failed"],
			["older task", "done"],
		]);
		expect(readJob(root, first.id).summary).toBe("made it");
		expect(() => readJob(root, "../escape")).toThrow("Invalid job id");
	});

	it("#when a job is asked for in Korean #then the language is kept for the agent that runs it", () => {
		const root = mkdtempSync(join(tmpdir(), "buddy-jobs-"));
		roots.push(root);
		const job = createJob(root, "정리해줘", new Date("2026-11-20T03:00:00Z"), "ko-KR");
		expect(readJob(root, job.id).language).toBe("ko-KR");
		expect(readJob(root, createJob(root, "plain").id).language).toBeUndefined();
	});
});

describe("buddy helper routing #given the buddy subcommands", () => {
	it("#when routed #then only ask runs in the permission helper, so listen and agent jobs never descend from it", () => {
		expect(needsHelperPermissions("buddy ask")).toBe(true);
		for (const path of [
			"buddy listen",
			"buddy agent",
			"buddy job-run",
			"buddy jobs",
			"buddy connect",
			"buddy apps",
			"buddy disconnect",
		]) {
			expect(needsHelperPermissions(path)).toBe(false);
		}
	});
});

describe("buddyAgentCommand #given the installed agent CLIs", () => {
	it("#when Claude Code is installed #then asks may only read and jobs may edit and browse but not run shell", () => {
		const exists = (path: string) => path === "/home/me/.local/bin/claude";
		const ask = buddyAgentCommand("ask", DEFAULT_BUDDY_SETTINGS, {}, exists, "/home/me");
		expect(ask.executable).toBe("/home/me/.local/bin/claude");
		expect(ask.args.slice(-2)).toEqual(["--allowedTools", "Read"]);
		const job = buddyAgentCommand(
			"job",
			DEFAULT_BUDDY_SETTINGS,
			{ OPENCUA_BUDDY_MODEL: "sonnet" },
			exists,
			"/home/me",
		);
		expect(job.args).toContain("sonnet");
		expect(job.args.at(-1)).toBe("Read,Write,Edit,Glob,Grep,WebSearch,WebFetch");
	});

	it("#when only an override is given #then it runs as a print-mode agent reading stdin", () => {
		expect(
			buddyAgentCommand("job", DEFAULT_BUDDY_SETTINGS, { OPENCUA_BUDDY_AGENT: "/opt/omo" }, () => false, "/h"),
		).toEqual({
			executable: "/opt/omo",
			args: ["--print", "--no-session", "-"],
		});
	});
});
