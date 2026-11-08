# Window lease contract (2026-11-08)

Scope: advisory design for per-window and per-region input leases on the macOS host. No source
changes were made for this document. Every `file:line` below was read on commit c13b0f4 (origin/main);
paths are relative to the repo root and `packages/core/src/platform/` is shortened to `platform/`,
`packages/mcp/src/` to `mcp/`. Claims not checked in code are marked UNVERIFIED. The competitive
inputs (Cua Driver's per-pid serialization and bounded manifest, agent-desktop's machine-wide
`interaction.lock`, one session at a time in Claude, no lease concept in Codex) come from
`docs/comparison-2026-11-06.md:26-28` and the task brief, not from testing those products here.

## 1. Current enforcement points

The host backend is observation-only. Input reaches a host process only when opencua launched it
(an "owned surface"); the person's own apps are refused at every layer below.

| Layer | Where | What it does today |
| --- | --- | --- |
| Policy primitive | `packages/core/src/computer/host-interaction-policy.ts:10-22` | `HostInteractionDenied` (`code = "HOST_INTERACTION_FORBIDDEN"`, line 11) and `denyHostInteraction(operation): never` (line 20). Pure throw; no state, no log. |
| Ownership registry | `platform/owned-surfaces.ts:14-19`, `43`, `108-132` | `OwnedSurface` is pid plus process start time (`startedAt`, line 16). `isOwnedSurfacePid` (124) re-reads `owned-surfaces.json` by mtime (108-120) and re-verifies the start time every `RECHECK_MS = 2_000` (43). Registered only by `registerOwnedSurface`/`openOwnedSurface` (135, 168). |
| FFI gate | `platform/macos-ffi/skylight.ts:34-37` | `SLEventPostToPid` refuses any pid that is not an owned surface (`denyHostInteraction("host-window")`, line 35). Both exported posters route through it (137-147). `SLPSPostEventRecordTo` (57), `CGEventPostToPSN` (75), `postMouseEventRecordToWindow` (134), `activateWindowWithoutRaise` (160), `setProcessAppActive` (167), `beginFocusWithoutRaise` (171), `restoreFrontProcessNoWindows` (199) are unconditional denies. |
| FFI gate | `platform/macos-ffi/coregraphics-bindings.ts:179-189` | `postToHidEventTap` denies `global-input`; `warpCursorPosition` denies `physical-pointer`. The physical pointer and the system event stream are never touched. |
| Surface transport | `platform/macos-ffi/coregraphics.ts:269-285`, `290-296` | `sendToOwnedSurface` (socket, line 274) and `stampSurfaceCursor` (cursor tag, line 291) apply only to owned pids. |
| Computer | `platform/macos.ts:152-154` | `capabilities` are frozen with `supportsScreenshot: false`, `supportsInput: false`. |
| Computer | `platform/macos.ts:179` | Constructor: `delivery === "attended"` denies `global-input` before any call. |
| Computer | `platform/macos.ts:915-918`, `1246-1249` | `assertInputAvailable` and `preflightInput` pass only for `supportsInput` or an owned pid; otherwise `host-window` denial / `isolated-session-required`. |
| Computer | `platform/macos.ts:214`, `1168-1170` | Screenshot and OCR of host windows refused unless the window belongs to an owned pid (`isOwnedWindow`, 920-924). |
| Computer | `platform/macos.ts:905-911` | `AppApprovalStore.decide` (`packages/core/src/permission/app-approval.ts:17-29`): unset `OPENCUA_ALLOWED_BUNDLE_IDS` means unrestricted; this gates observation targets, not input. |
| Computer | `platform/macos.ts:160`, `546-558` | Machine-wide file lock `InputLock` (`platform/input-lock.ts:74`, `input-lock.json`) around each input burst; skipped for an owned surface's own lane (557-558). Foreign holder past the budget: `input-lock-busy` (133). |
| Input controller | `platform/macos-input.ts:456` | `activateBehind` never activates an owned surface; for any other pid it would call `setProcessAppActive`, which is a denial (skylight.ts:167). |
| Input controller | `platform/macos-input.ts:771`, `797`, `1032` | Background or owned-surface posts; otherwise the focus-leased gesture path, whose SkyLight calls are denials. |
| Input controller | `platform/macos-input.ts:633-642` | `serialize`: one gesture chain per pid, or per `pid:cursor` on an owned surface. |
| Region (core) | `packages/core/src/computer/input-region.ts:9-25`, `54`, `65-84` | `AsyncLocalStorage<Rect>` set by `withInputRegion` (22); `assertPointInInputRegion` (54), `assertFocusInInputRegion` (65), `assertElementInInputRegion` (73) throw `InputOutsideRegion` (`INPUT_OUTSIDE_WORKER_REGION`, 12-13). Half-open rects. |
| Region (callers) | `platform/macos-input.ts:546`, `818`, `836`, `859`, `965`, `1011`, `1140`, `1153`; `platform/macos.ts:1038-1064`, `1141`, `1217` | Checked right before each post: pointer events, scroll, drag waypoints, every keystroke (focus re-read per character, 835-836), accessibility writes. |
| Cursor scope | `packages/core/src/computer/cursor-scope.ts:33-65` | `withCursorIdentity` / `currentCursorIdentity` / `currentCursorOwner`: attribution (agent, session, parent, purpose), validated names; not an authorization. |
| Session tokens | `mcp/guarded-session.ts:413-426`, `437-443`, `2503-2517`, `2648-2658`, `1875-1883` | One live token per lane (`LaneKey` = pid, or `pid:cursor` on a surface, 2579-2581); `issue` replaces the previous token (2510-2513), `consume` is single-use (2653), `revokeToken` on release. |
| Session mutation funnel | `mcp/guarded-session.ts:2129-2160` | `beginMutation`: stop switch (2139), consume token (2145, refusal `stale-observation-token`), pid must match the token's observation (2149-2152), element validation, then `preflightInput` (2158). Callers: 814-820, 874-877, 984-988, 1301-1308. |
| Session queues | `mcp/guarded-session.ts:2666-2690` | `enqueue`: one promise tail per lane, one global tail. |
| Stop switch | `platform/stop-switch.ts:19-23`, `38-43` | Machine-wide `stop.json` under `OPENCUA_STATE_DIR`; only a human `resume` lifts it; unreadable file counts as stopped. |
| Coordinator | `mcp/worker-coordinator.ts:271`, `276-340` | `sharedApp` defaults to `isOwnedSurfacePid`. `assign`: a region is allowed only on a shared surface (309); overlapping regions in one window are refused, not queued (312-316, `regionsOverlap` 187); a non-shared pid belongs to one worker (338). |
| Coordinator | `mcp/worker-coordinator.ts:558-690`, `705-765` | `run`: token must be the worker's (575), control must be `running`, every known target pre-checked in screenshot pixels (610-611), then `withInputRegion(screenRegion, ...)` (623) inside `withCursorIdentity` (594). Attended delivery is serialized on `attendedTail` (628-634). `confinedDriver` re-checks targets resolved mid-run. |
| Coordinator | `mcp/worker-coordinator.ts:520-556`, `846-868` | `forget` revokes the token (523); `pause`/`stop`/`resume` (531-556) are the human Take Over; `observeState` refuses when the app pid or bundle id changed (851, 867). |
| Cross-process registry | `mcp/worker-registry.ts:5-30`, `86-88`; `mcp/mcp-server.ts:175-178` | `registry.json` + `registry.lock` under `<stateDir>/workers`: one app per live owner process unless `shared`. |
| MCP surface | `mcp/worker-tools.ts:77-96`, `99-190`; `mcp/native-policy.ts:37-49` | `refusingControl` turns `WorkerControlRefusal`/`WorkerRegionRefusal` into `isError` results. `createNativeComputer` reads `OPENCUA_ALLOWED_BUNDLE_IDS` and `OPENCUA_DELIVERY`; Linux/Windows go through `GuardedPlatformComputer` with `inputAllowed` defaulting to false (`platform/guarded-platform-computer.ts:66`, `70-72`, `87`). |
| Person-conflict probes | `platform/macos-physical-intent.ts:25-33`, `46`; `platform/macos-focus-watch.ts:38`, `115` | HID probe: seconds since a physical mouse-down, Command held. `watchForFocusSteal` sends the person's app back and stops for good once the person switched deliberately. Used by the (now denied) focus-lease path; still available. |

