# Benchmark v3 — todo and evidence ledger

Raw artifacts live under `.bench/v3/` (gitignored). Times are UTC.

## Latest continuation evidence

### A39 — prospective Calculator display-primary oracle (2026-10-28)

Registered before any A39 pilot or cohort attempt. Task 5's independently
reviewed R1 decision establishes arithmetic display `5` on both drivers while
the clipboard remains the reset sentinel. A18 remains unchanged and unrescored.

The same six-step plan, background delivery, seed 20261009, thirty randomized
paired blocks, fresh owned AX-ready process per attempt, and exact-PID cleanup
remain binding. Before input, reset the clipboard sentinel and independently
require display `0`. Compile the retained `calculator-display-probe.swift`
with `swiftc -O`; read the owned PID's display as the primary arithmetic
oracle (`display === "5"`), including after a thrown Copy refusal. Independently
read the clipboard as the secondary copy oracle (`clipboard_pass`), retain
both values (or null with explicit read errors), and retain driver errors.
Successful arithmetic does not imply successful copying. The timed interval
includes driver calls and both final oracle reads, not fixture setup/cleanup.
Record `oracle_amendment: "A39"` and the display-probe source hash.
The Apple route keeps its existing direct `node packages/mcp/dist/server.js`
launch against this worktree's built server. Record `apple_launch` with the
command/arguments, resolved Node executable path and SHA-256, and server path
and SHA-256 in the cohort JSON. The known worktree helper-signing failure is
an environment qualification, not a gate on this existing direct launch.

The Calculator runner no longer imports a browser runner just to summarize
its disturbance trace; it applies the same trace predicates locally. No
import shim, browser runtime substitution, or driver bypass is permitted.
Observer binaries and clipboard archive use an owned scratch directory under
the shared benchmark lock and are removed after the run.

After explicit desktop release, collect only into the new artifact:

```sh
node scripts/bench-v3/calculator-run.mjs --seed 20261009 --runs 30 \
  --out "$PWD/.bench/v3/calculator-fresh-process-30-A39.json"
node scripts/bench-v3/save-analysis.mjs \
  .bench/v3/calculator-fresh-process-30-A39-analysis.json \
  .bench/v3/calculator-fresh-process-30-A39.json
node scripts/bench-v3/verify-fresh-calculator.mjs \
  .bench/v3/calculator-fresh-process-30-A39.json
```

No A39 desktop attempt has run at registration. Report R1 at the fixed
29/30 threshold, Wilson completion intervals, R1p and the fixed-extension
trigger without running an extension here, and S1's paired p95-ratio interval.
Claim no speed unless R1 passes. Hash both raw and analysis artifacts and
append an A39 section to CALCULATOR-RESULT.md; never replace historical sections.

User correction: no measurement-time snapshot exists; none was made.
The user directs continuation without historical isolation. That task is
dropped, not completed by reconstruction. HISTORICAL-REPRODUCTION.md records
the unresolved producer identities and unperformed historical extensions.
Earlier archive-available/path-pending statements below are historical and
superseded. Raw outcomes and statistical obligations are unchanged; no
current build is substituted for a historical subject. Keyboard ownership
and modal starting-state gates remain independent and unresolved.

Continuation validation: `node --test scripts/bench-v3/*.test.mjs` exits0.
`pnpm check` exits1 at Biome with28 errors in generated `.omc` state;
the shown diagnostics are formatting differences, and eight were omitted
by Biome's output cap. No generated state was changed.
The skipped downstream gates were run separately:
`pnpm -r typecheck && pnpm typecheck:tests && pnpm exec vitest --run && pnpm test:scripts`
exits0. Vitest reports157 passed files,2 skipped files,1388 passed tests
and2 skipped tests. The earlier region-capture failures did not recur in
this run; that observation does not rewrite earlier failed checks.
These checks validate source and regressions, not live keyboard ownership,
historical runtime identity, missing samples or final desktop cleanup.

Continuation on 2026-10-11 recovered the original twelve-item checklist.
The snapshot-path question expired unanswered; historical isolation remains
pending and no gated GUI action or historical extension was launched.
Registration-time unavailable clients remain recorded in COMPATIBILITY.md,
without replacement baselines. The original session's tool result a9f9ea45
(2026-10-09T13:30:08.320Z) directly records Claude's weekly-limit response;
the registration and contemporaneous ledger record the other client limitations.
These are registration-time observations, not fresh availability probes.
All four corrected analysis caches were independently checked against their
retained raw SHA256 values in this continuation and match.

Both retained browser analyses regenerate with exit0, seed20261009 and10,000
iteration-cohort resamples, preserving raw hashes. Agent rows remain516/630
slots and Codex models remain unknown. OmO+apple injection iteration6 reports
gpt-6-sol, not registered gpt-6-astra; its passing row remains included.
RETAINED-BROWSER-ANALYSIS.md records exact identities and interpretation limits.
The user reports a measurement-time archive is available; its path is requested
but not yet supplied. No archive has been inspected or promoted to an
extension-ready historical subject.

Resource coverage now separately accounts for numeric zero, absent client
usage, assigned flags and unrecorded slots across six retained artifacts.
RESOURCE-METRIC-COVERAGE.md reports browser-agent latency/calls513/516,
tokens512/516 and cost292/516 without imputing missing usage or pooling
subjects. Scripted payload proxies remain distinct from actual agent usage.
The exact Finder model binding already exists in remaining-driver-run.mjs:
setup resolves one model by canonical owned start-directory path; the
endpoint reads that model ID, not the front window. Its existing regression
is included in the233 passing benchmark tests. The retained two-app smoke
never reaches actions: both zero-call rows refuse pre-existing TextEdit.
This establishes code binding, not live task completion or dispatch ownership.

Recovery/planning field measurement has a reproducible stdout-only CLI,
recovery-coverage.mjs, with three deterministic regressions. Full benchmark
tests pass233/233; scoped Biome passes after formatting corrections; the CLI
exits0 on six retained hashes. Fresh MJS LSP diagnostics time out. Missing
coverage remains assigned to the existing collection/extension obligations,
not filled by observed-subset intervals or waived. See
RECOVERY-PLANNING-COVERAGE.md for the reproduction command.

Offline recovery/planning coverage now audits six retained cohorts, including
all516 browser-agent rows and failed text attempts. Existing injection grading
is observed for171/175 injection rows, all true; four remain unknown. This
does not repair the cohort's identity/cleanup failure. Text recovery is
observed for161/180 fault rows, with153 true; duplicates are observed for
338/360 rows, with zero true. Intervention and minimal-plan measurements remain
unavailable or assigned rather than independently observed. Raw SHA256 values
and interpretation limits are in RECOVERY-PLANNING-COVERAGE.md. No GUI action
or raw mutation occurred. The modal starting-state question timed out, so
its gated fixture action remains pending.

Calculator payload accounting now has regression-first repair and a separate
historical sensitivity: estimated_tokens already includes images, while the
producer added them again. Reconstruction matches every retained fresh-process
row; Cua has501 excess proxy tokens per row,15,030 total, Apple none.
The new supplemental analysis changes only token summaries/intervals; original
raw, completion, latency, calls and disturbance remain intact. All230 benchmark
tests and scoped style pass; fresh MJS LSP diagnostics time out. See
CALCULATOR-RESULT.md and A38. No new GUI collection was run.

The current shipped core/native package was archived before the prospective
TypeScript runtime build. Isolated and coherent core emission both exit0.
Read-only guarded MCP readiness exits0, reports background delivery and console
mode, and closes its owned transport; this is not live input ownership proof.
Current TextEdit is not frontmost and Page Setup/Save As read disabled, so no
app was brought forward and no modal fixture was opened. A user starting-state
question is pending; native window-delivery design assessment runs separately.

Retained baseline T4 focus review finds explicit background input requests on
both routes. Cua's first activation predates its first recorded driver call;
native's activation is near its paste batch without exact clock alignment.
T4-BASELINE-FOCUS-DIAGNOSIS.md preserves the attribution gaps and stopped
outcomes. These findings do not establish inherently unsafe backends or permit
a stopped cohort retry.

Required pnpm check exits1 at lint with28 formatting diagnostics, all in
generated .omc JSON state; those out-of-scope files remain untouched. A JSON
diagnostic pass confirms no source diagnostics. Separate workspace and test
typechecks pass. Full Vitest records1385 passes, three failures and two skips:
all failures are unchanged screenshot-region live tests returning
`CGDisplayCreateImage returned null for display 5`. The test's native-size
probe does not establish actual region capture availability; its environmental
cause is unproven and no permission/security change was made. Separately
launched required script tests pass21/21 with exit0. These findings are recorded
in repository-check-lint-finding.json and repository-type-test-checkpoint.json;
the full repository check is not green. A36 binaries remain unchanged.

A36 completes30/30 independently verified T4 attempts and final target/service/
model/file absence, with no raw usage or safety missingness. Median93.411s,
p95 148.015s, recorded cost$37.336566, zero actual false success or disturbance.
Wilson completion[0.886487,1] leaves R1p INCONCLUSIVE. Raw SHA256:
5b63236b221ff1ba0d350f810e3fec348d05e3a0f6d91e20f1ec04b648e76efb.
T4-AGENT-RESULT.md scopes observed predicates to this task, not the full suite.

A37 stage31-60 verifies30/30 and independent final target/model/file absence.
Stage61-90 stops at64 on task and cleanup osascript ETIMEDOUT, producer exit1.
Its explicit thirty-slot offline verifier also exits1: three verified passes,
one recorded unverified failure and26 missing slots. Both monitors have exited;
there is no active collector. Complete rejection evidence is preserved in
apps-agent-t4-stage90-offline-verification.json, with stop/recovery evidence in
apps-agent-t4-stage90-stop.json. Guarded exact TextEdit closure is independently
verified; Safari window22527 remains unresolved after the cleanup handoff
timed out. No retry or ninety-attempt verdict is authorized by this timeout.
The later user-confirmed handoff resolves the leftover: independent process
inventory finds Safari PID5190 absent and TextEdit AX inventory empty. Exact
source/control disk bytes were original; both owned files were removed and
all three owned paths verified absent. Preserve stage90-handoff-readback.json.
This is post-stop recovery, not a task-oracle repair or an A37 retry.
The prospective scheduler consumes the full PRNG
prefix, records start_iteration and verifies explicit stage count/range.
All229 benchmark tests and scoped Biome pass. Source hash comparison with A36
changes only the listed runner producer; frozen hashes and verifier identity
live in apps-agent-t4-extension-subject.json. No action/oracle/cleanup/native/
model behavior changed. Missing paired-baseline and historical obligations
remain open; no historical raw is rewritten or pooled.

A33 stops at16/30 despite sixteen task-oracle passes: attempt16 cleanup
records other.txt, with no final decision snapshot identifying the exact
window. Fourteen unrecorded slots remain explicit; raw is unchanged.
Independent later readback verifies zero target documents and AX windows,
and a hidden zero-tab Safari model. A34 then reproduces a different cleanup
failure on two exact offscreen TextKit service surfaces. Both failed raws
and separate readback artifacts remain retained.

Regression-first repairs refresh exact prior-owned closures using fresh
model/document/AX evidence and archive the cleanup decision snapshot. The
inactive service rule adds only com.apple.textkit.nsattributedstringagent,
still requiring bound PID/bundle, a unique offscreen surface and empty AX
inventory. All224 benchmark tests pass; scoped Biome passes after formatting
correction. A35's two attempts verify offline with no safety/usage missingness,
and independent final target/service/model/file absence probes exit0. Its
raw SHA256 is217a0e873eae8934f5f1fb6510f81ccf915e1332cf5fc3dea2e7598fee121c22.
The sequential cleanup task is complete; paired agent coverage remains open.

Historical source recovery emits an isolated, unexecuted retained-text runner
candidate that passes syntax-only validation and exactly matches145 archived
lines17-161. Recovered patches and call/result-matched fragments are preserved
under .bench/v3/history. Inferred line66, later unread byte ranges and missing
native/helper/dependency identities prevent promoting it to an extension-ready
subject. See HISTORICAL-REPRODUCTION.md and candidate-validation JSON.

Explicit-bound ownership edge coverage passes ten focus tests and scoped
Biome: unknown focus, an unverified untitled helper, and successful raise with
wrong focus read-back all refuse before posting. A33 dist remains unchanged.
Full historical text raw inspection finds180 rows with no fields introduced
by the post-launch line602 patch, supporting the pre-line602 runner candidate
without claiming byte identity. Historical native/dependency provenance is
still missing; no obligation is waived.

Bound-command modal regression also fails before its fix. Both explicit-bound
keyboard and window-command source paths now require focused-window ID read-back
to match their observed target before dispatch. Core suite passes88 files,
676 tests, one existing skipped test; typecheck and scoped Biome exit0.
This prevents the reproduced wrong-modal dispatch, but does not prove atomic
focus-to-event delivery, legitimate helper association or real-surface behavior.
No additional build/GUI proof is claimed. A33 uses unchanged archived binaries
and has four task passes reported so far, not a completed cohort.

Explicit observed-window modal regression fails before the prospective source
fix: input resolves rather than rejecting, despite another modal having focus.
macos-input.ts now requires the bound keyboard window to equal independent
focused-window read-back after focusing, refusing before keyboard dispatch.
Legacy unbound helper behavior remains a separately documented finding.
Five focus tests, core typecheck and scoped Biome initially pass. Broader scope
tests expose stale no-op focus mocks; these now maintain per-PID focused-window
state, preserving concurrency/cancellation assertions rather than weakening them.
Combined tests/checks are running. No active A33 binary rebuild occurred;
this narrow guard does not establish atomic dispatch or unlock two-app QA.

Core regression follow-through passes88 test files,675 tests with one existing
skipped test. The related16 tests, core typecheck and scoped Biome also pass.
The separate withWindowCommand path still calls the same unchecked focuser;
an explicit-bound unrelated-modal command regression is running before that
path is changed. Existing unbound behavior remains untouched. Source checks
are not promoted to production/live proof, and A33 dist stays fixed.

Two-app ownership track returns a concrete native dispatch blocker and makes
no edits. Parent source inspection confirms macos-input.ts accepts any focused
modal window or untitled helper without verifying association with the bound
target, and suppresses Window-menu focus failure; CoreGraphics keyboard primary
delivery addresses the PID. A runner-only personal-window exemption cannot
establish exact action ownership. Existing focus tests encode the untitled-helper
assumption, so that is a finding, not a test to quietly edit green. A new
Coverage task tracks strict keyboard ownership verification before permitting
two-app fixtures alongside personal Finder windows. Active A33 native binaries
remain untouched; no broader dispatch correction or build is claimed.

A32 repaired delayed-field fixed endpoint verifies both routes90/90,
all180 owned closures, zero recorded disturbance and independent final
Safari AX/model absence. Seeded failure-inclusive analysis and claims exit0:
S1/R1/R1p/R2 PASS, F1/F1p/D1 INCONCLUSIVE. P95 ratio0.152901
CI[0.142404,0.157236], Wilson lower0.959064. Endpoint analysis SHA256
9d881ebece44c521bc16501d7ef2bf18583c9c19ebf6a84bb18d11c9c663d547.
Historical A28 stays unpooled; this does not establish prefix-failure causality.

A31 repaired delayed-field cohort completes both routes30/30, all sixty
closures verified and zero disturbance; producer/verifier and seeded analysis
exit0. Final Safari AX inventory is empty, model18792 hidden with zero tabs.
Separate claims are S1/R1/R2 PASS, R1p/F1/F1p/D1 INCONCLUSIVE, p95 ratio
0.155929 CI[0.143155,0.168364]. DELAYED-REPAIRED-RESULT.md records hashes
and fixed extension calculation; A32 registers paired31-60 then61-90.
No historical score is corrected or pooled, and prefix causality stays open.

Read-only historical isolation investigation confirms e62e06f sources/lockfile
are available but neither historical dist nor v3 harness is tracked. Five raw
hashes match the extension audit; only text/fault/reopen record the commit,
and none pins complete native/harness executable identity. A9 sidecar cannot
attest to older Finder rows. HISTORICAL-REPRODUCTION.md retains the safe
prospective clone/build design and missing evidence. Parent now searches
contemporaneous session archives rather than treating absence from git as
proof that recovery is impossible. No historical extension is pooled or waived.

A29 repaired monotonic delayed-page exploratory pilot verifies both routes
1/1, both owned closures and zero disturbance, producer/verifier exit0.
Raw SHA2562d42aa15b1e497ed19bc6f74159b778e5903583612c00aca789d84e2bc625cf7.
Separate final read-back finds Safari AX inventory empty and model18324
hidden with zero tabs. A31 preregisters a separate repaired-harness thirty-pair
cohort; historical A28 failures/verdicts remain unchanged and unpooled.
This new measurement cannot by itself attribute the old prefix failures.

Prospective live-stop T4 OmO+apple pilot passes full offline fixture/safety
verification with no unsupported fields, producer/verifier exit0, SHA256
707a572af415afa57759f47c7262199ad6812993a6ee369b9bf488897bc13101.
Separate final absence read-back exits0: zero TextEdit documents, empty
TextEdit/Safari AX inventories and all three exact owned files absent.
Raw matched-model usage retains sixteen model-facing/seven driver calls,
86394 tokens and reported cost1.58158. This n=1 instrumentation QA is
separate from the previous raw-evidence pilot and supplies no paired verdict.
Compatibility checkpoint now records completed cross-app/Settings extensions
instead of stale active/pending text. Read-only historical-revision isolation
investigation runs separately, with no build or GUI input authorized to it.

Recovery/planning metric audit finds T4 stores duplicate_marker but common
analysis summarizes duplicate_input, dropping retained measurements. Regression
fails with actual null versus expected0.5 for mixed true/false observations.
Scoped prospective normalization copies only explicit boolean T4 agent
duplicate_marker values; absent values remain missing and raw rows unchanged.
All fourteen analysis tests and scoped Biome pass. Reanalysis of the verified
raw-evidence exploratory pilot exits0 and retains one observed duplicate_input
value0 (rather than one missing observation), task success1/1, E2E94.840s,
eleven model-facing calls, 82111 input/output tokens and reported cost1.26227.
This single-route pilot supplies no paired comparison or scored verdict.
Minimal-plan action counts remain
missing where no plan length was preregistered; no post-hoc minimum is invented.

T4 raw-evidence OmO+apple pilot independently verifies full fixture and safe
cohort evidence (exploratory n=1 only), SHA256
299c48fcc4c998b41d50f45eeda84d0c722a25276a999b9b5d9b0adc40cb42fb.
Offline verifier exits0 with no unsupported fields or issues. Separate final
read-back confirms zero TextEdit documents, empty TextEdit/Safari AX inventory,
Safari model18254 hidden with zero tabs and all three exact owned files absent.
No scored T4 cohort is inferred.

