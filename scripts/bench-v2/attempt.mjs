import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cleanupAttempt } from "./cleanup.mjs";
import { PAGE, oracle, osa, safariUrlMatches, setup, textEditBodyLines } from "./fixture.mjs";
import { safariMatches } from "./oracle-server.mjs";

const ORACLE_SETTLE_MS = 3000;

export const errorClass = (error) => {
	const message = String(error);
	if (message.includes("server-exit")) return "server-exit";
	if (message.includes("protocol-error")) return "protocol-error";
	if (message.includes("timeout")) return "timeout";
	if (message.includes("tool-error")) return "tool-error";
	if (message.includes("target-missing") || message.includes("element-missing")) return "target-missing";
	return "driver-error";
};

export class AttemptRunner {
	constructor(probe, pageServer, beforeRun) {
		this.probe = probe;
		this.pageServer = pageServer;
		this.beforeRun = beforeRun;
		this.contexts = [];
	}
	async run(spec, driver, iteration) {
		const { probe, pageServer, beforeRun } = this;
		let pass = false;
		let error = null;
		let observation = "";
		let fixtureReady = false;
		let infraClass = null;
		let phase = "fixture";
		let before = null;
		let after = null;
		let baselineNonce = null;
		const pageUrl = `${pageServer.url}?attempt=${randomUUID()}`;
		this.contexts.push({ spec, pageUrl });
		let attemptSnapshot;
		try {
			attemptSnapshot = probe.snapshot();
			if (["text", "rich", "two-docs", "cross-app"].includes(spec.fixture)) {
				const textEdit = attemptSnapshot.apps.find((app) => app.bundle === "com.apple.TextEdit");
				if (
					attemptSnapshot.windows.some(
						// Off-screen records linger in the window server after TextEdit closes a document (it then
						// reports no documents and no accessibility windows), so only a visible window is open.
						(window) =>
							window.pid === textEdit?.pid &&
							window.onScreen !== false &&
							["document.txt", "other.txt", "rich.rtf"].includes(window.title),
					)
				)
					throw new Error("fixture document already open; refusing to close or reuse a pre-existing window");
			}
			setup(spec, pageUrl);
			if (["clipboard", "calculator", "cross-app"].includes(spec.fixture) || spec.oracle.kind === "clipboard")
				execFileSync("pbcopy", { input: "bench-v2-unset", timeout: 10000 });
			if (spec.fixture === "safari" || spec.fixture === "cross-app") {
				if (!(await pageServer.waitFor((state) => state?.page === pageUrl)))
					throw new Error("fixture page did not report load");
				baselineNonce = pageServer.state.nonce;
			}
			fixtureReady = true;
			before = probe.read();
			if (typeof driver.runTask === "function") {
				// An agent gets the whole task as one goal, so mid-plan fixture steps (a checkpoint, a window
				// move) have nowhere to interleave; the external oracle is unchanged.
				phase = "driver";
				observation = (await driver.runTask(spec, pageUrl)).answer;
			} else
				for (const step of spec.steps) {
					phase = step.op === "assert-text" || step.op === "move-window" ? "fixture" : "driver";
					if (step.op === "assert-text") {
						let actual;
						try {
							actual = osa('tell application "TextEdit" to get text of front document');
						} catch {
							// Off-console, TextEdit scripting times out; read the window's text with Vision instead.
							actual = textEditBodyLines().join("\n");
						}
						if (actual !== step.value)
							throw new Error(`oracle-checkpoint: expected ${step.value}, got ${actual}`);
					} else if (step.op === "move-window") {
						let position;
						try {
							position = osa(
								'tell application "System Events" to tell process "TextEdit" to get position of front window',
							);
						} catch {
							// Off-console System Events cannot reach TextEdit's windows, but the menu bar still works:
							// Window > Zoom changes the window's frame just the same, invalidating the observation.
							const textEdit = probe.snapshot().apps.find((app) => app.bundle === "com.apple.TextEdit");
							if (!textEdit) throw new Error("cannot move TextEdit window: TextEdit is not running");
							await probe.invokeMenu("com.apple.TextEdit", textEdit.pid, ["Window", "Zoom"]);
							continue;
						}
						const numbers = position.match(/\d+/g)?.map(Number);
						if (!numbers || numbers.length !== 2) throw new Error(`cannot move TextEdit window: ${position}`);
						osa(
							`tell application "System Events" to tell process "TextEdit" to set position of front window to {${numbers[0] + 18}, ${numbers[1] + 18}}`,
						);
					} else {
						const result = await driver.step(
							step.op === "type" && step.value === `file://${PAGE}` ? { ...step, value: pageUrl } : step,
						);
						if (step.op === "observe") observation = JSON.stringify(result);
					}
				}
		} catch (cause) {
			error = String(cause);
			if (phase === "fixture" && !error.includes("oracle-checkpoint")) infraClass = "fixture-infra";
		}
		if (before && driver.calls > 0) {
			try {
				after = probe.read();
			} catch (cause) {
				infraClass = "fixture-infra";
				error = `desktop-probe: ${String(cause)}`;
			}
		}
		try {
			if (fixtureReady && infraClass !== "fixture-infra" && !error?.includes("oracle-checkpoint")) {
				pass = oracle(spec, observation, pageUrl);
				// Apps finish a save or a rename asynchronously after the last keystroke, so wait a bounded
				// time for the same end state; nothing else is accepted, and a step error still fails.
				const settleUntil = performance.now() + ORACLE_SETTLE_MS;
				while (!pass && !error && performance.now() < settleUntil) {
					await new Promise((resolve) => setTimeout(resolve, 250));
					pass = oracle(spec, observation, pageUrl);
				}
				if (process.env.BENCH_TRACE === "1" && spec.oracle.kind.startsWith("safari-"))
					process.stderr.write(`ORACLE ${spec.id}: url-pass=${pass} state=${JSON.stringify(pageServer.state)}\n`);
				if (pass && spec.oracle.kind.startsWith("safari-"))
					pass = await pageServer.waitFor(
						(state) =>
							// The page reports its own href, which carries the #hash after a link click.
							typeof state?.page === "string" &&
							safariUrlMatches(state.page, pageUrl) &&
							safariMatches(spec.oracle.kind, spec.oracle.expected, state, baselineNonce),
					);
			}
		} catch (cause) {
			infraClass = "oracle-infra";
			error = `oracle-error: ${String(cause)}`;
		}
		const row = {
			iteration,
			scenario: spec.id,
			driver: driver.kind,
			pass,
			seconds: driver.seconds,
			calls: driver.calls,
			call_ms: driver.call_ms,
			disturbed_focus: before && after ? before.app !== after.app : null,
			disturbed_pointer: before && after ? Math.hypot(before.x - after.x, before.y - after.y) > 2 : null,
			text_bytes: driver.text_bytes,
			image_base64_bytes: driver.image_base64_bytes,
			image_tokens: driver.image_tokens,
			estimated_tokens: driver.estimated_tokens,
			error_class: infraClass ?? (error ? errorClass(error) : pass ? null : "oracle-mismatch"),
			error,
			gave_up:
				!pass &&
				!infraClass &&
				(driver.gave_up || ["timeout", "server-exit", "protocol-error"].includes(errorClass(error))),
			false_done: !pass && !infraClass && driver.claimed,
			human_ask: driver.human_ask,
			keyboard_fallbacks: driver.keyboard_fallbacks,
			...(driver.unverified_dispatches ? { unverified_dispatches: driver.unverified_dispatches } : {}),
			...(driver.agent ? { agent: driver.agent } : {}),
			...(driver.trace.length > 0 ? { trace: driver.trace } : {}),
		};
		row.cleanup = await cleanupAttempt(probe, attemptSnapshot ?? beforeRun, spec, pageUrl, beforeRun);
		return { row, pageUrl };
	}
}
