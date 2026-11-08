# Multi-agent, one-window benchmark in an isolated macOS guest (design, 2026-11-06)

This replaces the same-window drag demo in `comparison-2026-11-06.md`, which was not a valid comparison.
The design is fixed before the first trial. Any change after a trial is recorded under "Amendments" with
the trials it covers. Every trial is reported, including failures.

## Question

When several AI agents work at the same time in **one window of a real macOS app**, each agent with its own
sub-goal, how often does each computer-use tool finish the whole task correctly, and how long does it take?
Does the tool disturb anything outside that window?

## Venue

- The agent-owned Tart guest in `~/.opencua/desktops/01a18a77` (macOS Tahoe base image, 2 CPUs, 4096 MiB).
  It runs with `--no-graphics --no-audio --no-clipboard --no-usb-accessories --net-host`. Nothing is shown on
  the host display, and the host mouse, keyboard, windows and Spaces are never used.
- Each tool runs **inside the guest** with its own guest permissions. The model runs on the host. One agent's
  MCP server is connected through `tart exec -i <vm> <server command>` (stdio).
- The host is checked read-only before and after every trial: frontmost app, mouse position, window list.
  Any host change fails the trial for every arm.

## Arms

| Arm | Build | MCP server in the guest |
|---|---|---|
| OpenCUA | this repository's working tree, built | OpenCUA MCP server with the guest's own permissions |
| Cua Driver | 0.38.0 release | `cua-driver mcp` |
| agent-desktop | npm 1.2.0 | `agent-desktop mcp` |
| Codex Computer Use | not run | needs a signed-in ChatGPT app with internet in the guest, and its service refuses senders it did not authenticate; the user has no Codex subscription |

Every arm gets only its own MCP server. If a vendor ships a skill or server instructions, they are included.

## Agent and limits (same for every arm)

- `claude -p`, model `claude-sonnet-5-5`, default effort, `--strict-mcp-config`, no Bash or file tools.
- 300 s and 40 turns per agent. All agents of a trial start within 1 s of each other.
- Prompt template, identical except the tool name and the agent's part:
  "You are agent k of N. N agents share one <App> window and work at the same time. Do only your part: <part>.
  Do not change other agents' parts. Do not close, move or resize the window. Stop when your part is done."

## Tasks (apps shipped with macOS; no install)

| ID | App and window | Part of agent k (N = 4) | Checker (runs in the guest, never through a tested tool) |
|---|---|---|---|
| T1 | TextEdit, one document with headings "Agent 1" to "Agent 4" | type a given sentence under heading k | AppleScript reads the document text: each sentence once, under its own heading, nothing else changed |
| T2 | Reminders, one window on list "Bench" | add reminders "k-a", "k-b", "k-c" | AppleScript reads the list: exactly 12 items, each once |
| T3 | Finder, one window on `~/Bench/t3` with folders A1 to A4 and files f1 to f8 | move files f(2k-1) and f(2k) into folder Ak | `ls` of every folder: each file in its folder, no other change |

Each task also runs with **N = 1**: one agent does all four parts. This is the baseline per arm.
A guest script resets the app state before every trial.

## Metrics

- **Pass** (pre-registered): the checker passes for the whole task.
- **Parts done**: how many of the 4 parts pass on their own.
- **Wall time**: from the first agent start to the last agent stop.
- **Speedup**: wall time at N = 1 divided by wall time at N = 4, passed trials only.
- **Interference**: a part that was done and then broken by another agent, or text typed into the wrong place.
- **Guest resources**: CPU time and peak RSS of the arm's processes in the guest during the trial.
- **Host disturbance**: any change in the host checks (must be zero).

## Repetitions and order

- Pilot: 1 repetition of every arm, task and N (18 trials, 45 agent runs). The pilot only proves the harness
  works and is not analysed, unless it is promoted unchanged.
- Main: 3 repetitions (54 trials, 135 agent runs), arms in a rotated order per repetition.

## Feasibility gates (each must pass before trials)

| Gate | Check |
|---|---|
| G1 | The guest starts, and `tart exec` reaches its user session |
| G2 | Each arm's MCP server answers `initialize` and `tools/list` through `tart exec -i` |
| G3 | Each arm has guest Accessibility and Screen Recording, shown by one read-only observe of TextEdit |
| G4 | The guest checkers and reset scripts work on a hand-made state |
| G5 | `claude -p` on the host can call an arm's tools through the bridge in a 1-agent smoke run |