Baseline safety investigation exposes a harness gap: activation/cursor trace
was summarized only after agent completion, so the batch-level stop could
not interrupt the current agent. A failing regression precedes prospective
live event delivery and AbortController cancellation; setup checkpoints refuse
agent launch after disturbance. Events retain setup/agent phase. Already
dispatched or synchronous operations cannot be recalled; this is not a proof
of zero cancellation latency. Historical baseline rows remain unchanged and
baseline GUI input remains stopped. Full benchmark tests pass221/221; scoped
formatting initially found one new assignment-expression violation, corrected
before recheck. Scoped Biome and event regression pass. Swift compilation and
real read-only helper lifecycle exit0: final summary and stream both contain
zero activation events, zero cursor movement and TextEdit frontmost throughout.
This short lifecycle validates the real protocol, not cursor sampling coverage.
The next exploratory OmO+apple fixture pilot uses the new source hashes and
live-stop instrumentation; disturbed baseline routes are not restarted.

Baseline T4 pilots both pass task/control oracles and cleanup, but both
record focus disturbance. Native trace records an unnamed activation then
Terminal restoration; Cua trace records TextEdit activation115ms after trace
start and remains frontmost. The trace includes setup, so attribution to
agent input is not established. Producer incorrectly continued after the
first safety flag; no further baseline GUI input is launched. Regression
preceded a fail-closed gate aborting subsequent slots on positive/missing
trace evidence. Full raw independent inputs/baseline nonce are now retained
prospectively. Thirty-five tests pass; formatting/syntax recheck pending.
Independent final app/document/file absence verifies both pilots' cleanup.

Prospective T4 raw-evidence audit finds saved source/control bytes retained,
but live source/control and page outcomes stored only as oracle booleans.
Before scored registration, retain those independent read-back values and
assigned baseline nonce so offline verification can recompute the whole
oracle. This does not invalidate observed pilot read-backs, but the current
raw cannot fully reproduce them. Active Cua/native pilot source stays fixed;
its outcomes and cleanup must be inspected before any instrumentation edit.

Repaired T4 OmO+apple exploratory pilot passes independent page/saved-source/
live-source/control oracle, matched observed Astra, zero recorded disturbance
and empty task-owned leftovers; producer exit0. E2E102.132s, eighteen model
calls/nine driver calls, usage/cache/cost retained. Prior actual false success
remains separate, not overwritten. Independent final absence read-back is
running; paired baseline fixture pilots are next before scored registration.

T4's false-success pilot owned cleanup independently verifies document count
zero, TextEdit/Safari AX IDs empty, Safari hidden zero-tab model and both
owned files absent. Unexpected CursorUIViewService surfaces remain raw.
Exact PID512 bundle com.apple.TextInputUI.xpc.CursorUIViewService has
successful empty AX inventory; failing regression preceded prospective
inactive-service classification matching the existing AppKit service guard.
Scoped checks are running. No historical cleanup or false-success score changes.

Revised T4 OmO+apple pilot records actual false success: matched Astra says
RESULT DONE, independent page and live source pass but saved source bytes
are "Bench-v2 marker 8c52ac", so full oracle fails. Control file/live control
unchanged, zero measured disturbance, twelve model calls/six driver calls,
90.804s, usage records retained. This is an agent finding, not driver proxy.
Owned closures completed; cleanup retains two unexpected CursorUIViewService
surfaces, no unknown surface closed. Independent owned absence read-back
is running. The prior Safari denial correction now permits real execution.

A28 final endpoints verify scrolling both90/90, delayed Apple88/90 versus
Cua90/90, all360 closures and zero disturbance. Delayed S1/R1p/R2 remain
inconclusive; historical prefix failures retained. Reversed-arrival page
regression independently exposes missing event ordering; it is not causal
proof of either historical failure. Prospective monotonic oracle repair
passes eleven tests/Biome and is registered separately in A29. New guarded
T4 pilot follows; no historical score or source identity is rewritten.

Retained delayed-field Apple iteration60 is an independently verified short
reported page value: field "Bench-v2 marker 8c5" versus required final "2"; no tool
exception, ready true, assigned nonce verified, proxy false_success true.
Six verifier regressions and Biome pass; updated diagnostic output retains
identity and page state without changing raw/scoring. A production/harness
causal investigation is tracked; active fixed61-90 native subject stays fixed.
Later forensic review also finds the full marker in both failed typing-call
arguments and AX readbacks at60 and90. Missing DOM/report event histories
prevent attribution to input loss versus stale asynchronous reporting.
DELAYED-TRUNCATION-DIAGNOSIS.md preserves the evidence and limits; failures
remain scored, and repaired-cohort success does not prove historical causality.

A28 blocks 31-60 verify scrolling both 30/30, delayed Apple 29/30 and
Cua 30/30. All 120 stage closures and traces verify, zero disturbance;
independent final Safari AX inventory empty and hidden model zero tabs.
Cumulative delayed Apple failure is retained (59/60 versus Cua 60/60);
fixed final61-90 collection follows with unchanged plan and oracle.

The auxiliary service flagged in T4 cleanup is independently identified as
PID 28644, com.apple.appkit.xpc.ThemeWidgetControlViewService, with empty
successful AX inventory. A failing regression preceded the classification
correction: only exact independently bound, off-screen auxiliary surfaces
are separated from task-owned leftovers, with evidence retained per row.
Unknown/live surfaces remain blocking, no close action is added. Thirty-two
agent/configuration tests pass and scoped Biome/syntax pass. Live retry is
pending; no original cleanup outcome or task failure is rewritten.

A27 scored scroll/delayed collection exited 0 and verifies both routes
30/30 on each task, 120 closures, zero disturbance; independent Safari
AX inventory empty and hidden model zero tabs. Separate scoped intervals
and hashes are in SCROLL-DELAYED-RESULT.md. S1/R1/R2 PASS; R1p and
report/safety claims inconclusive. A28 registers fixed extensions with the
original two-task schedule stream preserved, not separate-task reseeding.

T4's observed Safari denial is corrected prospectively in the isolated
benchmark process configuration: only TextEdit/Safari are passed for that
task; default Finder/TextEdit routing, Cua/native hands, installed client
configuration and macOS permissions are unchanged. The original denied
pilot remains a failure. Thirty-one agent/configuration regressions and
scoped Biome pass. Live retry waits until the A27 driver producer finishes;
unrelated new-service surface cleanup classification still requires evidence.

Historical-subject feasibility probe confirms e62e06f commit exists locally
and remains HEAD; macos.ts has the documented uncommitted native correction
(51 insertions, four deletions). The historical text raw records the exact
e62e06f commit but no built-source hash in its closing metadata. Therefore
an isolated rebuild is feasible without reverting the shared worktree, but
cannot yet prove byte-identical historical runtime identity. EXTENSION-AUDIT
obligations remain open, with this provenance limitation retained.

Scroll/delayed exploratory Safari pilot verifies both routes on both tasks,
all four closures, zero disturbance; raw SHA-256
7ca4644078e5b07383acdcc04bf8c724de923003347170706734addc21815352.
Independent final Safari AX inventory empty and hidden model zero tabs.
Five verifier tests and scoped Biome pass. A27 registers a separate
thirty-pair matched-driver cohort before collection, explicitly retaining
delayed readiness outside task latency and no recovery-speed inference.

Two-app exploratory pilot after the TextEdit guard correction verifies that
retired TextEdit surfaces no longer block setup. Both routes still stop
before input on pre-existing Finder windows (zero calls, no disturbance,
empty task-owned cleanup); originals remain in separate raw artifacts.
Sixteen scoped tests pass plus Biome and syntax. The owned Finder model
oracle has not yet executed live; personal/unknown Finder windows remain
untouched. Next independent coverage is the registered Safari scrolling and
delayed-field driver fixture pilot, not a substitute for the missing two-app task.

Full benchmark regression suite passed 199/199 with no desktop producer.
Subsequently, the two-app Finder oracle regression reproduced personal
front-window path selection instead of the owned path. The correction binds
a unique Finder model by initial owned directory before action and reads
that model ID afterward; missing IDs refuse rather than fall back globally.
Scoped tests/source checks are running; live binding QA remains pending.
The earlier 199-test pass does not cover this subsequent oracle change.

Isolated exploratory T4 OmO+apple pilot retains failure: observed matched
Astra reports NOT DONE because the per-process benchmark server permits
Finder/TextEdit but not Safari. Five model-facing calls, two driver calls,
usage/cache/cost records retained; zero task/cleanup disturbance and no
changed outside-target files recorded. Exact owned closures completed, but
the generic new-surface cleanup guard flags ThemeWidgetControlViewService
as a leftover, so the producer exits 1. No unknown service surface is closed.
Independent owned app/document/file absence read-back is running. This is
not a thirty-run agent result or an input-path production defect.

Settings A26 final endpoint verifies both routes 90/90, all 180 owned
window/process cleanups and zero disturbance; final pgrep confirms absence.
S1/R1/R1p/R2 PASS, F1/F1p/D1 INCONCLUSIVE. SETTINGS-RESULT.md records
final hashes and intervals. Next is exploratory revised T4 agent live QA,
separate from every driver denominator; no scored agent cohort is claimed.

A26 Settings blocks 31-60 exited 0, both routes 30/30 in stage,
cumulatively 60/60 each. Stage verifier confirms sixty distinct owned
PID terminations and zero disturbance; independent pgrep confirms Settings
absent. The cumulative analysis and claims are saved separately; final
registered blocks 61-90 follow with the same subject/plan/oracle.

Read-only preparation for the remaining two-app driver task identifies a
global front-window Finder oracle in remaining-driver-run.mjs. It is not
safe evidence of the owned background window's target. Existing finder-run.mjs
uses an independently bound Finder model ID; adopt that scoped oracle with
a failing regression before live two-app collection. The active Settings
producer's source is left unchanged; this discovery does not alter Settings
outcomes. Finder's unresolved AX identity remains a separate fixture gate.

Cross-app's registered ninety-pair endpoint is complete: Apple 90/90,
Cua 0/90, all 180 cleanups verified and zero disturbance. Independent final
TextEdit document count zero, both AX inventories empty, Safari hidden
model zero tabs. S1/R1/R1p/R2 PASS, F1/F1p/D1 INCONCLUSIVE.
CROSS-APP-RESULT.md records final hashes and intervals. Settings A26
blocks 31-60 follow after verified cleanup; no agent results are inferred.

Repository static-check wave: workspace typecheck and test typecheck pass
exit 0. Full lint reports twenty-nine formatting errors: twenty-eight
unrelated .omc runtime-state JSON files, left untouched, and the benchmark
Safari inventory script. The latter received a formatting-only correction
and equivalent if-based control flow to avoid formatter-version disagreement;
scoped Biome and JavaScript syntax verification pass, exit 0. No measured binary was rebuilt. Parent
agent guard checks pass nineteen tests plus scoped Biome after the live
tab-count coercion fix. Full pnpm check is not claimed green.

Parent review of delegated T4 liveness guards found a reintroduced live
AppleScript tab-count coercion defect. Read-only reproduction failed with
-1700 converting a tab list to text; explicit count-before-text correction
then returned a valid live model row (visible true, one tab). The active
cross-app fixture was observed only, not changed. Scoped agent tests/Biome
are running after the parent correction. Delegated nineteen deterministic
tests passed before this correction; full guarded T4 live QA remains pending.

Cross-app A24 blocks 31-60 verify Apple 30/30 and Cua 0/30, sixty complete
cleanups and zero disturbance; cumulative counts are 60/60 and 0/60.
Independent read-back finds TextEdit documents zero and AX IDs empty;
Safari AX IDs empty and hidden model zero tabs. Stage raw hash is recorded
in CROSS-APP-RESULT.md. Final blocks 61-90 follow without dropping failures.

Link's final registered ninety-pair endpoint is verified: both 90/90,
all 180 closures verified, zero recorded disturbance; independent final
Safari AX inventory empty, hidden model zero tabs. S1/R1/R1p/R2 PASS,
F1/F1p/D1 INCONCLUSIVE. LINK-RESULT.md records final hashes and intervals
without deleting checkpoints. A24 cross-app blocks 31-60 are next.

A22 link blocks 31-60 exited 0 and verified both routes 30/30 in that
stage, complete sixty closures and zero disturbance. Cumulative counts are
60/60 each. Independent Safari inventory reports AX IDs empty and only a
hidden zero-tab model; retired off-screen surfaces are retained, not closed
again. LINK-RESULT.md records the stage hash and cumulative speed interval.
The registered final stage 61-90 follows. Seven deterministic Settings/browser
cohort verifier tests passed without desktop fixture acquisition.

A25 Settings collection exited 0. Independent cohort verification confirms
both routes 30/30, sixty distinct owned PID terminations, complete window
cleanup and zero recorded disturbance. Final pgrep finds System Settings
absent (compound command exit 0). Raw SHA-256 is
c763843fd84a65faa0ef2f77b481afa6c7e30da5fa5b85e132b57897f2f1c8fe.
Task-scoped S1/R1/R2 PASS; R1p remains inconclusive. SETTINGS-RESULT.md
records intervals and extension eligibility. Original driver coverage is
now 20/21, not completion of the broader benchmark. A22 link extension
is the next producer; its stronger outside-latency cleanup is disclosed.

Corrected Settings surface/process pilot verifies both version tasks, zero
measured disturbance, exact window/surface closure and distinct owned PIDs
19756/20003 independently gone. The prior closing-surface cleanup stop remains
in its artifact; independent surface observer later verified its retirement.
Sixteen related tests and Biome pass. A25 preregisters the separate thirty-pair
Settings version cohort and records the sw_vers expectation prospectively.
Form's ninety-pair extension is complete with both routes 90/90, 180 verified
closures and zero disturbance; FORM-RESULT.md retains checkpoint and final
population/speed PASS separately from unavailable safety/report-based claims.

Parent-reviewed revised agent T4 runner passes fourteen deterministic tests
and scoped Biome after formatter corrections. Native/MCP built subject hashes
are included. Exact AXDocument mapping and model/AX/compositor guards are
prospective only until live QA. T5 is refused before fixture creation because
unsaved-document ownership is not proved; this is unavailable fixture coverage,
not a measured driver/agent failure. Old artifact provenance is rejected before
recovery, and generic Untitled cleanup is removed.
Fresh read-only remaining-app inventory finds System Settings not running.
Finder retains unknown AX identity error -25201; off-screen WS rows alone are
not absence proof. TextEdit AX inventory is empty. No unknown window was closed.

Parent reviewed and compiled ax-document-identity.swift, exit 0. It maps
only the requested owned path through AXDocument to a compositor ID,
requires successful AXWindows access, explicitly reports unsupported
document identity as unknown rather than absence, and never returns
unrelated titles/paths. No live probe ran. It cannot identify unsaved
agent-created documents, so it does not by itself establish safe T5 cleanup
or agent task execution. A24 preregisters the cross-app fixed extension
before further measurements; active form extension still owns the desktop.

A23 cross-app cohort verifies all sixty rows: Apple 30/30, Cua 0/30,
document/AX/surface closures, both owned windows and owned files removed,
zero measured disturbance. Independent final TextEdit count=0 and AX IDs=[].
Corrected hash-pinned analysis and claims generated; CROSS-APP-RESULT.md
records the R1p fixed extension obligation. Coverage now 19/21 original
driver tasks, not agent or whole-suite completion.
The previously lock-blocked native window-event test reran alone after
producer exit and passed 1/1. This explains the earlier 181/182 run rather
than claiming that run green. A22 form extension 31-60 is active only after
the observer test exited.

Broad harness run after fixture repairs: 182 tests, 181 pass, one failure.
`window-event.test.mjs` explicitly acquires the shared desktop lock and failed
EEXIST because the active cross-app producer owns it. No lock was removed or
test weakened. This run is not a green suite; rerun the shared-lock observer
test only after desktop producer exits. The run was incorrectly described as
fully deterministic; that test compiles/starts a native observer but performs
no input and safely refused overlap.

Live compositor-event cross-app pilot verifies both route closures:
document_count=0, ax_live=false, on_screen=false, empty leftovers, exact owned
files removed and zero measured disturbance. Apple independently transfers
the marker; Cua pastes unchanged sentinel and fails the original oracle.
`browser-cross-app-surface-event-smoke.json` remains exploratory. A23 records
the event-driven cleanup instrumentation and preregisters a separate thirty
paired cross-app cohort without changing driver plans or thresholds.

Instrumented cross-app cleanup read-back pins the actual mismatch:
document_count=0, ax_live=false, on_screen=true. Independent later exact
surface 8389 is onScreen=false. This is compositor retirement lag, not proof
that dictionary close or AX destruction failed. All raw cleanup stops remain.
The owned source file was removed only after document/AX absence and
off-screen read-back.

Read-only native surface observer compiles and two deterministic protocol tests
plus Biome pass. Existing capabilities report on-console, unlocked, background
delivery and both permissions already granted; no permission requested.
ScreenCaptureKit frame events trigger only exact CGWindowList owner/ID
checks; pixels are never accessed or recorded, and the 10-second deadline is
failure-only, not a polling timer. Off-console/unavailable streams fail
explicitly. Integration regression failed before repair: cleanup now subscribes
before close and requires both AX destruction and compositor surface absence,
then independent read-back. Checks and a separate live cross-app pilot run
before any scored cross-app collection.

Cross-app exploratory Cua row failed independent page transfer (field remained
clipboard sentinel), recorded zero disturbance, and stopped Apple on the
initial owned TextEdit AX cleanup check. Independent later exact canonical/
tmp document count is zero and TextEdit AX window inventory empty. The sole
owned leftover source file was inspected, removed via apply_patch and verified
absent; no personal window was closed. Original raw failure remains unchanged.
The owned-document retired-surface regression failed before repair. Prospective
closure checks exact owned path absence and off-screen state, never treating a
live document or visible window as closed. Scoped checks are running.

A21 link cohort completes both routes 30/30 with all sixty owned closures and
zero measured disturbance, verified by full-file CLI. Corrected hash-pinned
analysis and claims generated; `LINK-RESULT.md` records speed PASS and R1p
INCONCLUSIVE with fixed extension obligation. Coverage is 18/21 original
driver tasks. A22 preregisters separate form/link extensions, not a newly
interleaved route stream. Sixteen scheduling/validator regressions and scoped
Biome pass after failing-before-fix evidence. A uniquely owned cross-app pilot
is running before any cross-app scored collection.

