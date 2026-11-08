# OpenCUA compared with Cua Driver, agent-desktop and Codex Computer Use (2026-11-06)

This is a dated record, judged from each product's code and measured on this Mac (Apple M1 Pro,
macOS 27.2). Every claim cites a file and line from the version named here, a string in a shipped
bundle, or a local measurement. Something a source does not show is marked UNKNOWN. It is never
assumed to be absent.

Versions read:

- Cua Driver: `trycua/cua` at `78b0911` (2026-11-06), `libs/cua-driver/rust/crates/...`. Measured
  build: the installed Cua Driver 0.23.2.
- agent-desktop: `vercel-labs/agent-desktop` at `b43ac4f` (2026-11-05), `crates/...`. Measured build:
  the npm package 1.2.0.
- Codex Computer Use: `Codex.dmg` from `persistent.oaistatic.com/codex-app-prod/` (sha256 `56bf3c1e...`),
  ChatGPT app with plugin `computer-use` 1.0.1001824. Readable JS is in
  `Contents/Resources/cua_node/lib/node_modules/@oai/sky` 0.7.17. The native service is installed
  on this Mac at `~/.codex/computer-use/Codex Computer Use.app` (`com.openai.sky.CUAService`
  26.1027.1001730, `SkyComputerUseService` plus `SharedSupport/SkyComputerUseClient.app`). It was read
  statically (Swift symbols and strings), not disassembled.
- OpenCUA: this repository's working tree of 2026-11-06.

## Many agents in one window

| | How it works, from the code |
|---|---|
| Cua Driver on macOS | Every session gets its own cursor (`cua-driver-core/src/agent_cursor.rs:19`). The overlay keeps a map of cursors (`cursor-overlay/src/render_map.rs:213`) and shows session names when two or more are on screen (`cursor-overlay/src/badge_mode.rs:14`). But input to one app is serialized: `background_mutation.rs:4-9` says two concurrent mutations for one pid "must not interleave". `gate_background_window_action` takes the per-pid lock before every background window action (`platform-macos/src/tools/mod.rs:493-509`), and every foreground activation in the daemon shares one lock (`platform-macos/src/input/skylight.rs:1224-1232`). So agents in the same app take turns, one action at a time. Events go to the target process through SkyLight `SLEventPostToPid` (`platform-macos/src/input/mouse.rs:4`). |
| Cua Driver on Linux X11 | Real OS multi-pointer: each session gets its own XInput2 master pointer, created with `XIAddMaster` (`platform-linux/src/input/mod.rs:141`, `667`, `711`). macOS has no equivalent. |
| agent-desktop | Every interaction of every agent on the machine takes one file lock, `/tmp/agent-desktop-<uid>/interaction.lock` (`core/src/session/interaction_lease.rs:108-134`), so all interactions are serialized machine-wide. Ref actions use AX (`macos/src/tree/properties/ax_ipc.rs:226`) and keys go to the pid (`macos/src/input/keyboard/keyboard_event.rs:136`). Coordinate mouse input is posted to `CGEventTapLocation::HID` (`macos/src/input/mouse/mod.rs:156`, `167`), the system event stream that moves the real pointer. Separate press and release are refused (`macos/src/input/mouse/mod.rs:54`). Cursor overlays are per (session, agent) (`macos/src/system/cursor_overlay/endpoint.rs:8`). |
| Codex Computer Use | Every request goes over one Unix socket to one shared native service: `~/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/IPC/computeruse.sock` (`@oai/sky/.../targets/mac/native-pipe.js`). That file also launches `Codex Computer Use.app` / `com.openai.sky.CUAService` when the socket is missing. Each transport chains its requests on one promise, so one client has only one request in flight at a time (same file, `request()`). Requests name only an `app`, with no window, session or cursor id, and a drag is only `from`/`to` with no path (`targets/mac/client.js`). The service binary agrees: `ComputerUseIPCAppPerformActionRequest.init(app:action:)`. Its cursor is bound to an app, not to an agent: `ComputerUseCursor.setCorrespondingApplication(pid:)`, `correspondingApplicationPID` and `targetWindowID` (symbols of `SkyComputerUseService`). No agent or session field appears on the cursor. How the service schedules several clients is UNKNOWN; it is not visible in the symbols. |
| OpenCUA | On an OpenCUA surface opened with `pointers: "multi"`, every cursor is its own page pointer, a `pen` PointerEvent with its own pointerId (`packages/core/native/opencua-surface.m`, `kMultiPointerScript`). Pointer bursts to an owned surface skip the machine-wide input lock (`packages/core/src/platform/macos.ts`, `pointerBurst`). Each MCP session has its own cursor tag, and a worker's cursor shows `name: task` (`packages/core/src/platform/owned-surfaces.ts`, `surfaceCursorFor`). Measured: 15 subagent server processes drew at the same time on one surface; the page counted 15 pointers down at once, and 15 of 15 rows had 52 of 52 sampled pixels in their own color. This works only for OpenCUA's own surfaces; other apps are refused on the host by policy. |

### Same-window drag demo on this Mac (not a valid comparison)

**Do not read this table as a ranking.** The venue was OpenCUA's own board page, which gives every OpenCUA
cursor its own page pointer. That feature exists only in OpenCUA; the other tools drive a window through OS
mouse events, and a macOS window has one mouse. So "5 vs 1 pointers at once" was decided by the venue, not
measured. Each tool also ran once, on straight lines, not on a task. Cua Driver was driven as 5 sessions on one
window, which is not how it is meant to be used, and its 168 pt offset may come from this harness. A fair
comparison is designed in `docs/benchmark-multi-agent-vm-2026-11-06.md`.

