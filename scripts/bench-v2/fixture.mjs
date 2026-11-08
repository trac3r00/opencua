import { execFileSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";

export const ROOT = "/tmp/cua-bench";
export const FILE = path.join(ROOT, "document.txt");
export const SECOND = path.join(ROOT, "other.txt");
export const RICH = path.join(ROOT, "rich.rtf");
export const PAGE = path.join(ROOT, "page.html");
export const STAGING = path.join(ROOT, "start");
// Starts with a capital: TextEdit auto-capitalizes typed sentences, which made a lowercase marker fail.
export const TARGET = "Bench-v2 marker 8c52";

const WINDOW_TEXT_SCRIPT = new URL("./window-text.swift", import.meta.url).pathname;

/**
 * Text Vision reads in an app's largest on-screen window, captured by the harness itself; with a
 * title, only a window whose title contains it, so a leftover document cannot answer for another.
 */
export function windowText(owner, title) {
	return execFileSync("swift", [WINDOW_TEXT_SCRIPT, owner, ...(title ? [title] : [])], {
		encoding: "utf8",
		timeout: 60000,
	});
}

/**
 * The body lines of TextEdit's front document window as Vision reads them, without the title line.
 * Used when AppleScript cannot answer (off the physical console, TextEdit scripting times out), so
 * the check still reads the app's real state rather than the driver's report.
 */
export function textEditBodyLines(title = "document.txt") {
	return windowText("TextEdit", title)
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith(title));
}

/**
 * True when `text` appears in the RTF with bold on: the last bold control word before it is `\b`
 * or `\b1`, not `\b0`. RTF control words end at any non-letter, so `\b\fs24` is bold on too.
 */
export function rtfTextIsBold(rtf, text) {
	const at = rtf.indexOf(text);
	if (at < 0) return false;
	const toggles = [...rtf.slice(0, at).matchAll(/\\b(0|1)?(?![a-z])/g)];
	const last = toggles.at(-1);
	return last !== undefined && last[1] !== "0";
}
export const PAGE_HEADING = "Local benchmark 8c52";
export const exec = (command, args, options = {}) =>
	execFileSync(command, args, { encoding: "utf8", timeout: 10000, killSignal: "SIGKILL", ...options }).trim();
export const osa = (script) => exec("osascript", ["-e", script]);

/**
 * `open`, retried while LaunchServices still reports the app as quitting (error -600): the previous
 * attempt's cleanup quit it moments ago, and opening into a half-quit app fails.
 */
function openFixture(args) {
	for (let attempt = 1; ; attempt++) {
		try {
			return exec("open", args);
		} catch (error) {
			if (attempt >= 8 || !String(error).includes("-600")) throw error;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
		}
	}
}

export function validateFixture(spec) {
	if (!/^[a-z][a-z0-9-]+$/.test(spec.id)) throw new Error(`invalid id: ${spec.id}`);
	if (!["text", "rich", "finder", "safari", "settings", "calculator", "two-docs", "cross-app"].includes(spec.fixture))
		throw new Error(`invalid fixture: ${spec.id}`);
	if (!Array.isArray(spec.steps) || !spec.steps.length || !spec.oracle?.kind)
		throw new Error(`missing steps/oracle: ${spec.id}`);
	for (const step of spec.steps) {
		if (
			!["observe", "key", "type", "click-label", "menu", "scroll", "move-window", "assert-text"].includes(step.op) ||
			!["TextEdit", "Finder", "Safari", "System Settings", "Calculator"].includes(step.app) ||
			(step.op === "scroll" &&
				(!["up", "down", "left", "right"].includes(step.direction) ||
					(step.amount !== undefined && !(Number.isInteger(step.amount) && step.amount > 0))))
		)
			throw new Error(`invalid step: ${spec.id}`);
		if (step.value?.includes("/tmp/") && !step.value.includes(ROOT)) throw new Error(`unsafe path: ${spec.id}`);
	}
	if (
		![
			"file",
			"clipboard",
			"finder-path",
			"finder-name",
			"finder-selected",
			"safari-heading",
			"safari-field",
			"safari-link",
			"settings",
			"calculator",
			"rich-bold",
			"alert-dismiss",
			"two-docs",
			"two-apps",
			"save-sheet",
		].includes(spec.oracle.kind)
	)
		throw new Error(`invalid oracle: ${spec.id}`);
	return true;
}

export function ensureFixtureRoot() {
	mkdirSync(ROOT, { recursive: true });
	if (
		lstatSync(ROOT).isSymbolicLink() ||
		[FILE, SECOND, RICH, PAGE, STAGING].some((file) => lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink())
	)
		throw new Error("fixture path is a symlink; refusing writes outside /tmp/cua-bench");
}