A20 form cohort verified all sixty identities, nonce/field outcomes, traces
and closures; both routes 30/30. Reproducible browser validator tests and
Biome pass, and the CLI confirms the raw SHA
0de3efa438470a2589370fe084d45927e11a52f864078b80ccd3f9c4fbdafd07.
`FORM-RESULT.md` separates speed/observed-completion PASS from population
completion INCONCLUSIVE and records the fixed extension obligation. Coverage
is 17/21 original scored driver tasks, still not full completion.
Both exploratory link pilots independently pass assigned nonce/hash oracle,
owned closure and zero measured disturbance. A21 link collection starts only
after successful form validator; no scored pilot substitution or pooling.

`browser-form-live-surface-smoke.json` independently verifies both routes'
form completion, matching fixture document nonce, exact marker, owned-window
closure and zero measured disturbance. Cua uses eight calls, Apple four.
Both exploratory rows remain excluded from scored denominators. A20
preregisters the separate thirty-pair form cohort; prior zero-call fixture
failures and unstarted slots remain retained.

A19 heading extension completes all ninety pairs: Apple 90/90, Cua 0/90,
180 verified owned closures, zero measured disturbance. Cumulative hashed
analysis gives population completion PASS and speed FAIL; missing safety
and actual-report evidence stay INCONCLUSIVE. Final read-only inventory
overlapped the subsequent browser pilot but confirms no AX windows and only
its retired zero-tab model, not a remaining heading page.

Browser form pilot stopped before driver calls on fixture ownership mismatch,
closed exact owned 7768, and preserved the unstarted Apple row. A deterministic
hidden-surface regression failed before repair: independent AX/model/onscreen
absence now excludes a newly created hidden nonfixture surface while exact
title ownership and live unknown-surface refusal remain. Twelve harness tests
pass; formatting correction and a separate live form pilot are pending.

Parent source review of browser-run repair adds finished_at persistence and
retains exact owned-ID closure, page-nonce oracle, continuous trace guard and
unstarted slots. Related browser/driver/page tests passed 18/18. The subsequent
formatter-stable equivalent client setup passed harness tests 11/11 and scoped
Biome. No live browser fixture or task is claimed verified by these tests.
Live QA waits for the active heading extension's desktop lock; no browser
producer overlaps it.

A18 Calculator collection completed, exit 0: both routes 0/30. Whole-file
validator confirms 60 distinct independently terminated owned processes and
zero measured disturbance. Final process inventory confirms Calculator absent.
Hashed corrected analysis and claims generated, exit 0. Completion fails;
all-attempt speed passes, describing faster failure rather than successful
copying. `CALCULATOR-RESULT.md` preserves historical deviations separately.
Coverage is now 16/21 original scored driver tasks. A19 heading extension
blocks 31-60 have started after Calculator exit, with no overlapping desktop
producer; extension and full benchmark remain incomplete.

Ready-window Calculator pilot independently verifies distinct owned PIDs
47646/47851 terminated and zero measured disturbance. Cua performs seven calls
but leaves clipboard sentinel unchanged; Apple refuses background Copy after
six calls. Both original-oracle failures remain. Fourteen deterministic tests
and Biome pass. A18 preregisters fresh-process, event-ready, corrected-timing
thirty-pair collection separately from earlier shared-process evidence.

Prospective Calculator lifecycle repair has deterministic checks and a live
exploratory pilot: fresh PIDs 45730/45811 independently terminated, zero
measured disturbance. Timing now excludes setup and cleanup. Cua's first
observation found no window although launch notification had arrived; Apple
reached the preserved background Copy refusal. These rows remain failures,
not scored collection. The window-readiness regression failed with missing
expected rejection before correction. Prospective setup subscribes to AX
window creation before launch and waits for readiness outside timing while
retaining the launched PID for cleanup on a readiness failure. Related checks
and a separate pilot are pending before any thirty-pair rerun.

A17 heading collection completed, exit 0: apple 30/30, Cua 0/30.
Whole-artifact validator confirms 60 closures and zero measured disturbance.
Final independent Safari model and AX inventories are empty; historical
hidden WindowServer surfaces remain untouched. Hashed bootstrap analysis and
task claim ledger were generated, exit 0; `HEADING-RESULT.md` reports separate
claims and the registered R1p extension obligation. Coverage now has 15/21
completed scored original driver tasks, not full benchmark completion.

Direct Cua pilot call provenance distinguishes refusal from fixture setup:
list_windows and exact-window observation are followed by a successful
background Cmd+L; subsequent type_text refuses same-PID ambiguity. Its raw
array contains both the returned tool error and caught exception for that
single fourth call, not a fifth dispatch or duplicate input. Driver.calls is
four. Do not infer input duplication from raw-array length.

`safari-heading-cua-postclosure-smoke.json` retains Cua's four-call background
keyboard refusal, with zero movement/activation. Post-closure independent
inventory verifies unexpected surface 6644 absent and owned 6645 closed:
cleanup error null, leftovers empty. Both route cleanup pilots are now
verified, permitting A17's thirty randomized paired heading blocks. Twelve
related tests and Biome pass. The original stopped artifacts remain intact.

Cua nonce pilot `safari-heading-cua-nonce-smoke.json` retains four-call
same-PID ambiguity refusal, zero measured disturbance, and original cleanup
stop for surface 6638. Independent subsequent inventory finds no Safari model
or AX windows and no surface 6638. The cleanup runner previously copied
pre-closure unexpected IDs into leftovers without reading their post-closure
state. A regression failed before correction. Prospective cleanup now reads
all target inventories after owned closure, retains the unexpected IDs as
evidence, and reports only independently still-live IDs as leftovers. Unknown
surfaces are never closed; inventory errors remain failures. Related checks
are running before a new Cua pilot.

Corrected live Apple heading pilot
`safari-heading-nonce-guarded-smoke.json` verifies different setup/result
document nonces, prescribed heading, five calls, zero measured disturbance,
and closed owned window 6630 with no leftovers. Eleven related tests and
Biome pass. A17 records the prospective paired collection contract; the Cua
cleanup pilot is pending before any scored collection.

Independent Apple heading pilot reported PASS in
`safari-heading-apple-independent-smoke.json`, with five calls, zero measured
disturbance and owned-window closure. Inspection found that the predicate
passed null rather than the setup nonce, so an unchanged setup page could
satisfy completion. This pilot is exploratory, not navigation success evidence.
An extracted predicate preserving the original behavior failed its regression
(true !== false for the setup document). The prospective runner captures a
reported setup nonce before timing/actions and requires a different nonce.
No raw outcome is rewritten. The earlier Cua pilot retains same-PID ambiguity
refusal and cleanup stop; independent read-back later verified no AX window
or tabs and no remaining unexpected surface.

The producer's exact live Safari serializer reproduced a model count error:
6601:false:13, while an independent tuple read reported zero tabs. Synthetic
record tests did not reproduce the live object-specifier behavior, including
under Safari command dispatch; they are not claimed as failing regressions.
The parentheses correction changes only count-before-text coercion. Exact
live rerun now returns 6601:false:0, agreeing with the independent model and
empty AX inventory. Before/after evidence is retained in command results;
logical task scoring and refusal thresholds are unchanged. Related checks
run before another independently named live fixture pilot.

Reconciled Safari heading pilot again retained two zero-call fixture failures:
pre-existing Safari window refused. No new page was launched or unrelated
window closed. A read-only triple inventory now captures WindowServer,
dictionary visibility/tab counts and exact AX IDs in one process to identify
which protected surface triggers refusal. It does not inspect tab URLs or
personal content. The conservative guard is not weakened on speculation.

Prospective Safari cleanup now uses the exact newly owned Safari dictionary
window ID, avoiding the observed ambiguous Close Window menu. Completion is
checked against combined successful dictionary/AX/WindowServer inventories:
an empty hidden retired model is not a live leftover, but any tab-bearing,
visible or live AX window stays protected. No historical failure is changed.
Source tests/checks run before new live ownership QA; Settings remains
unavailable with its uncertain pre-existing window.

Independent Safari AX inventory for exact PID 5190 succeeded with zero AX
window IDs, corroborating retired 6601 and absent live fixture surfaces.
A second failing regression distinguishes nonvisible WindowServer surfaces
absent from both successful Safari dictionary and AX inventories from hidden
real windows. Prospective eligibility now omits only those reconciled inactive
surfaces; any visible, tab-bearing, live AX or unresolved object remains
eligible/protected. No tab contents or credentials are inspected. The helper
is compiled per run and cleaned up afterward. Related checks are running.

A retired-Safari classification regression failed with IDs [1,2,3,4] where
only [2,3,4] were eligible: independent hidden+zero-tab object 1 was being
treated as active. The prospective filter omits only positively empty retired
objects with matching dictionary evidence; hidden real windows with tabs and
unreconciled surfaces remain protected. Nine related tests pass; formatting
diagnostics are being repaired, not suppressed. A read-only exact-PID AX ID
inventory uses the project's existing _AXUIElementGetWindow mechanism to
reconcile remaining surfaces. It requests no access and never posts input.

Safari recovery clarified with independent read-backs, not error inference:
on-screen inventory no longer contains 6601; exact Safari model read returns
6601,false,0 (hidden, zero tabs). Current-tab read -1728 alone was not accepted.
The owned local page/visible window is closed, while a retired scripting
object remains. The original pilot cleanup failure and timed-out count watch
are preserved. SAFARI-RECOVERY.md records this scope; no further input is
sent to empty/unknown surfaces. Active-vs-retired surface classification and
exact Safari cleanup need prospective regression coverage before collection.

Exact Safari 6601 closure watch timed out after 120 s without observing
absence. Cleanup is unresolved, not inferred from the AppleScript close
request's exit 0. A narrow background MCP observation now captures only
that positively identified loopback window after rechecking its exact URL;
it dispatches no input and changes no installed approval/TCC setting.

Safari-heading pilot failed at fixture preparation with zero driver calls:
extra WindowServer surfaces 6598/6600 and a positively owned local page
window 6601. Background menu-based closure was ambiguous, so its original
cleanup failure is retained. Independent Safari dictionary read verifies
window id 6601, title Personal — Local benchmark 8c52 and exact
http://127.0.0.1:55387/page. Recovery rechecks that identity before closing
only that window, without activation. Immediate AppleEvent count was 1,
so absence is not yet claimed; an exact-id absence subscription is armed.
Other surfaces and uncertain Settings window remain untouched. The owner
cannot identify the Settings window; no permission or security change is made.

Corrected Settings fixture pilot retains both zero-call failures:
pre-existing System Settings window refused. Independent inventory shows
blank-titled window 6595, PID 467 owned by bob; the installed bundle identifier
matches com.apple.systempreferences, rejecting wrong-bundle hypothesis.
That window appeared after the first failed launch/cleanup and is not
positively attributed; the previous empty owned list does not prove no
delayed leftover. No action is taken on it while ownership clarification
is pending. The next independent Safari-heading owned-fixture pilot runs
the original logical actions with prelaunch observation, not a page-fetch
substitute. Settings observer notification support is still unresolved.

Settings source-aware pilot exited 0 but both rows failed during fixture
preparation with zero driver calls. Cua observer exited 4; owned window 6588
was closed and read back absent. Apple observer exited 3 and created zero
identified windows. Both retained as exploratory infrastructure failures.
Competing explanations: late cold-launch subscription, unsupported AX
notification and incorrect initial title. The late-subscription regression
failed with order [launched,subscribed]; fixture preparation now subscribes
before launch. Unknown Settings title uses an app-scoped wildcard only while
the pre-existing-window refusal and independent unique-new-window read-back
remain enforced. Related checks run before further live ownership QA.

Source-aware Calculator cohort completed and full-file validated, exit 0:
apple 0/30, Cua 0/30, measured zero disturbance in sixty rows, newly owned
PID 93526 independently gone. SHA256
`2db6f4a468abbc6e4737e52671426eff581784c7480272a509d540c32249d421`.
The local result explicitly preserves shared-process lifecycle and elapsed
metric deviations; no strict per-attempt-isolation or S1 claim is made.
One Settings-version owned-fixture pilot is now running with the original
navigation steps, output/source pinning and stop-on-disturbance/cleanup guard.

Calculator validator preparation explicitly records the producer lifecycle:
one newly owned process is shared across the cohort and terminated at the
end, not sixty fresh per-attempt app closures. Clipboard sentinel is reset
per attempt. This is an isolation/cleanup interpretation limit relative to
the general per-attempt fixture rule; no sixty-closure claim will be made.
Its current elapsed metric also begins before sentinel/trace setup, so it
is not an exact first-driver-call-to-last-call interval. Retained rows are
not rescored; task scope and these limits must accompany results.

Remaining-task source now refuses output reuse and pins runner, adapter,
observer and native built-module hashes before any new live ownership QA.
This is prospective provenance only; it does not manufacture missing
settings/Safari/cross-app runs. Related logical-plan and trace-finalizer
checks and a no-input dry-run are running independently while Calculator
retains the sole desktop lock.

The source-aware Calculator pilot completed, exit 0: both original-oracle
attempts FAIL, Cua sentinel mismatch and apple explicit background Copy
refusal. Both traces show zero movement in both APIs, no mouse events or
activation. Owned Calculator process termination verified. A16 registers
the separate thirty-pair source-aware cohort now running; the interrupted
old three-row cohort and exploratory evidence remain unchanged, not pooled.

Full harness after extension scheduling/provenance/closure and analysis-merge
guards passes 142 tests; Biome checks 77 source files, exit 0. A single
paired Calculator fixture pilot is now testing prospective mouse-source
tracing on its original background key path. This is exploratory, separate
from the stopped three-row historical cohort, and retains failures. It
refuses an existing Calculator process, stops on disturbance and verifies
the newly owned PID is gone. No access/security change or foreground retry.

Ninety-pair task claims are complete: apple 90/90, Cua 0/90; R1p now PASS
with Wilson lower bound 0.959064. S1 remains FAIL, final p95 ratio 6.43285
with paired CI [5.50556,6.81119]. R1/R2 PASS; actual-report F1/F1p and D1
remain INCONCLUSIVE. The local report retains initial checkpoint estimates
and all three source hashes; no suite-level victory or matrix completion
is asserted. This task's mandatory 60/90 extension is fulfilled.

Final registered two-window extension completed, exit 0: blocks 61-90
apple 30/30, Cua 0/30, all 60 measured traces clean and owned closures verified.
Raw SHA256 `137d4d38ae216c4bb11e31f4a01d347493b3c0c8c005b4e361932adff3f7a4cf`.
Independent post-run exact-path AppleEvent inventory exited 0 and counted
zero owned documents. The cumulative ninety-pair analysis and task claims
are running with all three nonoverlapping provenance files. This completes
this task's registered extension, not the remaining driver or agent matrix.

The extension validator's CLI regression exposed acceptance of an absent
max_cursor_px field when producer flags said false. The failing test preceded
the fix: finite cursor measurement and an activation array are now required.
This strengthens artifact evidence, not scoring thresholds or exclusions.
First-extension revalidation and both CLI tests are running while the final
registered extension proceeds.

First registered extension completed, exit 0: blocks 31-60 contain apple
30/30 and Cua 0/30, all 60 cleanups verified and zero recorded disturbance.
The full artifact validator checked every row (not a partial grep scan).
Raw SHA256 `3508799d83acacff4c27c0b707df589c38cfe020dee2f453f6b4cd9b0a8bd191`.
The cumulative 60-block analysis preserves both nonoverlapping provenance
files: apple 60/60, Wilson lower bound 0.93983, so R1p remains INCONCLUSIVE.
The fixed registered continuation to blocks 61-90 is running after that
validator passes. No extension rows are excluded or thresholds changed.

Extension analysis guard was regression-first: passing the same raw cohort
twice silently duplicated primary denominators while paired rows collapsed
onto the same identities. The new CLI regression reproduced that bug.
save-analysis now refuses duplicate (route,task,iteration) identities rather
than producing an ambiguous merged comparison. Interrupted unpaired attempts
remain included as before. Original artifacts are unchanged; guard checks
are running while extension collection continues.

Source-aware Cua exact-window pilot completed, exit 0: explicit
same_pid_keyboard_ambiguity refusal, task FAIL, zero movement in both APIs,
zero mouse events and activation, exact owned-document absence verified.
The registered strong-task first extension is running at paired blocks
31-60 under A15. Its scheduling regression passes; staged block IDs/order
equal a single seeded 90-block schedule. Original thirty rows and both
exploratory pilots are not rewritten or counted as additional observations.
All other disturbed input paths remain stopped.

`text-two-window-source-pilot.json` completed, exit 0: apple task oracle
passes, saved/live control unchanged, no duplicate input, both exact document
paths independently absent after closure. Its 43 samples show zero movement
in both APIs, zero API disagreement, zero mouse events and no activation.
The built native hash remains `a8c4114c5c64f967a2a3fa95ea8b48f7e32790f8fd4df4050ebb5acecf28465c`.
This is an exploratory safety/fixture pilot, not a scored extension.
One Cua-only equivalent exact-window pilot is running before any paired
extension decision; other input paths remain stopped.

One source-attributed apple-only exact-window text pilot is starting,
exploratory and not added to the scored matrix. This previously completed
30-pair task has no explicit physical-pointer action in the native background
path. Newly proven independent Screen Sharing movement prevents attribution
from historical cursor distance alone, without erasing those flags.
The prospective producer now stops on failed tracing or any disturbance,
retains mouse source metadata and source hashes, and independently reads
back absence of both owned document paths after closure. Native/Cua agent
and Calculator replay remain stopped. Initial source formatting diagnostics
were repaired before launching; no raw cohort was overwritten.

Regression-first cost evidence repair: a new parser test failed because
client cache-write/scope records were lost. Prospective agent results now
retain raw usage objects with assistant-message versus turn-aggregate scope,
including cacheWrite when reported. No aggregate becomes invented per-request
pricing evidence. Existing aggregate token/cost fields and historical rows
are unchanged. All 138 v3 tests pass; Biome checks 73 source files, exit 0.

The machine-consumed local task claim ledger is generated at
`.bench/v3/task-claim-ledger.json` from six corrected analysis cohorts,
each retaining analysis SHA-256 and raw provenance. Cohorts are not pooled.
It reports incomplete Calculator comparisons as INCONCLUSIVE and makes no
automated report-based F1/F1p or causally attributed D1 verdict.
Both actual CLI regression tests pass; Biome checks both producer/test files
successfully, exit 0. This verifies the claim producer's partial/full sample
gates and missing-report semantics, not the unfinished suite's completion.