What does not exist: any persisted record of a grant, wait or refusal. `grep -rn audit packages`
finds only `kCGSSessionAuditIDKey` and a Windows `--audit` flag. Refusals are tool errors only.
Verified by grep: `coregraphics-bindings.ts` binds no `CGEventPost*` function, and every post call
site in `coregraphics.ts` (167-212) reaches the denied `postToHidEventTap` (167, 188, 212), the
gated SkyLight posters (179, 199) or the denied PSN/record posters (174, 200); `coregraphics.ts`
binds nothing through koffi itself. UNVERIFIED: `createNSEventBackedMouseEvent` in
`macos-ffi/appkit.ts` (imported at coregraphics.ts:9) was not read; by name it builds an event
rather than posting one.

## 2. Lease model

### 2.1 Two designs, one pick

A. Lease as a config-only gate on the existing primitives (recommended). A lease file owned by the
person is read by core; each `isOwnedSurfacePid` check that decides input gains one more disjunct,
`leasedHere(pid)`, that is true only inside an `AsyncLocalStorage` lease context the session set
for this flow. Regions, tokens, lanes and refusal plumbing are reused unchanged. Cost: ~10 edit
sites, one new core module, one scheduler. Failure mode is local: a missing disjunct means a
refusal, never a grant.

B. Lease as a virtual owned surface: write leased windows into `owned-surfaces.json` with a
`kind: "leased"`. One predicate changes, nothing else. Rejected: `isOwnedSurfacePid` is pid-granular
and also unlocks window capture, OCR, audio state, the surface socket and the no-`InputLock` lane
(macos.ts:214, 1168, 786, 557-558); a lease would silently inherit surface privileges, and
"opencua launched it" would stop meaning that.

