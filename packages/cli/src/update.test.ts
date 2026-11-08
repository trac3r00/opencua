import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { InstallMarker } from "./layout.js";
import { classifyLocalChanges, gitIn, runUpdate, updateSource } from "./update.js";

const GIT_ENV = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "opencua test",
	GIT_AUTHOR_EMAIL: "test@example.invalid",
	GIT_COMMITTER_NAME: "opencua test",
	GIT_COMMITTER_EMAIL: "test@example.invalid",
};
const NATIVE_INPUTS = "packages/core/native/build-inputs.sha256";

/** The upstream, the author clone and the checkout, built once; every test works on its own copy of it. */
let template = "";
let root = "";
let author = "";
let checkout = "";

function git(cwd: string, ...args: string[]): string {
	const result = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	}
	return result.stdout.trim();
}

function writeFile(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

/** A new upstream commit with this version, made in a second clone and pushed. */
function publish(version: string, file = "README.md"): void {
	writeFile(join(author, "package.json"), `{ "version": "${version}" }\n`);
	writeFile(join(author, file), `${version}\n`);
	git(author, "add", "-A");
	git(author, "commit", "--quiet", "-m", `release ${version}`);
	git(author, "push", "--quiet", "origin", "HEAD:master");
}

function update(
	options: {
		readonly stamp?: string;
		readonly digest?: string;
		readonly marker?: InstallMarker;
		readonly rebuildKeepsGrants?: boolean;
	} = {},
) {
	const output: string[] = [];
	let setupRuns = 0;
	const helperApp = join(root, "opencua-mcp.app");
	if (options.stamp !== undefined) {
		writeFile(join(helperApp, "Contents/Resources/helper-inputs.sha256"), `${options.stamp}\n`);
	}
	const status = runUpdate(
		{ checkout, helperApp },
		{
			git: gitIn(checkout, GIT_ENV),
			marker: options.marker,
			runSetup: () => {
				setupRuns += 1;
				return 0;
			},
			helperDigest: () => options.digest,
			rebuildKeepsGrants: options.rebuildKeepsGrants ?? false,
			print: (text) => {
				output.push(text);
			},
		},
	);
	return { status, output: output.join("\n"), setupRuns };
}

beforeAll(() => {
	template = realpathSync(mkdtempSync(join(tmpdir(), "opencua-update-template-")));
	const upstream = join(template, "upstream.git");
	author = join(template, "author");
	git(template, "init", "--quiet", "--bare", "-b", "master", upstream);
	git(template, "clone", "--quiet", upstream, author);
	writeFile(join(author, NATIVE_INPUTS), "abc  build.sh\n");
	publish("0.1.0");
	git(template, "clone", "--quiet", upstream, join(template, "checkout"));
});

afterAll(() => {
	rmSync(template, { recursive: true, force: true });
});

/** Points the copy's clones at the copy's own upstream; the template path is the only thing git recorded about it. */
function retargetRemote(clone: string): void {
	const config = join(clone, ".git", "config");
	writeFileSync(config, readFileSync(config, "utf8").replaceAll(template, root));
}

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "opencua-update-")));
	cpSync(template, root, { recursive: true });
	author = join(root, "author");
	checkout = join(root, "checkout");
	retargetRemote(author);
	retargetRemote(checkout);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("#given git status output #when local changes are classified #then rebuilt native outputs do not block", () => {
	it("separates the binaries setup rebuilds from real local work", () => {
		const changes = classifyLocalChanges(
			` M packages/core/native/libsckit.dylib\n M ${NATIVE_INPUTS}\n M README.md\n?? notes.txt\n`,
		);

		expect(changes.derived).toEqual(["packages/core/native/libsckit.dylib", NATIVE_INPUTS]);
		expect(changes.blocking).toEqual([" M README.md", "?? notes.txt"]);
	});
});