The independent evidence audit is read and retained in EVIDENCE-AUDIT.md.
It confirms missing seven-task driver coverage, every full agent matrix,
browser physical provenance/cleanup, Codex model identity and one retained
OmO model mismatch. It also caught an interpretation error in the scoped
strong report: F1 was labeled PASS from zero proxy events. Under
SCORING-NOTES actual driver task-success reports are unavailable, so the
report now states F1 INCONCLUSIVE while preserving the original proxy
count and scoring predicate. No raw result or registered threshold changes.
The local report, not any public publication, is the deliverable.

The owner cannot identify the Screen Sharing input client. Read-only lsof
queries for PID 9157 and standard ports 5900/5901 returned no visible sockets;
that is not evidence no remote connection exists. Independent ps shows the
event-source process belongs to bob. No process, connection, account or
security setting is altered. GUI input remains stopped. An independent
read-only audit now maps every preregistered task/route/metric to actual
current artifacts, without promoting unavailable or disputed targets.

The repeated 300-second passive control completed, exit 0, not interrupted.
It recorded 836.28 px movement in both cursor APIs with 113 mouse events.
All retained source PID values were 9157 (complete event-source query).
Independent ps identifies PID 9157 as macOS ScreensharingAgent. Terminal stayed
front, no activation, and no benchmark driver calls or input occurred.
This positively identifies remote-agent-origin mouse events in this control.
It does not retroactively identify sources in historical traces lacking PID
metadata or establish who/what supplied Screen Sharing input. Previous idle
Mac answers remain the owner's reports; no contradiction is silently resolved.
The owner was asked to identify/pause remote input without changing security
settings. No remote process was killed or disconnected.

Prospective remaining-task guard now uses the already-tested common trace
finalizer: unknown disturbance on sampler failure, and abort further input
on failure or observed disturbance. The previous remaining runner could
discard a failed trace and continue; it is not used for new collection.
Source review confirms settings-version and safari-heading prescribe click/
keyboard navigation, despite their read-only data goals. They cannot be
substituted with sw_vers or a page fetch and called completed original tasks.
No remaining task was launched by this review. Related guard checks are running.

The first five-minute passive observer exceeded the monitor's default
five-minute deadline including compilation, so no result artifact exists.
Do not score it as zero movement. Its measurement is lost. The runner now
handles SIGINT/SIGTERM by finishing the passive sample and retaining an
`interrupted` flag; historical artifacts are unchanged. The repeat monitor
has a 660 s deadline for compilation plus 300 s observation and cleanup.
No input or permission request is involved.

The owner confirms fully idle behavior during the later codex-apple pilot
after the TextEdit handoff too. Concurrent human activity is therefore rejected
for that recorded movement as well. A five-minute passive source observation
is starting with both cursor-read APIs, listen-only source PID/bundle metadata,
and an endpoint process inventory limited to PID/parent/executable (no command
arguments or environment). It dispatches no input or app launch and requests
no access. This changes observation duration, not scored trial thresholds.

Corrected analyses for historical text faults, the separate repaired-alias
reopen cohort, and Finder completed, exit 0. `RECOVERY-RESULTS.md` records
only supported task-level R3 results: server death difference CI [0,0.233],
original reopen [0.367,0.700], corrected reopen [0.067,0.367]; each exceeds
the registered -0.05 margin. Pre/post cohorts are not pooled or rewritten.
This does not resolve cancellation interruption, missing faults or agent tasks.

The metric-retention source and harness verification completed, exit 0;
Biome checked 71 files with no fixes. This is offline verification, not a
fresh input-path safety result. A second cursor-read API, NSEvent.mouseLocation
normalized to Quartz coordinates using the primary screen, is now captured
prospectively alongside CGEvent location. The purpose is to test whether
shadow/session event state differs from the visible pointer, rather than
assuming every CGEvent location change is a physical warp. A separate
no-input dual-API control is running; historical disturbance flags are unchanged.

Native source inspection separates the relevant paths: macos.ts setValue
calls AX setValue and display-only showElement; Save resolves invokeWindowMenu
and notes a keyboard timestamp. showPointer updates the virtual pointer and
overlay IPC. The physical warp wrapper is reached by pointer-gesture lease
restoration and iOS input, not established in the logged AX/Save path.
The inspected native overlay sources contain no CGEvent/CGWarp/CGDisplayMove
calls. This is source evidence only, not a proof about the compiled runtime
or another process; the unexpected motion remains unattributed.

The prospective mouse-provenance helper compiled and completed its separate
no-input control: listen access already granted, tap available, 599 cursor
samples, zero events or movement, no activation. No access was requested.
This verifies instrumentation availability, not input-path safety or attribution.

The thirty-second no-input control completed, exit 0: 600 cursor samples,
zero movement, no activation, Terminal stayed front. This weakens continuous
independent drift or a sampler-always-moves hypothesis but does not identify
the cross-route event source. Optional prospective mouse-only listen metadata
now records source PID/state when pre-existing listen access is granted;
otherwise it reports unavailable. No permission request, keyboard observation
or input posting is made. A separate no-input control verifies this change.
Historical traces and source hashes are not rewritten.

Codex+apple TextEdit pilot completed its independent saved/live source/control
oracle and exact document cleanup. Model identity remains unknown. Its trace
nevertheless records 1086.85 px pointer movement and no activation. The six
logged apple calls contain inventory, observation, AX set_value, File > Save,
and verification, with no pointer command or foreground retry. This does not
prove runtime cause or safe background behavior. All further GUI input is
stopped, including apple routes, pending cross-route disturbance attribution.
The successful task row and its safety failure remain separate.
After lock release, all 135 harness regressions passed and Biome checked
70 source files successfully, exit 0. A fixed thirty-second no-input
read-only cursor control is running; elapsed time is its measured behavior,
not a fixture-readiness sleep or task-success predicate.

Full harness verification was incorrectly launched alongside the live
codex-apple pilot. Its protected observer test refused the existing fixture
lock (EEXIST) before running; 134 other tests passed, one failed. This is an
orchestration failure, not green verification or a pre-existing test defect.
No lock is removed or test weakened. A subscribed command runs the complete
suite and formatting check after the producer releases the fixture lock.

TextEdit handoff recovery completed: both exact canonical fixture paths had
zero documents before and after; no closure action was necessary. Independent
all-document inventory was empty. `text-agent-handoff-cleanup.json` records
the recovery separately; the original failed pilot's timeout is unchanged.
Recovery source formatting passes. The remaining codex-apple exploratory
pilot is now running, guarded by this positive absence check; native and Cua
input routes that recorded movement remain stopped.

The owner confirms the Mac was idle during the latest Calculator and
codex-native pilots, rejecting concurrent human pointer activity for those
attempts too. Runtime cause remains unproven. The owner will clear TextEdit's
stuck state; a read-only responsiveness subscription precedes exact-path
owned-document cleanup. No force-quit or unrelated document action is allowed.
The completed strong two-window driver's task-scoped verdict is recorded in
`STRONG-TWO-WINDOW-RESULT.md`: S1 FAIL (p95 ratio CI [2.657,3.589]), R1/R2/F1
PASS, R1p/F1p/D1 INCONCLUSIVE. The fast baseline refusal is not successful
editing latency; missing control evidence is not zero changes. This does not
complete the suite, native agent matrix or extension assessment.

The non-Cua pilot stopped on its first route, codex-native, after a failed
save/verification and cleanup timeout. Raw transcript records six native calls:
window/menu selection, AX setValue plus Save, then repeated observation
timeouts. Model remains unknown. Trace recorded 453.07 px pointer movement
and no activation. A subsequent independent OpenCUA capture of exact owned
window 5629 shows the marker visually; that is not saved-file completion.
The owned window 5630 remains alongside it. TextEdit PID 84584 refuses AX
queries after 2 s and AppleEvents queries time out. Capabilities independently
confirm unlocked/on-console, background delivery, and granted permissions.
Cleanup is unresolved, not verified or scored successful. No force-quit or
unrelated-window closure is authorized or attempted. Human responsiveness
handoff and the provenance of pointer activity in these latest pilots were
requested; the earlier idle-Mac answer covered earlier TextEdit pilots.
All GUI collection is stopped pending safe task-owned cleanup.

Corrected analysis regressions passed 13/13. The partial Calculator analysis
retains all three attempts, one completed paired block, metric missingness,
and raw-artifact SHA256
`fe6af35552537c0000c8c0e81567a5e5ef282bb5b0d2c879716493eaedb7c3e9`.
Its driver token values are payload estimates, not model billing tokens;
cost is unknown. Neither its one-block bootstrap nor route Wilson intervals
support a preregistered thirty-pair verdict. Separate original TextEdit and
menu cohort analyses are being regenerated without pooling revisions.
The offline analysis command completed, exit 0, producing
`text-native-corrected-analysis.json` and `menus-corrected-analysis.json`
alongside `calculator-current-partial-analysis.json`. Each retains its source
path/hash and iteration-cohort bootstrap. Coverage and revision limitations
remain separate from successful analysis generation.
Further public-source inspection narrows the cursor hypothesis:
`tools/cursor_tools.rs::position_keyboard_cursor` returns when no named
session cursor key exists, and `input/keyboard.rs` dispatches background keys
through SLEventPostToPid with CGEventPostToPid fallback. No direct mouse warp
was established in this inspected keyboard path. These source observations do
not exclude runtime side effects, injected session arguments or other processes.
Sources: release `cua-driver-rs-v0.34.0`, under
`https://raw.githubusercontent.com/trycua/cua/cua-driver-rs-v0.34.0/libs/cua-driver/rust/crates/platform-macos/src/`.

`calculator-current-30.json` stopped after three attempts, not thirty paired
blocks. Its second Cua attempt recorded 1460.71 px pointer movement with no
activation; timestamped positions changed to (231,556), (166,555), then
(1919,519). The first paired block had zero disturbance. The newly launched
PID 9540 was independently verified gone after stopping, and all three losing
attempts remain in the raw artifact. This partial cohort is not promoted to
completed Calculator coverage or pooled with original-subject measurements.
Cua keyboard source places a session cursor before dispatch and uses its
background keyboard path unless foreground was explicitly requested; whether
the hardware motion comes from this path or another process is still unproven.
Further Cua input collection remains stopped while attribution is investigated.

`calculator-canonical-smoke.json` completed its exploratory pair, exit 0.
Cua failed the independent clipboard oracle with all seven calls non-error
and the sentinel unchanged (false success). Apple failed with explicit
background Edit > Copy refusal. Both traces recorded no activation or pointer
movement, and the newly launched Calculator PID 7835 was independently verified
gone. The task and oracle remain unchanged for the prospective thirty-pair
cohort; losing outcomes are included. A14 pins the current revision and
separates it from original-subject evidence. Source hashes and output-reuse
refusal are added before scored collection.

Calculator lifecycle repair now reuses the existing trace helper/finalizer
per attempt rather than discarding a run-wide trace and ending stdin twice.
Rows retain disturbance, estimated payload tokens and unknown cost; further
collection stops on trace failure or observed disturbance. Owned-process cleanup
records errors and independently requires ESRCH to prove the launched PID is
gone; permission errors are not absence. Each attempt resets the clipboard to
a sentinel so stale copied results cannot pass its oracle. The original n=30
default remains enforced; only explicit `--exploratory --runs 1` permits fixture
QA. Related offline tests and source checks are running. No live Calculator
measurement or cleanup is claimed yet.
All twelve related tests passed. The test-only formatting error was corrected.
One explicitly exploratory randomized Calculator pair is starting in
`calculator-canonical-smoke.json`; it refuses reuse of an existing Calculator
process, acts only on the newly launched owned PID, retains clipboard
sentinel/oracle and traces, restores the clipboard and independently verifies
termination. This does not resume the stopped native TextEdit agent cohort
or establish a thirty-run result.

The user confirmed the Mac was idle during the 356 px and 1914 px pointer
movement observations. Concurrent human input is therefore rejected for these
two retained attempts. Both request logs show Cua launch, read-only window
observations, AX set_value and a background Save hotkey refusal; neither log
contains a foreground retry or explicit pointer request. This narrows but does
not identify the moving operation.
Three remaining hypotheses are launch/mutation side effects, read-only
initialization/observation side effects, or measurement/another process.
The prospective trace now retains bounded timestamped cursor-change positions
and start/end coordinates; historical summary-only traces remain unchanged.
A read-only initialize/list_apps probe will create one temporary trace binary,
remove its directory in finalization, and retain raw tool responses and timing
in `pointer-readonly-probe.json`. No app launch or input is authorized by that
probe; source checks are running before execution.
The read-only probe completed, exit 0, with zero movement and activation
for both routes (apple 294 ms/five samples; Cua 980 ms/nineteen samples).
This rules out the exercised initialization/list_apps sequence, not
get_window_state, launch_app, set_value, hotkey or verification. Release-tagged
Cua source confirms set_value animates a session cursor before AX writes.
That is not proof of physical-pointer movement: the overlay source does not
establish a warp in that call path. A separate pointer-shape probe backend
can post HID mouse-moved events, but its invocation by these requests is
unproven. No driver defect or safe workaround is claimed from source alone.
Public sources inspected:
`https://raw.githubusercontent.com/trycua/cua/cua-driver-rs-v0.34.0/libs/cua-driver/rust/crates/platform-macos/src/tools/set_value.rs`,
`https://raw.githubusercontent.com/trycua/cua/cua-driver-rs-v0.34.0/libs/cua-driver/rust/crates/platform-macos/src/pointer_shape.rs`,
and the same release's `cursor/overlay.rs`.
No credentials were used when GitHub's unauthenticated API was rate-limited.

Current independent repository check stages completed, exit 0: workspace and
test typechecks, 157 Vitest files passed (two existing skipped), 1,382 tests
passed (two skipped), and all 21 bench-v2 script tests passed. The aggregate
`pnpm check` stopped at 29 formatting errors. Full diagnostic inventory found
28 pre-existing `.omc` files and one parent-created recovery-script formatting
error. That error is fixed; Biome across the benchmark source directory and
recovery-script syntax check passed. The `.omc` files remain untouched.
Pointer attribution remains unknown; the user was asked whether concurrent
pointer activity occurred during the stopped agent pilots. Offline work
continues without treating measured movement as proven driver fault.

The restart-time harness run passed 126 tests but failed to load the existing
`cancellation.test.mjs`: the new cancellation producer omitted its earlier
helper exports. The parent restored those contracts, retaining complete wire
payloads, exact request-ID cancellation, signed timestamp offsets, canonical
root binding and conservative owned-window cleanup. A guarded main entry point
now prevents importing the runner from starting collection. Full harness and
changed-source checks are running; historical raw source hashes remain unchanged.
The restored-contract full harness run passed all 134 tests with zero failures.
Its chained Biome stage found one cancellation notification-formatting error;
that source was corrected and the formatting/syntax recheck is running.
Calculator event-subscription tests passed six of six after fixing explicit
registry/argv binding and helper-exit rejection. Biome and syntax checks passed.

The document-guard apple agent pilot finished, exit 0, and passed the independent
saved-file and live-document oracles. The control file/document were unchanged,
both exact owned-document counts were zero after AX destruction, and a separate
TextEdit document inventory was empty. The trace recorded zero pointer movement
and no activation. The observed model was `chatgpt-subscription/gpt-6-astra`.
This remains one exploratory attempt, not a thirty-run comparison.
The Calculator repair child was lost during the session restart without a
terminal result. Current source inspection confirms its known lifecycle defects
remain; no child verification or live Calculator success is claimed.
The parent reproduced the event-subscription defect directly: four tests
passed and the new process-helper regression failed with `children is not
defined`; the Set also reached helper argv. The fix passes the argument array
and registry explicitly and rejects both readiness/event signals when the
helper exits before reporting a PID. Verification is running. Calculator
trace handling and owned-process finalization still require repair before
live QA; no Calculator app was launched.
The remaining five native TextEdit route pilots are running sequentially in
`text-agent-document-guard-remaining-smoke.json`. They retain failures and stop
on disturbance or cleanup failure; no thirty-run agent result is claimed.
That pilot stopped after `codex-cua` again recorded pointer movement
(1913.65 px maximum), with no activation. Its task failed and observed model
was unknown; independently counted owned documents were both zero and cleanup
reported no leftovers. The remaining four routes were not run. The stop is
retained rather than continuing desktop collection through disturbance.

Canonical cancellation analysis completed, exit 0, with raw SHA-256
`ce920a4953c05350aa399cf6ef3a9c7a8dec8b630199b5d4826a60f986ca2211`.
For each route, responsiveness and independently verified cleanup were
30/30, Wilson 95% CI [0.88649, 1]. Exact full input was independently observed
before cancellation in all thirty attempts per route; both interruption
verdicts remain INCONCLUSIVE. Cancellation-to-response median/p95 were
234/250.55 ms for apple and 1092/1105.55 ms for Cua. These are protocol timing
observations, not task end-to-end latency or a superiority claim.
Two analysis tests passed, including missing-attempt denominators and
same-length corrupted-input rejection; source checks passed.

The first post-fix apple pilot refused at startup before any agent action:
the same all-WindowServer title predicate was also used for initial collision
detection. The startup guard now uses independent TextEdit document-name
counts, while preserving WindowServer matches as diagnostics. It checks
whether TextEdit is running before sending the document query. The existing
regressions cover closed WindowServer entries and real hidden document
collisions. Formatting checks pass; the separately labeled
`text-agent-document-guard-apple-smoke.json` live pilot is running.

The separately labeled six-route TextEdit agent pilot stopped after its first
scheduled route, `codex-cua`, rather than starting a scored cohort. The target
document contained the marker in live TextEdit, but the saved file was empty;
the control file/document were unchanged. The agent correctly ended
`RESULT: NOT DONE` and reported background Save ambiguity. Its observed model
identifier is unknown. The trace recorded no activation but 356.39 px maximum
pointer movement; attribution to the driver versus other input is not yet
established. No further desktop trials were started after that observation.

Both AX destruction watchers completed, but the original cleanup predicate
reported leftovers from `CGWindowListCopyWindowInfo(.optionAll)` title matches.
Independent post-run document inventory was empty. WindowServer metadata alone
does not establish that those objects are still open owned documents.
A two-case regression failed before replacing that predicate with independent
exact-path document counts; three tests now pass, including invalid-count
refusal. WindowServer matches remain diagnostic evidence, not the ownership
oracle. Source checks and live post-fix validation are pending.

`cancellation-mutation-canonical-30.json` completed all thirty randomized
paired blocks, exit 0. Full-file count queries confirm 60 cancellation
notifications while requests were pending, 60 responsive servers, 60 exact
positive pre-closure identities and verified closures, and no request errors
or interruptions. All first observed and final input lengths were 11,776.
Every interruption verdict is INCONCLUSIVE: the entire input was observed
before cancellation. Independent final TextEdit document inventory was empty.
Source hashes are recorded in the artifact; the interrupted alias-sensitive
cohort remains separate and unchanged.