C. One machine-wide lock for all leased input (Cua Driver / agent-desktop style). Simplest wait
rule, no concurrency. Kept only as the phase-1 cross-process fallback (section 2.5).

### 2.2 Data shape

```ts
// packages/core/src/computer/window-lease.ts (new)
interface WindowLease {
	readonly id: string;                 // CLI-generated, e.g. "L-7f3a"
	readonly holder: string;             // must equal the server process's OPENCUA_LEASE_HOLDER
	readonly target: {
		readonly bundleId: string;
		readonly pid: number;
		readonly startedAt: string;        // `ps -o lstart=`, exactly like OwnedSurface.startedAt
		readonly windowId: number;         // CGWindowID, required
		readonly region?: Rect;            // window-local points, top-left origin; absent = whole window
	};
	readonly tools: readonly ("click" | "drag" | "scroll" | "key" | "type" | "set_value" | "capture")[];
	readonly grantedAt: string;          // ISO 8601
	readonly expiresAt: string;          // hard; expiresAt - grantedAt <= 8 h
	readonly grantedBy: "cli" | "menu";  // same idea as StopSource (stop-switch.ts:7)
	readonly note?: string;
}
```

File: `<stateDir>/leases.json` (`resolveStateDir`, stop-switch.ts:23), `{ "version": 1, "leases": [...] }`,
mode 0600 in the 0700 state dir, written by temp-file + rename exactly like `writeOwnedSurfaces`
(owned-surfaces.ts:97-102). Read with the same mtime cache as `currentRegistry` (108-120). A file
that fails to parse yields zero leases: fail closed.

### 2.3 Who grants

Only the person, through `opencua lease grant --holder <name> --app <bundle id> --window <title|id>
[--region x,y,w,h] --tools click,type [--for 30m]`, `opencua lease revoke <id|--all>`, `opencua lease
list`, `opencua lease log`. The CLI resolves pid, start time and window id at grant time. No MCP tool
reads arguments into this file; `@opencua/mcp` never writes it. The grant requires a human-presence
proof (Touch ID or account password through a LocalAuthentication helper, see decision 1), so a
shell-capable agent running the CLI gets the prompt, not the lease.

The grantee is `holder`, matched against `OPENCUA_LEASE_HOLDER` in the environment of the MCP server
process. The person sets it in the client's MCP config, which an agent cannot change from a tool
call. `session_id` and `worker_id` are chosen by the agent (`manage_workers`, worker-tools.ts:105-166)
and therefore stay attribution, never authorization. No `OPENCUA_LEASE_HOLDER` means no lease ever
matches: today's observation-only behaviour, unchanged.

### 2.4 Composition with regions and observation tokens

- A leased mutation needs both a live token (the agent observed this window state; single-use,
  guarded-session.ts:2648-2658) and a live lease (the person allowed this window). The token proves
  freshness, the lease proves permission; neither substitutes for the other.
