#!/usr/bin/env bash
# Runs the Bun test suite on the given paths.
#
# Bun 1.4.4 can abort a --parallel test worker while it loads koffi's x86_64 addon ("a test worker process
# crashed"), which aborts every file left in that worker. That is a runtime crash, not a test result, so in that
# case only the suite runs once more and the second result stands. Any other failure is reported as is.
set -uo pipefail

# The agent's drawn cursor is on by default; a unit test must never spawn the real overlay helper on this desktop.
export OPENCUA_CURSOR=off

log="$(mktemp -t opencua-bun-test)"
trap 'rm -f "$log"' EXIT

bun test --isolate --parallel=4 "$@" 2>&1 | tee "$log"
status=${PIPESTATUS[0]}
if [ "$status" -ne 0 ] && grep -q "a test worker process crashed" "$log"; then
	echo "Bun crashed a test worker (a Bun runtime fault, not a test failure); running the suite once more." >&2
	bun test --isolate --parallel=4 "$@"
	status=$?
fi
exit "$status"
