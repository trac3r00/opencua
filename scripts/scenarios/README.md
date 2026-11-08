# Wedge scenarios

## Team input isolation

This is task 13 of `.omo/plans/apple-cua-technical-gaps.md`. The desktop run is
gated: **do not run it until the coordinator sends `DESKTOP GO`.** Unit tests and
compiling the Swift observer do not open applications.

After that authorization, from this worktree:

```sh
node scripts/scenarios/team-input-isolation.mjs --desktop-go \
  --drivers apple,cua,peekaboo \
  --out docs/benchmarks/wedges/team-input-isolation-2026-10-28
node scripts/scenarios/team-input-isolation.mjs --desktop-go \
  --drivers apple --same-window \
  --out docs/benchmarks/wedges/team-input-isolation-2026-10-28
```

The first command collects ten repetitions per driver. The second collects one
negative control: both sessions address the TextEdit window while the independent
oracle still reads the two original documents. It must report `interleaving`.
Commands refuse to overwrite existing JSON. Keep failed cohorts, too.

### Fixture and workload

Each repetition starts dedicated new instances of TextEdit and Script Editor
with blank nonce-named rich-text and AppleScript documents. The native observer
finds their exact `AXDocument` paths and window IDs; it refuses missing or
ambiguous editors and toolbar buttons. It never sets their text.

Each of two independent MCP stdio processes owns one document. For twenty
seconds each session follows four seeded, independently jittered deadlines:
click its toolbar button, click back into its editor, move to document end, and
type the next 100 characters of its distinct 400-character punctuation payload.
The click, focus restoration, and append operations all go through that driver.
No retry, foreground fallback, or added input-lock waiting hides a refusal.
An overdue session skips subsequent bursts rather than extending the workload
indefinitely. Session lifetime is bounded at 25 seconds and each MCP request at
4 seconds. Reported throughput includes the common twenty-second observation
window; `input_finished_ms` also records when input finished.

Default toolbar labels are `Bold` and `Show or hide the log`. These labels and
their toolbar ancestry have **not yet been verified on the desktop**. If this
Mac's accessibility labels differ, inspect the recorded button inventory after
authorization and set `TEAM_INPUT_BUTTONS` to a JSON array of the two exact
labels. Keep the same fixture and labels for every arm; do not choose a
different action to improve a control's result. A missing toolbar is
`fixture-or-run-infra`, not evidence of competitor failure.

The independently compiled Swift process samples hardware pointer position and
frontmost PID at 50 ms and subscribes to app activations. An exact zero-pixel
maximum displacement and unchanged frontmost PID are required. Sampling gaps
over 150 ms invalidate coverage. The exact AX text, not an exit code, clipboard,
saved file, or tool success message, decides text equality. Foreign session
markers additionally classify `interleaving`; other corruption is
`text-mismatch`. Refusals, incomplete work, missing lock telemetry, and recording
failure remain separate failure classes even if final text happens to match.

### Driver commands and telemetry

Defaults: checkout `node packages/mcp/dist/server.js`,
`~/.local/bin/cua-driver mcp`, and `/opt/homebrew/bin/peekaboo mcp`.
Build the checkout and start CuaDriver's daemon before the desktop run if needed.
There are no new dependencies. Full `tools/list`, raw call arguments/responses,
per-call and per-session timing, seeds, samples, versions, cleanup, and oracle
classes are retained in each driver's JSON.

Override a server with `TEAM_INPUT_APPLE_COMMAND`, `TEAM_INPUT_CUA_COMMAND`, or
`TEAM_INPUT_PEEKABOO_COMMAND`, a JSON array containing the executable and args.
Use the signed helper launcher if the bare Node process lacks TCC permission.
For wrappers whose version invocation is different, also set the corresponding
`TEAM_INPUT_<DRIVER>_VERSION_COMMAND` JSON array. Missing version information is
recorded explicitly and must be resolved before publishing a comparison.

Apple calls target the numeric PID and observed window; Cua calls use
`pid` + `window_id` from the baseline bench-v2 driver. Peekaboo uses
`see(app_target, window_id, include_elements)` and snapshot-bound
`type`, `press`, and `click(on)`, as in `cef6196:scripts/bench-v2/drivers.mjs`.
An unavailable snapshot or element records `cannot-target` plus its attempted
call. Peekaboo's explicit `dispatched_unverified` response is retained without
replay; the independent AX oracle decides its effect.

The apple-only `--import` preload measures elapsed time around the existing
`InputLock.acquire` promise, including acquire overhead, and records every
acquisition's result. It does not modify core source, its budgets, or its return
value. Both apple processes use the same machine-wide lock path; sandboxing
`OPENCUA_HOME` does not change `OPENCUA_STATE_DIR`. The two controls have no
equivalent exposed lock-wait measurement: their field is `null`, never an
invented zero. Every `input-lock-busy` response is counted and fails the trial.
Publish the claim **“no interleaving across concurrent sessions”** only beside
completion, throughput, refusal counts, and the controls' measured outcomes.

### Recording and cleanup

Every repetition records with `screencapture -v`, then stops and reaps the
recorder. `ffprobe` checks that a nonempty movie covers the measured duration.
The one-second recorder setup occurs before measurement for every arm.
Movies and raw JSON go directly under the requested result directory, with
`SHA256SUMS`. Before committing desktop results, retain one representative
movie per driver under 20 MB (compress with ffmpeg if necessary), and retain
all repetitions' recording checksums. Do not delete failed recording evidence
or imply a movie was published when only its checksum was retained.

`SIGINT`, `SIGTERM`, and `SIGHUP` cancel scheduled input and trigger cleanup.
MCP processes, the sampler, and the recorder are stopped and reaped. Only
fixture-owned app PIDs are terminated, with matching bundle IDs checked; the
native termination notification verifies they are gone. Scratch files and
compiled observers use unique task-owned directories removed in `finally`.
The output-directory `.running` guard prevents overlapping runs to that folder;
the coordinator must still reserve the single desktop against other harnesses.

Before **any** setup script or apple-cua CLI, isolate the install directories:

```sh
home_root=$(mktemp -d -t apple-cua-t13-home.XXXXXX)
bin_root=$(mktemp -d -t apple-cua-t13-bin.XXXXXX)
export OPENCUA_HOME="$home_root/home" OPENCUA_BIN_DIR="$bin_root/bin"
mkdir -p "$OPENCUA_HOME" "$OPENCUA_BIN_DIR"
# Never use --register. After setup, this must print nothing:
grep -l apple-cua-wt ~/.local/bin/apple-cua ~/.omo/agent/mcp.json ~/.apple-cua/bundle/bundle.json
# Stop processes using the sandbox before removing these task-owned roots.
rm -rf "$home_root" "$bin_root"
```

### Offline checks

```sh
node --test scripts/scenarios/team-input-isolation.test.mjs
pnpm test:scripts
pnpm exec biome check scripts/scenarios package.json
```

The tests use injected clocks, event barriers, and readiness signals, with no
fixed sleeps. They cover exact equality, same-window corruption, interruption
and refusal classes, sampling coverage, all three type mappings, overlapping
sessions, lock telemetry, process reaping, and the desktop authorization gate.
They do not certify GUI behavior. No core fix is justified until a measured
apple-cua interleaving failure has been observed.