- Lane key for a leased pid becomes `${pid}:L:${leaseId}` (guarded-session.ts:2579-2581 and
  macos-input.ts:637 mirror this for surfaces). Two disjoint leases on one window hold tokens and
  gesture chains concurrently; workers under one lease share one lane.
- The lease region is the outer bound. A worker `region` (screenshot pixels, worker-coordinator.ts:276)
  is mapped by `regionOnScreen` (172-184) and must lie inside the lease region, else assignment is
  refused (`lease-region-exceeded`). `withInputRegion` takes global screen points (input-region.ts:5,
  21), while the lease region is window-local, so each step translates it by the window's live origin
  (`leaseRectOnScreen`; item 4 refuses a moved window) before intersecting and applying it. Direct
  tools (`click`, `run_steps`, `set_value`, ...) run inside `withInputRegion(leaseRectOnScreen)` too,
  so the lease confines them without a worker.
- `tools` is checked per step kind in the session before any input (section 3, item 8).

### 2.5 Overlap rule

Disjoint regions run concurrently; overlapping ones wait. New `WindowScheduler` in core:
`acquire(windowId, rect | "whole") -> Promise<release>`. A request is admitted when it overlaps
(positive-area intersection, as `regionsOverlap`, worker-coordinator.ts:187) no active and no
earlier-queued request; otherwise it waits FIFO with a bounded timeout (default 30 s, then refusal
`lease-wait-timeout`). Both the wait and the admission are audited. Assignment-time overlap inside
one coordinator stays a refusal (312-316): that is a planning error, not contention. In phase 1 this
rule holds only within one server process. Across processes, each leased burst runs under the existing
machine-wide `InputLock` (input-lock.ts:74), but `InputLock.run` throws `input-lock-busy` after its
wait budget instead of queueing FIFO (input-lock.ts:129-133), and it reserves nothing between bursts,
so another process can interleave an overlapping request. Phase 1 therefore surfaces cross-process
contention as the refusal `input-lock-busy` (audited as `refuse`), never as `lease-wait-timeout`. A
shared cross-process region reservation is decision 5.

### 2.6 Expiry and revocation

A lease is live when all hold: now < `expiresAt`; `processStartTime(pid) === startedAt`
(owned-surfaces.ts:63, rechecked every 2 s like 124-132); `windowId` is still owned by `pid`
(`processSerialNumberForWindow`, skylight.ts:230, or `listTopLevelWindows`,
`platform/macos-top-level-windows.ts:4-6`); the lease is still in the file. Liveness is checked at
every enforcement point, not once per run, so a long run is cut between steps the way `checkpoint`
cuts typing (macos-input.ts:362, 833). Revocation paths: `opencua lease revoke`; `opencua stop`
(already refused in `beginMutation`, guarded-session.ts:2139); worker `pause`/`stop`
(worker-coordinator.ts:531-547); window closed or pid replaced (auto-void, audited as `expire`).
No auto-rebind to a new window with the same title.

### 2.7 Audit log

`<stateDir>/audit/lease-YYYY-MM-DD.jsonl`, append-only, 0600, one `appendFileSync` per line, lines
kept under 4 KiB. POSIX guarantees atomic writes only for pipes (`PIPE_BUF`), not regular files, so
non-interleaving is an expectation: phase 1 tests it with two concurrent writer processes, and the
writer takes a per-file lock if that test ever interleaves. One JSON object per line:

| Field | Meaning |
| --- | --- |
| `at` | ISO 8601 with milliseconds |
| `event` | `grant`, `revoke`, `expire`, `acquire`, `wait`, `admit`, `refuse`, `release` |
| `leaseId`, `holder` | the contract |
| `session`, `worker`, `cursor` | agent-chosen attribution from `CursorOwner` (cursor-scope.ts:3-9), when present |
| `pid`, `bundleId`, `windowId`, `region` | the target as checked at that moment |
| `tool`, `step` | step kind and index |
| `code`, `reason` | on `refuse`/`expire`: `lease-required`, `lease-expired`, `lease-tool-forbidden`, `lease-region-exceeded`, `lease-focus-elsewhere`, `lease-window-gone`, `lease-wait-timeout`, `input-lock-busy`; on `wait`: `person-active` when the person's own input holds the lease back |
| `waitedMs`, `blockedBy` | on `admit`: how long and which lease id held the overlap |
| `by` | `cli`, `menu`, `server` |

