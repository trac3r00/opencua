#!/usr/bin/env bash
# Runs the Bun test suite on the given paths.
#
# Bun 1.4.4 can panic while a test worker reloads koffi's native addon for the next isolated file ("NAPI FATAL
# ERROR ... Crashed while loading native module: koffi.node"), on any architecture and with or without --parallel.
# The panic aborts every file left in that worker. That is a runtime crash, not a test result, so only the files it
# took down, plus every file with a recorded failure, run again (up to three times); the rerun's result stands, so a
# real failure still fails. Any other failure is reported as is.
set -uo pipefail

# The agent's drawn cursor is on by default; a unit test must never spawn the real overlay helper on this desktop.
export OPENCUA_CURSOR=off
# Unit tests run on fakes, so the gesture pacing meant for real apps only spends wall-clock time; a focus wait that
# polls a fake for its full bound took a second per case. Each test that checks pacing sets its own values.
export OPENCUA_GESTURE_FOCUS_SETTLE_MS=1 OPENCUA_GESTURE_HOVER_MS=1 OPENCUA_GESTURE_PRIMER_TO_CLICK_MS=1 OPENCUA_GESTURE_CLICK_DRAIN_MS=1

scratch="$(mktemp -d -t opencua-bun-test)"
trap 'rm -rf "$scratch"' EXIT

# Files a crashed worker aborted, and files with a failed test case, one per line.
files_to_rerun() {
	{
		sed -n -E 's/^✗ ([^ ]+) \((worker crashed|aborted).*/\1/p' "$1"
		[ -f "$2" ] && tr '\n' ' ' <"$2" | grep -o '<testcase [^>]*file="[^"]*"[^>]*>[[:space:]]*<failure' | sed -E 's/.*file="([^"]*)".*/\1/'
	} | sort -u
}

run() {
	bun test --isolate --parallel=4 --reporter=junit --reporter-outfile="$scratch/junit.xml" "$@" 2>&1 | tee "$scratch/log"
	return "${PIPESTATUS[0]}"
}

rm -f "$scratch/junit.xml"
run "$@"
status=$?
attempt=1
while [ "$status" -ne 0 ] && [ "$attempt" -le 3 ] && grep -q "a test worker process crashed" "$scratch/log"; do
	rerun=()
	while IFS= read -r file; do rerun+=("$file"); done < <(files_to_rerun "$scratch/log" "$scratch/junit.xml")
	[ "${#rerun[@]}" -gt 0 ] || break
	echo "Bun crashed a test worker (a Bun runtime fault, not a test failure); running the ${#rerun[@]} affected files again (attempt $attempt of 3)." >&2
	rm -f "$scratch/junit.xml"
	run "${rerun[@]}"
	status=$?
	attempt=$((attempt + 1))
done
exit "$status"