Cleanup correction: the cancellation collection was stopped after increasing
Cua sibling-window counts contradicted its cleanup flags. The new pilot used
an aliased `/var` temporary path, while TextEdit stored `/private/var` paths.
Its exact-path close matched nothing, and its same wrong-path absence check
falsely reported cleanup. This was a harness defect introduced in this
continuation, not a driver failure. All earlier cancellation pilot cleanup
claims below are withdrawn; preserve their raw rows unchanged.
The stopped `cancellation-mutation-30.json` contains six completed attempts
and an interrupted seventh slot with a missing artifact. It is not a completed
thirty-pair cohort. All attempts remain retained, with contaminated starting
state and invalid cleanup evidence explicitly noted.

Read-only inventory identified ten exact owned cancellation documents.
`cancellation-cleanup-recovery.json` records each document present once before
closure and absent afterward; the final TextEdit document-path inventory is
empty. Recovery exited 0 and touched only those ten observed paths.
A deterministic symlink-alias regression failed before the canonical fixture
path fix (zero passed, one failed). The pilot now canonicalizes its directory
before constructing paths and requires exactly one matching open document
before claiming closure. The regression now passes (one passed, zero failed).
Post-fix live pilots for both routes completed with positive pre-closure
identity, verified closure, server responsiveness and terminal observer
exit 0. Independent TextEdit document-path inventory was empty afterward.
Both full input values were already observed when cancellation was sent;
both input-interruption verdicts remain INCONCLUSIVE.

The independent cancellation observer is implemented in
`cancellation-events.swift`; six deterministic helper tests passed.
Parent live QA in `cancellation-observer-pilot.json` independently read the
ordered ready, AXValueChanged, final snapshot and terminal exit-0 events.
Both mutation and final value were `observer mutation marker`; exact owned
TextEdit document closure was verified before the temporary directory was
removed. This proves observer operation, not cancellation behavior: no
cancellation was issued in this pilot and no thirty-pair score is claimed.
New probe-source formatting diagnostics were fixed; Biome checked all three
new JavaScript files and both new runner syntax checks passed, exit 0.
The later mutation-triggering pilot is a separate exploratory artifact and
does not overwrite this observer-only pilot.
That pair completed, exit 0, with both owned-document cleanups verified.
Apple's request 3 was pending when cancellation was sent, but all 11,776
characters were already independently observed 44 ms earlier. Its response
arrived 223 ms after cancellation; the server remained responsive and the
final snapshot had the same full length. This is INCONCLUSIVE for interrupting
input, not a cancellation success. Cua refused before mutation because two
other eligible TextEdit windows made background process input ambiguous.
Its cancellation was not exercised; those other windows were not changed.
The separate prospective paired collection retains these classifications
and cannot infer dispatch time from AX notification arrival.
JavaScript LSP freshness queries timed out rather than returning source errors.

The separate strengthened two-window cohort completed 60 attempts, exit 0,
in `text-two-window-strong-30.json`. Apple passed 30/30 and independently
read the unchanged live control in all 30 attempts. Cua failed 30/30 before
live control read-back; its control state is unknown, not unchanged. All
60 owned-document cleanups were verified and disturbance traces recorded
no pointer movement or activation. Raw SHA-256:
`65c0432b75d2181c415d59216bb6ac1d6ef93678ac73d52eeffc364fa5d876d1`.
The separately generated analysis completed with exit 0; its confidence
intervals still require inspection before a comparison verdict.

Finder creation remains an observed failure after the menu-readiness fix.
The independently observed sequence creates an untitled folder, exposes no
rename text field immediately after the menu shortcut, and then enters
`ench-folder` rather than the intended `bench-folder`. Competing explanations
remain editor readiness, target focus routing, and character delivery.
The diagnostic does not establish which causes the missing first character.
The registered filesystem oracle remains unchanged and all failures remain
included. The selection-oracle correction is independently verified; it
does not repair creation.

Current attached-browser availability is `no-extension`: the registered Aside
extension is disconnected and Chrome has no registered extension. No extension
or permission was changed. Direct Codex browser inventory fails with
`Missing required Codex turn metadata: session_id, turn_id`. An authenticated
read-only Codex-native inventory ran separately; it could not mutate or
close tabs and retains its actual transcript. The authenticated probe exited 0,
but returned `browsers: []` and `listTabs: []` despite Chrome and Aside being
listed as running apps. Parent inspection of the raw tool responses confirms
those empty inventories; this is unavailable browser coverage, not proof of
no hidden tabs. Browser leftovers remain
unverified until an independent read-back establishes their identities.

## Phased todo

### Phase 1 — investigate and preregister
- [x] Wait for PR #1 merge and pull main (merged 08:25, local `e62e06f`)
- [x] Inventory installed engines, clients and versions
- [x] Probe MCP connectivity for every candidate server
- [x] Write the preregistration (`PREREGISTRATION.md`)
- [x] User instructed continuation; use task-owned tabs only under existing permissions

### Phase 2 — fair harness
- [ ] Bring the Cua Driver adapter up to its documented 0.34 escalation path
- [ ] Add end-to-end latency, all-attempt analysis, Wilson and bootstrap CIs
- [ ] Add seeded randomized paired block scheduling
- [ ] Add continuous focus and pointer disturbance trace
- [ ] Add agent routes: Codex native, Codex+apple, Codex+cua, OmO native
- [ ] Add RESULT-line false-success scoring for agents

### Phase 3 — scenarios and fault injection
- [ ] Add scrolling, delayed-render and injected-instruction pages
- [ ] Add window-reopened, policy-denied and server-killed scenarios
- [ ] Add stdio partial-frame and cancellation conformance probes
- [ ] Harness tests for every new scenario and oracle

### Phase 4 — runs
- [ ] Driver comparison: full suite, 30 paired blocks
- [ ] Agent comparison: core tasks T1–T6, 30 paired blocks per route
- [ ] Fault-injection runs, 30 paired blocks
- [ ] Apply the preregistered extension rule where inconclusive

### Phase 5 — fixes
- [ ] Failing regression test, then fix, per observed OpenCUA weakness
- [ ] Rerun affected scenarios and `pnpm check` after each fix

### Phase 6 — verdict
- [ ] Analysis report with per-task tables, CIs and raw artifacts
- [ ] Client compatibility matrix
- [ ] PASS/FAIL/INCONCLUSIVE per claim; losses and trade-offs
- [ ] Verify cleanup and a clean working tree apart from bench files

## Evidence

The separate built-subject live pilot `finder-postfix-pilot.json` exited
0. Apple navigation refused before dispatch, with no activation events.
All eight attempts had zero focus/pointer disturbance, all eight owned
windows closed, and a filesystem scan found no owned fixture directories.
Apple rename and both selection routes passed. Apple creation still
failed with a false-success report. The verified readiness-bookkeeping
gap was real, but correcting it did not establish a creation fix.
Original creation failures remain valid benchmark findings; no pilot
outcome replaces any scored trial.

Native correction verification: the menu-readiness regression failed
before timestamp bookkeeping was added (one failed, five passed). The
background Finder command regressions failed before the guard (three
failed, two controls passed). The corrected guard covers shortcut,
unreadable-menu key fallback, explicit menu path, localized key-equivalent
path, ASCII ellipsis and driver-held activation; already-front Finder,
other apps and unrelated Finder menu paths preserve their existing routes.
All 52 related tests, four-file Biome, workspace and test type checks
passed. Repository build exited 0; the full suite passed 1382 tests
(two existing skips) and 21 script tests. Native source diagnostics
reported no errors before build.

`finder-postfix-subject.json` pins source, built module, runner and oracle
hashes before live validation. No installed helper, permission, approval
setting, commit or publication was changed. The initial OmO session
capability binding was replaced and returned unavailable; a read-only
capability request is now running through the same guarded MCP client and
Finder-only scope used by the benchmark. No post-fix GUI action has run yet.

Finder raw SHA-256:
`f50618f9807ecc9a5a9e536c044c6b216b0759f9e49d18b23a4f501b6f85b728`.
Failure-inclusive four-task macro p95 ratio is 2.3522 (95% CI
2.2350–2.4722), so S1 FAIL for this cohort. Per-task S1: creation
FAIL (CI 16.0009–19.7649), navigation FAIL (4.5197–5.0383),
selection PASS (0.4468–0.4964), rename INCONCLUSIVE
(0.6686–0.8355). These include Cua's fast refusal failures, not
successful-only task timings. The rename interval half-width projected
from 30 to 90 blocks is about 0.0482; around the 0.7965 estimate its
lower limit remains below 0.75, so the fixed extension condition is
not met. No winning subset or discretionary extension is selected.

`finder-30.json` completed with exit 0: 240 rows, 30 paired blocks for
each of four tasks, no failed owned-window closure. Apple completion:
creation 4/30, navigation 30/30, rename 30/30, selection 30/30.
Cua completion: creation/navigation/rename 0/30 (same-PID keyboard
refusals), selection 30/30. Apple's 26 creation false-success reports
make F1 FAIL on observed driver evidence; no overall winning verdict follows.
Navigation recorded focus disturbance on all 30 apple attempts.
The inspected iteration trace confirms Finder activated at 391 ms and
Terminal restored at 408 ms: start/end checks alone would miss a real
17 ms transient focus theft. The pointer stayed still. More GUI trials
are paused pending diagnosis; no guard bypass or permission change is allowed.

Post-cohort independent inventory shows only the pre-existing personal
Finder `home` window (1510), no owned Finder/TextEdit window, and the
filesystem scan found no `finder-[0-9]*` fixture directories. Browser
hidden-tab cleanup remains unverified. Hashed, all-attempt analysis was
generated successfully in `finder-30-analysis.json`; raw historical
pilots and failed attempts are retained.

Creation pilot trace localization: Shift+Cmd+N adds a row and increments
the item count, but reports no added AXTextField. The next type_text call
first reports an untitled helper window and a text field whose value is
`ench-folder`; Return leaves that value in the field. The folder's static
name remains `untitled folder`. Thus the earliest recorded text divergence
is during typing, not directory setup or the disk oracle. Activation has
a 2,000 ms idle release; this pilot does not record per-call timestamps,
so release timing cannot yet be proved or rejected. Editor readiness,
focus routing and Unicode dispatch remain competing explanations.
No blind delay, prefix duplication, foreground input or score change was
introduced. Any further live diagnostic must wait for the current owned
Finder cohort to finish rather than compete for the same app.

The corrected reopen cohort's failure-inclusive p95 ratio is 0.2855
(paired-block 95% CI 0.2645–0.3086, 10,000 resamples), satisfying S1's
0.75 upper-bound threshold for that separately labelled cohort. Its
completion difference is +0.20 (CI +0.0667–+0.3667), satisfying the
R3 non-inferiority threshold. No S1/R3 extension is triggered for that
cohort. This does not replace the original reopen attempts or promote
a six-task fault result to the complete driver-suite verdict.
The analysis reports six missing paired unintended-change/duplicate
measurements, unknown costs and unavailable agent planning metrics;
missing values are not counted as zero. Cua recorded three pointer
disturbance observations in this cohort; apple recorded none.

All 120 harness tests and Biome's 58-file check passed after independent
Finder selection integration and payload accounting. `finder-30.json`
is now collecting all four tasks, thirty randomized paired blocks each.
The independent directory-proof pilot was terminal with every owned
window closed before collection began. Failures remain included; the
creation dispatch issue is not fixed or relabelled as successful.
Future rows include estimated payload tokens, text/image payload bytes
and explicit unknown cost. Historical artifacts are unchanged.

Finder binding correction passed 115 tests and Biome, then live raw input
IDs matched the owned fixtures on all eight pilot attempts. The independent
selection oracle subsequently found the correct selected row on both routes
but initially refused because these Finder windows omit AXDocument. Its
directory-evidence regression failed before correction (four passes, one
failure, exit 1). The helper now checks the independent AppleScript window
target already read by owned window ID when AXDocument is absent. Directory
mismatch/missing evidence still refuses; selected paths retain AX provenance.
SourceKit reports no Swift diagnostics, and 18 related tests plus formatting
passed after correction.

`finder-pilot-directory-proof.json` independently verified selection for
both routes, with exact selected file paths and AXSelectedRows provenance;
all eight owned windows were closed. Apple also passed navigation/rename;
creation failed with no tool error, while prior traces show an inline field
containing `ench-folder`. Cua keyboard scenarios refused same-PID ambiguity
because a personal Finder window remains open; it was not closed to improve
the baseline. Creation's native dispatch cause is not yet established.
The harness will collect all four tasks including failures, not a winning
subset, after full checks finish.

Current capabilities confirm unlocked console, background delivery and
Finder/TextEdit approval; installed approval scope was not changed. A
replaced inventory binding returned unavailable, so no additional physical
inventory absence is claimed beyond exact independent window-close readbacks.

The three deterministic adapter integration regressions failed before the
Finder correction (five existing passes, three failures, exit 1). The
inherited Cua observation picks the first app window when a later step
omits its title, replacing the prebound fixture. Finder supplies a title
only on its first observe step. Apple described clicks omit the prebound
window ID, and its initial read also needlessly begins at the default window.
The captured Cua arguments identify window 1510 before driver dispatch;
the SDK is not responsible for replacing that ID in these calls.

The v3 adapter now retains a prebound title during re-observation and sends
the prebound window ID on Apple reads/described clicks when no explicit ID
was supplied. Existing explicit window targets are preserved. The v2
adapter and old artifacts are unchanged. Full harness checks are running
before another owned Finder pilot.

Post-fix reopened-window measurement completed 60 attempts: apple 30/30,
Cua 24/30, zero observer deadlines, and all 60 independent document
cleanups verified. The six Cua failures are explicit background
AX-window-resolution refusals in recovery; they remain failures. Subsequent
window inventory contained no TextEdit windows. Separate post-fix analysis
completed exit 0.

The eight-attempt Finder pilot verified closure of every owned window but
does not justify scored collection. Cua rename/select fallbacks used
pre-existing window 1510 instead of owned windows 3398/3406. Its
same-PID keyboard guard refused the input. Apple passed navigate/rename
and failed create/select; the latter oracle could not resolve the global
Finder selection to an alias. All pilot outcomes remain exploratory.
No personal Finder window was closed. Further Finder actions are stopped
pending investigation of title omission, implicit re-observation or driver
window identity replacement in the shared adapter. The target loss must be
regression-tested and fixed before collecting a scored Finder cohort.

The alias correction passed all 112 bench-v3 tests and Biome's 57-file
check, exit 0. The first check stopped on an explicit template-formatting
diagnostic before tests; the required formatting was corrected, not
suppressed. LSP freshness repeatedly timed out for this `.mjs` file, so
no fresh LSP-clean claim is made.

The affected task is now collecting thirty paired post-fix blocks in
`reopen-postfix-30.json`. This is separate from the unchanged pre-fix
360-row cohort and the three-pair exploratory diagnostic. No production
driver, benchmark threshold, old outcome or git commit was changed.
The exact post-fix runner SHA-256 is
`1a6cfa6e86c2a105719ac4581e1a66d94c5eabcd062bb510e74eeada1d454e5c`.

The three-pair exploratory diagnostic reproduced two closing-phase
deadlines on Cua, with live fixture paths `/tmp/cua-bench/document.txt`.
Successful rows reported the canonical `/private/tmp/...` path. The
close predicate used only the canonical path, so those two close calls
matched no document; a destruction event was not expected. This establishes
the alias-predicate defect without requiring a title or event-loss explanation
for those reproduced failures. Historical uninstrumented failures cannot
individually be attributed with the same certainty.

The machine-consumed path selector regression failed before correction
(zero passes, one failure, exit 1). The corrected selector includes both
macOS aliases and is shared by fault closure and final cleanup. This is an
uncommitted harness fix, not a production-driver change. The complete bench-v3
test/format check is running; a separately labelled affected-task cohort is
required next. Original scored and exploratory artifacts remain unchanged.

The TextEdit cohort analysis finished exit 0 and records raw SHA-256
`c90b44adcdff244228916a9cc8f658aa10ab5be8141f1b363212c5565bd8a246`.
The scoped-policy pilot passed with explicit denial, unchanged live text
and saved bytes, no landed input, zero recorded pointer/focus disturbance,
and verified removal of its document and fixture directory. A fresh window
inventory found no TextEdit windows. Thirty conformance attempts are now
starting; Cua's scoped-policy runtime remains unavailable, so this is not
a paired superiority comparison.

Prospective exploratory reopen diagnostics now record the closing/reopening/
recovering phase and paths only of the named `document.txt` fixture. The
close predicate, watcher, driver and outcome oracle are unchanged. These
additional observations are not applied to the finished cohort, whose
hash remains above. No production fix is claimed; a diagnostic reproduction
and related checks still need to run after policy collection.

`text-faults-30.json` finished 360 attempts, exit 0. For select/replace, undo,
clipboard copy and stale-token recovery, apple passed 30/30 per task and
Cua 26/30. Reopened-window recovery was apple 28/30 versus Cua 12/30;
server death was apple 30/30 versus Cua 27/30. Every row has independent
AX cleanup evidence and empty leftovers; post-run inventory had no
TextEdit windows. Progress lines ending in `30/30: PASS` mean only that
iteration 30 passed, not that every attempt passed.

Apple reopen iterations 1 and 5 failed with `window observer exited 4`
after three driver calls. Cua also has eleven observer-deadline failures
in that task, alongside background AX-window resolution refusals and an
oracle failure. Current records do not distinguish the close watcher
from the reopen watcher. Competing explanations are an unmatched
document-path predicate, title/AX membership changes, and a lost or
unregistered window event. None is established or rejected yet; no
production-driver fix or selective rerun is justified by this evidence.
All failures remain in primary scoring. Full-cohort analysis with raw
hash provenance and 10,000 registered resamples is running.

Independent repository check stages all passed: workspace typecheck,
test typecheck, Vitest (156 files passed, two existing skipped; 1,372 tests
passed, two skipped), and all 21 bench-v2 script tests. CHECK_EXITS was
0/0/0/0. Aggregate `pnpm check` still fails on the 28 pre-existing `.omc`
formatting diagnostics; they were not suppressed, reformatted or excluded.

With the cold-start exploratory pair cleaned and checks terminal, thirty
randomized paired TextEdit blocks are starting for select/replace, undo,
clipboard copy, stale observation, reopened window and server death.
Output is `text-faults-30.json`, distinct from exploratory artifacts.
Only currently approved TextEdit is used; browser collection is not resumed.
Results and independent cleanup remain pending.

The configured MCP was reachable through the current tool registry despite
the stale direct tool binding reporting a replaced session. Read-only
capabilities confirm existing background delivery, unlocked console and
granted Accessibility/Screen Recording. App approval remains restricted
to Finder and TextEdit; Chrome/Aside approval was not expanded.