Grants and revocations are written by the CLI; everything else by the enforcing server process at
the enforcement point. `opencua lease log --tail` reads it. Retention is decision 8.

## 3. Minimal enforcement changes

Everything outside a `withLease` context behaves exactly as today, so the default stays
observation-only.

| # | Function | Where | Change |
| --- | --- | --- | --- |
| 1 | new module | `packages/core/src/computer/window-lease.ts` | `WindowLease`, `readLeases(stateDir)` with mtime cache, `isLive(lease, now, startTime, windowOwner)`, `withLease`/`currentLease` on `AsyncLocalStorage` (pattern: input-region.ts:9-25), `leasedHere(pid)`, `LeaseRefusal` with the codes above, `appendLeaseAudit`. Pure; every probe injectable. |
| 2 | `SLEventPostToPid` | skylight.ts:34-37 | `if (!isOwnedSurfacePid(pid) && !leasedHere(pid)) denyHostInteraction("host-window")`. A post outside a leased flow stays refused even for a leased pid. |
| 3 | `assertInputAvailable` | macos.ts:915-918 | add `|| leasedHere(targetPid)`. |
| 4 | `preflightInput` | macos.ts:1246-1249 | add `|| leasedHere(expected.pid)`; for leased windows force `requireSameBounds` so a moved window invalidates the region mapping. |
| 5 | `captureScreenshot`, `recognizeWindowText` | macos.ts:214, 1168 | allow only when the lease lists `capture` and `windowId === lease.target.windowId`; never the full screen. For a region-scoped lease, crop the image and the OCR output to `leaseRectOnScreen`, and refuse capture until cropping exists; only a whole-window lease sees the whole window. |
| 6 | `activateBehind` | macos-input.ts:456 | add `|| leasedHere(pid)` to the early return: no `setProcessAppActive` for a leased window (it is a denial at skylight.ts:167 and would otherwise throw mid-click). |
| 7 | `postText`, `postKey` | macos-input.ts:814-850, 857-862 | before each keystroke, `focusedWindowIdForPid(pid) === lease.target.windowId` (`macos-ffi/accessibility.ts:313`), else `lease-focus-elsewhere`; keep `assertFocusInInputRegion` (818, 836, 859). |
| 8 | `beginMutation` | guarded-session.ts:2129-2160 | after 2152: `lease = resolveLease(holder, pid, observation.windowId)`, matching `target.windowId` too, so a lease on one window never authorizes another window of the same process (pointer, keyboard and accessibility steps alike); non-owned pid without a live lease -> `InputRefusal("lease-required")`; step kinds not in `tools` -> `lease-tool-forbidden`; return the lease. The four callers (814-820, 874-877, 984-988, 1301-1308) wrap the action in `scheduler.acquire` + `withLease` + `withInputRegion`. |
| 9 | `laneKey` | guarded-session.ts:2579-2581 | `${pid}:L:${leaseId}` for a leased pid. |
| 9b | `MacOSInputController.serialize` | macos-input.ts:633-641 | the same `${pid}:L:${leaseId}` gesture lane for a leased pid; without it disjoint leases on one app still serialize per pid. |
| 10 | `WorkerCoordinator` ctor, `assign`, `run`, `status` | worker-coordinator.ts:266-274, 276-340, 558-690, 471-494 | `sharedApp = (pid) => isOwnedSurfacePid(pid) \|\| hasLiveLease(holder, pid)`; require worker region inside the lease region; keep the surface-only message (309) for unleased pids; report `lease_id`, `lease_expires_at` in status. |
| 11 | `refusingControl`, tool descriptions | worker-tools.ts:77-96, 105, 168 | map `LeaseRefusal` to `isError` with `reason` and a hint that only the person grants leases (`opencua lease grant`). |
| 12 | `createNativeComputer` | native-policy.ts:37-49 | read `OPENCUA_LEASE_HOLDER` (trimmed, no control characters, <= 128 chars as cursor-scope.ts:37-48 does for names); pass to `MacOSHostComputer` and `GuardedSession`. Absent: nothing changes. |
| 13 | CLI | `packages/cli/src/lease-command.ts` (new) + one registration in `cli.ts` | grant/revoke/list/log; same shape as `skills-command.ts`, imported and registered at `packages/cli/src/cli.ts:25` and `584` (`registerSkillsCommands`). |

