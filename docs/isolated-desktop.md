# Agent-owned macOS desktop

The isolated MCP entrypoint controls a separate macOS guest, not the human's
running applications. It does not use the host mouse, clipboard, display
windows, focus, Spaces, audio devices or USB accessories. There is no host-input
fallback. The experimental VNC transport is not used.

The shared-host computer is a separate path: it captures and drives the
person's own apps in the background (per-PID input, no focus steal, no cursor
warp), gated by the app allowlist, observation tokens and the global stop. Use
this guest when the work must not touch the host at all.

## Requirements

- An Apple-silicon Mac running macOS 26 (Tahoe) or newer that can run the configured macOS VM
  through Tart. Tart refuses the required `--net-host` run argument on earlier releases.
- A separately provisioned Tart guest with the Tart Guest Agent installed.
- Guest Accessibility permission for input and guest screen-capture permission.
  Host permissions do not satisfy these requirements.
- An owned directory containing `tart.app`, `guest-store` and `ownership.json`.
- Sufficient storage and memory for the guest. The acceptance VM uses two CPUs
  and 4096 MiB of RAM.

The directory's registry must name the actual coordinating agent and session:

```json
{
  "backend": "tart",
  "agentName": "OmO",
  "sessionId": "your-session-id",
  "store": "guest-store",
  "vmName": "opencua-your-session-id",
  "runArguments": [
    "--no-graphics",
    "--no-audio",
    "--no-clipboard",
    "--no-usb-accessories",
    "--net-host"
  ],
  "sharedDirectories": [],
  "attachedHostDisks": []
}
```

This registry describes an already provisioned resource; writing it does not
create a VM or prove ownership of an arbitrary existing user VM.

## Run from source

From the repository root:

```sh
bun --tsconfig-override=tsconfig.isolated.json \
  packages/mcp/src/isolated-server.ts \
  /absolute/path/to/owned-desktop OmO your-session-id
```

This is an MCP stdio server, not an interactive shell. After normal packaging,
the corresponding executable is `opencua-isolated-mcp`.
Allow at least 210 seconds for a client's initial `start` request. Startup has
a bounded 180-second guest-agent readiness window. Normal guest commands have
a 30-second deadline.

## Protocol

`get_capabilities` reports the configured owner, runtime state and stop status.
`virtual_desktop` accepts `status`, `start`, `observe`, `act` and `close`.

1. Start the owned guest.
2. Observe its screenshot.
3. Submit an action with the returned `observation_token`.
4. Check the returned screenshot for the intended outcome.
5. Save guest work before closing; `close` stops this server's owned VM.

Actions include move, click, scroll, drag, key chord and Unicode text paste.
Coordinates are screenshot pixels. Key chords use the supported RFB/X11
keysym values; unsupported symbols are refused rather than guessed.
Use lowercase ASCII base keys with explicit Shift for uppercase shortcuts.
For arbitrary characters and punctuation, use Unicode text paste.
Unicode text uses only the guest clipboard.

A delegated actor supplies `actor: {"id":"stable-worker-id","name":"Actual name"}`
on observation and action. The coordinator's session and parent name are
attached automatically. Tokens are single-use and actor-bound. An actor ID
cannot be renamed during the server lifetime.

Names are coordinator-declared metadata, not OS-authenticated identities.
Actors share one serialized guest desktop and one guest OS pointer; they are
not independent hardware mice. Cursor owner/position metadata is returned in
responses. No labels are drawn on the human desktop.

## Limits

- Guest applications are separate copies. Existing host app windows, logged-in
  sessions and documents are not transferred.
- The required host-only guest network does not provide general Internet access.
- Only the configured owned resource is accepted. An already active runtime is
  not silently adopted.
- UTM/QEMU contracts and host Spaces are not interchangeable with this backend.
  Herdr's existing host toolbar and embedded browser are not verified through it.
- A dispatched action is not proof of application success. Inspect the returned
  image; failed actions invalidate their observation token.
- Source changes do not retrofit safety into already-running older clients.
  No other sessions are restarted by this setup.