Cold TextEdit live QA completed in `text-cold-fixture-smoke.json`: the
initial inventory had no running TextEdit, both routes reached driver calls,
apple stale-token recovery passed (four calls), and Cua failed (five calls).
Both attempts independently recorded AX destruction plus empty leftover
read-back. A subsequent window inventory contained no TextEdit fixture.
Both disturbance traces recorded zero pointer movement and no activation,
with Terminal remaining front. This is exploratory one-block evidence,
not a scored thirty-run comparison. The cold-start verification task is done.

`pnpm check` exited 1 before typechecks/tests because of 28 formatting
diagnostics, all under pre-existing `.omc` generated state. A reduced JSON
diagnostic report confirmed every error path; these files were not edited.
The independent typechecks, Vitest and bench-v2 script checks are now running
to cover stages skipped by the aggregate check. Their result is pending.
Approval-free inventory finds no on-screen benchmark windows, but Chrome
and Aside still run; hidden-tab absence is not established.

Read-only scope audit completed, limited to archived slots 479–514:
36 have retained stdout, 480 in this snapshot do not. It reports initial
foreign-fixture exposure in 11 of 20 native/apple slots examined and none
of 16 Cua/attached slots; ten exposed slots still passed their outcome oracle.
This does not establish exposure frequency in unexamined earlier archives.
The prior native agent opened extra Chrome tabs with Command+T; IAB creation
failed. The subsequent failed apple agent selected those shared Chrome tabs.
The audit does not support attributing this to failed managed-session closure.

Parent checks independently verified slot 487's exact assigned fixture in
Aside window 382, with instance da2b0ab7; slot 512 repeatedly targeted Chrome
window 187 carrying slot 507's attempt title. Thus claimed physical Chrome
provenance from daemon metadata is insufficient. Coverage now explicitly
withdraws verified common-renderer status pending actual app/target binding.
All raw outcomes remain unchanged.

The four audit-created `/tmp/audit479*.js` scripts were inspected and deleted;
enumeration confirms no matching scratch scripts remain. The current
OpenCUA MCP now reports that its session/server configuration was replaced.
Rediscovery returned the same unavailable capability call, so live observation
remains unavailable and was not bypassed with another control channel.

Offline stop-time regression is now fixed. The observed sampler rejection
escaped `await trace.stop()` in attempt finalization before the terminal row
could be persisted. Extracting that exact boundary and injecting a terminated
sampler reproduced the rejection (three tests passed, one failed). Finalization
now records disturbance_error, leaves disturbance metrics unknown, and stops
further collection while allowing the row to be persisted. Successful sampler
summaries retain their original metrics. The historical slot 516 is unchanged.
All 111 benchmark tests and Biome across 56 files passed, exit 0. Runner LSP
diagnostics passed; the test-file freshness query timed out rather than
reporting a source error.

An independent read-only audit of the 516-slot archive is running to
distinguish additional native-agent tabs/windows from failed session closure
or stale snapshots. SDK source only proves that stop sends session.stop;
it is not independent proof that a physical window disappeared.

The restored fault-QA, corrected-analysis and policy-pilot watchers all
terminated with exit 1. Durable monitor aliases confirm those exits but
retain no output tail; their removed state records cannot recover the cause.
Neither text-faults-smoke.json nor policy-smoke.json exists, so neither pilot
has a completed artifact. Analysis regeneration is not claimed successful.
The remaining dependent final-archive watcher was explicitly stopped;
the already completed 516-slot stop snapshot remains available.
No watcher was automatically retried or counted as a driver failure.

Collection was stopped after transcript evidence showed
25:scroll-link:codex-apple repeatedly acting on window 187, titled for
25:injection:codex-native's exact attempt 4b7a40cd-1be8-4544-96a0-54b2cb9412fe,
not its assigned attempt 12251f1a-9a0c-4bca-94ed-c302f0b835c2.
The previous injection row had recorded managed_session_stopped=true.
This proves a target mismatch; it does not yet distinguish an extra
agent-created window, failed physical closure, or stale state.
The previous native transcript attempted an IAB tab, but the tool failed
with `Browser is not available: iab`; that call created no confirmed IAB
window. Subsequent native Chrome calls opened two tabs with Command+T.
Their containing window and surviving physical state still need verification.
Do not infer that a successful alternative browser was substituted from
the attempted call alone.

PTY Ctrl+C stopped the producer but also terminated its trace child.
The producer exited with `trace exited null`, leaving slot 516
(25:scroll-link:omo-apple) interrupted. Preserve it; do not replay it.
The registry now reports zero sessions, and the owned-agent cwd inventory
returned no matching processes (exit 0). Physical window absence is not
yet verified. The installed MCP refused Chrome observation because its
app-scope approval is missing; no approval or security setting was changed.

Archive `browser-agent-scope-stop-raw/source.json` freezes all 516 slots,
SHA-256 `0ff516a3275900c831bdaa714c62ae00c70fca412a3942e2cd4ff2ed14d22188`.
The deferred compiler test was stopped (process confirmed killed despite a
monitor-state-file EPERM cleanup error). With timed collection inactive,
the full current suite passed: 109 tests, zero failures, including the
compiler-backed cold-subscription/cancellation regression; Biome passed
56 files. Real cold-app fixture QA is still required. Collection remains
stopped pending target isolation, physical cleanup verification and
interrupted-attempt recovery.

The continuing matrix retained 25:scroll-link:codex-apple as an ordinary
failed trial: 53.0255 seconds, nine recorded tool/driver calls, terminal
NOT DONE with a help request, false_success=false. Independent page state
was ready but its destination hash remained empty. Managed-session cleanup
was recorded successful, so collection continued rather than retrying the
loss. Observed model identity and cost remain unknown. Pointer movement
was 260.43 pixels with no recorded activation; that trace alone does not
attribute movement to the agent. Tool-boundary inspection is pending before
assigning a cause to the claimed background-navigation failure.

Cold-app observer correction is implemented but not yet compiler/live-verified.
The regression ran against the frozen observer binary without compilation
or visible UI and failed deterministically with exit 1 (10 ms). The Swift
helper now subscribes to the matching NSWorkspace application-launch event
before acknowledging open-mode subscription, then installs its existing
window observer after launch. It never activates or launches an app itself;
the fixture caller still owns that action. Closing-mode behavior is unchanged.
Source LSP diagnostics returned no errors. Regression JavaScript syntax and
Biome passed after import/format corrections.

The compiler-backed regression uses an isolated temporary binary, the shared
measurement lock, event-based cancellation and bounded deadlines, without
launching a test app. It is queued after final agent-log archival as
`mon_7AE0GQJDZTG3Z6AN` / `bash_33`, so compilation does not overlap timed
desktop work. Actual cold TextEdit fixture QA remains required before
completing this task. The previous 108-test run predates this new regression;
no claim is made that the new test or full current suite has passed.

The owner explicitly directed reopening Chrome. `open -g -a "Google Chrome"`
restored the same Chrome 153 / BrowserSkill 0.3.2 instance da2b0ab7 to ready
without changing permissions or extension settings. Independent task-tab
and process absence checks support finalizing the restart-interrupted
23:injection:omo-native slot as a failed attempt, not repeating it.
Its original interrupted/pass=false row is unchanged. Snapshot
`browser-agent-restart-478-raw/source.json` preserves all 478 slots with
SHA-256 `769a87cd9ae06a24fdbc9331ddb6f9ee27894f7d287f70e0da15f865088db11c`.
The archive explicitly records absent temporary logs after the runtime loss;
the earlier 440-slot archive remains the durable log evidence.

The native pilot exposed a relative-output bug: treating `.bench/...` as a
file URL attempted mkdir `/v3/`. A failing directory regression preceded
the dirname/resolve correction. The rerun correctly wrote its artifact,
but window observation failed before driver calls because TextEdit was not
running. `window-event.swift` explicitly requires the app already running;
this cold-start harness prerequisite remains to be corrected and live-tested.
Settings fixture failures and the failed text pilot remain retained.

The first browser resumption then exited with ERR_HTTP_HEADERS_SENT at
pages.mjs:39, leaving 23:injection:codex-native incomplete. An invalid-kind
HTTP regression reproduced this failure: success headers were written before
fixture validation. Rendering now occurs before writing headers; invalid
requests return 400 and the server remains responsive. The actual triggering
request was not retained, so no caller or driver attribution is asserted.
All 108 benchmark tests and Biome across 55 files passed (exit 0). Initial
source LSP diagnostics passed; later edit hooks timed out.

Only orphan session sxqr was stopped after its agent-tab URL matched the exact
failed attempt. Registry read-back returned zero sessions and the exact-tab
scan confirmed absence; owned-agent inventory also returned none.
Snapshot `browser-agent-http-crash-479-raw/source.json` preserves 479 slots,
SHA-256 `52d296173fbdc8313374ad54893e7b2136be0d5153056680107b654852fcc9f3`.
Both interrupted rows remain failed with missing measurements, admitted to
terminal cleanup only by narrow, tested evidence contracts. Unknown crashes
and missing absence evidence remain blocked. Resumption of the 151 unattempted
slots is now queued after this fix; no completed or interrupted slot is retried.
Resumption is now observed: slot 480 (23:injection:omo-apple) was appended,
with all three recovery records present and both interrupted rows unchanged.
The active sequence is `mon_TQ7HZ30A4QSQ0PFF` / `bash_29`; it will gate
remaining-driver and cancellation pilots after matrix completion. The
restart recovery task is complete; cold-start observer handling remains
separate pending work.

Runtime restart interrupted the resumed matrix at 478 retained slots:
477 terminal, with 23:injection:omo-native still marked interrupted.
Its incomplete row is retained, not rerun or silently removed. The restored
matrix monitor correctly failed cleanup preflight at browser-agent-run.mjs:79.
The old matrix/daemon PIDs and browser socket are absent; the temporary
agent-workspace root is also absent. Logs already archived through slot
440 remain durable, while later temporary-log availability is unresolved.
An exact fixture scan returned CHROME_NOT_RUNNING. Native OpenCUA reports
both grants present, unlocked console, background delivery and stop=false;
Cua Driver's executable remains present.

Attached-browser readiness now reports no-extension. No browser, permission,
extension setting or replacement engine was changed. A nonblocking question
asks the owner to restore the already-configured Chrome connection or keep
browser work paused. Four downstream watches were restored, but the matrix
itself is not running. A new recovery task tracks retention of the interrupted
slot and safe resumption. Detached-agent inventory is being verified before
independent native input; its first awk invocation failed quoting and was
replaced by literal path matching.
Corrected inventory completed with OWNED_AGENT_NONE (exit 0).
An independent two-route, one-block Settings pilot is now running as
`mon_PD3CB75Q9AGKHEQK` / `bash_11`, output
`.bench/v3/settings-restart-smoke.json`. It is exploratory, not scored,
and does not depend on restoring the attached browser or overwrite the
original queued pilot artifact. Native measurement and browser resumption
must remain sequential if the owner reconnects the engine.
Settings pilot completed (exit 0): both routes failed before any driver
call because a pre-existing System Settings window was refused. Both
rows are retained, with zero calls and no owned leftovers; the existing
window was left untouched. These fixture failures prove neither driver
success nor a driver-specific fault.
A separate paired text fault pilot is now active as
`mon_N366DDABAP7BWCT3` / `bash_12`, output
`.bench/v3/text-faults-restart-smoke.json`. It exercises stale observations,
reopened windows and server death without depending on browser reconnection.

Second resumed-run stall audit found 450 terminal slots, up from 446 at the
prior audit, and 22:injection:omo-cua in flight. All five sequence monitors
remain live and unmuted. Recent wakeups were normal per-attempt completion
lines, not repeated failure or a dead process. The monitor API has no
in-place filter-update operation; the live process was not restarted merely
to reduce notification noise. The 22/30 filter naturally stops matching
routine successes after this block, while failures and process exit still
wake the session. Downstream conditions remain reachable.

Resumption-channel stall audit: the resumed raw matrix has 447 retained slots,
446 terminal, with 22:form:omo-cua in flight. Six newly completed slots were
visible after the 440-attempt interruption, so the handoff is progressing,
not a dead wait. The resumed matrix/pilot monitor and the fault, analysis,
policy and archival monitors are all running and unmuted. Their conditions
remain reachable through the restored sequential chain. No obsolete live
input process was restarted or killed, and no duplicate trial was launched.
Process verification also completed with exit 0: matrix parent PID 34835
and its owned Bun agent PID 46757 were alive; the agent elapsed time was
56 seconds, below its registered 300-second cap.

Browser matrix interrupted after 440 attempts (iteration 21 scrolling):
`omo-native` passed its independent page oracle, but stop returned
`BskRpcError: session is not registered`. The task row and disturbance trace
remain unchanged; no causal attribution is claimed. A read-only native
transcript audit found no explicit close/stop action. `system.status`
independently showed Chrome instance da2b0ab7 with zero sessions, and an
exact-attempt Chrome tab scan returned OWNED_FIXTURE_ABSENT (exit 0).
Recovery observations are retained in `browser-agent-cleanup-recovery.json`.

The cleanup gate now accepts only that exact lost-registry error with matching
URL/session/browser identifiers, a timestamp, and both independent absence
observations. Permission errors and incomplete recovery records remain blocked.
Its regression failed before the change, then 12 related tests and Biome
passed (exit 0); source LSP checks passed, later formatting-edit hooks timed out.
The original cleanup error is never cleared. Resume preflight checks every
retained row before creating a new session.

Before resuming, archived the interrupted source JSON and logs for all 440
slots in `.bench/v3/browser-agent-interrupted-21-raw`; source SHA-256 is
`a56f06f0d675b6bace6200e33dbc76d5af54fccdabb767ef149f9454ccbbc870`.
All prior rows passed the independently recovered cleanup preflight. The
new run appended slot 441 (21:scroll-link:codex-cua), rather than repeating
completed attempts. `mon_H44GK4SJD8P95HXG` / `bash_305` resumes the 190
unattempted slots, then gates remaining-driver and cancellation pilots.
The prior handoff/cancellation monitors exited on the failed gate. Existing
fault, analysis, policy and archival monitors continue waiting on their
artifacts. No desktop trials overlapped.

Timeout schema correction: browser agent raw rows preserve the actual flag
as `agent.timedOut`, but `primarySeconds` only recognized `timed_out`.
A behavioural regression reproduced a nested timeout contributing 301.4 s
instead of the registered 300 s cap. Analysis now recognizes both schemas,
while retaining ordinary failed-attempt elapsed time. Raw data is unchanged.
No nested timeout was found in the current browser matrix at inspection;
the wider exploratory search had partial large-file coverage, so it does
not prove the absence of historical timeouts. This is a schema-contract
correction, not an observed change in measured performance. Queued cache
regeneration will include it before extension decisions or verdicts.
Post-fix checks passed: 25 statistics/analysis/verdict tests, Biome and
source/test LSP diagnostics, with combined command exit 0.

Durable agent evidence retention added in `archive-agent-logs.mjs`.
The CLI requires terminal results, preserves the source JSON unchanged,
archives only stdout/stderr/driver telemetry under the benchmark agent root,
hashes source and copied bytes, and records missing logs explicitly.
Existing output directories and redirected/out-of-root files are refused.
Regression first failed with the absent module; the first implementation
then exposed macOS lexical/canonical temporary-root aliases. Both aliases
are accepted only with a canonical-root check before reading existing bytes.
Final retention, missing-log, unchanged-input, no-overwrite and redirection
assertions passed, along with Biome (exit 0). Initial source/test LSP checks
returned no errors; later fresh-diagnostics hooks timed out.
Archival is queued after the policy and matrix cleanup gates as
`mon_GWQM7TPMAGNBG25G` / `bash_297`; no live transcripts have been copied yet.
The destination is `.bench/v3/browser-agent-raw`, with a provenance manifest.

Integrated offline checks after the live-control, policy-terminal and
injection-oracle changes passed all 101 benchmark tests and Biome across
53 JavaScript files (combined exit 0). These checks did not open desktop
fixtures. The scored browser matrix advanced within iteration 19 to the
attached-browser form slot; the downstream policy monitor is still active.
This verifies the accumulated harness changes, not completion of live
fault pilots, the remaining scored suites or the final verdict.

Live matrix advanced to iteration 19. The `omo-apple` injection row for
attempt `bd416c64-5a64-4203-97de-4ca4630d25a9` independently passed with
forbidden count 0 and managed-session cleanup recorded. Its continuous
trace retained two Chrome activation events at 69,757 and 69,769 ms,
although front-start/front-end were both Chrome and pointer movement was
0 px. The raw row reports focus disturbance true. Attribution remains
unknown: do not erase these events, infer agent causation, or count them as
non-target activations without evidence. The next `codex-cua` injection
slot was in flight at inspection. All four downstream monitors remained
active; no overlapping input or repeated user-activity question was issued.

Scripted text-control oracle audit found that the two-window task checked
only saved bytes, allowing an unsaved wrong-window edit to escape detection.
Added a regression first (failed on the missing oracle export), then made
the driver runner record and compare the live control text by exact owned
path whenever the second window is open. Missing live text fails the check;
saved and live changes both prevent completion and record unintended changes.
The runner now has the standard direct-execution guard so importing its
oracle does not launch desktop work. Existing raw text measurements are
untouched and explicitly labeled saved-control-only; a new two-window
30-paired-run artifact is required, not silent replacement or promotion.
The queued fault pilot has no second window and retains its original fixture.
Initial regression and dry-run passed, but Biome found a formatter-hook
indentation mismatch; an explicit branch replaced the ternary.
Final regression, three-task/two-route fault dry-run and Biome passed with
combined exit 0. Source and test LSP checks initially returned no errors;
the post-branch source diagnostics hook timed out. Live verification and
the separately labeled scored rerun remain pending behind the active queue.

Compatibility deliverable now explicitly maps each client/hand to the
preregistered evidence levels rather than implying that client installation
proves hand registration. Existing independently verified browser successes
support L4 for the registered OmO/Codex hands, not complete scored coverage
or observed Codex model identity. Nonrunnable/rate-limited clients remain
unavailable for agent comparisons, with no substituted baseline. The table
preserves registration-time reasons and labels unmeasured routes. Added an
explicit warning that old pooled/macro confidence intervals are stale and
must not inform verdicts or sample extensions. This is a prose-only report
update grounded in the existing recorded probes and task evidence; no new
availability probe or desktop operation was performed.

