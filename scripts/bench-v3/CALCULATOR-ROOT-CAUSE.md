# Calculator clipboard-oracle root cause

## Decision: R1

Both drivers independently reach display `5`; neither changes the sentinel
clipboard. The clipboard-only oracle therefore cannot distinguish successful
arithmetic from failed background copying. Amend the prospective oracle to
make an independent AX display read primary and retain clipboard copying as a
secondary outcome. Register that amendment under the next free ledger ID
(A39 at planning time) before task 9 collects any new cohort.

This is a diagnosis, not an oracle amendment or a rescoring. A background-copy
task still failed. Do not describe the arithmetic-only outcome as successful
copying, or these instrumented exploratory timings as speed measurements.

## Retained evidence

Executed on macOS 26.6.2 (25G83), 2026-10-28, from branch
`test/calculator-root-cause`, source base `7f4e0f8`. The single exploratory
block completed at `2026-10-28T04:42:33.487Z`, in seeded order Cua then Apple.
All paths below are relative to this worktree and are gitignored raw evidence:

| Artifact | SHA-256 |
| --- | --- |
| `.bench/v3/root-cause/2026-10-28-t5/exploratory-pair.json` | `467c73faab040dcb58b627fa478c0cf0b2c7cf5d173b13dad594f4148e61836b` |
| `.bench/v3/root-cause/2026-10-28-t5/apple-observations.json` | `a7ed25bae483063380e35b705b99b426094581c84e7e1d049047f89744e2b32e` |
| `.bench/v3/root-cause/2026-10-28-t5/cua-observations.json` | `caa9f2329bfa0bccb5f8676dcc56fef683054113b546c0d801afff5870a44430` |

The pair contains unmodified harness outcomes, complete MCP call arguments and
responses, producer hashes, disturbance traces, and owned-PID cleanup results.
The two observation files retain the independent probe, clipboard, and bounded
AX-tree reads after every logical step, including the failing Apple Copy,
before harness cleanup. They are supplementary observations, not new scores.

## Per-driver traces

`calculator benchmark sentinel` was written by the existing harness immediately
before each attempt. The independent `pbpaste` read after observation and after
every subsequent step still returned that exact sentinel for both routes.

| Logical step | Apple display, PID 37558 | Cua display, PID 36294 |
| --- | --- | --- |
| observe | `0` | `0` |
| `2` | `2` | `2` |
| `+` | `2+` | `2+` |
| `3` | `2+3` | `2+3` |
| `=` | `5` | `5` |
| background Cmd+C | `5` | `5` |

Apple makes ten actual calls: `get_app_state`, `press_keys(["2"])`,
`get_app_state`, `press_keys(["+"])`, `get_app_state`, `press_keys(["3"])`,
`get_app_state`, `press_keys(["="])`, `get_app_state`,
`press_keys(["cmd+c"])`. Fresh observations supply one-use tokens after input
responses without a replacement token. The final call returns `isError: true`:

```text
Copy would do nothing: the app is in the background, where Edit > Copy is disabled, and no text is selected in a focused native text field to copy through accessibility.
```

The raw array also records that last exception separately; its eleven entries
must not be mistaken for eleven calls. The original row has `pass: false`,
`false_success: false` and the tool error. It has no `clipboard` field because
the exception bypasses `services.readClipboard()`. The sidecar independently
records display `5` and clipboard `calculator benchmark sentinel` anyway.

Cua makes seven calls: `list_windows`, `get_window_state`, then five
`press_key` calls for `2`, `+`, `3`, `=`, and `c` with `modifiers: ["cmd"]`.
Each key call explicitly requests `delivery_mode: "background"` against the
same PID/window. No call errors. The Copy response says it pressed `c`, but
its structured `effect` is `unverifiable`, route `synthetic_events`. The
original row has `pass: false`, `false_success: true`, clipboard
`calculator benchmark sentinel`, and `error: "clipboard mismatch"`.
The independent display remains `5`.

This does not prove that Cua's modifier reached Calculator or that Calculator
ignored a correctly delivered chord. It proves that an accepted tool call did
not copy the result. The supported decision is an oracle correction, not a
claim about an unobserved event-delivery mechanism.

## Mechanism and historical limits

`calculator-run.mjs` imports the v3 `Driver`, which translates the shared
logical plan through the inherited v2 `primaryStep`/`act` implementation.
The v3 Cua override prohibits foreground delivery and retains raw responses.
On Apple, background Cmd+C reaches `MacOSHostComputer.runBackgroundKeyPlan`
in `packages/core/src/platform/macos.ts`: the `copy-selection` plan requires
selected text in a focused native field and otherwise throws the exact error
above. Calculator exposes the result as static text inside a scroll area,
not as a selected native text field.

Two levels above that refusal, `runCalculatorAttempt` abandons the clipboard
read on any step exception, while `calculatorOutcome` accepts only
`clipboard === "5"`. A successful arithmetic result is never independently
observed by that oracle. Cua's non-error response still fails the external
clipboard comparison. The independent display probe closes this observation
gap without changing either driver or the scoring code.