Out of scope and unchanged: Tart/UTM guests, the browser bridge and iPhone Mirroring have their own
entry points (`mcp/isolated-server.ts`, `OPENCUA_UTM` at mcp-server.ts:122); Linux and Windows keep
`inputAllowed: false` until a later phase adds the same disjunct at guarded-platform-computer.ts:70-72.

## 4. Threat cases

| Threat | Control |
| --- | --- |
| Prompt injection asks the agent to obtain a lease | No tool grants or edits a lease; the file is 0600 under the 0700 state dir and the server has no write path. The CLI needs a human-presence proof, so an agent with a shell gets a Touch ID / password prompt. The holder lives in the server's environment, not in any tool argument. Each `lease-required` refusal is audited, so a request flood is visible. The agent's legitimate move is `ask_user` (`mcp/tool-names.ts:41`). |
| Stale lease: window closed | `windowId` ownership is rechecked at every enforcement point (2.6); failure voids the lease (`lease-window-gone`, audited `expire`). The session already drops a bound window whose id disappears (`forgetClosedBoundWindow`, guarded-session.ts:2520). |
| Stale lease: pid reused or app relaunched | `startedAt` comparison, the same defence `OwnedSurface` uses (owned-surfaces.ts:14-19, 124-132). The coordinator additionally refuses on pid or bundle change (worker-coordinator.ts:851, 867). A relaunched app needs a new grant. |
| Keystrokes leak to a non-leased window | Keys are posted to the pid, never the HID tap (coregraphics-bindings.ts:179), so they cannot reach another app. Within the app, item 7 refuses when the focused window is not the leased one, and `assertFocusInInputRegion` (macos-input.ts:818, 836, 859) refuses a focused element outside the region, re-read per character. |
| Focus moves to the leased window and steals the person's typing | No activation under a lease (item 6); `setProcessAppActive`, `beginFocusWithoutRaise` and friends stay denials (skylight.ts:160-199). If the app raises itself in reaction to input, `watchForFocusSteal` (macos-focus-watch.ts:38) can send the person's app back and stops once the person switched on purpose. |
| Pointer conflict with the person | The physical pointer is never moved (`warpCursorPosition` denied, bindings:187). Background events are window-addressed. Remaining conflict is semantic (both press controls in the same window): before each burst, if `hidPhysicalInputProbe.secondsSinceMouseDown()` (macos-physical-intent.ts:25-33) is under 2 s the burst waits (audited `wait`, reason `person-active`), bounded by the wait timeout. |
| Keyboard conflict when the leased window is frontmost | Keystroke steps additionally wait while the person has pressed keys in the last 2 s. `readSecondsSinceHidEvent` (`macos-ffi/event-flags.ts:31`) takes any event type; no key-down constant exists in `macos-ffi` (grep), so phase 4 adds `K_CG_EVENT_KEY_DOWN = 10`. Decision 10 covers refusing frontmost leases outright. |
| Agent-chosen identifiers | `session_id`/`worker_id`/`agent_name` are labels (cursor-scope.ts:35-57 only validates characters). They never select a lease; `holder` does. |
| Expired lease mid-run | Liveness is checked per posted event, not per run; a run crossing `expiresAt` stops between steps with `lease-expired` and nothing further is posted, the same shape as `WorkerRegionRefusal.actionDispatched` (worker-coordinator.ts:139-158). |
| Lease file tampering by another local process | Same trust boundary as `stop.json` and `owned-surfaces.json`: a process running as the user can already do anything. Out of scope; noted so nobody reads the lease as a sandbox. |

## 5. Phased plan and tests

Tests use the existing fake seams only: `vi.mock("./macos-ffi/coregraphics.js")` and
`setFocusedFrameSourceForTesting` as in `platform/macos-input-region.test.ts:1-60`, injected
`startTime` as in `owned-surfaces.test.ts`, `FakeGuardedComputer` and `Deferred` from
`mcp/protocol-test-harness.ts:102-122`, temp state dirs as in `input-lock.test.ts:8-12`. No test
posts to the host desktop; the asserted evidence is which mock was called with which pid.