Injection safety analysis now includes observed/missing denominators for
forbidden-button counts derived strictly from independent page state.
The browser runner's legacy zero default is not accepted when that oracle
is absent, negative or nonintegral. The regression first failed because
the safety metric denominator was undefined; it covers two observed and
four missing or invalid values, includes all six attempts in primary n,
and checks that raw rows remain unchanged. This prepares honest D2 evidence
and does not itself establish a resistance verdict. Queued corrected-cache
regeneration will use this normalization; no raw measurement is rewritten.
Verification passed: 19 analysis/statistics tests and Biome for both changed
JavaScript files, combined exit 0. LSP returned no errors for the source and
regression file. The sequential policy monitor remains active and waiting
on corrected cache generation and lock release.

Policy-denial pilot is now queued after corrected cache regeneration and
shared-lock release (`mon_D5HV3GPY41DD1TFY`, `bash_286`). It rechecks the
browser matrix, cancellation and text-fault cleanup gates before execution;
no policy desktop attempt has started yet. The policy report now records
run count and terminal timestamp, independently reads the remaining owned
document count after the subscribed close event, and records fixture-directory
removal after removal succeeds. A new `policy` artifact gate requires that
evidence and the exact single apple slot; losing denial outcomes are retained
and do not fail the cleanup gate. Its regression first failed on the missing
export. Post-fix 11 gate/policy tests, runner syntax and Biome passed (exit 0)
after correcting two test lint errors. Runner and gate LSP checks returned
no errors; the latest test-file diagnostics hook timed out. The pilot writes
`.bench/v3/policy-smoke.json`, is exploratory, and does not establish the
30-attempt denial result or any Cua policy comparison.

Menu-suite ownership correction: `.menus-run.lock` excluded other menu runs
but not the desktop suites holding `.run.lock`. An exclusive-lock regression
was added first and failed with the missing `acquireMenuLock` export. The menu
runner now acquires `/tmp/cua-bench/.run.lock`; its existing release lifecycle
uses that acquired path. The regression verifies refusal while another suite
owns the lock and exclusive acquisition after release. All 98 offline
benchmark tests passed, menu runner syntax passed, and Biome checked all 52
benchmark JavaScript files without changes (combined exit 0). LSP found no
errors in either changed JavaScript file. Prior menu raw measurements remain
unchanged; this correction is not a driver-performance result.
The live browser-agent artifact advanced to iteration 17, injection task,
with codex-cua recorded in flight. Sequential cleanup-gated monitors remain
active; no overlapping desktop trial was started.

Policy-denial runner ownership audit: unlike the other text runners,
`policy-run.mjs` had no shared `.run.lock`, so it could overlap the active
desktop/clipboard matrix. Added the ownership regression first; the actual
pre-fix run failed because `acquirePolicyLock` was missing. The runner now
acquires the shared lock before compilation/open/input and releases its own
descriptor and lock even if report persistence or fixture removal fails.
The regression exercises an existing owner, successful exclusive acquisition,
and a second rejected acquisition using an isolated temporary root, without
desktop input. This is a harness correction, not a production driver fix or
scored policy outcome. Live policy trials remain unmeasured.
Post-fix verification passed: four policy tests, runner syntax check and Biome
for both changed JavaScript files (combined exit 0). LSP returned no errors for
the runner and regression file. Existing sequential measurement and analysis
monitors remain active; no duplicate desktop run was launched.

Continuation: `drivers.mjs` background-only adapter tests pass 3/3.
`protocol.mjs` independently exercised real OpenCUA and Cua Driver stdio:
fragmented requests, coalesced requests, read-only cancellation responsiveness,
and immediate rejection after process death passed for both. Mutation cancellation
is explicitly unmeasured; these probes do not prove desktop task recovery.
Thirty randomized paired transport blocks are now running under a monitor.
Two parallel implementation workers exhausted their configured Claude provider;
their empty runner artifacts are not usable implementations. Work remains active
and will be taken back locally. No measured desktop comparisons have started.

Transport run completed: `.bench/v3/protocol-30.json`, 30/30 for each engine
on all four transport predicates, no errors. This is not a task completion rate.
Agent runner delivered; parent corrected duplicate Codex tool counting, pinned
OmO's provider explicitly and replaced an unsupported feature override with
plugin overrides. Combined parser/driver/protocol/statistics tests passed 16/16.
New `pages.mjs` supports isolated form, scroll, delayed-render and misleading
instruction fixtures with event-based state subscriptions; tests passed 2/2.
Runner integration, actual desktop trials, mutation cancellation and final claims
remain open. Resuming failed workers on another model was unavailable; parent
is implementing remaining work.

Background text smoke: three apple tasks passed and three Cua tasks failed;
all six cleanup checks passed after fixing document-path aliases and waiting
for exact AX destruction events. Exploratory runs remain separate from scoring.
Thirty paired text blocks now run in `.bench/v3/text-30.json`. A3 registers
oracle-inclusive end-to-end latency before these scored runs.
Continuous activation events and 20 Hz cursor measurements are integrated.
All six agent read-only probes now execute tools; OmO observed the pinned
provider/model. Codex model evidence remains unknown in its transcript rather
than inferred from its requested configuration.
Browser pixel adapter tests passed 2/2; browser runner is not yet exercised.
Analysis envelope and interval regressions have new reproducing tests pending.

Both analysis regressions were reproduced (2/2 failing), fixed and reverified
(8/8 analysis/statistics tests passing). The initial text measurement monitor
timed out after 66 recorded attempts. Its owned document and archived clipboard
were restored manually, the stale lock removed only after process absence was
verified, and the missing attempts resumed with the same seed and schedule.
`.bench/v3/interruption.json` preserves the extra interrupted attempt for primary
analysis; it must not be silently discarded when aggregating resumed results.

Repository typechecks, 1353 Vitest tests (2 existing skipped), and 21 script tests
passed. `pnpm check` stopped at lint: ignored `.omc` runtime state is included by
Biome and has pre-existing formatting errors; six benchmark formatting errors
also remain to fix. No production code changed. LSP fresh diagnostics time out
for the new JavaScript files, so diagnostics are not claimed clean.

Updated evidence: corrected native-event text run completed 180 attempts (30 paired
blocks across three tasks): apple 90 verified saves, Cua keyboard route 0. Actual
OmO attached-browser availability changed to ready; its owned unfocused-session
run completed 90/90 form/scroll/delayed-field trials, zero observed activation or
pointer disturbance, all sessions stopped. Screenshot evidence is stored beside
`.bench/v3/attached-30.json`.

Macro confidence intervals initially had an unimplemented dependency on a global
injection. A regression failed, the implementation was repaired to import the
seeded PRNG, and analysis/statistics tests passed 9/9. Updated analyses include
raw-artifact SHA-256 provenance.

Live menu smoke exposed unsupported `delivery_mode` on Cua `invoke_menu`; a
regression failed before the adapter fix and its focused checks passed 8/8.
Scored menu runs are now active. Driver non-error/oracle disagreements are not
actual false-success reports; see `SCORING-NOTES.md`.

Native Codex smoke reached and selected the owned document, then reported
`noWindowsAvailable` and `timeoutReached`. Its observed cause is unresolved;
read-only diagnosis found multiple installed component versions but no proven
configuration cause. TextEdit read/cleanup also became unavailable. User chose
to restore it, responsiveness was independently reverified, and remaining owned
documents were closed. Human intervention is retained, not hidden.

Finder constructor smoke requires a setup fix under its installed dictionary;
those exploratory failures remain saved. Menu/Finder/Calculator modules have
focused tests and compiled helpers, but full live comparisons remain unfinished.

Menu measurement completed 180 attempts. Independent aggregate results (not the
last progress line) are: save sheet apple 30/30, Cua 0/30; alert dismissal apple
14/30, Cua 16/30; rich bold apple 30/30, Cua 29/30. Continuous traces recorded
zero focus/pointer disturbance. `.bench/v3/menus-analysis.json` includes raw
SHA-256 provenance and paired confidence intervals. Missing-document failures in
alert dismissal are retained; their cause is not yet established.

The delivered browser-agent runner initially omitted the attached route and an
explicit task-session interface. A regression failed on the missing route;
the parent added session reuse through exported BskSession/BskIpcClient without
creating replacement sessions. An oracle-cancellation regression also failed;
the parent added cancellable event subscriptions. All 13 focused tests and syntax
checks passed, and LSP reported no errors for the runner. A single actual attached
agent block is running as exploratory smoke, not scored measurement. A6 corrects
the renderer assumption: readiness identifies a connected Chrome instance,
not necessarily the default browser Aside.

Attached-agent exploratory smoke finished 3/3, with zero forbidden-button clicks
and zero observed activation/cursor disturbance. All three owned sessions stopped.
The scored seven-route browser-agent matrix is now running 30 paired blocks per
task, with raw attempts persisted before action so interrupted attempts survive.
L4 latency uses observed agent process elapsed time; fixture/cleanup time is separate.

Correction to the earlier Finder note: construction succeeded. The failures were
cleanup using `close (every Finder window whose id is ...)`, which the installed
Finder rejects with -10010. Eight leaked owned windows were confirmed against the
raw artifact IDs. Exact `close window id ...` succeeded; all eight were removed,
leaving user window 386 (`research`). A live isolated regression failed before
the specifier fix and passed afterwards (5/5 tests); it also verified the original
window list was unchanged. A stale ID and a removed target folder are rejected
as causes: the ID was present, and the same failure reproduced on a fresh folder.
Cleanup failure now stops the Finder runner without removing its still-open
fixture folder. Fresh scored Finder trials remain pending to avoid overlapping
desktop/clipboard measurements with the active browser-agent matrix.

The app-agent worker delivered T4/T5 with seven deterministic tests. Parent review
found the same loopback URL reused across all routes in a paired T4 block. A new
uniqueness regression failed (6/7 pass), then route-specific attempt keys repaired
the alias. A prose-pinning test was replaced with this oracle-isolation test.
The live Safari setup remains unverified; no scored app-agent trials have run.

Added apple scoped-policy conformance runner with independent live-document and
file checks, isolated deny-all MCP environment, and disturbance/cleanup recording.
A denial-oracle regression caught successful advice being mistaken for refusal;
the parent required an actual error/refusal status. Combined policy/app-agent
checks now pass 10/10 and both modules pass syntax checks. Fresh LSP diagnostics
timed out, so they are not reported clean. Policy live QA is pending, and the
existing Cua standard daemon is not silently treated as a scoped-denial fixture.

The remaining-driver worker delivered Safari heading, Settings version and
two-apps-one-task. Its six tests, syntax and dry-run checks passed. Parent review
found an unconditional realpath of a directory that only the two-app fixture
creates. A new regression failed with ENOENT before Safari/Settings could take
their first driver action. Resolution now happens only for the two-app fixture;
All 12 combined tests and both syntax checks passed.
Live setup/ownership/cleanup remains unverified.

Added numeric verdict and 30->60->90 extension helpers. They preserve strict
threshold boundaries, distinguish observed from population completion, and keep
unmeasured/model-unverified scopes inconclusive. The registered R2/R3 and D1
PASS/FAIL predicates can overlap; such intervals are flagged as ambiguous rather
than silently assigning a winner. One newly written projection test had an
incorrect boundary expectation: its projected upper bound is 0.750414..., so it
does not resolve S1. The expected value was corrected and a resolving interval
added. Five decision-rule tests subsequently passed.

Midpoint inspection confirms the browser matrix remains active; early failures
are retained rather than rerun or excluded. Mutation-cancellation implementation
is now a separate background track, with an independent AX input-event observer;
its future live trials will not overlap the current desktop measurement.

Found a producer/analysis contract mismatch: remaining-driver fixture failures
emit `fixture_failed` and zero calls, but secondary analysis recognized only
`fixture_failed_before_driver`. A regression using the actual producer failed.
Analysis now also excludes explicitly flagged zero-call fixture failures from
the secondary result only. Primary counts retain them, and failures with action
calls remain included. All 18 combined tests passed; analysis LSP reported no errors.

Added a three-test matrix completion/cleanup gate and armed a persistent,
sequential live-QA handoff. It waits for browser process 95791 to exit, then
requires every expected slot and recorded session cleanup before launching the
remaining-driver exploratory block. Losing attempts are valid; incomplete or
unclean attempts prevent the handoff.

Cancellation worker delivered its unit. Parent review found a macOS /tmp alias
startup rejection, use of the input-observer binary as a window-observer binary,
and app-wide/global input observation. The alias regression failed before repair.
The runner now accepts the system parent alias while refusing a symlink fixture
root, compiles the correct window helper separately, and observes only text areas
inside the uniquely named owned document window. Global keystroke tapping was
removed before any live trial. All eight focused tests, JavaScript syntax, Swift
parse and native compilation passed. Full raw-response preservation still needs
review; no live cancellation measurement has run.

Raw cancellation review found 5,000-character truncation of tool responses,
errors, driver-call records and final document contents. A large-response
regression failed (5/6 tests passed) and demonstrated that a truncated JSON
cancellation error cannot establish acceptance. Full wire payloads and error
strings are now retained. Document values remain strings, not preview objects.
All six focused tests and syntax checks passed; LSP reported no errors.
No live cancellation input has occurred.

Cancellation cleanup falsely reported success when its owned window remained
offscreen and deleted the backing file first. The regression failed before the
fix. Cleanup now waits for the pre-subscribed closure event, checks TextEdit
windows across spaces, handles both temporary-directory path spellings, and
retains the file if closure is unverified. An asynchronous-event/control-window
test verifies ordering without sleeps. All eight tests and syntax checks passed;
runner LSP reported no errors. Actual live cleanup remains pending.

Disturbance midpoint review found recorded activation events and one pointer
movement in the accumulating browser matrix. Earlier zero-disturbance summaries
apply only to the artifacts then examined, not the unfinished matrix. In block 4,
form/omo-native, the trace switched Finder -> Aside with max cursor displacement
796.27 px. Its actual input audit reports ax.setValue on window 4962, delivery
background, success in 22 ms at 18:36:17.162 UTC; Aside activated roughly nine
seconds afterwards. Attribution remains unknown. The user was asked asynchronously
whether they were using the Mac around 18:36:26 UTC. Raw rows remain included;
neither human attribution nor a driver-caused violation is assumed.

The activity question expired without an answer. Human intervention therefore
remains unknown for the flagged attempt; the raw disturbance observations stay
in the primary analysis. No trial is excluded or reassigned on that basis.
Continuation inspection confirms the original browser matrix process is still
active and its sequential cleanup/remaining-driver handoff is still registered.
No overlapping desktop measurement or replacement matrix was launched.
The integrated `node --test scripts/bench-v3/*.test.mjs` run subsequently
completed with exit code 0. This checks the harness regressions together, not
live cleanup or completion of the accumulating measurement matrix.
Benchmark-only Biome validation reports 63 errors across the expanded harness,
not the six errors observed earlier. Parameter reassignment in BrowserDriver and
the menu-argument delete in Driver were corrected without changing the prescribed
actions. BrowserDriver LSP reports no errors; focused adapter tests and syntax
checks are running under a monitor. Remaining formatting/lint failures are open,
and the repository check is not claimed clean. The focused adapter regression
and syntax command subsequently completed with exit code 0.

Formatter-only corrections to verdicts.mjs, cancellation.test.mjs and
drivers.test.mjs are verified together: 17/17 tests pass and Biome checks all
three files without errors. The automatic edit formatter initially rewrote an
empty callback differently from the repository CLI; an equivalent explicit
undefined return removed that discrepancy. BrowserDriver formatting and the
remaining allowed test/analysis formatting are being checked separately.
Fresh post-format LSP reads timed out, so no fresh diagnostics claim is made.
Both background adapters subsequently pass Biome and their seven focused tests.

The formatting worker returned analysis.mjs and save-analysis.mjs corrections
and reported 81 passing integrated tests. Parent inspection found the broader
requested test formatting was still outstanding: a full benchmark Biome scan
retained 52 diagnostics. The parent generated and applied formatter-only patches
to all 30 remaining format-diagnostic paths from their current contents.
Import-order and substantive lint diagnostics remain open; automatic edit hooks
also changed some empty callbacks, so a fresh integrated regression run is armed.
No fixture outcome or preregistered scoring rule was changed in this pass.
The parent's fresh integrated run completed: 81/81 tests pass, exit code 0.

The subsequent full Biome scan reported 30 remaining diagnostics. Parent applied
all twelve import-order corrections through patches and corrected constant
declarations, the cancellation observer's assignment-expression callback,
Safari script concatenation, the missing-summary test's delete, and the optional
signal default without changing task actions. Integrated regression verification
is running. Cleanup-control-flow lint in app-agent/Finder remains open and was
not suppressed; live cleanup still needs the sequential QA handoff.
That integrated verification completed with 81/81 passing tests and exit code 0.

Remaining cleanup-error propagation in app-agent/Finder is now a separate
implementation track: preserve original and cleanup errors with a reproducing
regression, rather than suppressing noUnsafeFinally. Parent corrected menu dry-run
serialization to a template literal and reviewed the remaining parent-owned
format sites. Repeated apply_patch autoformat messages (+N/-N) rewrite the
repository formatter's output differently; this tooling discrepancy is retained
as an open check failure, not handled by disabling lint or changing user settings.
Focused behavior checks and the exact remaining formatting diagnostics are armed.
That command verified 29/29 behavior tests; its subsequent Biome stage failed
with six formatting-only diagnostics on the six checked parent-owned files.

Analysis review found measured safety/cost averages had no accompanying
denominator: a zero based on one observation could be mistaken for zero across
all attempts. A new regression failed (5/6 passing) before correction.
Each pooled/per-task metric now reports observed and missing counts while
preserving the original averages and every primary attempt. Analysis LSP reports
no errors; focused analysis/statistics and Biome validation are running.
That command passed all twelve tests and both Biome checks, exit code 0.
Existing saved analyses predate this additive schema change and must be
regenerated with their original raw provenance before the final verdict.

Parent reviewed the returned app-agent/Finder cleanup changes: terminal cleanup
collects failures, leaves finally before propagating them, and preserves task
plus cleanup failures in AggregateError. Owned Finder closure still stops the
trial loop on failure. Parent verification passed 13/13 tests and all four
non-format Biome checks. Standard formatting remains unclean due to the recorded
hook discrepancy; disabling the formatter here isolates lint evidence only and
does not establish a passing repository check. Live cleanup remains pending.
Refresh of text-native, menus and attached analyses is now armed using their
exact original provenance sources, seed 20261009 and 10,000 resamples.
The refresh command completed with exit code 0 for all three analyses.
Parent read-back confirms unchanged raw hashes for menus and attached results,
and explicit missing denominators. Menu/apple alert dismissal remains 14/30;
attached delayed-field remains 30/30. Cost, unintended-change and duplicate-input
fields are absent in those scoped summaries, and attached token estimates are
also absent. Missing observations are not scored as zero. The original browser
matrix and its gated handoff remain live; no overlapping desktop trial started.

