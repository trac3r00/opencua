import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

// The opencua buddy: hold a key, ask about what is on screen, hear the answer and see the cursor point at the spot,
// or say "agent ..." to hand a task to a background agent that reports back when it is done.

export interface ScreenPoint {
	readonly x: number;
	readonly y: number;
	readonly label: string;
}

export interface BuddyReply {
	/** What is said out loud and printed, with the point tags removed. */
	readonly speech: string;
	/** Places to point at, in screen points (already scaled from screenshot pixels). */
	readonly points: readonly ScreenPoint[];
}

export interface ImageGeometry {
	/** Screenshot size in pixels. */
	readonly imageWidth: number;
	readonly imageHeight: number;
	/** Screen size in points, the space the cursor overlay draws in. */
	readonly screenWidth: number;
	readonly screenHeight: number;
}

/** A circle (lasso) or box the person drew to show what they mean, in screen points. */
export interface Mark {
	readonly kind: "lasso" | "box";
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

export function parseHudOutput(line: string): { readonly marks: readonly Mark[]; readonly cancelled: boolean } {
	const parsed = JSON.parse(line) as { marks?: unknown; cancelled?: unknown };
	const marks = Array.isArray(parsed.marks) ? parsed.marks.filter(isMark) : [];
	return { marks, cancelled: parsed.cancelled === true };
}

function isMark(value: unknown): value is Mark {
	if (typeof value !== "object" || value === null) return false;
	const mark = value as Record<string, unknown>;
	return (
		(mark["kind"] === "lasso" || mark["kind"] === "box") &&
		["x", "y", "width", "height"].every((key) => Number.isFinite(mark[key]))
	);
}

/** `--mark x,y,width,height` in screen points. */
export function parseMarkOption(value: string): Mark {
	const numbers = value.split(",").map((part) => Number(part.trim()));
	const [x, y, width, height] = numbers;
	if (
		numbers.length !== 4 ||
		x === undefined ||
		y === undefined ||
		width === undefined ||
		height === undefined ||
		!numbers.every(Number.isFinite) ||
		width <= 0 ||
		height <= 0
	) {
		throw new Error(`--mark takes x,y,width,height in screen points, got "${value}".`);
	}
	return { kind: "box", x, y, width, height };
}

function describeMarks(marks: readonly Mark[], geometry: ImageGeometry): string[] {
	if (marks.length === 0) return [];
	const scaleX = geometry.imageWidth / geometry.screenWidth;
	const scaleY = geometry.imageHeight / geometry.screenHeight;
	return [
		"While asking, they drew on the screen to show what they mean. Their question is about what is inside:",
		...marks.map((mark, index) => {
			const x = Math.round(mark.x * scaleX);
			const y = Math.round(mark.y * scaleY);
			const right = Math.round((mark.x + mark.width) * scaleX);
			const bottom = Math.round((mark.y + mark.height) * scaleY);
			return `- mark ${index + 1} (${mark.kind === "box" ? "a box" : "a circled area"}): pixels x ${x} to ${right}, y ${y} to ${bottom}`;
		}),
		"Words like 'this' or 'that' refer to the marked area.",
	];
}

const POINT_TAG = /\[POINT:\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*(?::\s*([^\]]*))?\]/g;

export interface AskContext {
	/** The screenshot file an agent CLI opens; undefined when the image is attached to the request. */
	readonly screenshotPath?: string | undefined;
	readonly marks?: readonly Mark[] | undefined;
	/** The language they spoke, such as Korean; the answer comes back in it. */
	readonly language?: string | undefined;
}

export function askPrompt(question: string, geometry: ImageGeometry, context: AskContext = {}): string {
	const size = `${geometry.imageWidth}x${geometry.imageHeight} pixels`;
	return [
		"You are opencua buddy, a friendly helper who lives on this person's Mac and sees their screen.",
		context.screenshotPath === undefined
			? `Their screen is the attached image (${size}). Look at it first.`
			: `Their screen is in the image file ${context.screenshotPath} (${size}). Read it first.`,
		"Answer their question about what is on screen out loud: short, warm, plain sentences that sound right spoken,",
		"no markdown, no lists. When the answer involves a place on screen (a button, a menu, a field, a word),",
		"point at it by adding a tag [POINT:x,y:label] where x,y are the pixel coordinates of its center in the image",
		"and label is 1 to 3 words. Use at most 3 tags, in the order they should click. Never guess a point you cannot see.",
		...describeMarks(context.marks ?? [], geometry),
		...(context.language === undefined ? [] : [`They spoke ${context.language}; answer in ${context.language}.`]),
		"",
		`Their question: ${question}`,
	].join("\n");
}

