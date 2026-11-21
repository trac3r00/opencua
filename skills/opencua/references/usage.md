# Usage reference

Use guarded MCP for autonomous desktop tasks. CLI and programmatic calls are low-level
interfaces; they do not enforce the MCP context-token workflow. Never use them to bypass a
paused or denied MCP action. The Pi extension is position-bound but not token-bound: it refuses
element and coordinate input unless a `get_app_state` in the same session is still the current
observation, so an index can never outlive the tree it was read from.

## Guarded MCP workflow

Build core and MCP, then let the harness own the stdio process:

```bash
pnpm --filter @opencua/core --filter @opencua/mcp build
node packages/mcp/dist/server.js
```

Explicitly name the target app; no whitelist is required by default. The optional app restriction
is host-controlled: unset permits named apps, while explicitly empty denies inspection/input; see
[harness configuration](harnesses.md). Do not send debugging text to stdout when launching
an MCP server: stdout carries its protocol.

Read-only tools:

- `list_apps`: inventory of running apps; no authorization implied.
- `list_displays`: every display (id, main, bounds, scale, shown Space, whether it holds the
  cursor) and the frontmost app; posts no input.
- `get_app_state`: screenshot, AX elements and current context for the named app.
  Optional `diff_only` returns only what changed since the previous observation of that app
  (the `axChanges` list) instead of the whole tree; the first observation of an app is
  always the full tree, because element `id`s come from it. `include_screenshot: false`
  skips the image and keeps element geometry, which is the cheapest re-index before an
  element action. `max_elements` caps a very large tree; when the walk stops at the budget
  the answer sets `elementsTruncated` and a `note`, and a walk at a different budget is
  treated as a fresh baseline rather than diffed against a differently truncated tree.
  `subtree_of: <element id>` observes only that element's branch, with element ids restarting
  at 0 and the branch root as id 0, which is the cheap way into a capped or very large tree.
  `include_menu_bar: true` adds application menus when the task needs them. The answer names
  the window it scoped to (`windowId`, `windowTitle`) and lists `windowCandidates` when the
  app has several windows; `window_id` observes one specific candidate instead of the app's
  focused window.