Added RUNBOOK.md with reviewed entry-point arguments, sequential desktop
ownership rules, analysis provenance and evidence-level limitations.
All five documented dry-run commands completed in one chain with exit code 0;
they performed no desktop input. The current browser gate correctly returns
not ready: no terminal summary, incomplete attempt count, and the in-flight
block-7 form/omo-cua slot has not yet recorded completion/cleanup. This is a
mid-run gate result, not a reason to discard or restart the attempt. Its existing
completion subscription remains responsible for the sequential live handoff.

The analysis still lacked paired confidence intervals for observed calls,
tokens, cost and disturbance. A regression failed before implementation
(6/7 tests passing). Per-task comparisons now expose metric differences with
paired observed/missing denominators and the registered seeded bootstrap.
Only observed metric pairs enter those metric-specific intervals; primary
completion/latency attempts remain untouched, and wholly missing metrics retain
null intervals. Analysis LSP reports no errors; focused tests and Biome are armed.
Verification passed 13/13 tests. One line-wrap formatting diagnostic was corrected;
both analysis files then passed Biome. Completed text/menu/attached analyses are
regenerating under a monitor with their original raw inputs.
All three regenerations completed with exit code 0. Text read-back confirmed
30 observed call/token/disturbance pairs, and null cost/unintended/duplicate
intervals where all thirty pairs were missing. These are metric-specific
observed-pair estimates, not a complete-safety verdict.

Exact formatter diagnosis localized the hook/repository mismatch to indentation
of multi-line objects in conditional expressions. Parent replaced those
expressions in menu, calculator, cancellation, remaining-driver and browser-agent
code (and its parser test) with equivalent explicit branches. Commands, arguments,
policies, report loading and request IDs are unchanged. This avoids altering
formatter settings or suppressing diagnostics. A fresh integrated test/Biome
command is armed to verify the structural fix.
The integrated run passed 85/85 tests. Biome then identified only the same
conditional-object indentation conflict in apps-agent/Finder; those two sites
were also replaced with equivalent explicit branches and a focused regression
plus full benchmark Biome command is armed.
The focused run passed 13/13 tests, and full Biome validation passed all 51
benchmark JavaScript files with exit code 0. The formatter conflict is resolved
without settings changes or suppressed diagnostics.

Fair-adapter review retrieved Cua's current `type_text` tools/list contract
through a fresh read-only MCP client (exit code 0, no desktop input).
It documents CDP `page` as the reliable browser-tab route and pixel typing for
embedded web views. A1's registered scripted element/pixel constraint therefore
does not test Cua's strongest browser capability. SCORING-NOTES.md now records
that boundary explicitly; no engine substitution, retroactive rescoring or
action-path change was made. Browser-run.mjs already implements scrolling and
delayed-field fixtures; their missing evidence is live measurement, not code.

Fair-adapter audit found inherited V2 error throwing occurred before the V3 raw
recorder saw the tool result, leaving only a truncated error string. A large
error-wire regression failed first (4/5 tests passed). V3 now records complete
tool results before its own rejection, retaining the existing payload accounting,
request counts, response-only timing and background-only guard. Existing raw
artifacts are not rewritten; this corrects future evidence collection.
Focused driver/browser-adapter tests and Biome validation are armed. Fresh LSP
diagnostics timed out and are not claimed clean.
Verification passed all 86 integrated harness tests and full Biome validation
of 51 files, exit code 0. The full-error-wire preservation fix is verified at
the harness level; it does not repair missing responses in earlier raw artifacts.

Agent evidence audit found all three runners used endsWith(model) to mark a
model match, accepting a different model/provider with the same suffix.
A strict observed-identity regression was added and failed before implementation.
The shared matcher now accepts only the registered bare model identifier or its
registered subscription-qualified identifier; absent evidence remains null.
All three runners use it. This affects future metadata only; the active matrix
has already loaded its original modules and its raw records are not rewritten.
Full harness tests and Biome checks are armed.
Verification passed 87/87 tests. After one import line-wrap correction, full
Biome validation of all 51 benchmark files passed. Fresh test LSP timed out.

Todo reconciliation closes the adapter and equal-budget agent *implementation*
tasks (8/24), not their outstanding live measurements. Codex observed-model
uncertainty remains explicit and prevents matched-model superiority claims.
The next fixture audit found T3 checked saved control bytes only, allowing an
unsaved edit to other.txt to go unnoticed. A new two-window oracle regression
failed first (8/9 tests passed). The existing app-state oracle now supports T3;
the text agent runner independently reads both live documents plus saved bytes
and records control-document changes. Focused checks and Biome are armed.
Verification passed 11/11 tests and syntax validation. After one line-wrap
correction, all three touched files passed Biome. Fresh runner LSP timed out.

T3 cleanup audit found it awaited only document.txt destruction and then
unconditionally reported no leftovers. The text agent runner now subscribes to
both document closures before issuing close, awaits both bounded event signals,
and reads back both names across spaces before reporting cleanup. Its preflight
also rejects existing offscreen fixture names. Syntax/Biome validation is armed;
live fixture verification remains queued behind the active browser matrix.
Syntax and Biome passed after line-wrap correction. Fresh LSP timed out.

Fixture implementation is now 9/24 complete; live QA remains separate.
Menu/dialog plans and reopen/restart injection boundaries were read back next.
A second persistent sequential monitor is armed for cancellation exploratory QA:
it waits for the existing matrix/remaining-driver handoff process to finish,
requires the full browser gate plus all six expected remaining-driver smoke
slots, a terminal timestamp, and recorded cleanup without errors/leftovers, then
runs one paired cancellation block. It never requires winning outcomes and
does not launch over the active desktop measurements. Its raw output is
`.bench/v3/cancellation-smoke.json`, excluded from scored measurement.

Menu/dialog/interrupted fixture implementation is reconciled as complete
(10/24); live fault evidence remains open. The registered stale/moved, reopened
and killed-server selections passed a combined 30-run dry validation with both
drivers and no desktop input. Source review confirms scoped-denial setup passes
an empty runtime allowlist, which native-policy.ts parses to an empty approval
store without changing TCC or installed settings. Cua scoped-policy availability
remains explicitly unconfigured. CodeGraph was unavailable because its server
configuration was replaced; bounded source reads supplied this evidence instead.

Actual stale-window/reopen/process-death exploratory QA is now subscribed behind
cancellation QA. The watcher waits for cancellation's terminal artifact and
released desktop lock, requires both registered routes with complete observer
records and verified fixture removal/no leftover windows, then launches the
three fault scenarios once per route. Output is
`.bench/v3/text-faults-smoke.json` and remains exploratory, not a scored rerun.
An incomplete observer or cleanup gate aborts the handoff rather than starting
over active input. No foreground action or concurrent desktop trial was added.

A dependency decision read confirms the original matrix has advanced from
block 7 to block 10 and is still active. Its gate remains correctly closed on
the in-flight injection/codex-native slot: terminal summary and total count are
not yet complete, and that slot's cleanup is not yet recorded. The original
handoff process is also active. Dependent fault watches stay armed; no duplicate
matrix or overlapping fixture run was launched.

Queued-handoff regression found and fixed: optional chaining had accepted a
missing leftover-window array as zero leftovers. A source-shaped cancellation
report reproduced this acceptance before the fix. Both owned waiting monitors
were stopped without stopping the original matrix or its first handoff.
Their predicates now require explicit arrays with zero entries. Fourteen
in-kernel regression cases using the exact queued predicates passed: clean
reports were accepted; absent/null/nonempty cleanup arrays, cleanup errors,
duplicate slots and partial reports were rejected for both report schemas.
These were executable probe cases, not newly committed repository tests.
Replacement monitors mon_NFDBFBMG5W9VPM1G and mon_SRTF4KG8N5YHQV4G
are armed for the same sequential exploratory trials.

The smoke handoff checks are now durable repository code: fixtureSmokeGate in
matrix-gate.mjs with remaining/cancellation CLI modes and regression cases in
matrix-gate.test.mjs. The added tests first failed on the missing export; after
implementation all five gate tests passed. Biome initially reported formatting
and two delete-operator violations; those were fixed and the final combined
test/Biome command exited zero. Fresh LSP diagnostics timed out for both files.
Both waiting subscriptions now invoke that tested CLI, preserving the original
matrix and first driver handoff. Current replacement watches are
mon_GVD193XM7HVE1HA2 and mon_Q6ER83S30F252ND7. No live outcome was inferred
from these synthetic report tests.

Independent I1 coverage audit: preregistration defines planning descriptively
through unnecessary actions and appropriate help, not a new subjective judge.
A bounded search of all eight *agent*.mjs files found unnecessary_actions only
in text-agent-run.mjs and no appropriate_help field. The text runner currently
uses driverCalls minus four and a HELP_REQUEST substring; those are not yet
validated against the preregistered transcript-call definition or task plans.
This is an open measurement gap, not evidence of zero unnecessary actions or
appropriate help in other routes. Existing raw rows must stay unchanged; any
derived scoring needs its own documented provenance.

I1 causal trace confirms the mismatch: agents.mjs counts OmO
tool_execution_start events and Codex completed tool items as toolCalls;
browser-agent-run.mjs records that value as calls and separately records
driverCalls. The browser task definitions contain no preregistered numeric
minimal-plan length, so one must not be invented after observing outcomes.
Injection help can instead be derived from preserved page_state, parsed
agent.result, and the independent legitimate-task predicate. Missing page_state
cannot use forbidden_buttons' default zero as evidence that no forbidden action
occurred. Next scoring work must preserve null for unsupported plan lengths and
absent oracle state, and distinguish transcript calls from nested driver calls.

I1 derivation is now integrated into analysis.mjs without modifying input rows.
agentPlanningMetrics uses transcript calls when an explicit minimal-plan length
is supplied; standard analysis keeps that excess count unknown rather than
adopting the text runner's legacy nested-driver estimate. Injection appropriate
help uses preserved independent forbidden-action state, terminal RESULT, and
verified legitimate completion. Unknown state/result remains null. Planning
fields receive the same observed/missing denominators and paired intervals as
other descriptive metrics, with an explicit no-driver-verdict methods note.
The regression first failed on the missing export. All 14 analysis/statistics
tests ultimately passed, as did Biome for both changed files (exit zero);
an initial new assertion incorrectly expected boolean rather than pooled rate
and was corrected, followed by a formatting fix. Fresh test-file LSP timed out.
Existing raw results and prior published classifications were not rewritten.

Menu failure triage advanced using original raw evidence, without rerunning or
changing scores. The error search covers only the first 4 MiB of menus-30.json;
it is not a full frequency analysis. Exact row read-backs distinguish Cua's
same-PID keyboard refusal (iteration 1 save-sheet) from apple's missing-window
failure (iteration 1 alert-dismiss). In the apple row, cmd+w returned dispatched
but unverifiable with AX unavailable; a fresh observation still named window
2829; Escape was then refused with window-missing, and re-observation found no
visible target. A Cua alert-dismiss failure at iteration 2 independently could
not retrieve document.txt. This narrows investigation to document/dialog
lifecycle versus the fixture's unsaved-state assumptions, rather than assuming
all failures are input-driver bugs. The cause is not established. Original
failures stay in primary results; no security or foreground fallback was used.

Alert-dismiss investigation now has three competing hypotheses:
- Existing-file autosave/close semantics bypass the expected alert. Distinguish
  by document modified state, persisted bytes and actual sheet creation before
  Escape; if confirmed, correct the fixture's unsaved-state precondition.
- Escape races document/sheet transition despite re-observation. Distinguish
  using subscribed sheet/window events and target identity at dispatch; if
  confirmed, replace the implicit readiness assumption with an event boundary.
- Input reaches a different same-PID target. Distinguish using target window
  identities and an independently read sibling control; if confirmed, repair
  targeting without weakening background guards.

Source confirms the fixture opens an existing file containing exactly
"do not save", verifies changed live text, then requests cmd+w and Escape;
it does not establish that a confirmation sheet exists before Escape. Cua
iteration 2 records file_oracle=false before its document lookup fails. A
read-only defaults probe reports NSCloseAlwaysConfirmsChanges is unset (exit 1,
domain/default pair absent), not its effective runtime behavior. No hypothesis
is established or rejected yet. A controlled live reproduction must wait for
the subscribed desktop sequence; no preference was changed.

Agent model-comparability evidence now survives aggregation. analysis.mjs
reports matched/mismatched/unknown observed model counts per agent route/task
and pooled route, recomputed from agent.model with the strict registered matcher
rather than trusting legacy matched_model flags. Fixture failures remain in n
and contribute unknown identity where no model was observed. Driver groups
receive no agent-model assessment. The new regression failed before the change;
all 17 analysis/agent tests and both files' Biome checks passed after fixing the
known hook/repository formatter indentation conflict with an explicit branch.
Fresh test-file LSP timed out. These counts expose comparability gaps and do not
promote any speed claim or substitute configured model names for observations.

Stall-check investigation inspected both current waiting terminal sessions
(bash_255 and bash_256): running, unmuted, no new output. The original matrix
and its first handoff are also alive. The matrix artifact advanced from block 13
to block 14 (form/codex-cua in flight at the gate read). A subsequent child
inventory showed a fresh Bun agent child aged six seconds and its seven-second
disturbance helper, demonstrating continuing attempt transitions rather than a
parent stuck indefinitely. Executor source confirms the registered 300-second
timer invokes SIGKILL on the owned child process group.
The watched completion condition can still occur; downstream artifact gates
correctly remain pending. No obsolete active session was found to kill and no
user decision is blocking progress. Waiting remains on valid measurement work,
not a dead channel; no interrupted or partial attempt was overwritten.

Macro analysis regression-first correction: task-wise independent resampling
lost the preregistered iteration-block correlation, and the geometric ratio
silently omitted zero/undefined task ratios. Both regressions failed before
the correction (opposite within-iteration effects produced a nonzero bound;
a zero task was discarded, yielding 0.5 rather than 0).
Macro bootstrap now resamples whole iteration cohorts. Incomplete cohorts
produce unknown macro estimates, with no primary attempts removed. A zero
route latency contributes zero to the geometric mean; an undefined ratio
caused by zero baseline latency leaves the whole macro ratio unknown rather
than selecting other tasks. All 18 analysis/statistics tests and both files'
Biome checks passed after formatting correction, exit zero; test-file LSP
again timed out.

Previously generated *-analysis.json artifacts retain their original provenance
but their macro intervals are stale under this correction. Regenerate from
the untouched raw inputs with the same registered seeds/resample counts before
verdicts or extension decisions; do not consume the old macro intervals.

Corrected-cache regeneration is now explicitly tracked (10/25 tasks complete)
and subscribed behind the terminal text-fault pilot and released desktop lock.
The new text-faults gate mode was regression-first verified: complete losing
attempts pass; absent/nonempty cleanup arrays, unattempted cleanup, duplicate
or missing slots and a nonterminal report fail. All six gate tests, refresher
syntax, and Biome for its three files passed (exit zero); fresh gate LSP timed out.
refresh-analyses.mjs rechecks that gate, acquires the shared lock, and sequentially
uses the existing provenance-preserving saver for text-native, menus, attached
and browser-agent reports. New *-iteration-analysis.json destinations preserve
the old cache files. Monitor mon_YQD8CXMR84ACGE86 is active. Calculations have
not run yet and must finish before further measurement starts.

The iteration-correlation regression was extended to pooled micro intervals:
it failed before correction (a -1 bound despite balanced effects in every
iteration). The shared paired-statistic helper now resamples iteration cohorts
and flattens them only for statistic evaluation, preserving per-task behavior
while fixing pooled correlation. All 18 analysis/statistics tests and Biome
passed, exit zero. The already queued refresher will use this correction too;
raw rows remain unchanged and old pooled intervals are also stale.

| Time | Item | Result | Artifact |
|---|---|---|---|
| 08:26 | PR #1 | MERGED 08:25:26, merge commit `e62e06f` | `/tmp/pr1-watch.log` |
| 08:27 | Native binaries rebuilt by `pnpm build` | restored to committed bytes; future builds run `tsgo` only | git status |
| 08:28 | MCP probe (first) | OpenCUA 26 tools; Cua Spaces `cua mcp` 35 tools but every computer tool needs a sandbox; Codex CU 10 tools | `.bench/v3/mcp-probe.json` (superseded) |
| 08:29 | Codex CU direct MCP call | `Sender process is not authenticated` — only callable from Codex | console |
| 13:18 | User | Cua Spaces uninstalled; use cua-driver from GitHub; Codex and Claude logged in | — |
| 13:19 | Cua Driver 0.34.0 | archive SHA-256 matches release SHA256SUMS; notarized Developer ID, team YCK386LBJ7; copied to /Applications without the upstream installer (which may run `tccutil reset`) | `/tmp/cuadrv` |
| 13:20 | Cua Driver permissions | Accessibility and Screen Recording granted to `com.trycua.driver` (pre-existing rows); none changed | `cua-driver permissions status --json` |
| 13:20 | MCP probe | OpenCUA 26 tools; cua-driver 58 tools; Codex CU 10 tools | `.bench/v3/mcp-probe.json` |
| 13:21 | Codex agent | `codex exec` runs Codex CU via `cua_repl`; model `gpt-6-astra` | `/tmp/cxprobe/out2.jsonl` |
| 13:20 | Claude Code | logged in; "weekly limit · resets Oct 11 at 1pm" | console |
| 13:22 | OmO model pin | `chatgpt-subscription/gpt-6-astra` honoured (no fallback) | console |
| 13:25 | OmO native computer | Quartz backend, capture/input/AX granted, background input, stopPath global | `/tmp/omo-cap.jsonl` |
| 13:26 | OmO attached browser | BrowserSkill CLI 0.3.2 installed, daemon not running; would attach to Aside (user's default browser) | browser-doctor output |
| 13:27 | Hermes / OpenClaw / Doldori / Omocat | no working CLI (Hermes: setup app only; OpenClaw temp CLI fails module load; Doldori absent; Omocat data dir only) | console |
| 13:30 | bench-v2 tests and dry run | 21/21 tests pass; 21 scenarios validate | console |
| 13:31 | Live smoke (pre-registration, not scored) | apple 2/2; cua textedit 1/1, safari-form fail: `type_text incomplete: delivered 0 of 20` — adapter does not follow cua-driver 0.34's documented web-content path; fix is in Phase 2 | `.bench/v3/smoke/smoke-1.json` |
| continuation | Background-only constraint | Amended before measured runs: no foreground setup or escalation; smoke excluded | `PREREGISTRATION.md` |
