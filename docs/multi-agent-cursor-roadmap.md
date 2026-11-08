# Multi-agent virtual cursor roadmap

Goal: every agent gets eyes (screenshot plus coordinates) and two hands (pointer and keyboard)
in its own virtual cursor and virtual space, so 20, 100 or 500 agents can work at once like a
room full of people, without ever touching the user's mouse, screen focus or Spaces.

## Who touches the result

- The user at the desktop: must never see agent cursors over their own work, can list active
  agents from the menu bar, open an agent's window to watch it, and take over.
- The coordinating agent: assigns one app and one goal per worker.
- Worker agents: observe with an image plus element coordinates, then click, drag, scroll and
  type through their own cursor.

## Ideal state

1. A background cursor is visible only where its target window is visible to the user: it is
   stacked directly above that window, covered by anything in front of it, and hidden when the
   target is hidden, minimized or on another Space. (Done in this change, see below.)
2. Each cursor carries the agent or subagent name, its intent and its current goal, shown next to
   the arrow and in the menu bar list.
3. N workers drive N apps at the same time (Calculator, Notes, Reminders, ...), each with its
   own cursor and lane, with no shared focus or hardware cursor.
4. The menu bar item lists active agents per app/server; selecting one brings that app window
   forward for monitoring; a Take Over control pauses the agent so the user can act, and lets the
   user point to the correct target ("click here, not there") before handing control back.
5. Every observation returned to an agent includes the image itself plus labeled element frames
   in screenshot coordinates, so the agent can aim from vision without guessing.
6. Fine motor work: continuous drag paths (drawing) and fast acquire-and-click (aim trainer)
   through a virtual cursor and vision only, with no browser CDP shortcuts.
7. Scale: 20, 100 and 500 concurrent cursors stay responsive on one overlay process.

## Gaps against the ideal state

| # | Gap | Why it matters |
|---|-----|----------------|
| 1 | Fixed: per-app markers used `NSFloatingWindowLevel` and `orderFrontRegardless`, floating over every app | The cursor covered the user's screen during background runs |
| 2 | Cursors are keyed by pid, and the label is the socket identity (`OPENCUA_CURSOR_ID`), not an agent name, intent or goal | The user cannot tell which agent is doing what |
| 3 | One marker per pid: two agents on the same app share one marker | Breaks "one cursor per agent" |
| 4 | The overlay status item shows one cursor mode, with no agent list, window focus action or Take Over | Item 4 of the ideal state does not exist yet |
| 5 | Observation image plus coordinates exists in MCP `get_app_state`, but the CLI output path still needs an audit for image-first reporting | Item 5 may be met only on some surfaces |
| 6 | Each marker is a separate NSWindow with its own timer | Unmeasured at 100 to 500 cursors; likely needs one shared layer per target window |

## Plan (in dependency order)

1. Key markers by (agent identity, pid) instead of pid alone, and carry `name`, `intent` and `goal`
   in a new `label` overlay command. This unblocks gaps 2 and 3.
2. Menu bar agent list built from the live marker table: select to raise the target window, plus
   a Take Over action that pauses that worker's lane through the coordinator and records a
   user-designated target point.
3. Audit the CLI and MCP observation outputs so each returns the image plus element frames.
4. Measure overlay frame time and CPU at 20, 100 and 500 markers in an owned virtual desktop;
   consolidate into per-target layers only if the measurement shows a hotspot.
5. Drawing and aim-trainer acceptance runs in an owned guest or virtual desktop.

## QA scenarios

| Scenario | Pass condition |
|----------|----------------|
| Background run while the user works in another app | No agent cursor pixel appears over the user's front window (screenshot diff) |
| User clicks the target app's window | The cursor appears above that window within 250 ms |
| Target minimized, hidden or on another Space | The marker is ordered out |
| 4 workers on Calculator, Notes, Reminders and a fourth app | 4 labeled cursors, each goal verified by app state |
| Menu bar list | Shows every active agent; selecting one raises the right window |
| Take Over | The agent lane pauses; the user's chosen point is used on resume |
| Drawing | Continuous stroke matches the requested path in a canvas screenshot |
| Aim trainer | Target hit rate and latency recorded from vision only |
| 100 and 500 cursors | Overlay stays under its frame budget; numbers recorded, not assumed |

All live scenarios run only in an owned virtual desktop or guest, never by posting input to the
user's desktop.

## Status of item 1

`packages/core/native/cursor-overlay.m` now stacks each per-app marker and per-app highlight
directly above the target's frontmost normal (layer 0) on-screen window at normal window level.
It re-stacks on app activation and every 250 ms, and orders the marker out when the target has
no on-screen window. The selection logic is covered by
`packages/core/src/platform/macos-ffi/cursor-overlay-stacking.test.ts`. The committed
`cursor-overlay` binary must be rebuilt with `packages/core/native/build.sh` before the change
takes effect.