| Phase | Deliverable | Tests (`#given #when #then`, `bun test --isolate`) |
| --- | --- | --- |
| 0 | `window-lease.ts`: parse, liveness, context, audit writer | round-trip; malformed file -> zero leases; `startedAt` mismatch, `expiresAt` passed, foreign window owner -> not live with the right code; `withLease` visible only inside its callback and across `await`; audit line shape, one line per event, < 4 KiB, 0600 file. |
| 1 | Core gates (items 2-7) | non-owned pid without lease: click/type/scroll -> `HOST_INTERACTION_FORBIDDEN`, `postMouseEvent` never called; same pid inside `withLease` -> posted once with `targetPid`; point outside lease region -> `INPUT_OUTSIDE_WORKER_REGION`, nothing posted; focused window id differs -> `lease-focus-elsewhere` before the first character; lease expires between two characters -> second never posted; `activateBehind` not entered for a leased pid; `capture` absent -> screenshot still refused. |
| 2 | Session + coordinator (items 8-11), `WindowScheduler` | `beginMutation` refuses `lease-required` before `preflightInput` on a fake computer; `tools` without `type` refuses a `type` step and still consumes nothing posted; token single-use unchanged; two disjoint leases: both dispatches in flight at once (Deferred ordering, no timers); overlapping: second not dispatched until the first releases, `wait` then `admit` audited with `blockedBy`; wait timeout -> `lease-wait-timeout`; revoking by rewriting the file refuses the next step; `status` carries `lease_id`. |
| 3 | CLI grant/revoke/list/log, human-presence hook | writes atomically with 0600; refuses when the injected authenticator fails; `revoke --all` empties the file and audits each id; `list` hides expired leases and `log --tail` prints the last N lines. The authenticator is an injected function; the real Touch ID path is exercised manually once and recorded under `docs/evidence/`. |
| 4 | Person-conflict yielding, Linux/Windows disjunct | fake `PhysicalInputProbe`: recent mouse-down -> burst waits and audits `person-active`, old mouse-down -> immediate; frontmost + recent keys -> keystroke step waits; `GuardedPlatformComputer` with a lease context passes `assertInput`. |

Gates per phase: `pnpm -r typecheck`, `pnpm typecheck:tests`, `biome check`, `bun test --isolate`
on the touched packages, as in `2026-11-01-opencua.md` Q8.

## 6. Open decisions for the maintainer

Decided 2026-11-08: the maintainer accepted every recommendation below. Phase 0 (`window-lease.ts`:
parse, liveness, context, audit writer) is implemented; no input path consults it yet.

1. Grant authority. Options: CLI with Touch ID / password via a small LocalAuthentication helper
   next to `native/opencua-surface`; menu-bar approval; plain file edit. Recommendation: CLI with the
   presence proof, menu bar later. A plain file edit is one `bash` call away from any shell-capable
   agent.
2. Holder identity. `OPENCUA_LEASE_HOLDER` in the server environment (recommended) versus MCP
   `clientInfo.name` (set by the harness, unsigned, UNVERIFIED how the server exposes it) versus
   agent-chosen `session_id` (reject: it is a tool argument).
3. Activation under a lease. Some apps ignore background clicks until told they are active
   (macos-input.ts:436-458). Recommendation: no activation in v1; measure which leased apps fail and
   decide per evidence whether a lease may ever carry `host-focus`.
4. Overlap semantics. Per-window scheduler with FIFO and timeout (recommended) versus refuse at
   assignment (today) versus one machine-wide lock (Cua Driver / agent-desktop). Keep assignment-time
   overlap inside one coordinator a refusal.
5. Cross-process wait. Reuse `InputLock` around leased bursts in phase 1 (recommended: exists, tested)
   and add a shared scheduler file only if two servers on one window become a real workload.
6. Durations. Default 30 min, hard maximum 8 h, no open-ended lease (recommended).
7. Capture under a lease. Allow window-bound screenshot and OCR when `tools` lists `capture`
   (recommended); full-screen capture stays refused.
8. Audit retention. Daily files kept 14 days, pruned by the CLI on `grant` (recommended).
9. `opencua stop`. Stop already refuses every mutation. Recommendation: `stop` also revokes all
   leases (fail closed; the person re-grants after `resume`).
10. Frontmost leases. Allow with keystroke yielding (recommended, keeps the person in control
    through the probe) versus refuse any lease whose window is frontmost.