A18 in `PREREGISTRATION.md` registers thirty seed-20261009 paired blocks,
fresh owned AX-ready Calculator processes, original plan/sentinel and exact
PID termination. `LEDGER.md` records the ready-window pilot's unchanged Cua
sentinel and Apple background Copy refusal, followed by both routes' 0/30.
`CALCULATOR-RESULT.md` records the historical raw hash
`be99c567f110c94aa71f17e5f8db686a8b4d13578eb2d25b3a8323bce88299b4`
and its validator invocation. Those records support the same copy failure
signature. They do not contain a historical display read; this experiment
does not retroactively establish sixty successful arithmetic results.
No historical cohort was edited, rescored, or rerun.

## Probe contract and acceptance

```sh
swiftc -O scripts/bench-v3/calculator-display-probe.swift -o "$TASK_SCRATCH/probe"
"$TASK_SCRATCH/probe" <Calculator-pid>
```

The probe checks the PID's bundle identity, requires exactly one AX window,
and reads the single `AXStaticText` value under `StandardInputView`. It never
selects the keypad's button labeled `5`, the history expression under
`StandardResultView`, a different process, or the clipboard. It removes only
direction marks and surrounding whitespace; it does not parse or evaluate
the expression. AX messaging has a two-second timeout and traversal is
bounded to 20 levels/512 elements. Unsupported, missing, or ambiguous
displays fail explicitly instead of becoming an arithmetic pass.

Compilation exited 0. After Apple's failing Copy, the probe against PID
37558 printed `5`, exit 0, next to independent clipboard value
`calculator benchmark sentinel`. Against live task shell PID 35807, it exited
1 and printed:

```text
Calculator display probe: no Calculator window: PID 35807 is not a running Calculator
```

Focused Calculator, driver and fresh-cohort validator tests passed 25/25,
exit 0. Swift LSP reported no probe diagnostics. No fixed sleeps were added
to tests.

## Execution qualifications

The first read-only inspection found persistent currency conversion mode
(USD/KRW), not an arithmetic fixture. Before collection, a separate owned
Calculator process used freshly resolved AX targets to toggle the observed
Convert menu and press All Clear. Readback established
`Mode: basic; unitConversion: false` and display `0`. Each actual benchmark
attempt independently began at `0`; no mode-changing step was inserted into
the logical plan. Preparation PIDs 23082 and 30634 were terminated.

The installed v3 runner has an unrelated top-level import of an unavailable
browser runtime at `/Users/bob/.../omowright/index.js` through
`browser-agent-run.mjs`. A task-local Node `registerHooks` preload redirected
only that exact import to a function that throws if browser use is attempted.
The original `recordBrowserTrace`, runner, drivers, oracle, plan, and cleanup
remained unchanged. No browser was opened. The same import-only shim enabled
the focused tests.

A second task-local preload wrapped `Driver.prototype.step` with `try/finally`
to run the compiled display probe, `pbpaste`, and a bounded AX inspection,
recording JSON after each step even when Copy threw. Each subprocess had a
ten-second timeout. MCP calls retained their thirty-second cap, lifecycle
observers their ten/twelve-second bounds, and the complete run had a
300-second monitor deadline. These observations add overhead inside timing;
the resulting durations are deliberately not benchmark performance evidence.

Actual collection command (after the separately started CuaDriver daemon):

```sh
ROOT_CAUSE_OUT="$PWD/.bench/v3/root-cause/2026-10-28-t5" \
DISPLAY_PROBE="$TASK_SCRATCH/probe" AX_TREE="$TASK_SCRATCH/ax-tree" \
BENCH_TRACE=1 node --import "$TASK_SCRATCH/observe.mjs" \
  scripts/bench-v3/calculator-run.mjs --runs 1 --exploratory \
  --out "$PWD/.bench/v3/root-cause/2026-10-28-t5/exploratory-pair.json"
```

One earlier invocation failed at module resolution before launching Calculator
or creating an output file; it is not an additional attempt. No 30-pair
collection was run. The worktree TypeScript/native build completed, but
setup stopped during helper signing with `errSecInternalComponent`; explicit
keychain signing and unlocking did not resolve it. The benchmark used the
built server directly through Node, not that helper. No key material was
printed or copied, and no signing configuration was changed.

Both attempt cleanup records verify their exact PIDs gone, with zero recorded
focus/pointer disturbance. The separately owned CuaDriver daemon PID 33433
was terminated and independently verified gone. All task scratch was removed.
The post-setup shared-install check found no `apple-cua-wt` references in
`~/.local/bin/apple-cua`, `~/.omo/agent/mcp.json`, or
`~/.apple-cua/bundle/bundle.json`.

## Known limitations (review of 2026-11-08, not fixed)

- The runner paragraph above describes the exploratory, pre-A39 revision; the final A39 runner reads both values
  and uses the display as the primary outcome.
- `calculator-run.mjs` creates its scratch directory after taking `.run.lock` and outside the cleanup scope, so a
  failure there leaves the lock behind.
- `verify-fresh-calculator.mjs` can accept an A39 artifact without the launch and display-probe provenance.