One fresh OpenCUA board window, 640 x 480, kept behind the person's windows. Each tool got 5 MCP sessions (5
agents), and each agent dragged its own horizontal row at the same time, in background delivery. The page
counts how many pointers are down at once.

| Tool | Page: most pointers down at once | Rows drawn | Wall time for 5 drags | Notes |
|---|---|---|---|---|
| OpenCUA (installed helper, this tree) | 5 | 5 of 5, 52 of 52 samples each, no ink between rows | 2.5 s (2 s drags) | every call succeeded on the first try |
| Cua Driver 0.38.0 (latest release, `delivery_mode: background`, `duration_ms: 2000`) | 1 | 5 of 5 complete, but 168 pt below the requested rows (168 pt is the window's top edge on screen; cause UNKNOWN) | 18.4 s; calls finished one after another at 3.7 / 7.4 / 11.2 / 14.9 / 18.4 s | A window's screenshot frame belongs to the last session that observed it ("belongs to another session"), so agents re-observed and retried 6 times in total |
| Cua Driver 0.23.2 (previously installed) | 0 | 0 | refusals arrived about 575 ms apart | "Background drag is unavailable on macOS; use delivery_mode: foreground" for all 5 |
| Codex Computer Use 26.1027.1001730 | not run | | | see Follow-up attempts |
| agent-desktop 1.2.0 (`--headed`, Accessibility granted to Ghostty) | not read (board counter missing) | UNKNOWN where they landed: `focus-window --app opencua-surface` returned WINDOW_NOT_FOUND, so the board was not brought forward | 16.8 s; drags finished one after another at 3.4 / 6.8 / 10.1 / 13.5 / 16.8 s | each reported `delivered_unverified`; the serial finish times match the machine-wide `interaction.lock` |

### Follow-up attempts (user-approved)

- Codex Computer Use: a direct client gets `-10000 Sender process is not authenticated`. The bench's own path
  (`node_repl` with the env of Cua's `arms.py` `codex_cu_config`), also launched with responsibility
  disclaimed, failed every call with "Sky Computer Use native pipe startup failed". Going further would mean
  defeating OpenAI's sender authentication, so it was not done.
- agent-desktop: its coordinate drag posts to the system event stream (`macos/src/input/mouse/mouse_drag.rs:47`)
  and needs `--headed`. With the board brought to the front, every command returned `PERM_DENIED: Accessibility
  permission not granted`. Only the user can grant that permission.

- agent-desktop rerun with a safety gate (no drag unless focus succeeds): `list-windows` does not list the board at all; it listed only a hidden 500 x 500 `opencua-surface` window, so no drag was sent. Why the board is missing is UNKNOWN (the surface is kept behind normal windows, which may be the cause). In the earlier run the 5 drags went to the screen with the board not in front; where they landed is UNKNOWN, and the user found no change in Calendar, the window seen in that area at the rerun.

Why OpenCUA uses page pointers: a local probe sent tablet events from device ids 11 and 22 into a
WKWebView, and both arrived as `pointerId 1` of type `mouse`. A macOS window has one mouse.

## Resource use (local, same probe for every product: 5 MCP sessions, initialize and tools/list only)

| | Per extra session | Shared | Tools listed |
|---|---|---|---|
| agent-desktop 1.2.0 | 11.5 MB, 1 process | none | 67 |
| Cua Driver 0.23.2 | 20 MB proxy | about 81 MB daemon (`cua-driver serve`, auto-launched; `cua-driver/src/proxy.rs:10`) | 56 |
| Cua Driver 0.38.0 | 23 MB proxy | one 87.6 MB daemon for 5 sessions started at once (checked from a clean start) | 62 |
| OpenCUA before this work | 255-256 MB (2 launchers, Node supervisor, Node server, menu bar helper) | none | 34 (full toolset) |
| OpenCUA now | 132-133 MB (2 launchers, 1 Node server); 137 MB in the installed helper with a surface open | one 58 MB menu bar helper for all sessions | 34 (full toolset) |
| Codex Computer Use 26.1027.1001730 | 36 MB per `SkyComputerUseClient mcp`, 1 process | `SkyComputerUseService`, 103.6 MB (already running) | 10 |

OpenCUA is still the heaviest per session. It runs one Node server per session for isolation.
Cua Driver and Codex share one native service across sessions behind a small per-session client,
and agent-desktop is one small native process.

Idle CPU, OpenCUA only (20 s `ps` samples; 0.05 % is the resolution floor): cua-history recorder
went from 1.55 % to 0.05 %, and a surface after drawing from 1.0 % to 0.05 %.

## Task success

Not compared. Cua Driver Bench v2 (`libs/cua-driver-bench`, FSL-1.1-MIT) already has arms for Cua
Driver, Codex Computer Use and agent-desktop (`automated-eval/macos_bench/RUNNER.md`). It has none
for OpenCUA. Its method runs every trial in a macOS VM, "never on anyone's working desktop"
(`METHOD.md`, Platform), with `claude -p` signed in inside that VM. Here that would need a
signed-in Claude Code in OpenCUA's isolated desktop, the Bench apps built there, an OpenCUA arm
written, and about 10 tasks x 5 runs x 2 conditions per arm of subscription use. None of that was
done in this pass.

## Sources

- https://github.com/trycua/cua (commit `78b0911`)
- https://github.com/vercel-labs/agent-desktop (commit `b43ac4f`); npm `agent-desktop@1.2.0`
- https://persistent.oaistatic.com/codex-app-prod/Codex.dmg (sha256 `56bf3c1ec35029a8f92cd49f27238dc6e4f2484e76c722fe0676f9047aaaa6dc`)
- https://openai.com/index/codex-for-almost-everything/ and https://github.com/openai/codex/issues/20852 (product claims only; the table above uses the shipped code)