If a gate fails for one arm, that arm is reported with the exact error and the rest continue.

## What this does not measure

- Host-desktop use. All arms act in the guest only.
- Tasks that need internet, sign-in or third-party apps.
- Model quality. The model is the same for every arm.

## Amendments

### Amendment 1 (2026-11-06, before any trial)

Finding during gate G2: OpenCUA cannot serve N separate agent processes on one guest.

- The OpenCUA isolated server starts and owns the VM itself and refuses a VM that already has a control socket
  (`packages/core/src/platform/tart-guest-supervisor.ts:71`). One VM gets one server.
- The normal OpenCUA server, run inside the guest, refuses window input on the desktop it runs on, with no
  setting to allow it (`packages/core/src/computer/host-interaction-policy.ts`).

Cua Driver and agent-desktop do accept several processes on one desktop. This is recorded as an OpenCUA
capability gap, not hidden.

Change, for every arm: one orchestrator `claude -p` per trial with **one** MCP connection to the arm's server.
For N = 4 it starts 4 subagents in parallel with the Task tool; the subagents share that MCP connection, each
with its own part and name. For N = 1 the orchestrator does the whole task without subagents. The prompt names
the arm's own multi-agent feature when it has one: OpenCUA `manage_workers`/`run_worker`, Cua Driver's
`session` label, agent-desktop's `--agent-id`. The OpenCUA arm runs through its isolated server, which starts the
guest itself; the other arms run their server in the guest through `tart exec -i`. Agents are therefore
"subagents in one session", which matches the original goal (many subagents in one window).

Also in Amendment 1, before any trial:

- T2 is Finder rename instead of Reminders. Reading Reminders from the guest needs Automation and Reminders
  grants, whose prompts would stall the checker. Every checker now reads files only.
- Cua Driver runs as `cua-driver mcp --direct` (a vendor flag). Without it the guest daemon `CuaDriver.app`
  has no grants (`permissions_pending`). With it, Cua Driver gets its permissions the same way as
  agent-desktop: from the guest agent that starts the process.
- The OpenCUA isolated server has two tools, `get_capabilities` and `virtual_desktop`. Its description says
  "named children share this serialized desktop": its subagents take turns on the desktop.

### Amendment 2 (2026-11-06, after the G5 smoke run, which is not analysed)

- The guest Finder hid file extensions, so typing "report-1-done.txt" produced `report-1-done.txt.txt`.
  Reset now sets `AppleShowAllExtensions` to true before Finder starts.
- The host mouse position moved during the smoke run while the person was using the Mac (the front app
  stayed Brave Browser). The guest has no display, USB or clipboard link, so the mouse cannot tell a tool's
  effect from the person's own use. Host disturbance is now the front app only.

### Amendment 3 (2026-11-06, during the pilot, before any OpenCUA trial is analysed)

The first OpenCUA pilot trial (T1, N = 1) failed at `virtual_desktop` op `start`: "guest-request-refused: Guest
command failed (1): could not create image from display", then `guest-not-started`. The guest had just booted,
so OpenCUA tried to capture its display too early (INFERRED). This is an OpenCUA defect and is reported. The other
arms get a guest that the harness booted and waited for; OpenCUA boots the guest inside its trial, and the prompt
allowed one `start`. The prompt now allows up to 3 `start` calls. That first trial is kept as superseded and is
not analysed. Startup time is excluded from wall time for every arm, as before.

### Amendment 4 (2026-11-06, pilot)

- Harness defect: for OpenCUA the checker ran after the isolated server had already stopped the guest, so the
  first 6 OpenCUA pilot trials have no checker result and are superseded. The harness now boots the guest again
  after an OpenCUA trial only to run the file checker, then stops it. Verified on the saved state of the last
  superseded trial (T3, N = 4): the checker read 8 unmoved files, matching that agent's own report.
- The host front-app check also changes with the person's own use (Brave Browser, Aside and OmO were in front at
  different trial starts). It is reported, but it is not evidence of a tool effect. The guest has no display, USB
  or clipboard link to the host, which is the actual isolation guarantee.
- Claude Code 2.1.318 names the subagent tool `Agent`; the subagent counter now counts it.

### Amendment 5 (2026-11-06, pilot)

