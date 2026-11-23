# Desktop workflow patterns

Use these patterns with the guarded stdio MCP server. They describe current
OpenCUA contracts; they do not authorize a target or replace user confirmation.

## Background and per-app input scopes

Background delivery is the default. Each action is scoped to the observed app
process and window; `observe_apps` issues per-app observation tokens and
`run_parallel` runs one batch per app on independent input lanes, with independent
logical pointer positions and PID-scoped overlay markers. Same-app input is serialized;
the native hardware cursor remains singular. Keep one desktop controller,
never transfer tokens or element IDs between apps, and target each action using
that app's own newest observation.

## Planners and app-owning workers

The host runtime creates subagents and chooses their models. OpenCUA supplies
guarded app execution, not model spawning or a reasoning scheduler. Use one
coordinator and one shared MCP session; if the host cannot share that session,
keep all tool calls in the coordinator and delegate only planning and review.
Do not start independent MCP servers as a substitute.

- **Planners/reviewers:** receive the user's goal, constraints and supplied
  observations or completed-work receipts. Return an approach, draft content,
  competing hypotheses or an evidence-based critique. They need no live token
  and make no desktop calls. Parallel thinking is useful even for a single app.
- **App-owning workers:** receive one `worker_id`, one assigned app, its full
  attributed observation (including indexed image blocks when present), its
  current token, a bounded subtask and explicit completion checks. They refresh
  only through `manage_workers {op: "observe", worker_id: ...}` and mutate only
  through `run_worker`. A worker ID is attribution, not authentication.
- **Coordinator:** resolves planner proposals, assigns non-overlapping app
  processes, routes observations to their owners, combines results and handles
  user decisions. It does not observe or act on an owned app while its worker
  is active. App names, bundle IDs and PID aliases may name the same process;
  separate windows do not create separate owners.

For example, to draft in two already-approved, running apps:

1. Ask host-created planners to prepare the content and review the plan without
   desktop input. Agree on end-state checks before delegation.
2. Call `manage_workers` with `op: "assign"` and assignments such as
   `{worker_id: "notes-draft", task: "Prepare the agreed note draft", app: "com.apple.Notes"}`
   and `{worker_id: "mail-draft", task: "Prepare the agreed email draft without sending", app: "com.apple.mail"}`.
   This observes the apps and returns each worker's own context and token; it
   does not launch agents. Pass each assignment only to its matching host worker.
3. Let each worker submit coherent `run_worker` steps with an `expect` block.
   Read the returned state before using its successor token once. Missing tokens,
   refusals or changed context require a worker-scoped refresh, not replay.
   Use bounded `wait_for` steps at UI transitions instead of fixed sleeps.
4. Have workers return their app/worker identity, completed and skipped steps,
   verification evidence, unresolved blockers and whether user confirmation is
   needed. Do not equate a dispatched input or an idle worker with completion.
5. Join all runs before releasing owners with `manage_workers {op: "release",
   worker_id: ...}`. The coordinator can then observe and verify the combined
   result. A restarted app requires release and reassignment.

Assignment batches publish only after every app has usable context; on failure,
ownership remains reserved until all in-flight assignment reads finish, then the
batch rolls back. Do not retry while that assignment call is pending.
`manage_workers {op: "status"}` reports compact ownership and busy state, not
the full observation or proof of task completion.

For independent known batches without host workers, use `observe_apps` followed
by `run_parallel` instead. Entries must resolve to different app processes,
including aliases. Inspect every `apps[]`/`batches[]` entry: after validation,
the top-level call is an error only when all entries fail, so it may contain
failed work. Each entry's `images` indexes address the image blocks in the
combined response, not image bytes embedded in JSON. Never retry successful
entries when recovering failed ones.

To work two apps side by side in one call (for example a note and a reminder
written at the same time), arrange their windows in columns of one screen and
drive both handles together; windows are moved and resized, never raised:

```js
const notes = apple.app("Notes"), reminders = apple.app("Reminders");
await apple.arrange([notes, reminders], { gap: 8 });
await Promise.all([
	notes.observe().then(() => notes.type("Groceries")),
	reminders.observe().then(() => reminders.type("Buy milk")),
]);
```