export function setup(spec, pageUrl) {
	ensureFixtureRoot();
	rmSync(path.join(ROOT, "bench-folder"), { recursive: true, force: true });
	rmSync(path.join(ROOT, "renamed.txt"), { force: true });
	rmSync(path.join(ROOT, "saved-from-sheet.txt"), { force: true });
	// A failed Finder attempt can leave half-renamed files ("renamed.txt.txt") or new folders it never
	// named ("untitled folder 2", a partly typed "bench-f"); they would change what the next attempt sees.
	for (const entry of readdirSync(ROOT))
		if (/^(renamed|untitled folder|bench-f|saved-from-sheet)/.test(entry))
			rmSync(path.join(ROOT, entry), { recursive: true, force: true });
	mkdirSync(STAGING, { recursive: true });
	writeFileSync(FILE, spec.initial ?? "");
	writeFileSync(SECOND, "other document unchanged");
	writeFileSync(RICH, "{\\rtf1\\ansi\\deff0 plain text}");
	writeFileSync(
		PAGE,
		`<!doctype html><html><body><h1>${PAGE_HEADING}</h1><label>Code <input id="code"></label><a href="#destination" id="link">Destination</a><h2 id="destination">Destination reached</h2></body></html>`,
	);
	if (spec.fixture === "finder") {
		openFixture([spec.id === "finder-navigate" ? STAGING : ROOT]);
	} else if (spec.fixture === "safari") {
		openFixture(["-a", "Safari", pageUrl]);
	} else if (spec.fixture === "settings") {
		openFixture(["-a", "System Settings"]);
	} else if (spec.fixture === "calculator") {
		openFixture(["-a", "Calculator"]);
	} else {
		openFixture(["-e", spec.fixture === "rich" ? RICH : FILE]);
		if (spec.fixture === "two-docs") {
			openFixture(["-e", SECOND]);
			osa('tell application "TextEdit" to set index of window "document.txt" to 1');
		}
		if (spec.fixture === "cross-app") openFixture(["-a", "Safari", pageUrl]);
		if (spec.id === "two-apps-one-task") openFixture([STAGING]);
	}
	// Activating is fixture setup, never charged to a driver.
	const app =
		{ finder: "Finder", safari: "Safari", settings: "System Settings", calculator: "Calculator" }[spec.fixture] ??
		"TextEdit";
	osa(`tell application "${app}" to activate`);
	if (spec.id === "finder-select-file") {
		osa('tell application "System Events" to key code 53');
		// Clearing the selection is the fixture reset; the oracle checks it after the click.
	}
}

export const safariUrlMatches = (actual, expected) => {
	const url = new URL(actual);
	url.hash = "";
	return url.href === expected;
};

export function oracle(spec, observation, pageUrl) {
	const { kind, expected } = spec.oracle;
	switch (kind) {
		case "file":
			return readFileSync(spec.fixture === "rich" ? RICH : FILE, "utf8").trim() === expected;
		case "save-sheet": {
			// No file means the driver never saved: a failed task, not an oracle that could not run.
			const saved = path.join(ROOT, "saved-from-sheet.txt");
			return existsSync(saved) && readFileSync(saved, "utf8").trim() === expected;
		}
		case "clipboard":
			return exec("pbpaste", []) === expected;
		case "finder-path":
			return (
				realpathSync(osa('tell application "Finder" to get POSIX path of (target of front window as alias)')) ===
				realpathSync(expected)
			);
		case "finder-name":
			return (
				existsSync(path.join(ROOT, expected)) &&
				(expected !== "bench-folder" || lstatSync(path.join(ROOT, expected)).isDirectory()) &&
				(expected !== "renamed.txt" || !existsSync(FILE))
			);
		case "finder-selected": {
			const selected = osa(
				'tell application "Finder"\nset chosen to selection\nif (count of chosen) is 0 then return ""\nreturn POSIX path of (item 1 of chosen as alias)\nend tell',
			);
			// Finder answers with the resolved path (/private/tmp/...); /tmp is a symlink, so compare the
			// real paths of both, as finder-path does. The unresolved comparison could never pass.
			return selected !== "" && realpathSync(selected) === realpathSync(path.join(ROOT, expected));
		}
		case "safari-heading":
		case "safari-field":
		case "safari-link": {
			// The attempt's URL is unique (it carries the attempt id), so any Safari document showing it is
			// this attempt's page; "front document" could be another window left over from an earlier run.
			const urls = osa('tell application "Safari" to get URL of every document')
				.split(", ")
				.map((url) => url.trim())
				.filter((url) => url.startsWith("http"));
			return urls.some((url) => safariUrlMatches(url, pageUrl));
		}
		case "settings":
			// Read the Settings window itself rather than the driver's observation or AppleScript, which
			// macOS refuses without an automation grant: the About pane must show this Mac's version.
			return windowText("System Settings").includes(exec("sw_vers", ["-productVersion"]));
		case "calculator":
			return exec("pbpaste", []) === expected;
		case "rich-bold":
			return rtfTextIsBold(readFileSync(RICH, "utf8"), TARGET);
		case "alert-dismiss": {
			if (readFileSync(FILE, "utf8") !== "do not save") return false;
			try {
				return (
					osa('tell application "TextEdit" to get name of front window') === "document.txt" &&
					!osa(
						'tell application "System Events" to tell process "TextEdit" to get name of every sheet of front window',
					).includes("Save")
				);
			} catch {
				// Off-console, window scripting fails; read the window itself: the document is still open
				// with the typed text and no keep-changes alert over it.
				const text = windowText("TextEdit", "document.txt");
				return (
					text.includes("document.txt") &&
					text.includes(TARGET) &&
					!/keep changes|Don.t Save|Revert Changes/i.test(text)
				);
			}
		}
		case "two-docs":
			return (
				readFileSync(FILE, "utf8").trim() === expected &&
				readFileSync(SECOND, "utf8") === "other document unchanged"
			);
		case "two-apps":
			return (
				readFileSync(FILE, "utf8").trim() === expected &&
				realpathSync(osa('tell application "Finder" to get POSIX path of (target of front window as alias)')) ===
					realpathSync(ROOT)
			);
		default:
			throw new Error(`unknown oracle: ${kind}`);
	}
}