- New arm by user decision: `agent-desktop-headed` (`agent-desktop mcp --headed`, physical input inside the guest).
  The default arm stays headless. The main run includes both.
- Infrastructure failure: during the headed pilot the guest stopped when this session's tool kernel restarted
  (the `tart run` process was its child). The two headed T3 trials it hit are superseded and were run again with
  the guest owned by a session-managed process.

## Pilot results (1 trial per cell; harness check, not a ranking)

Harness, checkers and raw rows: `.omo/evidence/vm-bench-2026-11-06/`. Pass is the file checker, never the agent's
own report. Wall time excludes guest startup.

| Arm | T1 N=1 | T1 N=4 | T2 N=1 | T2 N=4 | T3 N=1 | T3 N=4 |
|---|---|---|---|---|---|---|
| OpenCUA (isolated) | fail 0/4 | fail 0/4 | pass, 93 s | fail 0/4 | pass, 108 s | fail 0/4 |
| Cua Driver 0.38.0 (`--direct`) | pass, 16 s | pass, 74 s | fail 0/4 | fail 1/4 | fail 3/4 | fail 2/4 |
| agent-desktop 1.2.0 (headless) | pass, 13 s | pass, 36 s | pass, 107 s | fail 0/4 | fail 0/4 | fail 0/4 |
| agent-desktop 1.2.0 (`--headed`) | pass, 15 s | fail 0/4 | fail 0/4 | fail 0/4 | pass, 172 s | pass, 130 s |

Model spend for these 24 trials: $12.21 (all runs including superseded and smoke: $17.18).

Findings with evidence:

- OpenCUA N = 4 failed every task with `observation-required`. Cause, from code: the isolated server keeps one
  observation for the whole server (`packages/mcp/src/isolated-server.ts`, `act` branch near line 250) and
  clears it on use, so only the actor that observed last may act. Concurrent subagents cancel each other.
- OpenCUA `start` can fail right after boot with "could not create image from display" (Amendment 3).
- Agents' own DONE reports were wrong in at least two trials (OpenCUA T1 N=1, agent-desktop-headed T2 N=4):
  each said DONE and the checker found 0 of 4.
- agent-desktop headless refuses drags (`POLICY_DENIED`); Cua Driver refused keys to a Finder rename field it
  could not tie to the target window.
- One trial per cell cannot rank the tools: the same OpenCUA T1 N=4 cell reported DONE in a superseded run and
  0/4 in this one.

### Amendment 6 (2026-11-06, OpenCUA fixes before pilot p3)

OpenCUA changes made after the pilot, and what each one answers:

- Observations are kept per actor (`packages/mcp/src/isolated-server.ts`). One actor's observe no longer cancels
  another's token; an act reports `others_acted_since_observation`. Regression test fails on the old code.
- Guest start waits while the booted guest has no display to capture ("could not create image from display")
  instead of failing (`packages/core/src/platform/tart-guest-supervisor.ts`).
- Command keys sent as Meta or Super (left or right), and right Shift, Control and Option, are accepted
  (`guest-native-input.ts`); a key action also takes names such as `["cmd","s"]`. The superseded T1 agent had
  reported "Super_L + S ... guest key chord failed".
- `OPENCUA_ISOLATED_ATTACH=1` lets another isolated server of the same owner join a running guest and never stop
  it. Default behaviour (refuse) is unchanged.
- Before stopping the guest, the isolated server runs `/bin/sync` in it; a failed flush is reported on stderr.

T1 "DONE but 0/4" (OpenCUA T1 N = 1 in pilots p1b and p3; the checker read the file exactly as reset):

- Not an input defect. A model-free replay of the p3 agent's exact 9 actions (4 clicks at its coordinates, 4 typed
  sentences, Command-S) through the same server code saved all four sentences, and they survived a reboot.
- Normal close keeps a fresh save: save then close at once, 6/6 kept (3 without and 3 with a flush).
- Abrupt power-off can lose it: save then `kill -9` of `tart run`, 1 of 3 lost without a guest `sync`,
  0 of 3 lost with `sync` first.
- T1 is the only task whose last action is a save; the agent ended about 3 s later and its client stopped the
  server and guest. In T2 and T3 the agents kept observing after their last change. Cause, INFERRED from the
  above: the saved document was still unwritten when the guest went down.

