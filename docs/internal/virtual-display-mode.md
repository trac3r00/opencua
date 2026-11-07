# Virtual display mode (design)

Status: design only. Nothing here is implemented. Statements about private macOS APIs are marked
**unverified** unless an experiment in the validation plan has confirmed them.

## Goal

Let agents drive ordinary host apps (Keynote, Excel) on a display that OpenCUA owns, without the Tart guest
described in [docs/isolated-desktop.md](../isolated-desktop.md) (its acceptance VM uses 2 CPUs and 4096 MiB of RAM;
the guest image's disk cost hasn't been measured), and without touching any display the person uses.

## Binding rule

OpenCUA never uses the person's mouse, keyboard, screen, clipboard or Spaces. Virtual display mode must keep this rule.
If a mechanism can't keep it for some resource, that resource stays refused and the mode isn't offered for that case.

## How the host is guarded today

- `packages/core/src/computer/host-interaction-policy.ts` defines `denyHostInteraction`, which always throws
  `HostInteractionDenied` (`HOST_INTERACTION_FORBIDDEN`) for `physical-pointer`, `global-input`, `host-focus`,
  `host-clipboard`, `host-spaces`, `host-window` and `host-overlay`.
- `packages/core/src/platform/macos.ts` sets `supportsScreenshot`, `supportsInput` and `supportsClipboard` to false.
  Capture and input pass only when the target PID or window belongs to an owned surface (`isOwnedWindow`,
  `isOwnedSurfacePid`).
- Call sites refuse host work in `macos-ffi/skylight.ts` (focus helpers and PSN or event-record posting always
  deny; only per-PID event posting through `SLEventPostToPid` is allowed, and only when `isOwnedSurfacePid` holds),
  `macos-ffi/accessibility.ts`, `macos-ffi/cursor-overlay.ts`, `macos-ffi/pasteboard.ts`, `macos-ffi/workspace.ts` and
  `macos-ffi/coregraphics-bindings.ts`.