describe("#given a checkout with local work #when it is updated #then the update is refused and nothing moves", () => {
	it("refuses uncommitted changes, names them, and neither fetches nor runs setup", () => {
		publish("0.1.1");
		writeFile(join(checkout, "README.md"), "my edit\n");
		const head = git(checkout, "rev-parse", "HEAD");

		const result = update();

		expect(result.status).toBe(1);
		expect(result.output).toMatch(/update refused: .* has local changes:\n {2} M README\.md/);
		expect(result.output).toContain("stash");
		expect(result.setupRuns).toBe(0);
		expect(git(checkout, "rev-parse", "HEAD")).toBe(head);
	});

	it("refuses commits the upstream does not have", () => {
		publish("0.1.1");
		writeFile(join(checkout, "local.txt"), "mine\n");
		git(checkout, "add", "-A");
		git(checkout, "commit", "--quiet", "-m", "local work");

		const result = update();

		expect(result.status).toBe(1);
		expect(result.output).toContain("cannot fast-forward");
		expect(result.setupRuns).toBe(0);
	});

	it("refuses a branch without an upstream and a directory that is not a checkout", () => {
		git(checkout, "checkout", "--quiet", "-b", "topic");

		expect(update().output).toContain("branch topic has no upstream");
		checkout = join(root, "not-a-checkout");
		mkdirSync(checkout);
		expect(update().output).toContain("is not a git checkout");
	});
});

describe("#given a clean checkout behind its upstream #when it is updated #then it fast-forwards and reruns setup", () => {
	it("moves to the new commit, runs setup once and prints old -> new version and commit", () => {
		const oldCommit = git(checkout, "rev-parse", "--short", "HEAD");
		publish("0.1.1");

		const result = update();
		const newCommit = git(checkout, "rev-parse", "--short", "HEAD");

		expect(result.status).toBe(0);
		expect(result.setupRuns).toBe(1);
		expect(newCommit).not.toBe(oldCommit);
		expect(result.output).toContain(`Updated opencua 0.1.0 (${oldCommit}) -> 0.1.1 (${newCommit}).`);
		expect(readFileSync(join(checkout, "package.json"), "utf8")).toContain("0.1.1");
	});

	it("does nothing when already up to date", () => {
		const result = update();

		expect(result.status).toBe(0);
		expect(result.setupRuns).toBe(0);
		expect(result.output).toMatch(/Already up to date: opencua 0\.1\.0/);
	});

	it("restores rebuilt native binaries first, since setup checks them again", () => {
		publish("0.1.1");
		writeFile(join(checkout, NATIVE_INPUTS), "rebuilt here\n");

		const result = update();

		expect(result.status).toBe(0);
		expect(result.output).toContain("Restoring rebuilt native binaries");
		expect(readFileSync(join(checkout, NATIVE_INPUTS), "utf8")).toBe("abc  build.sh\n");
	});

	it("warns that permissions will be asked again only when the helper's inputs change", () => {
		publish("0.1.1");
		const changed = update({ stamp: "built-from", digest: "now" });
		publish("0.1.2");
		const same = update({ stamp: "same", digest: "same" });

		expect(changed.output).toContain("macOS will ask for Screen Recording and Accessibility again");
		expect(same.output).not.toContain("ask for Screen Recording");
	});

	it("tells a stably signed install that the rebuilt helper keeps its grants", () => {
		publish("0.1.3");
		const result = update({ stamp: "built-from", digest: "now", rebuildKeepsGrants: true });

		expect(result.output).toContain("its permission grants stay");
		expect(result.output).not.toContain("ask for Screen Recording");
	});
});

describe("#given the checkout install.sh made #when its update source is read #then the installed ref wins", () => {
	it("updates from origin and the ref install.sh cloned", () => {
		const marker = { checkout, repo: "https://example.invalid/opencua.git", ref: "release" };

		expect(updateSource(gitIn(checkout, GIT_ENV), checkout, marker)).toEqual({
			remote: "origin",
			ref: "release",
			branch: "master",
		});
		expect(updateSource(gitIn(checkout, GIT_ENV), checkout, undefined)).toEqual({
			remote: "origin",
			ref: "master",
			branch: "master",
		});
	});
});