export function parseBuddyReply(text: string, geometry: ImageGeometry): BuddyReply {
	const scaleX = geometry.screenWidth / geometry.imageWidth;
	const scaleY = geometry.screenHeight / geometry.imageHeight;
	const points: ScreenPoint[] = [];
	for (const match of text.matchAll(POINT_TAG)) {
		const x = Number(match[1]);
		const y = Number(match[2]);
		if (x < 0 || y < 0 || x > geometry.imageWidth || y > geometry.imageHeight) continue;
		points.push({ x: Math.round(x * scaleX), y: Math.round(y * scaleY), label: (match[3] ?? "").trim() });
	}
	const speech = text
		.replace(POINT_TAG, "")
		.replace(/[ \t]+([.,!?])/g, "$1")
		.replace(/[ \t]{2,}/g, " ")
		.trim();
	return { speech, points };
}

export type Utterance =
	| { readonly kind: "agent"; readonly task: string }
	| { readonly kind: "ask"; readonly question: string };

const AGENT_PREFIX = /^\s*(?:(?:hey|ok|okay)[\s,]+)?(?:buddy[\s,]+)?(?:agent\b|에이전트)[\s,:.-]*/i;

/** "agent, book me a table" (or "hey buddy agent ...", "에이전트 ...") starts a background agent; anything else is a question. */
export function routeUtterance(text: string): Utterance | undefined {
	const trimmed = text.trim();
	if (trimmed.length === 0) return undefined;
	const agent = AGENT_PREFIX.exec(trimmed);
	if (agent !== null) {
		const task = trimmed.slice(agent[0].length).trim();
		return task.length === 0 ? undefined : { kind: "agent", task };
	}
	return { kind: "ask", question: trimmed };
}

export type JobStatus = "running" | "done" | "failed";

export interface BuddyJob {
	readonly id: string;
	readonly task: string;
	readonly status: JobStatus;
	readonly createdAt: string;
	readonly finishedAt?: string;
	readonly pid?: number;
	readonly summary?: string;
	/** The locale the request was spoken in, such as ko-KR. */
	readonly language?: string;
}

export function jobsRoot(stateDir: string): string {
	return join(stateDir, "buddy", "jobs");
}

export function createJob(root: string, task: string, now: Date = new Date(), language?: string): BuddyJob {
	const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
	const id = `${stamp}-${randomBytes(3).toString("hex")}`;
	const job: BuddyJob = {
		id,
		task,
		status: "running",
		createdAt: now.toISOString(),
		...(language ? { language } : {}),
	};
	mkdirSync(join(root, id, "output"), { recursive: true, mode: 0o700 });
	writeFileSync(join(root, id, "task.md"), `${task}\n`);
	writeJob(root, job);
	return job;
}

export function writeJob(root: string, job: BuddyJob): void {
	writeFileSync(join(root, job.id, "job.json"), `${JSON.stringify(job, null, "\t")}\n`);
}

export function readJob(root: string, id: string): BuddyJob {
	if (basename(id) !== id) throw new Error(`Invalid job id: ${id}`);
	return JSON.parse(readFileSync(join(root, id, "job.json"), "utf8")) as BuddyJob;
}

/** Newest first; a job whose process is gone without a result reads as failed. */
export function listJobs(root: string, isAlive: (pid: number) => boolean): readonly BuddyJob[] {
	let ids: string[];
	try {
		ids = readdirSync(root);
	} catch {
		return [];
	}
	const jobs: BuddyJob[] = [];
	for (const id of ids.sort().reverse()) {
		let job: BuddyJob;
		try {
			job = readJob(root, id);
		} catch {
			continue;
		}
		if (job.status === "running" && job.pid !== undefined && !isAlive(job.pid)) {
			job = { ...job, status: "failed", summary: "The agent process ended without a result." };
		}
		jobs.push(job);
	}
	return jobs;
}

export interface JobContext {
	/** The job runs in a connected app on its own computer, not in a folder on this Mac. */
	readonly remote?: boolean;
	readonly language?: string | undefined;
}

export function agentJobPrompt(task: string, context: JobContext = {}): string {
	return [
		"You are a helper opencua buddy started on this person's Mac to do one piece of work in the background.",
		"They asked by voice, so read their request for what they actually want, then do it.",
		context.remote === true
			? "You work on your own computer: say where each deliverable is, or include it in your reply."
			: "Your working folder is this job's home: put deliverables in output/ and nothing else there.",
		"Check what you make before you say it is done. Never invent facts, files or results.",
		"Do not send messages, post, delete their data or spend money; if the work needs that, stop and say so.",
		"Finish with a short, warm message that leads with the result, as it will be read in a notification.",
		...(context.language === undefined ? [] : [`They spoke ${context.language}; reply in ${context.language}.`]),
		"",
		`Their request: ${task}`,
	].join("\n");
}

export function summaryOf(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= 200 ? flat : `${flat.slice(0, 197)}...`;
}