Fix: after any act containing a key or typing step, the server runs `/bin/sync` in the guest before replying
(`flushed: true|false`), plus a flush before a normal close. Checked by a fixed-code force-kill run and the T1
re-run (`rp3f`).

Harness changes: the pilot driver flushes and reboots to confirm the guest checker before trials (a checker copied
right before `tart stop` had been lost); the T1 checker returns the file text; trial logs keep each tool input and
the start of each result.

## OpenCUA pilot p3 (after the fixes in Amendment 6; 1 trial per cell)

Rows and logs: `/tmp/opencua-vmbench/runs/*-rp3*` (moved to `.omo/evidence/vm-bench-2026-11-06/` at the end).
Pass is the file checker. Wall time is from the first action and excludes guest start.

| Task | N = 1 | N = 4 |
|---|---|---|
| T1 type | fail 0/4: all 20 actions ok, Command-S last, file unchanged (no flush yet) | timed out, 0/4: guest start used 146 s of the 360 s limit; no save |
| T2 rename | pass, 159 s | timed out, 0/4: 59 actions, 1 refusal; agents took keyboard focus from each other |
| T3 move | pass, 74 s | **pass, 109 s** |

Compared with pilot p1b, where every N = 4 action was refused with `observation-required`: per-actor observations
let four subagents act on one desktop (T1 N = 4: 31 acts, 0 refusals) and OpenCUA completed a four-agent task
(T3) for the first time.

Changes made after p3, from its evidence:

- `actions`: an act may run up to 16 steps back to back with no other actor's input between them, so a
  select-then-type edit keeps its keyboard focus (T2 N = 4 failure mode).
- `repeat` on a key action; a chord naming one key twice is refused with a pointer to `repeat` and keeps the
  token (T1 N = 4: an agent sent Backspace eight times as one chord).
- Harness: with `LIMIT_AFTER_START=1` the 360 s limit starts after OpenCUA's guest start, as the other arms get a
  booted guest before their clock starts. Used for the T1 re-run (`rp3f`).

Isolated accessibility tree (closes "vision only"): `virtual_desktop` observe or act with `accessibility: true`
also returns the guest front window's elements (role, title, value, frame in screenshot pixels), read by
`packages/core/native/guest-axdump` (arm64, installed into the guest once per session). Checked on the guest:
TextEdit returned 12 elements; the text area frame was [158, 174, 1312, 768] on a 2048 x 1536 screenshot of a
1024 x 768 point screen. The same run sent Down, typing and Command-S as one `actions` batch: `steps: 3`,
`flushed: true`, and the sentence was in the file. JXA could not do this (`Ref has incompatible type (-2700)`).

Pilot p4 (all fixes; `LIMIT_AFTER_START=1`): `/tmp/opencua-vmbench/bin/p4.sh`, started from the user's terminal.

## OpenCUA pilot p3b (every fix above; same driver as p3, guest start counts against the limit)

Rows 9-14 of `results.ndjson` (ids reuse `rp3`); earlier p3 event logs kept in `runs-p3-first/`.

| Task | N = 1 | N = 4 |
|---|---|---|
| T1 type | **pass**, 52 s, 7 calls (p3: file unchanged) | fail 0/4: batches planned on screens other agents had changed |
| T2 rename | **pass**, 66 s, 12 calls (p3: 159 s, 46 calls) | 3/4 (p3: 0/4): Finder re-sorted after a rename; a stale batch renamed the wrong file |
| T3 move | **pass**, 66 s | 1/4: list shifted after the first move; stale drags took wrong files |

Every N = 4 failure has one cause: an agent acts on positions from an observation that another agent has since
invalidated. `others_acted_since_observation` only reported it afterwards. Added after p3b:
`require_unchanged: true` on act refuses before any input when another actor acted since this actor's
observation, and returns a fresh screenshot and token (`refused: "stale-observation"`). Protocol test covers
refuse-then-retry. Pilot p5 re-runs the three N = 4 cells with it (`/tmp/opencua-vmbench/bin/p5.sh`).

Guest check of `require_unchanged` (model-free, two actors): the stale act was refused before input
(`dispatched: false`, `refused: "stale-observation"`, `others_acted_since_observation: 1`) with a fresh token and
screenshot; the retry ran (`dispatched: true`, `flushed: true`) and the file held only the retried sentence. Pilot
p5 (the three N = 4 cells with it) was not run: it needs the user's terminal login.
