# @opencua/pi-extension

Computer use for the [pi coding agent](https://github.com/badlogic/pi-mono), part of
[OpenCUA](../../README.md).

pi has no MCP client, so this extension is one: a thin bridge to the same guarded `opencua-mcp`
server every other agent client runs, inside the signed helper app. The server keeps every guard
(observation tokens, the app allowlist, background delivery, the stop switch), and macOS
Accessibility and Screen Recording permissions belong to **opencua-mcp**, not to the terminal
that runs pi.

```bash
pnpm --filter @opencua/pi-extension build
pi install <checkout>/packages/pi-extension
```

## How it finds the server

At each session start (so a settings change applies to the next session) the extension starts
one server, first match wins:

1. `OPENCUA_MCP_COMMAND`, with `OPENCUA_MCP_ARGS` as a JSON array of arguments, for a server
   installed elsewhere.
2. The per-Mac bundle `opencua setup` writes, `$OPENCUA_HOME/bundle/plugins/opencua/.mcp.json`
   (`OPENCUA_HOME` defaults to `~/.opencua`): its `command`, `args` and `env`, the same
   registration and saved settings every other client runs.
3. The helper and server built in this checkout:
   `packages/mcp/dist/opencua-mcp.app/Contents/MacOS/opencua-mcp packages/mcp/dist/server.js`.

If none applies, or the bundle cannot be read, session start fails with an error naming
`opencua doctor`. The pi process's own `OPENCUA_*` variables are passed to the server on top
of the bundle's env and win over it, for example `OPENCUA_ALLOWED_BUNDLE_IDS`,
`OPENCUA_DELIVERY`, `OPENCUA_TOOLSET` and `OPENCUA_IPHONE`. The server's stderr is kept out
of pi's terminal UI and quoted in error messages instead.

One server runs per pi session and stops at session end. If it exits on its own it is restarted
once; a call that was in flight fails and is never replayed, because its input may already have
been dispatched. After a second exit every call fails until a new session starts.

## Tools

Tools are registered from the server's `tools/list` at session start, with the server's own names,
descriptions and JSON Schemas: `list_apps`, `get_app_state`, `click`, `run_script` and the rest of
the profile `OPENCUA_TOOLSET` selects, plus the iPhone Mirroring tools when `OPENCUA_IPHONE=1`.
Calls run one at a time and return the server's text and images unchanged; a refusal is reported
as a failed tool call carrying the server's reason. The server's instructions are added to the
system prompt, as an MCP client would show them.

## Native computer-use shapes

Anthropic models get the native computer tool version they accept, with its beta header (`computer_20251124`
for Claude Opus 4.5 to 4.7 and Sonnet 4.6, `computer_20250124` for earlier models), and OpenAI
Responses models can get `{ "type": "computer" }` (off until `OPENCUA_OPENAI_NATIVE_TRANSPORT=1`,
because the pi-ai transport cannot carry computer calls yet). `OPENCUA_DISABLE_COMPUTER_USE_BETA=1`
turns both off.

The native tool acts on the app window last observed through the bridge, so the model calls
`get_app_state` first. `screenshot` re-observes that window, the declared display is that window
screenshot's size, and coordinates are its pixels (the server caps window images at a 2560 px long
edge, so they map 1:1). Every action is one guarded call with the newest observation token; an
answer without a token means the next action needs a new screenshot.

| Native action | opencua-mcp call |
|---|---|
| `screenshot` | `get_app_state` of the targeted window (the window, not the whole screen) |
| `left_click`, `right_click`, `middle_click`, OpenAI `click` | `click` with `x`, `y`, `mouse_button`; OpenAI `keys` are held as `modifiers` |
| `double_click`, `triple_click` | `click` with `click_count` 2 or 3 |
| `left_click_drag`, OpenAI two-point `drag` | `drag` |
| `type` | `type_text` |
| `key` (xdotool chords, space-separated sequences), OpenAI `keypress` | `press_keys` |
| `hold_key` | `press_keys` with `hold_seconds` |
| `wait` | waits locally, nothing is sent |

These have no faithful equivalent and fail with an error that names the gap: `scroll` (the server
scrolls an observed scroll area by pages through `scroll` with an `element_index`, not the wheel at
a point), `mouse_move` and OpenAI `move` (the pointer is never moved), `cursor_position`,
`left_mouse_down` and `left_mouse_up`, the OpenAI `back` and `forward` buttons, and OpenAI drag
paths through more than two points.

Docs: [root README](../../README.md) · [harness setup](../../skills/opencua/references/harnesses.md).
MIT licensed — see [LICENSE](../../LICENSE).
