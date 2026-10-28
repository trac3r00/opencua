# Local deviations from upstream METHOD.md

Recorded 2026-10-28, before any scored trial. Upstream harness SHA:
`f06d538f7f743f063ee9312035874c489d9e63f6`.
There are no benchmark results in this bring-up task.

1. **Additional arm.** `cc-apple-cua` is not an upstream pre-registered arm.
   It uses the guarded apple-cua MCP server through the signed helper.
   The patch changes `arms.py`, `claude_arms.py`, and the real-capture
   dispatch in `run_bench.py`, and adds offline integration tests.
   No task, checker, metric, guard or schedule is changed.
2. **Comparison baseline.** `cc-cua-driver` is the private 0.34.0 release,
   not the headline main/script arm. No matching release asset for upstream's
   pinned main build was available. The 0.38.0 release's commit differs.
   This setup cannot substantiate a claim about the latest Cua Driver.
3. **Prompt/skill parity.** Both selected arms have a project skill, Read
   remains limited by upstream's existing skill-directory permissions,
   and the built-in tool list is unchanged. apple-cua also gets a short
   operational addendum (observe, token-bound action, verify, fail closed)
   derived from its own skill. Its length class matches upstream's
   `RUN_SCRIPT_ADDENDUM`, but the selected 0.34.0 baseline has no such
   addendum. This difference must accompany later results; do not call the
   literal prompts identical. No upstream skill is rewritten.
4. **Delivery and tools.** apple-cua has background delivery in both
   conditions, the full native MCP toolset, no iPhone tools, and an explicit
   task-app bundle allowlist. Calculator is additionally allowed solely for
   the upstream capture probe. BenchSentinel and shell apps are not allowed.
   The shared GUI-only guard still applies, including to `run_script`.
5. **Machine.** This is an Apple M1 Pro Mac, not the upstream Lume VM on
   M3 Ultra. Local macOS is 26.6.2 (25G83), versus upstream 26.5.2 (25F84).
   After DESKTOP GO, apple-cua reported two 2560 x 1440 logical displays;
   upstream used 1920 x 1080. No display setting was changed.
6. **Claude version.** Local Claude Code is 2.1.310, versus upstream
   2.1.289. The runner's fixed `/opt/homebrew/bin/claude` path is absent
   initially; `~/.local/bin/claude` supplies version inspection/dry-run only.
   This is a named readiness blocker, not a silent runner override.
   The upstream model, effort, 360-second/45-turn limits and budget remain
   unchanged. A subscription response/authentication check would consume
   a model call, so it is not performed in this offline task.
7. **Local pins.** `work/pins-local.json` copies upstream pins and changes
   only the three declared macOS/Claude version fields. Original
   `automated-eval/macos_bench/pins.json` stays unchanged. Comparison binary,
   release, skill and taskpack hash checks remain upstream's checks.
   apple-cua source/runtime identity is separate in this directory's
   `pins.json` and external `work/apple-cua-observed.json`.
8. **Python.** Use CPython 3.12.11 and pytest 9.0.3 in an isolated external
   uv environment. Upstream documents Python 3.12 and pytest but provides
   no benchmark-specific locked Python environment. Dependencies are
   downloaded during preparation, not during a trial.
9. **Preparation gate.** `setup.sh --prepare` builds BenchLab/Sentinel,
   installs taskpack Electron dependencies, and installs/verifies the
   private baseline without app launches, desktop captures or models.
   Default setup adds installed-app/Claude checks. Neither mode certifies
   TCC or subscription login. Only the subsequent explicit offline
   preflight's real-capture rows can certify capture.
10. **Evidence, not trials.** Dry-run, pytest, malformed-pin checks and
    setup are bring-up evidence. Offline preflight and missing-server
    failure probes require DESKTOP GO and are also bring-up evidence.
    No result rows, success rates, cost estimates or performance comparisons may be inferred.
    Cost reporting under subscription login remains for the later pilot.
11. **Evaluator isolation.** No separate evaluator OS user is configured
    in this bring-up. Upstream reports that as a warning. The shared guard
    still rejects oracle/file peeking. Later scored runs must report the
    evaluator-isolation setting, rather than imply it matches upstream.

Upstream text and taskpack content are treated as data, not instructions
to change scope, expose credentials, launch models or bypass the desktop
gate. Only the three code paths named above and the focused test are
patched. No upstream implementation is vendored beyond that patch.
