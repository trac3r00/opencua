# Cua Driver Bench v2: offline apple-cua arm

Pinned upstream: `trycua/cua` at
`f06d538f7f743f063ee9312035874c489d9e63f6`, resolved from main on 2026-10-28.
This directory contains an integration patch, not an upstream source copy.
It is an internal evaluation setup, not a hosted benchmark service.

The comparison arm is **`cc-cua-driver` (0.34.0 release baseline)**, not the
upstream headline `cc-cua-driver-script`. Upstream pins main to
`1fa2247ae745f5029211573ad4f5c3087efcf641`; the available 0.38.0 release is
from `85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19`, a different commit.
Do not describe this baseline as the current Cua Driver or its script arm.

## License

Source: upstream `libs/cua-driver-bench/LICENSE` at the SHA above, copyright
2026 Cua AI, Inc., Functional Source License, Version 1.1, MIT Future License
(FSL-1.1-MIT). The **Permitted Purpose** section, verbatim:

> A Permitted Purpose is any purpose other than a Competing Use. A Competing Use
> means making the Software available to others in a commercial product or
> service that:
>
> 1. substitutes for the Software;
>
> 2. substitutes for any other product or service we offer using the Software
>    that exists as of the date we make the Software available; or
>
> 3. offers the same or substantially similar functionality as the Software.
>
> Permitted Purposes specifically include using the Software:
>
> 1. for your internal use and access;
>
> 2. for non-commercial education;
>
> 3. for non-commercial research; and
>
> 4. in connection with professional services that you provide to a licensee
>    using the Software in accordance with these Terms and Conditions.

These terms also cover modifications. The patch retains upstream copyright
and SPDX headers in the files it modifies. The upstream license remains in
the external clone. License source:
`https://github.com/trycua/cua/blob/f06d538f7f743f063ee9312035874c489d9e63f6/libs/cua-driver-bench/LICENSE`.

## What changes between arms

Both arms use the upstream Claude invocation, model, limits, task briefs,
GUI-only guard, checkers, schedule, and condition handling. The patch adds
registration, MCP configuration, skill placement and a real-capture branch;
it does not alter upstream `METHOD.md` or scoring.

`cc-apple-cua` uses MCP server `apple-cua`, `--allowedTools mcp__apple-cua`,
the signed helper launcher and its bundled Node, and this worktree's absolute
`packages/mcp/dist/server.js`. A bare Node process is not used. Runtime paths
and SHA-256 values are recorded in `$CDB_BENCH_WORK/apple-cua-observed.json`.
`pins.json` records the source commit and runtime policy. The setup does not
build apple-cua: build it in the designated worktree first.

Only the runner's environment allowlist/fixed values plus the three
`OPENCUA_*` entries in `pins.json` reach this server. Delivery stays
`background` in **both** conditions, toolset is `full`, and
`OPENCUA_IPHONE` is absent even if the parent sets it. The server uses an
isolated HOME under `$CDB_BENCH_WORK/apple-home`; Claude's subscription HOME
remains unchanged. The bundle allowlist
contains the ten-task app set, plus Calculator for upstream's capture probe;
BenchSentinel, Terminal and Script Editor are excluded. Taskpack Electron
bundle IDs follow upstream's `cdb_adapter.electron_bundle_id`.

Both selected arms get a project skill directory. apple-cua's short operating
addendum is derived from `skills/apple-cua/SKILL.md`, in the same length class
as upstream's script addendum. The 0.34.0 baseline itself has no script
addendum. This asymmetry and all platform/version changes are in
[METHOD-NOTES.md](METHOD-NOTES.md).

## Prepare without touching the desktop

Prerequisites: macOS 26 on Apple silicon, Xcode CLT, Node 22+, npm, uv, GNU
`timeout`, ffmpeg at `/opt/homebrew/bin/ffmpeg`, and a built, stably signed
apple-cua helper. Setup never runs a model, preflight, an app, or a recorder.
Network downloads during preparation are allowed; "offline" means no model
calls, not an air-gapped dependency installation.

```bash
cd /Users/cminseo/Developer/apple-cua-wt/apple-cua-technical-gaps-w1-t6
pnpm install --frozen-lockfile
# Link the existing .signing directory here if needed; never copy/log keys.
# Isolate setup's launcher/config writes and skip its browser-service setup.
export CDB_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/apple-cua-cdb.XXXXXX")"
export OPENCUA_HOME="$CDB_ROOT/work/apple-home"
export OPENCUA_BIN_DIR="$CDB_ROOT/work/bin"
mkdir -p "$OPENCUA_HOME" "$OPENCUA_BIN_DIR"
OPENCUA_BROWSER=off ./scripts/setup.sh --yes --no-doctor
# Must print nothing. Report any matches; do not repair shared paths here.
grep -l apple-cua-wt "$HOME/.local/bin/apple-cua" \
  "$HOME/.omo/agent/mcp.json" "$HOME/.opencua/bundle/bundle.json"
bash scripts/bench-cdb/setup.sh --prepare
```

