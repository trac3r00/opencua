import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function verifyFreshCalculator(report) {
	if (
		!report.finished_at ||
		report.runs !== 30 ||
		report.results?.length !== 60 ||
		report.fixture_lifecycle !== "fresh owned process per attempt; AX window ready before timing" ||
		report.cleanup_error
	)
		throw new Error("incomplete fresh-process Calculator cohort");
	const identities = new Set();
	const pids = new Set();
	if (report.oracle_amendment !== undefined && report.oracle_amendment !== "A39")
		throw new Error("unknown Calculator oracle amendment");
	const counts = { apple: { attempts: 0, completed: 0 }, cua: { attempts: 0, completed: 0 } };
	for (const row of report.results) {
		const identity = `${row.route}:${row.iteration}`;
		if (
			!Object.hasOwn(counts, row.route) ||
			row.scenario !== "calculator-add" ||
			!Number.isInteger(row.iteration) ||
			row.iteration < 1 ||
			row.iteration > 30 ||
			identities.has(identity) ||
			typeof row.pass !== "boolean" ||
			!Number.isFinite(row.e2e_seconds) ||
			row.e2e_seconds < 0
		)
			throw new Error(`invalid attempt: ${identity}`);
		identities.add(identity);
		const cleanup = row.cleanup;
		if (
			cleanup?.verified !== true ||
			cleanup.error ||
			!Number.isInteger(cleanup.pid) ||
			cleanup.pid <= 0 ||
			pids.has(cleanup.pid)
		)
			throw new Error(`unverified fresh PID cleanup: ${identity}`);
		pids.add(cleanup.pid);
		const trace = row.disturbance_trace;
		if (
			row.focus_disturbance !== false ||
			row.pointer_disturbance !== false ||
			!Number.isFinite(trace?.max_cursor_px) ||
			trace.max_cursor_px > 2 ||
			!Array.isArray(trace.activations) ||
			trace.activations.length !== 0
		)
			throw new Error(`unverified disturbance: ${identity}`);
		if (report.oracle_amendment === "A39") {
			if (
				row.initial_display !== "0" ||
				!(typeof row.display === "string" || (row.display === null && typeof row.display_error === "string")) ||
				!(
					typeof row.clipboard === "string" ||
					(row.clipboard === null && typeof row.clipboard_error === "string")
				) ||
				row.pass !== (row.display === "5") ||
				row.clipboard_pass !== (row.clipboard === "5")
			)
				throw new Error(`oracle disagreement: ${identity}`);
		} else if (row.pass && row.clipboard !== "5") throw new Error(`oracle disagreement: ${identity}`);
		counts[row.route].attempts++;
		counts[row.route].completed += Number(row.pass);
	}
	return { counts, verified_distinct_process_terminations: pids.size, zero_recorded_disturbance: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const file = process.argv[2];
	if (!file) throw new Error("usage: verify-fresh-calculator <raw>");
	const bytes = readFileSync(file);
	process.stdout.write(
		`${JSON.stringify({ file, sha256: createHash("sha256").update(bytes).digest("hex"), ...verifyFreshCalculator(JSON.parse(bytes.toString("utf8"))) })}\n`,
	);
}