Background app lanes can run concurrently; attended worker input is serialized.
Cursor identities distinguish feedback, not independent native mice. The OS
cursor, shared clipboard, menus and human input remain shared constraints.
For workflows that exchange data between apps, finish and release the producer
before handing the dependent step to its next owner.

## Window and coordinate targeting

Aim pointer actions only at the exact observed window and its returned screenshot.
Use element IDs or semantic `target` queries first. When coordinates are necessary,
use the coordinate space documented by that observation; never convert screenshot
pixels to global logical points by guesswork. Current background pointer actions are
window-targeted. `displays` reports each screen's ID, global origin, logical size
and scale. `windowDisplayId` identifies the greatest-overlap screen;
`windowDisplayIds` includes every screen intersected by a spanning window.
Observe the target in place rather than moving it to the main screen.

## Cheapest confirming observation

Choose the smallest read that can answer the concrete question:

1. For a known control, use `find_elements` or a semantic action `target` query.
2. For a known element after a mutation, use its returned value/effect evidence;
   use `include_screenshot: false` to refresh element IDs and geometry.
3. Use `diff_only` to compare with a prior state, or `element_format: "table"` to
   reduce the size of a large tree.
4. Use `verify_state` for an explicit value, label, element-exists/gone, or window
   expectation.
5. Request a window screenshot when pixels are the only evidence, such as artwork
   not exposed through accessibility.

An unchanged accessibility tree is not proof that an action failed. Read the
action's effect, evidence and escalation; do not replay a non-idempotent action.

## Bounded batches and drawing

Use `run_steps` for a coherent sequence of at most 20 known steps. It validates
the batch before dispatch, stops at the first failed step, supports bounded
`wait_for`, and can verify an explicit end condition. Split work before a decision,
external side effect, uncertain transition, or step whose target depends on
unobserved intermediate state. Never use a fixed sleep as a readiness check.

For a canvas, inspect the observed window and tool controls. `drag` holds one
button from its start through up to 100 intermediate `waypoints: [{x,y}]` to its
end. Every point uses the observed screenshot's coordinates. Set integer
`duration_ms` from 0 to 30000 for paced samples; choose `mouse_button` left, right
or middle and held `modifiers` for the app's drawing, orbit or pan tool.
Verify the mark or view change with AX evidence or a window screenshot.
Separate strokes are separate drag steps. Pressure/tilt, multi-touch and cursor
button-state visualization are not provided.

## Finished-work blocks

Decide the document's content, reading order, spacing and completion evidence
before inserting objects. Establish one correctly sized and styled native object,
inspect it, then repeat that verified pattern for its peers. A finished artifact
must have coherent content and no clipped text, overlaps, placeholders or leftover
test objects; successful input dispatch is not the acceptance test.

Use `run_script` to keep a coherent block in one guarded call. A block might insert,
label and position one card, or fill a slide's known placeholders. Keep transient
menu opening and the observed selection in the same block: background activation
can expire between agent calls and dismiss the menu. Prefer direct, observed menu
commands over opening a picker solely to rediscover the same object.

Use fast chains for stable known targets. A picker that reorders recent items is
not stable: use a fresh query action or verified batch at that boundary. After a
partial result, inspect the completed-step receipt and resulting pixels, then
continue only the unfinished work. Never replay the entire block.

Canvas text editing is app-specific. Entering a Keynote placeholder clears its
placeholder text; an extra Select All can be both unnecessary and refused in the
background. Text insertion can also trigger native smart punctuation or lists.
Read the rendered text rather than assuming the submitted string is unchanged.
For a chord, use one key string, such as `keys: "command+shift+g"` (or `["command+shift+g"]`) or
`app.press("command+shift+g")`; separate array entries are separate presses.

An empty AX diff cannot prove that a native canvas object was unchanged. Inspect
the canvas at meaningful boundaries, not after every keystroke. Conversely, an
unrelated application opening a window is never evidence for the target action.

For a save sheet, observe its parent document when that document's AX tree exposes
the sheet and its fields. Do not use a sheet-sized image showing a scaled parent
document for coordinates. Verify the entered filename, the final named window and
the saved artifact; a Save click or title match alone does not verify its content.

Keep a run ledger: actual actions, observations, elapsed call times, refusals,
partial blocks and corrective edits. Include failed attempts in the accounting.
Judge the complete artifact and uninterrupted workflow, not the number of tests
or isolated successful clicks.