- `packages/core/src/platform/owned-surfaces.ts` keeps the registry: `registerOwnedSurface`, `isOwnedSurfacePid`
  (keyed by PID plus `processStartTime`, so a reused PID doesn't inherit ownership), `closeOwnedSurface`.
- Region leases: `packages/core/src/computer/input-region.ts` and `manage_workers` `region`
  (`packages/mcp/src/worker-tools.ts`, `worker-registry.ts`) confine each worker's input to a rectangle.

## Mechanism options

### A. CGVirtualDisplay

`CGVirtualDisplay`, `CGVirtualDisplayDescriptor` and `CGVirtualDisplaySettings` are private CoreGraphics classes
(used by tools such as BetterDisplay). **Unverified:** that a signed, non-sandboxed helper can create one without an
entitlement, that it survives only while the creating process lives, and that ScreenCaptureKit lists it as an
`SCDisplay`.

- Pro: no VM, no extra disk, native app speed.
- Con: private API, can break in any macOS release. **Unverified** (experiment 8): the display joins the person's display arrangement, so the
  WindowServer may move windows onto it, and Mission Control and System Settings show it. It must be placed far from
  the real displays and created with `hideFromMirroring`-style settings if they exist (**unverified**).

### B. Headless or dummy display

A hardware HDMI dummy plug, or a display the system creates for screen sharing. Behaves like a real monitor.

- Pro: public behaviour, nothing private to bind.
- Con: needs hardware or a sharing session. It's still part of the person's desktop, with the same arrangement
  problems as A.

### C. Moving an app's windows to the owned display

After A or B, place target windows there (AX `kAXPositionAttribute`, or SkyLight window moves).

- This touches `host-window` on an app the person also uses. Moving Keynote windows the person has open would break
  the rule, so it is allowed only for an app instance that OpenCUA launched and registered (see D).
- New windows (dialogs, inspectors) open on the display the app picks, often the main one. Each new window must be
  detected and moved before it is visible, which isn't guaranteed (**unverified**).

### D. A separate app instance

1. `open -n -a Keynote` in the person's session. A second instance shares the person's preferences, document recovery,
   iCloud state and often refuses to run (many Apple apps are single-instance; **unverified** per app).
2. A separate macOS user in a separate login session (fast user switching, or a background `loginwindow` session).
   The app gets its own preferences, keychain and pasteboard server. **Unverified:** whether a background session gets
   a usable WindowServer display without being the console user, and whether CGVirtualDisplay works there.

### What none of these isolate in the person's session

| Resource | A/B/C in the person's session | D2 separate user |
|---|---|---|
| Clipboard | Shared general pasteboard; refuse copy and paste | Per-session pasteboard (**unverified**) |
| Notifications | App banners appear on the person's screen | Shown to the other session only (**unverified**) |
| Keyboard focus | Activating the app steals focus; input must stay per-PID with no activation | Separate |
| Single-instance state | Shared prefs, autosave, open documents | Separate home folder |
| Spaces | The display gets its own Space; Mission Control shows it | Separate |

Because focus, notifications and the clipboard leak under A, B and C alone, the recommended direction is D2 with A
inside that session. A, B or C alone only fits apps OpenCUA launches and that never need activation.

## Security and TCC

- Creating a virtual display may need Screen Recording or no permission at all (**unverified**). Either way the helper
  `dev.opencua.mcp` already holds Screen Recording and Accessibility, so this mode widens what those grants reach.
- A separate macOS user needs its own TCC grants. Only a person can grant them, in that user's session. `opencua
  doctor` would need to report them without prompting.
- The isolated user must have no access to the person's home folder or keychain, and no admin rights. Its password is
  generated and stored in the person's keychain, never printed.
- Private API use must be gated: off by default, a clear refusal when the API is missing, no fallback to the person's
  displays.

## Fit with the ownership model

- A launched app instance is registered with `registerOwnedSurface` (PID plus start time), so existing checks in
  `macos.ts` and `skylight.ts` admit it with no new bypass. Proposed: a `kind` field (`web` or `app`) on
  `OwnedSurface`.
- The virtual display gets its own record (display ID, owner PID). Capture is allowed only for windows that are both
  owned and on that display.
- Region leases keep their meaning: rectangles in the owned display's coordinate space, handed out by
  `manage_workers`.
- Teardown: closing the surface quits the instance, then destroys the display. A crashed helper must leave no display
  behind (**unverified**: whether the system removes it when the process exits).

## Open questions

1. Can a background (non-console) session host CGVirtualDisplay and ScreenCaptureKit capture?
2. Can per-PID events (`CGEventPostToPid`) reach a window on the owned display without activating the app?
3. Which target apps refuse `open -n`, and do they still autosave into shared state?
4. Do notifications from an owned instance reach the person's Notification Center?
5. How does the display appear in System Settings and Mission Control, and can it stay hidden?

## Validation plan

Run every experiment on a spare Mac or in the Tart guest first, never on the person's desktop.

| # | Experiment | Pass condition |
|---|---|---|
| 1 | Small Swift tool creates a 1920x1080 CGVirtualDisplay, lists `SCShareableContent.displays`, exits | Display appears, then disappears on exit |
| 2 | Same tool under a second user via fast user switching, then in the background | Display and capture work while that user isn't frontmost |
| 3 | Launch TextEdit there, move its window to the display, post per-PID keys | Text arrives; console user's frontmost app unchanged (logged with `NSWorkspace`) |
| 4 | Open Keynote and Excel dialogs (Save, Inspector) | Record which display each new window opens on |
| 5 | Trigger a notification and a copy in the owned instance | Person's session shows no banner; its pasteboard `changeCount` is unchanged |
| 6 | `open -n` for Keynote, Excel, Freeform | Record which start a second instance and what state they share |
| 7 | Kill the helper with SIGKILL | Display is gone; no orphan windows on the person's displays |
| 8 | Create the display, open Mission Control and System Settings > Displays, and record the arrangement | Pass only if no agent window appears on, and no agent input or cursor reaches, any display the person uses, and none of the person's windows moves onto the agent display; any failure refuses this mechanism |

The gate depends on the mechanism and the apps offered. The mode ships only if 1, 3, 5, 7 and 8 pass on the supported
macOS versions, every leak found is refused in code, and:

- for D2 (separate-user session), experiment 2 passes;
- for each app offered, experiments 3, 4, 5 and 6 are repeated with that app and pass, or the app isn't offered.
