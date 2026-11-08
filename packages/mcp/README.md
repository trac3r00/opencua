# @opencua/mcp

The guarded stdio MCP server for macOS computer control, part of [OpenCUA](../../README.md).

It exposes 33 tools over MCP: observation (`get_app_state`, `list_apps`, `list_windows`,
`find_elements`, `verify_state`), mutation (`click`, `click_target`, `set_value`, `set_fields`,
`run_steps`, `type_text`, `press_keys`, `scroll`, `drag`, `select_text`, `perform_secondary_action`,
`invoke_menu`, `set_window_frame`, `clipboard_read`, `clipboard_write`), lifecycle (`open_app`) and
the iPhone Mirroring tools (`ios_*`).

On the shared host the server only observes through Accessibility. Anything that would act on or capture the
human desktop is refused with `isolated-session-required`: input, the clipboard, window geometry
(`set_window_frame`), app launch and activation (`open_app`), overlays, screenshots, and iPhone Mirroring input,
because the Mirroring window is part of that desktop. Agent work runs in an agent-owned isolated desktop; see
[docs/isolated-desktop.md](../../docs/isolated-desktop.md).

The three targeting tools are the ones to reach for when a caller knows *what* it wants but not
where it is: `find_elements` resolves a description (role, label, text) to ranked element ids,
`click_target` resolves, waits, clicks and verifies in one call, and `open_app` launches or reopens an app; on the
shared host the last two are refused like every other action.

## Concurrent worker sessions

The full toolset supports several cooperating sessions on one server. Use `session_id` on
`manage_workers` and `run_worker`; omitting it selects `default`. Worker names can repeat across
sessions. App ownership is pinned to the PID and exclusive across all sessions, including app aliases,
so two sessions cannot race the same app's keyboard focus or invalidate each other's tokens. The exception is an
OpenCUA-owned surface, which several workers share by disjoint `region`s.
This is coordination between trusted clients, not authentication or a separate macOS login session.

```json
{
  "op": "assign",
  "session_id": "notes",
  "assignments": [
    { "worker_id": "editor", "task": "Edit the note", "app": "Notes" }
  ]
}
```

Pass the returned token to `run_worker` with the same `session_id` and `worker_id`.
Under background delivery, run calls for disjoint apps concurrently; attended delivery serializes them. Steps inside
each worker remain ordered.
Every worker has a server-created virtual cursor identity and per-app position. Background cursors
are invisible and never move the user's pointer. `observe_apps` and `run_parallel` also maintain
distinct cursor identities per app; `run_parallel` validates every step before dispatch.

Assignment and refresh observations default to text-only tables. Set `include_screenshot: true`
only when pixels decide the next action; use `max_elements` to bound reads and `diff_only: true`
on refreshes to return changes. Results retain one-use continuation tokens and verification evidence.
Use `pace: "fast"` for supported step chains to reduce intermediate reads; final verification still applies.
Status returns only the named session's compact worker records, not cached screenshots.

Refresh with `manage_workers` using `op: "observe"`, the session ID, and worker ID.
Until released, only that worker should observe or mutate its app; unassigned tools share the
same app context and must not be used on an owned app. Release idle workers with `op: "release"`,
or all idle workers in a session with `op: "release_session"`. Busy sessions cannot be released.
Release revokes outstanding worker tokens; a restarted app requires release and reassignment.

```bash
pnpm --filter @opencua/core --filter @opencua/mcp build
node packages/mcp/dist/server.js
# or, with its own TCC identity (Screen Recording + Accessibility attach to the bundle):
scripts/build-tcc-helper.sh
```

Explicitly name the app to observe or control; no manual whitelist or implicit frontmost target is used.
Optionally set `OPENCUA_ALLOWED_BUNDLE_IDS` to exact, case-insensitive bundle IDs to restrict access.
Unset means unrestricted named apps; an explicitly empty value denies all apps. Observation tokens,
window preflight, and the stop switch still guard input.

The helper bundles a self-contained `node` built for this Mac's CPU (Homebrew's build links
`libnode.dylib` and cannot be copied into a bundle); set `OPENCUA_NODE` to choose one,
`OPENCUA_BUNDLE_ID` for another bundle id, and `OPENCUA_SIGN_IDENTITY` to keep a stable code
identity across rebuilds. `opencua config --register` writes the helper into Omo, Claude Code or
Codex.

Docs: [root README](../../README.md) · [usage](../../skills/opencua/references/usage.md) ·
[harness setup](../../skills/opencua/references/harnesses.md). MIT licensed — see [LICENSE](../../LICENSE).