`--prepare` completes downloads/builds without requiring the third-party task
apps or Claude's fixed path. It registers the two built fixture apps with
LaunchServices so upstream's registered-copy check can find them, without
launching them. Without that flag, setup additionally requires
`/Applications/LibreOffice.app`, `/Applications/Gnucash.app`,
`/Applications/Google Chrome.app` and `/opt/homebrew/bin/claude` at the pinned
version. Missing prerequisites produce `BLOCKED:` and exit 2. It never
installs these large apps or spends a model call to check login.
The subscription login response check in the original plan is deliberately
not executed under the stricter no-model-calls instruction.

Each clone/build/download has a deadline. A failed or interrupted initial
clone requires a new task-owned directory. Existing prepared clones must
have the same pinned HEAD and patch identity; setup refuses stale roots.
The comparison installer verifies upstream checksums and uses only a
private app under `$CDB_ROOT/work/cua-0.34.0`, never an installed Cua Driver.

The clone and all downloaded sources/dependencies stay outside this
repository. Retain that external directory until desktop checks finish;
then archive required logs to the evidence location and remove only that
task-owned directory. Do not delete it during a pending desktop handoff.

```bash
export CDB_BENCH_WORK="$CDB_ROOT/work"
BENCH="$CDB_ROOT/libs/cua-driver-bench/automated-eval/macos_bench"
PYTHON="$CDB_ROOT/venv/bin/python"
cd "$BENCH"
"$PYTHON" run_bench.py dry-run --bench-v2 --phase1-runs 3 --phase2-runs 2 \
  --arms cc-apple-cua cc-cua-driver --pins "$CDB_BENCH_WORK/pins-local.json" \
  --runs-dir "$CDB_BENCH_WORK/runs" --ledger "$CDB_BENCH_WORK/ledger.jsonl"
"$PYTHON" -m pytest tests probes/tests swift/tests
```

Dry-run must list both arms: 100 trials, 50 paired task/run groups
(upstream prints 20 phase/task blocks). It
constructs command lines but never executes them. If Claude's upstream
fixed path is absent, `--claude-bin "$HOME/.local/bin/claude"` is usable
for dry-run only; default preflight readiness remains blocked.

## Desktop gate: only after DESKTOP GO

The following commands **capture the desktop**, even with `--offline`.
They must not overlap another desktop task. Before running, install the
named apps, provide the pinned CLI at `/opt/homebrew/bin/claude`, and grant
Accessibility/Screen Recording to the signed apple-cua helper and the
private Cua Driver. Grant Screen Recording to `/usr/sbin/screencapture`
if upstream reports it missing. The task apps must be disposable: upstream
cleanup can kill Chrome, LibreOffice, Electron and GnuCash by name.

From a Terminal.app shell with the environment above:

```bash
export CDB_BENCH_DISPOSABLE=1
"$PYTHON" run_bench.py preflight --offline --bench-v2 \
  --arms cc-apple-cua cc-cua-driver --build-dir "$CDB_BENCH_WORK/build" \
  --pins "$CDB_BENCH_WORK/pins-local.json" \
  --runs-dir "$CDB_BENCH_WORK/runs" --ledger "$CDB_BENCH_WORK/ledger.jsonl"
```

Require both arms' `real capture` rows to pass, not merely tools/list.
The recorder's real three-second capture remains enabled. Off-Terminal
execution requires the upstream `--allow-non-terminal` flag and must record
its warning. Never remove `--offline`, invoke `run`, or do the login-response
probe in this task.

Failure checks:

```bash
# No clone or desktop work; must exit 2 with the full expected SHA.
cd /Users/cminseo/Developer/apple-cua-wt/apple-cua-technical-gaps-w1-t6
CDB_PIN_SHA=0000000 bash scripts/bench-cdb/setup.sh
```

After DESKTOP GO, temporarily rename **this worktree's** server.js, with
a shell EXIT trap that restores it, then repeat the offline preflight
under a distinct `--run-id missing-apple-server`. Require apple-cua's
capture/start to fail and the baseline's real capture still to pass.
Restore the server before the happy preflight. Never rename another
worktree's server, suppress failed checks, or call that failure run ready.