- `find_elements`: resolves a description of a control — `role`, `label`, `label_contains`,
  `value_contains`, `text`, all of which must hold — against the app's live accessibility tree
  and answers the ranked matches with their `element_index`, geometry and `matched_by`
  evidence, plus the one-use `observation_token` for those ids. A miss answers `found: false`
  with `nearMisses` (candidates sharing words with the query, or, when a role was given, that
  role's own controls in reading order) instead of failing blind. `max_results` bounds the
  list, `max_elements` widens the walk, `window_id` picks a window, and no screenshot is
  captured unless `include_screenshot: true` — the cheap way to answer "what is this thing I
  am describing?" without spreading the whole tree.
- `verify_state`: re-reads the app freshly (no cached tree, no screenshot) and answers per
  expectation with `verified` plus the `actual` value found: `element_index` alone checks
  the element still exists, `exists: false` checks it is gone, `value`/`label` compare text,
  and `window_title` checks that a window of that app is open. `timeout_ms` polls until
  every check passes or the deadline passes. Requires the latest `observation_token` and
  returns a fresh one.

- `open_app`: brings a running app forward or launches it when it is not running, and waits
  until it is observable before answering `launched`/`activated` with its pid and bundle id.
  It needs no `observation_token` and authorizes no observation and no input — call
  `get_app_state` or `find_elements` next. It is the only way to reach an app this server
  cannot observe yet.

Mutation tools all require `observation_token` from the latest applicable state, except
`click_target`, which observes for itself:

In the full toolset, `manage_workers` assigns, observes, inspects, and releases app ownership, and
`run_worker` executes the same bounded `run_steps` schema under that worker's
server-issued cursor identity. The main agent is responsible for spawning workers
through its host runtime and independently checking their reported results. The
MCP server is not an LLM scheduler. Background workers are invisible; attended
cursor overlays identify isolated worker contexts but are not separate OS mice.
Use screenshot pixels only when semantic frames clearly map to that image; missing
images or inaccessible controls are limitations to report, not permission to guess.
Assignments and observations return images as MCP image blocks, indexed by each
worker's `images` field. Refresh a worker with `manage_workers` using
`op: "observe"` and its `worker_id`; `include_screenshot: false` is the cheaper
semantic refresh. All workers must share the coordinator's MCP session.
`visual_context` names the AX/OCR coordinate spaces and the image-to-screen
mapping; window-scoped AX frames must not be scaled a second time.

- `click`: an observed element ID or screenshot coordinates.
- `click_target`: acts on a described element in one call — observes the app, resolves the
  same query shape as `find_elements`, waits up to `timeout_ms` for the element to appear,
  hovers to it first when `hover_first` is set, dispatches by AXPress when the control
  advertises that action (or `press: "auto"`/`"pointer"`, a non-left `mouse_button`, or a
  `click_count` that needs the pointer), reads the outcome, and verifies the optional
  `expect` block in the same answer. It answers `found: false` with the near misses and no
  input dispatched when nothing matched within the patience given, and it reports the target
  it resolved plus the `alternatives` it did not click.
- `perform_secondary_action`: an action advertised for the observed AX element.
- `set_value`: a supported editable element's value.
- `set_fields`: up to 10 observed element values in one call, each verified by reading the
  value back from the app; the answer reports per-field `verified`/`unverified`/`skipped`
  status plus `requested`/`inputDispatched`/`verified` counts so dispatched input is never
  mistaken for a confirmed outcome. It stops at the first field it cannot verify.
- `run_steps`: up to 20 actions (`MAX_RUN_STEPS`) in order in one call — `click`, `perform_secondary_action`,
  `set_value`, `select_text`, `drag`, `scroll`, `reveal`, `wait_for`, `type_text`, `press_keys`, `invoke_menu`,
  `set_window_frame` or `clipboard_write` steps — for sequences like fill-then-submit that
  would otherwise need one round trip per action. Every step is validated against the token
  observation up front, element steps are re-checked against a fresh observation right before
  they dispatch, and the batch stops at the first step that fails or whose element no longer
  matches, reporting per-step `dispatched`/`skipped`/`failed` status with a reason. Element
  steps may instead name a `target` query (role/label/text, with `target_index`), resolved against a
  fresh read right before the step runs, so a batch can open a sheet and then fill it; a `wait_for`
  step (`target`, `gone`, `window_title`, `timeout_ms` up to 10000) waits for the UI to show or
  stop showing something. Element ids still refer to the token observation; anything else that must
  react to new UI needs a query target or the returned continuation token.
  A `reveal` step (`target` query required, `target_index`, `find`) scrolls the target into view
  with the bounded find (default 10 pages, max 50) and never clicks or edits it, so it is the way to
  navigate to off-screen content without acting; follow it with `get_app_state`/`find_elements`
  and `verify_state`. A `find` block (`scroll_within`, `direction`, `max_pages`, `vision`) on an action
  step is for deliberately acting on the target once it shows. `run_script` offers the same as
  `app.reveal(query, { scrollWithin, maxPages, vision, direction })`, which `read_only` rejects. The optional `expect` block verifies the outcome in the same call with
  the same checks as `verify_state` (`element_index` with `exists`/`value`/`label`,
  `window_title`, `timeout_ms`).
- `run_hands`: one guarded call for a person-like two-handed action. `keyboard` accepts
  `type_text`/`press_keys`; `pointer` accepts `click`/`drag`/`scroll` with an explicit
  `element_index` or `x`/`y`; `vision` optionally captures the window while the lanes run.
  `overlap` defaults to `auto`: disjoint lanes may overlap in background delivery, while
  attended focus-sensitive lanes serialize. `always` is refused when lanes share a resource.
  The answer includes per-lane `wait_ms`, `duration_ms`, `overlap_ms`, the final fresh state,
  and the next observation token. Use it when typing and pointing are genuinely independent;
  use `run_steps` when order and intermediate reads matter.
- `get_tool_usage`: read-only session counts, errors, bytes, p50/p95/max latency, and per-tool
  stats. Every tool result also carries `timing_ms` (`total`, `handler`, `bytes`, plus the
  existing `capture` phase when `OPENCUA_TIMING=1`); no token is needed for the usage report.
- `select_text`: exact text selection or caret placement in an observed text element.
- `drag`: bounded start/end coordinates from the screenshot.
- `scroll`: an observed scrollable element and direction.
- `type_text`: text into the established target's focused input.
- `press_keys`: a deliberate key/chord sequence, with optional timing.

`run_script` also exposes `apple.terminal()`: `await terminal.run(command)` sends a command to
Terminal.app and returns its dispatch marker, while `await terminal.read(windowId?)` reads the
visible text tail. Terminal.app must be running and allowlisted with
`OPENCUA_ALLOWED_BUNDLE_IDS=com.apple.Terminal`; command dispatch requires attended console
delivery and Apple Events authorization. `read_only` forbids terminal commands.

`run_script` also provides `apple.spaces()`: `active()` returns the active Space id and its
type when available; `displays()` returns the managed display/Space inventory. These calls are
read-only. `apple.menubar()` reads Control Center menu extras with `observe()` and presses an
observed id with `press(id)`. Presses require a fresh observation token, Control Center
allowlisting, attended console delivery, and accessibility permission.

Every mutation answers with the fresh post-action observation: what changed, the affected
controls and, when the input context is unchanged, a new one-use `observation_token`, so
consecutive actions need no extra `get_app_state`. That answer omits the full accessibility
tree (`treeOmitted: true`, with a `note` explaining it) and bounds long change lists with
`axChangesOmitted` counts; pass `full_state: true` on any mutation when the complete tree
is genuinely needed. When the answer carries no `observation_token` (`paused: true` or
`observationStatus: "context-changed"`), observe again before the next action.

The same answer closes the loop on the action itself:

```json
{
  "route": "accessibility",
  "delivery": "background",
  "effect": "observed_change",
  "evidence": [{ "kind": "ax_change" }],
  "windowEvents": [{ "id": 4211, "ownerPid": 1234, "ownerName": "TextEdit", "title": "Save" }]
}
```

`route`/`delivery` report how the input actually travelled, `effect` reports how far the
driver can account for the result (`confirmed` from a value read back, `partial` when some
updates verified, `observed_change` when the window changed after the action, `suspected_noop`
when nothing changed, `unverifiable` when input went out with no evidence either way, and
`refused` when nothing was dispatched), and `evidence` lists what that judgment rests on.
`escalation` appears when the driver knows the
next honest step (`target` `pixel`, `foreground`, `page` or `session`, with a `reason`) instead
of retrying blindly. `windowEvents` names windows that appeared while the action ran, so a
modal sheet or newly opened window is not missed. A `suspected_noop` is not permission to
replay a non-idempotent action: check the specific outcome with `verify_state`, or stop and
explain what is uncertain.

A refused call answers with `actionDispatched: false`, `effect: "refused"`, a machine-readable
`reason` and an `escalation` naming the next step, and it is flagged `isError` so a caller that
only checks that flag never reads a refusal as success:

```json
{
  "actionDispatched": false,
  "effect": "refused",
  "route": "unknown",
  "delivery": "not_applicable",
  "evidence": [],
  "reason": "window-changed",
  "escalation": { "target": "session", "reason": "no_window_target" },
  "paused": true,
  "needsExplicitObservation": true
}
```

Reasons seen in practice: `stale-observation-token` and `element-not-observed` (the token or its
ids are gone — observe again), `window-missing`, `window-changed` and `window-bounds-changed`
(the observed window is no longer the same one — never let the driver redirect input to another
window of that app), `app-not-frontmost` (use `get_app_state`, which fronts or re-observes the
target instead of typing into whatever is focused), `app-not-approved`, `url-blocked` and
`url-unavailable` (policy or the URL check could not be satisfied).

For example, the first MCP request is an observation, not a click:

```json
{
  "name": "get_app_state",
  "arguments": { "app": "com.apple.TextEdit" }
}
```

Read the result, identify the correct control and pass **its returned `id`** plus the returned
`observation_token` to the chosen mutation. Do not use an array offset or copy a sample ID.
On the next step, inspect the returned state before using any continuation token. On an
error, unchanged/unavailable observation, unexpected window transition or missing token,
stop input and observe explicitly again. A fresh read is for resolving uncertainty, not
for automatically repeating a potentially non-idempotent action.

## Phone: iPhone Mirroring

The phone is a second target, driven through the macOS iPhone Mirroring window. Its session is
checked before every action and reported as `ready`, `blocked`, `no-window` or
`not-running`; anything other than `ready` is refused with what the user has to do about it.
A `blocked` session (Unlock iPhone, iPhone in Use, paused, ended, Mac login) is the user's to
clear: never tap Connect, never type a password, never retry in a loop.

MCP tools: `ios_observe`, `ios_find_text`, `ios_screenshot`, `ios_tap`, `ios_tap_text`,
`ios_long_press`, `ios_swipe`, `ios_scroll`, `ios_type_text`, `ios_press_keys`,
`ios_home`, `ios_app_switcher`, `ios_open_app`. Every mutation needs an
`observation_token` from the newest `ios_observe`; the token is single-use and the answer
carries a fresh observation with a new token, so a decided follow-up does not need another read.

`ios_find_text` is the phone's bounded, non-tapping search for off-screen text. It takes the
`observation_token`, `query`, `exact` (default false), `direction` (default `down`), `max_scrolls`
(default 8, max 30; `0` searches the visible screen only), `timeout_ms` (default 10000, max 30000;
it bounds starting further scrolls), and optional `amount`, `borrow_pointer` and `at`. The answer
carries `search.matches` (OCR text with tap-ready `center`), `search.scrolls`, `search.reason`
(`matched`, `max_scrolls`, `no_progress`, `timeout`, `interrupted`), `verification`
(`{ verified, query }`) and a fresh `observation_token`. Scrolling still follows the
`ios_scroll` pointer policy: under background delivery it is refused unless `borrow_pointer: true`
is passed explicitly. Two unchanged screens end the search as `no_progress` (`suspected_noop`), so
do not widen `max_scrolls` to push past it. An `interrupted` search answers `isError` with no
token; if `actionDispatched` is true some scrolling happened (`effect: partial`), so re-observe
with `ios_observe` and decide again rather than blindly retrying. Tap a match only afterwards, with
`ios_tap` or `ios_tap_text` and the new token.

CLI:

```bash
node packages/cli/dist/cli.js ios status
node packages/cli/dist/cli.js --json ios observe
node packages/cli/dist/cli.js ios tap-text "Settings"
node packages/cli/dist/cli.js ios scroll down --amount 0.4
node packages/cli/dist/cli.js ios type "hello"          # exact paste path
node packages/cli/dist/cli.js ios key cmd+1             # Home
```

Directions are stated once and mean it: `scroll` says what you want to SEE (`scroll down`
reveals content further down the list), `swipe` says which way the finger moves. A vertical
touch-drag is dropped by macOS 26, so lists move with `scroll`.

## Human-directed CLI diagnostics

From the checkout, use the built CLI directly (or a configured `opencua` alias):

```bash
node packages/cli/dist/cli.js --help
node packages/cli/dist/cli.js permissions check screen
node packages/cli/dist/cli.js permissions check accessibility
node packages/cli/dist/cli.js --json apps list
node packages/cli/dist/cli.js --json apps state com.apple.TextEdit
```

`apps state` omits image bytes by default; add `--screenshot` when the consumer needs them.
`--max-elements <n>` caps a very large tree (the state then reports `elementsTruncated`),
`--menu-bar` adds application menus, and `--window-id <id>` observes one specific WindowServer
window instead of the app's focused window. When an app has several windows the observation
names the one it scoped to and lists the alternatives, so a caller can pass an explicit
`--window-id` next time. `diff_only` is deliberately not a CLI flag: a one-shot process has no
previous observation to diff against, so the state-honest place for it is the MCP server, which
keeps per-app snapshots.
For a separate screenshot artifact:

```bash
SHOT=$(mktemp -t opencua-shot.XXXXXX)
node packages/cli/dist/cli.js screenshot -o "$SHOT"
```

Inspect the captured image through the harness's image-reading capability before choosing
coordinates; writing an image to disk alone does not mean the model saw it. Remove temporary
artifacts after use. No Pi-specific Read tool is required.

CLI syntax (only use input verbs for an explicitly authorized, observed target):

| Action | Syntax |
|---|---|
| Click | `opencua click <x> <y>`; `-x`/`-y` aliases also supported |
| Drag | `opencua drag <fromX> <fromY> <toX> <toY>` |
| Type | `opencua type "literal text"` |
| Key chord | `opencua key s -m cmd` |
| Scroll | `opencua scroll --direction down --amount 5` |
| Cursor/screen metadata | `opencua cursor`, `opencua screen` |

Use `--target-pid` or `--target-bundle-id` deliberately; do not guess the focused app.
Raw CLI coordinates are global logical screen points, not necessarily screenshot pixels.
Each CLI invocation is a separate process: it does not carry a prior MCP observation token
or the retained native AX snapshot from another invocation. Keep unattended automation on
one guarded MCP connection instead.

## Pi extension and direct library

The optional Pi extension and `@opencua/core` remain available for integrations that supply
their own policy. They are not prerequisites for OpenClaw or Hermes. Installing the extension
does not turn its provider-native computer tool or raw library calls into guarded MCP calls.

For direct programmatic reads, release the computer in `finally`:

```typescript
import { MacOSHostComputer } from "@opencua/core";

const computer = new MacOSHostComputer();
try {
  const apps = await computer.listApps();
  console.log(apps);
} finally {
  await computer.close();
}
```

Do not drive independent CLI processes, multiple MCP connections or parallel agents against
the same desktop. Fixed sleeps are not a substitute for observing the right app and checking
a meaningful result. Irreversible-action confirmation is the harness's responsibility.
