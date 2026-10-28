import assert from "node:assert/strict";
import test from "node:test";
import { verifyFreshCalculator } from "./verify-fresh-calculator.mjs";

function cohort() {
	return {
		finished_at: "2026-10-11",
		runs: 30,
		fixture_lifecycle: "fresh owned process per attempt; AX window ready before timing",
		results: Array.from({ length: 60 }, (_, index) => ({
			route: index % 2 ? "cua" : "apple",
			iteration: Math.floor(index / 2) + 1,
			scenario: "calculator-add",
			pass: false,
			e2e_seconds: 1,
			cleanup: { pid: index + 1, verified: true },
			focus_disturbance: false,
			pointer_disturbance: false,
			disturbance_trace: { max_cursor_px: 0, activations: [] },
		})),
	};
}

test("#given fresh Calculator attempts #when verifying #then retains failures and verifies all distinct terminations", () => {
	const verified = verifyFreshCalculator(cohort());
	assert.equal(verified.verified_distinct_process_terminations, 60);
	assert.equal(verified.counts.apple.completed, 0);
	assert.equal(verified.counts.cua.attempts, 30);
});

test("#given invalid process or oracle evidence #when verifying #then rejects the cohort", () => {
	for (const mutate of [
		(row) => {
			row.cleanup.pid = 2;
		},
		(row) => {
			row.cleanup.verified = false;
		},
		(row) => {
			row.e2e_seconds = null;
		},
		(row) => {
			row.disturbance_trace.max_cursor_px = undefined;
		},
		(row) => {
			row.pass = true;
		},
	]) {
		const report = cohort();
		mutate(report.results[0]);
		assert.throws(() => verifyFreshCalculator(report));
	}
});

function amendedCohort() {
	const report = cohort();
	report.oracle_amendment = "A39";
	for (const row of report.results) {
		row.initial_display = "0";
		row.display = "5";
		row.clipboard = "calculator benchmark sentinel";
		row.clipboard_pass = false;
		row.pass = true;
	}
	return report;
}

test("#given A39 display success without copying #when verifying #then counts arithmetic completion", () => {
	const verified = verifyFreshCalculator(amendedCohort());
	assert.equal(verified.counts.apple.completed, 30);
	assert.equal(verified.counts.cua.completed, 30);
});

test("#given corrupted A39 oracle fields #when verifying #then names the invalid attempt", () => {
	for (const mutate of [
		(row) => {
			row.display = "4";
		},
		(row) => {
			row.display = undefined;
		},
		(row) => {
			row.clipboard = undefined;
		},
		(row) => {
			row.clipboard_pass = true;
		},
		(row) => {
			row.pass = false;
		},
		(row) => {
			row.initial_display = "5";
		},
	]) {
		const report = amendedCohort();
		mutate(report.results[0]);
		assert.throws(() => verifyFreshCalculator(report), /oracle disagreement: apple:1/);
	}
});

test("#given explicit A39 probe failure #when verifying #then retains a failed arithmetic attempt", () => {
	const report = amendedCohort();
	Object.assign(report.results[0], { display: null, display_error: "probe failed", pass: false });
	assert.equal(verifyFreshCalculator(report).counts.apple.completed, 29);
});
