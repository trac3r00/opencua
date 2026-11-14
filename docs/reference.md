# OpenCUA reference

> The complete manual: install internals, configuration, every surface (CLI, MCP, pi), permissions, architecture and benchmarks. For the overview and one-line install, see the [README](../README.md).

<img src="../packages/mcp/assets/appicon.png" alt="OpenCUA app icon: a cursor over a window on an indigo tile" width="120" align="right" />

Native macOS computer-use control, designed for the OpenAI computer-use action vocabulary. Host-native (CGEvent / ScreenCaptureKit-class) speed, no VM sandbox required.

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../LICENSE)
[![Node.js >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](../package.json)
[![platform: macOS 15+, Apple Silicon and Intel](https://img.shields.io/badge/platform-macOS%2015%2B%20%C2%B7%20Apple%20Silicon%20%7C%20Intel-blue.svg)](#permissions)
[![MCP: stdio server](https://img.shields.io/badge/MCP-stdio%20server-6f42c1.svg)](#mcp-server)

**Contents** — [Why this exists](#why-this-exists) · [Quickstart](#quickstart) · [The four surfaces](#the-four-surfaces) · [MCP server](#mcp-server) · [Targeting by description](#targeting-elements-by-description) · [Observation cost](#observation-cost) · [Action surface](#action-surface) · [Permissions](#permissions) · [Architecture](#architecture) · [Repository layout](#repository-layout) · [Roadmap](#roadmap) · [Development](#development) · [Comparison](#comparison-vs-cua--codex) · [License](#license)

## Why this exists

OpenAI Codex Computer Use is fast because it runs on the host with macOS-native APIs (ScreenCaptureKit, CoreGraphics, local MCP stdio). By contrast, [trycua/cua](https://github.com/trycua/cua) is portable but slow because of the multi-hop VM/HTTP/PIL pipeline: Python agent loop, 500 ms post-action screenshot delay, HTTP/WebSocket JSON to a guest FastAPI server, PIL encode, base64 SSE, client decode/re-encode. Codex removes the VM boundary and repeated image serialization; cua keeps it for sandbox isolation.

`opencua` is the Codex-style local path with cua's clean platform abstraction, written in strict TypeScript. It gives you the same app-oriented `list_apps / get_app_state / click / type_text / press_keys / scroll / drag` vocabulary that models expect, but executes directly on your Mac through native macOS APIs: ScreenCaptureKit for window and main-display capture, `koffi`-bound CoreGraphics for global input, Accessibility for app state/actions, and SkyLight/AppKit FFI for app-targeted window sessions. No Docker, no QEMU, no VNC, no bundled helper service, no cloud API key.

Need VM isolation, or Windows and Linux hosts? Use cua. For low-latency host-native control of your Mac, use this.
The cua cells below follow the dated sources under [Comparison vs cua / codex](#comparison-vs-cua--codex).

| | Codex | cua | OpenCUA |
|---|---|---|---|
| Runs on | Host Mac | Host, on macOS, Windows and Linux (Cua Driver) | Host Mac |
| Needs VM | No | No; Lume VMs and Cua Spaces optional | No |
| Needs API key | OpenAI only | Not for Cua Driver | No |
| Screenshot path | Native ScreenCaptureKit / IOSurface | ScreenCaptureKit on macOS | Native ScreenCaptureKit, CoreGraphics for the main display, `screencapture -l` for uncapturable windows |
| Input path | Native CGEvent / Apple Events | Native per platform (Quartz/HID on macOS) | CoreGraphics CGEvent via koffi + SkyLight/AppKit FFI for app-targeted windows |
| Transport | Local MCP stdio | MCP stdio, CLI, Python/TypeScript/Rust SDKs | Local process / MCP stdio / pi extension |
| Post-action delay | None reported | Not measured by this project as of 2026-10-28 [9] | None |
| Isolation | macOS permissions + app scoping | Permission modes, optional VMs | macOS permissions only |

## Quickstart

### Phone, FaceTime, and iPhone compatibility

Mac Phone is available on macOS 26 or later; FaceTime and iPhone cellular relay
also depend on the user's Apple service configuration. Floating call banners are
composited by Notification Center, with separate FaceTime helpers behind it.
Each target requires explicit approval under its own bundle ID:

- `com.apple.notificationcenterui` (the visible banner host on macOS 26.7)
- `com.apple.FaceTime.FaceTimeNotificationExtension`
- `com.apple.facetime.NotificationViewBridgeService`
- `com.apple.facetime.NotificationService`

The driver discovers these background hosts and targets their notification-layer
windows after verifying the bundle identity and system path. Main-app approval does
not grant host/helper approval. The banner's AX tree may expose only a placeholder
group; its screenshot identifies the actual Call control. Hidden helper windows
are not a substitute for the visible host. Follow the [call-banner workflow](../skills/opencua/SKILL.md#phone-and-facetime-call-banners)
and confirm the displayed recipient before dialing.

Discovery is verified; background dialing is not. On macOS 26.7, per-process
and window-owner background clicks were dispatched without a visible call-state
change. The window-owner attempt preserved the real pointer and frontmost app,
but the recipient confirmed that no call occurred. The ineffective mouse
window-owner experiment was removed. An opaque banner and a dispatched
event do not establish call support. Do not replay an uncertain Call action.

iOS 26 and iOS 27 fall within Apple's documented iOS 18-or-later
[iPhone Mirroring requirements](https://support.apple.com/en-ie/120421), but this is
eligibility, not an end-to-end test result. The banner failure and helper identities
were measured on macOS 26.7. macOS 27 and iOS 26/27 calling have not been validated
on devices here. Mirroring does not expose the iPhone microphone for phone calls;
[Mac call relay](https://support.apple.com/en-ie/102405) is a separate service.

```bash
curl -fsSL https://raw.githubusercontent.com/trac3r00/opencua/main/install.sh | bash
```

One command on a Mac with **macOS 15 (Sequoia) or macOS 26 (Tahoe)**, **Apple Silicon or Intel**. It clones OpenCUA
into `~/.opencua/app`, runs its `scripts/setup.sh`, and puts the `opencua` command into `~/.local/bin`. Use
`bash -s -- --add-to-path` to also add the one line that puts `~/.local/bin` on your `PATH` (your shell startup file
is backed up first). In a checkout of your own, `./scripts/setup.sh` does the same for that checkout.

Setup is safe to re-run: every step checks before it acts, and a run after a failure picks up where the last one
stopped. It

1. checks the macOS version and CPU, and the Xcode Command Line Tools (it tells you to run `xcode-select --install`
   when they are missing);
2. uses Node.js 20+ from `PATH`, or downloads the official Node.js LTS into `~/.opencua/node`, verified against
   nodejs.org's `SHASUMS256.txt`;
3. runs the pnpm version `package.json` pins, `pnpm install --frozen-lockfile`, and builds every package;
4. uses the committed universal (arm64 + x86_64) native binaries, rebuilding them only when their sources changed;
5. builds the signed helper app **opencua-mcp** only when it is missing, broken, or built from another launcher than
   the checkout has, bundling a self-contained `node` for this Mac's CPU (Homebrew's links `libnode.dylib` and cannot
   be bundled, so setup downloads the official build instead);
6. installs the `opencua` command and, in a terminal, offers to put it on `PATH`;
7. on a first run in a terminal, asks which apps agents may use and which MCP clients to register with (Enter
   registers with the ones installed on this Mac); otherwise writes your saved settings into every registered client;
8. walks you through macOS's permission dialogs for **opencua-mcp** (see below), and finishes with
   `opencua doctor`. With `--yes`, or without a terminal, it asks nothing and the doctor lists what is left.

From then on one command covers the whole lifecycle:

| Command | What it does |
|---|---|
| `opencua config` | Choose the apps agents may use and the MCP clients to register with; asks in a terminal, takes flags in scripts |
| `opencua permissions grant` | Walk through Accessibility, Screen Recording and Automation for **opencua-mcp**: shows macOS's dialog, opens System Settings with a panel attached to drag **opencua-mcp** into the list when it is missing there, and waits until each switch is on |
| `opencua doctor [--fix]` | Check everything without raising a permission prompt; `--fix` repairs what is safe and asks before the rest |
| `opencua update` | Fast-forward the checkout, rerun setup, re-apply the registrations, run the doctor |
| `opencua uninstall` | Remove the registrations (backed up), the helper and its permissions, the command and its PATH line, `~/.opencua`, and the checkout the installer made |

### Configure

Settings live in `~/.opencua/config.json` and are the source of truth for every registration: each registered
client's `opencua` entry carries them as environment variables, and changing a setting rewrites every registration.
Client config files are merged, never replaced: other servers stay as they are, and a file is copied to
`<file>.bak-<timestamp>` before it changes.

```bash
opencua config                                       # in a terminal: asks, and Enter keeps a value
opencua config --allow TextEdit,com.apple.finder     # approve apps by name or bundle id
opencua config --register omo,codex --toolset lean   # any client below; json prints a block to paste
opencua config --detect                              # which agent clients are installed, offers the missing ones
opencua config --unregister codex --disallow all
opencua config --show                                # the settings, and where each client is registered
```

| Option | Effect |
|---|---|
| `--allow <apps>`, `--disallow <apps>` | Set or edit an optional app restriction (`OPENCUA_ALLOWED_BUNDLE_IDS`); `--disallow all` clears it. Without a restriction, any explicitly named app is available. |
| `--register`, `--unregister <clients>` | `omo`, `claude`, `codex`, `gemini`, `cursor`, `hermes`, `openclaw`, `pi`, or `json`; see [Agent clients](#agent-clients). |
| `--detect` | List the installed agent clients and whether OpenCUA is set up in each; in a terminal, offer the missing ones (`--json` for a machine-readable answer). |
| `--delivery background\|attended`, `--toolset full\|lean`, `--iphone`, `--no-iphone` | `OPENCUA_DELIVERY`, `OPENCUA_TOOLSET` and `OPENCUA_IPHONE` in every registration. |
| `--cursor-motion <style\|off\|json>`, `--cursor-motion-timing <native\|fitts\|fixed>`, `--cursor-motion-duration <ms>` | Cua Cursor Motion for the agent cursor, saved and written as `OPENCUA_CURSOR_MOTION` into every registration; `off` removes it. The timing and duration flags (0 to 5000) adjust an enabled motion and fail without one. See [Cursor motion](#cursor-motion). |
| `--apply` | Write the saved settings into every registered client again; setup and `opencua update` do this. |

#### Agent clients

Every client gets the same thing from one per-Mac bundle, `~/.opencua/bundle`: the skill, an `.mcp.json` that
launches the signed helper with the saved settings, and the Claude Code, Codex and Gemini plugin manifests with a local
marketplace. `opencua config`, setup and `opencua update` regenerate it, and its version (`0.1.0+codex.<hash>`)
changes only when its content does, so re-running setup changes nothing. Each client is then set up the way that
client expects, through its own command line wherever it has one:

| Client | `--register` name | How OpenCUA is added | Skill |
|---|---|---|---|
| OmO / senpi | `omo` | `~/.omo/agent/mcp.json`, `mcpServers["opencua"]` | linked into `~/.agents/skills` |
| Claude Code | `claude` | the `opencua` plugin from the local `opencua-local` marketplace (`claude plugin install`, user scope); `claude mcp add --scope user` on a Claude Code without plugins. Honors `CLAUDE_CONFIG_DIR` | inside the plugin |
| Codex | `codex` | the `opencua` plugin from the local `opencua-local` marketplace (`codex plugin add`); `[mcp_servers.opencua]` in `config.toml` on a Codex without plugins. Honors `CODEX_HOME` | inside the plugin |
| Gemini CLI | `gemini` | `gemini extensions link` of the bundle, so it follows settings changes by itself | inside the extension |
| Cursor | `cursor` | `~/.cursor/mcp.json`, then `cursor-agent mcp enable opencua` approves it | linked into `~/.cursor/skills` |
| Hermes Agent | `hermes` | `hermes mcp add` (`HERMES_HOME`) | linked into `<hermes home>/skills` |
| OpenClaw | `openclaw` | `openclaw mcp set` then `openclaw mcp reload` (`OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`) | linked into `<state dir>/skills` |
| pi (the original coding agent) | `pi` | `pi install packages/pi-extension`, a bridge to the same MCP server (`PI_CODING_AGENT_DIR`) | — |
| anything else | `json` | prints a block to paste | — |

Setup detects the installed clients and, in a terminal, asks before adding OpenCUA to each; without a terminal it
only re-applies the clients you chose before. Changing a setting refreshes every client (plugins are updated, entries
rewritten). An old `opencua` MCP entry of this installation (for example a pre-plugin Codex `[mcp_servers.opencua]`,
which would shadow the plugin) is migrated; another installation's entry is left alone and named with the command
that removes it; a config file OpenCUA cannot parse is never rewritten. Codex and Claude Code ask before each call of
an MCP tool marked destructive, one tool at a time, so the plugin install also lets the plugin's server run its tools
without asking: `default_tools_approval_mode = "approve"` under
`[plugins."opencua@opencua-local".mcp_servers.opencua]` in Codex's `config.toml`, and `mcp__plugin_opencua_opencua`
in `permissions.allow` of Claude Code's `settings.json`. A mode or an `ask`/`deny` rule you set yourself is kept, and
uninstalling removes what OpenCUA added. Restart a client, or start a new session, after a change. Caveats the doctor
repeats:

- Gemini CLI turns MCP servers off in folders you have not trusted: trust the folder, or set
  `GEMINI_CLI_TRUST_WORKSPACE=true`.
- A Hermes or OpenClaw gateway running as a background service still needs a logged-in Mac session to reach the screen.
- OpenClaw refuses to write `openclaw.json` when it would shrink below half its size; when OpenCUA is most of that
  file, unregistering names the manual edit instead of failing.
- Gemini keeps its own signed `extension_integrity.json` record after the extension is removed.

### Permissions

Only a person can grant macOS privacy permissions, so setup (and `opencua permissions grant` any time later) guides
you through each one for the helper app, listed as **opencua-mcp**:

| Permission | Why | What you do |
|---|---|---|
| Accessibility | read app windows, send clicks and keys | choose **Open System Settings** in macOS's dialog and switch on **opencua-mcp** |
| Screen & System Audio Recording | screenshots | the same, in the Screen & System Audio Recording list |
| Automation of System Events and Finder (and of approved browsers that are running) | window lookup, desktop size, a page's address | choose **Allow** when macOS asks |

The walk-through opens the right pane (reopening System Settings so the new entry is listed), waits until the switch
is on, and lets you skip a step with Enter. Restart your MCP client afterwards. Setup and updates keep the helper
unless its launcher changed, so the grants keep working. Helpers built before the opencua-mcp name was used appear
as **node** in these lists; that entry is no longer used and can be removed with the minus button.

### Check and repair

The doctor never raises a permission prompt: it reads the helper's own permissions by running the server through it
in a read-only self-check (`server.js --doctor`), and exits 0 when everything is in place, 1 otherwise, with the fix
for each item. It also catches an Intel build of Node running under Rosetta on Apple Silicon and points to the native
one.

```text
opencua doctor
  ok    macOS 26.7 on Apple Silicon (arm64)
  ok    Node v22.23.2 (/Users/you/.opencua/node/bin/node)
  ok    libsckit.dylib: x86_64 + arm64
  ok    cursor-overlay: x86_64 + arm64
  ok    MCP server built (/Users/you/.opencua/app/packages/mcp/dist/server.js)
  ok    helper app /Users/you/.opencua/app/packages/mcp/dist/opencua-mcp.app (signature valid, bundled Node v22.23.2)
  ok    server.js answered through the helper (Node v22.23.2, arm64)
  ok    Accessibility granted to "opencua-mcp"
  FAIL  Screen Recording not granted to "opencua-mcp" (needed for screenshots)
  ok    Automation: "opencua-mcp" may control System Events
  warn  Automation of Finder not answered yet, so macOS would ask in the middle of an agent's task
  ok    ScreenCaptureKit capture loads in the helper
  ok    omo: registered in ~/.omo/agent/mcp.json
  ok    stop switch: not stopped (Control+Option+Command or `opencua stop` stops every agent)

Installed. One manual step remains, granting permissions to "opencua-mcp":
  1. Grant Screen Recording to "opencua-mcp": run opencua permissions grant, which shows macOS's dialog, opens System Settings > Privacy & Security > Screen & System Audio Recording and waits until it is on. ...
```

`opencua doctor --fix` rebuilds missing or outdated native binaries and re-registers clients whose entry went stale.
It asks before rebuilding a broken helper, because a rebuild is a new code identity that needs both permissions again
(`--rebuild-helper` consents up front; for an ad-hoc signed helper that holds grants it warns which ones a rebuild
drops and rebuilds only with `--rebuild-helper`), and before lifting a stop. It runs the permission walk-through for anything
missing, also without a terminal (an agent running it): each pane opens and the walk moves on by itself as soon as the
switch is on. On CI, on a locked screen or with `--no-wait` it only opens the first pane and lists the rest
(`--no-open` never opens System Settings). It ends with what it fixed and what is left.

### Update and uninstall

`opencua update` refuses when the checkout has local changes or commits its upstream lacks, then fast-forwards to the
upstream (the ref the installer cloned), reruns setup and prints the old and new version and commit. When an update
changes the helper's launcher or Info.plist, it says so first, since the rebuilt helper needs both permissions again.

`opencua uninstall` lists what it will remove and asks (`--yes` skips the question, `--dry-run` only lists): this
installation's registration in every client config (each file backed up first), running OpenCUA servers and the
cursor overlay, the helper app and its Accessibility and Screen Recording entries (`tccutil reset`), the `opencua`
command and the PATH line setup added, `~/.opencua`, and the checkout if the installer created it. A developer
checkout stays unless you add `--purge`.

The installer reads `OPENCUA_HOME` (default `~/.opencua`), `OPENCUA_REPO`, `OPENCUA_REF` (default `main`) and
`OPENCUA_BIN_DIR` (default `~/.local/bin`); `OPENCUA_BUNDLE_ID` gives the helper another bundle id.
`./scripts/setup.sh --help` lists setup's own options (`--rebuild-native`, `--rebuild-helper`, `--yes`, `--no-doctor`,
and shortcuts for `opencua config`).

The CLI runs with your terminal's permissions rather than the helper's, so CLI screenshots need Screen Recording granted
to the terminal:

```bash
opencua screenshot -o /tmp/shot.png
```

See [`skills/opencua/references/installation.md`](../skills/opencua/references/installation.md) for the full
walkthrough.

## The four surfaces

### CLI

The `opencua` binary is a thin `commander.js` wrapper over `MacOSHostComputer`.

```bash
# Screenshot (main display)
opencua screenshot -o shot.png

# Region of a display, in global screen points
opencua screenshot -o shot.png -r 100,100,800,600

# A specific display id instead of the main display
opencua screenshot -o shot.png --display 58

# Click and type into an explicitly named app
opencua --target-bundle-id com.apple.TextEdit click -x 500 -y 300
opencua --target-bundle-id com.apple.TextEdit type "Hello, world"

# Key chord
opencua --target-bundle-id com.apple.TextEdit key cmd --modifiers cmd,shift

# Query state
opencua cursor
opencua screen
```

Sample output:

```text
Screenshot saved to shot.png
Clicked at 500,300
Typed: Hello, world
Pressed: command+shift+cmd
1200,800
2560x1600
```

### Per-PID targeting

CLI input requires `--target-pid <pid>` or `--target-bundle-id <id>`; it never implicitly targets the frontmost app. The `apps` subcommands instead take an explicit app argument. Guarded MCP requires an observed target and a current observation token. The host implementation caches the app window session and routes mouse, drag, keyboard, text, and scroll events through CoreGraphics plus SkyLight/AppKit FFI. If no target window is known, targeted input fails loudly instead of falling back to global cursor-moving input.

Example: send a URL to Safari while Terminal stays focused:

```bash
# 1. get Safari's PID
SAFARI_PID=$(pgrep -x Safari)

# 2. focus Safari's address bar, type the URL, and press Return
# each CLI call primes the visible target window before dispatch
opencua --target-pid "$SAFARI_PID" key l -m cmd
opencua --target-pid "$SAFARI_PID" type "https://example.com"
opencua --target-pid "$SAFARI_PID" key Return

# click/scroll/drag Safari content while Slack stays frontmost
opencua --target-pid "$SAFARI_PID" click -x 500 -y 300
opencua --target-pid "$SAFARI_PID" scroll --direction down --amount 5
opencua --target-pid "$SAFARI_PID" drag --from-x 100 --from-y 100 --to-x 300 --to-y 300
```

If `--target-pid` is used before a target window has been discovered, the command fails with a clear app-session error instead of falling back to the global path.

### Per-PID mouse/scroll/keyboard architecture

- **Global input** (no `--target-pid`) stays on the koffi CoreGraphics HID-tap path and remains backward compatible.
- **Targeted mouse/drag** resolves a visible app window, creates AppKit-backed `CGEvent`s when a window is known, stamps target-window fields plus SkyLight field 40, activates the window without raising it, and posts through SkyLight plus the window owner's process serial number.
- **Targeted keyboard** requires a remembered app window and uses SkyLight `SLSEventAuthenticationMessage` before `SLEventPostToPid`.
- **Targeted text** uses per-character Unicode CGEvent payloads routed through the remembered app session.
- **Targeted scroll** requires the same remembered app window and refuses to fall back to the global event tap.

### MCP server

Use the guarded stdio MCP server for autonomous desktop tasks. It works through ordinary
MCP schemas and text/image results, without a Pi-specific extension or embedded agent.
It must run on the Mac being controlled, with the macOS permissions of the process that runs
it — or of the signed helper app below, which carries its own TCC identity.

```bash
pnpm --filter @opencua/core --filter @opencua/mcp build
node packages/mcp/dist/server.js
```

Any explicitly named app is available without a manual whitelist. There is no implicit
frontmost target. The host owner can optionally restrict access through
`OPENCUA_ALLOWED_BUNDLE_IDS`, a comma-separated list of exact, case-insensitive bundle IDs.
**Unset permits named apps; explicitly empty permits none.** Agents cannot widen that restriction.
`get_capabilities` reports `approval.allowedBundleIds: null` when unrestricted and an array otherwise.
App access does not authorize every operation inside the app; observation tokens remain required for MCP input.

A Claude Desktop-style server configuration with an optional TextEdit-only restriction is below. Other clients use different root
keys; see the [OpenClaw and Hermes setup guide](../skills/opencua/references/harnesses.md).
Merge configuration rather than replacing unrelated settings.

```json
{
  "mcpServers": {
    "opencua": {
      "command": "node",
      "args": ["/absolute/path/to/opencua/packages/mcp/dist/server.js"],
      "env": {
        "OPENCUA_ALLOWED_BUNDLE_IDS": "com.apple.TextEdit"
      }
    }
  }
}
```

For a grant that survives updates, run the server through the signed helper app instead of
`node` directly: the bundle carries its own TCC identity (`dev.opencua.mcp`, or `OPENCUA_BUNDLE_ID`), so Screen
Recording and Accessibility attach to it rather than to whatever launched the server. Setup builds it, and
`opencua config --register` sets it up in every [agent client](#agent-clients) (`--register json` prints the block
for any other client). By hand:

```bash
scripts/build-tcc-helper.sh
grok mcp add opencua -s user \
  -e OPENCUA_ALLOWED_BUNDLE_IDS=com.apple.TextEdit \
  -e OPENCUA_DELIVERY=background \
  -- /absolute/path/to/opencua/packages/mcp/dist/opencua-mcp.app/Contents/MacOS/opencua-mcp \
  /absolute/path/to/opencua/packages/mcp/dist/server.js
```

Grant the helper its permissions with `opencua permissions grant` (or when the server first asks, macOS names it
"opencua-mcp"), then restart the server. The helper bundles a self-contained `node` built for this Mac's CPU
(Homebrew's build links `libnode.dylib` and cannot be copied into a bundle), resolved in this order: `OPENCUA_NODE`,
then the first standalone node on `PATH`, then `~/.local/bin/node`, `/usr/local/bin/node` and `~/.opencua/node` —
and the build fails loudly when none of them fits. `setup.sh` passes `OPENCUA_NODE` itself and downloads the
official Node.js LTS when no self-contained node exists. Ad-hoc signing gives each rebuild a new code identity, so
macOS asks for the two grants again after a rebuild; setup therefore rebuilds the helper only when its launcher or
Info.plist changed (each build records their digest in `Contents/Resources/helper-inputs.sha256`), and
`OPENCUA_SIGN_IDENTITY` set to a stable certificate keeps one identity across builds.

Beyond observe-and-act tools, the server offers `run_script` (one JavaScript body that loops, branches and
reads while every action stays token-guarded and verified), `get_capabilities` (permissions, locked or remote
session, delivery mode, approved apps, stop state and advice in one read-only call), and its operating guide
as MCP resources (`skill://opencua/SKILL.md` and `skill://opencua/references/*.md`).

Actions combine the way a person's hands do. `modifiers` holds Command, Shift, Option or Control through a
background click or drag (Cmd-click to add to a selection, Shift-click to extend it). `pace: "fast"` (or
`app.chain([...])` in `run_script`) sends a person-paced sequence back to back with one verified read at the
end: on Calculator a click costs about 33 ms in a chain against 103-121 ms one by one. A step's `find` block
scrolls a list while it looks for the target, by accessibility or on-screen text, and clicks it the moment it
shows: "scroll, click test1, Cmd-click test2" in a 152-row background Finder list took 2 calls and 3.3 s
instead of 7 calls and 7.4 s.

Pick how much the agent loads with `OPENCUA_TOOLSET`. `full` (the default) registers every desktop tool;
`lean` registers ten — `get_capabilities`, `list_apps`, `list_windows`, `open_app`, `get_app_state`,
`find_elements`, `verify_state`, `run_script`, `ask_user` and `analyze_screen` — and does everything else
through `run_script`.
The iPhone tools are opt-in with `OPENCUA_IPHONE=1` under either profile.
`run_steps` and `run_parallel` publish one flat step schema and still validate every step
against the strict per-type schema before anything is dispatched.

**Context-first contract (MCP migration):**

1. The harness understands the user's goal, target and intended result before choosing input.
2. `get_app_state` returns the target's current state and an opaque `observation_token`.
3. Every mutating tool, including `press_keys`, requires that token. The server consumes it,
   validates the observed target/current approval and serializes preflight, input and post-read.
4. Read the resulting state before using any continuation token. A mutation answers with a
   compact post-action observation (what changed plus a fresh one-use `observation_token`)
   and omits the full accessibility tree unless the call passes `full_state: true`, so long
   autonomous runs stop paying for a complete tree after every click.
5. Unchanged, unavailable, failed or unexpected context pauses input; explicitly observe
   again rather than replaying. `set_fields` exists for multi-field edits: it applies up to
   10 verified value updates in one call, reading each back from the app, and reports
   `requested`/`inputDispatched`/`verified` so dispatched input is never read as success.
6. Every mutation closes its own loop with a small envelope, so the caller never has to guess
   what happened: `route` (`accessibility` or `synthetic_events`) and `delivery`
   (`background`/`foreground`) say how the input actually travelled, `effect` says how far the
   driver can account for the result (`confirmed` from a value read back, `partial` when some
   updates verified, `observed_change` when the observed window changed after the action,
   `suspected_noop` when nothing changed, `unverifiable` when input went out with no evidence
   either way), and `evidence` lists what that judgment rests on (`value_readback`,
   `ax_change`, `window_change`). An `escalation` field points at the next honest step
   (`pixel`, `foreground`, `page`, `session`) with its reason instead of silently retrying.
   `windowEvents` names any window that appeared during the action, so a modal sheet or a
   newly opened window is never missed.
7. `verify_state` is the read-only way to check a result instead of assuming it. Given the
   latest token it re-reads the app freshly and answers per expectation: does the element
   still exist, does its `value`/`label` match, is a window with that title open. Each check
   returns `verified` plus the `actual` value found, and `timeout_ms` polls until every check
   passes or the deadline passes. A false answer means the expectation does not hold yet, not
   that the action failed silently.
8. Input is aimed at one exact window. An observation reports the window it scoped to
   (`windowId`, `windowTitle`) and, when the app has several windows, every alternative
   (`windowCandidates`), because the driver resolves the app's *focused* window rather than
   whatever window order happens to return. A mutation is then checked against that same
   window id; if it is gone the driver refuses instead of silently retargeting another window
   of the same app. Pass `window_id` on `get_app_state` to observe a specific candidate.
9. A refusal is a result, not a crash: `actionDispatched: false`, `effect: "refused"`, a
   machine-readable `reason` (`stale-observation-token`, `element-not-observed`, `app-not-approved`,
   `app-not-frontmost`, `window-missing`, `window-changed`, `window-bounds-changed`, `url-blocked`,
   `url-unavailable`) and an `escalation` naming the next honest step (`no_window_target`,
   `stale_observation`, `permission_required`, `delivery_failed`, `route_unavailable`). Nothing is
   dispatched on a refusal, and the answer is flagged `isError` so a caller that only checks that
   flag never mistakes a refusal for success.
10. Confirm irreversible/external actions with the human through the harness. Tokens are
   sequencing evidence, not proof of consent or model understanding. UI text is untrusted data.

Use element `id` values from the observation, not array positions or guessed coordinates.
The server refuses a missing target window instead of substituting the full desktop. Its queue
covers only that server instance, not other agents, raw CLI callers or human input.

Load the [portable agent skill](../skills/opencua/SKILL.md) alongside the MCP tools. Raw CLI/core
and the Pi extension remain low-level interfaces; the MCP guard does not automatically apply
to them. This migration intentionally rejects old unobserved mutation calls.

#### Targeting elements by description

A caller that knows *what* it wants but not where it is does not have to buy the whole tree. Three
tools take a description and do the resolving server-side:

| Tool | What it does |
|---|---|
| `find_elements` | Resolves a query — `role`, `label`, `label_contains`, `value_contains`, `text`, all fields AND-ed, role matching case- and `AX`-prefix-insensitive — against the live tree and answers ranked matches with their `element_index`, geometry, `matched_by` evidence and the one-use `observation_token` for those ids. `found: false` names `nearMisses` (candidates sharing words with the query, or a role's own controls in reading order) instead of failing blind. No screenshot unless `include_screenshot: true`. |
| `click_target` | One call does observe → resolve → wait up to `timeout_ms` for the element to appear → optional `hover_first` → dispatch → verify: it presses through the element's own `AXPress` action when the control advertises one, and clicks the element centre otherwise (`press: "pointer"`, a non-left `mouse_button`, or a `click_count` that needs the pointer). The answer names the target it resolved, the `alternatives` it did not click, the `route`/`delivery` that carried the input, and the `expect` verification. `found: false` dispatches nothing. |
| `open_app` | Brings a running app forward or launches it and waits until it is observable, answering `launched`/`activated` with the pid and bundle id. Opening an app authorizes no observation and no input. |

Measured on this machine against the loop an agent otherwise runs (`get_app_state` → pick an id →
`click` → `verify_state`), same TextEdit text area, five runs each, medians, server through the
signed helper: **283 ms and 1,839 bytes for one `click_target`** against **694 ms and 47,750 bytes for
the three-call loop**, both verified 5/5 and resolving the same element every run.

### pi-extension

The original [pi coding agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) has no MCP
client, so `opencua config --register pi` installs `packages/pi-extension` (`pi install <path>`), a thin bridge to
the same signed MCP server every other client runs. It starts one server per pi session, resolved from
`OPENCUA_MCP_COMMAND`/`OPENCUA_MCP_ARGS`, then the bundle's `.mcp.json`, then this checkout's helper; registers
one pi tool per MCP tool with the server's own schema; and adds the server's instructions to the system prompt. Every
call goes through the server's guards (observation tokens, app approval, the stop switch), exactly as over MCP.

For Anthropic Messages and OpenAI Responses models it also offers the native `computer` tool, mapped onto MCP calls
against the window of the latest `get_app_state` (screenshot, clicks, drags, typing and key presses). Native actions
with no faithful MCP equivalent (`scroll`, `mouse_move`, `cursor_position`, raw mouse down/up, OpenAI `back`/`forward`,
multi-point drags) fail with an `unsupported_action` error rather than being approximated. Opt out of the native tool
with `OPENCUA_DISABLE_COMPUTER_USE_BETA=1`. Details: [packages/pi-extension/README.md](../packages/pi-extension/README.md).

### Programmatic API

Import `MacOSHostComputer` from `@opencua/core` and drive macOS directly:

```typescript
import { MacOSHostComputer } from "@opencua/core";

const computer = new MacOSHostComputer();

const { data, width, height } = await computer.screenshot();
await computer.click({ x: 500, y: 300 });
await computer.type("Hello from TypeScript");
await computer.key("Return", { modifiers: ["command"] });
await computer.scroll({ direction: "down", amount: 10 });
await computer.drag({ from: { x: 100, y: 200 }, to: { x: 300, y: 400 } });

const pos = await computer.getCursorPosition();
const size = await computer.getScreenSize();

await computer.close();
```

All methods return Promises. The API is intentionally identical to the OpenAI `Computer` abstraction so you can drop it into an agent loop without translation.

## The phone: a real iPhone through iPhone Mirroring

OpenCUA also drives a real iPhone, through the macOS iPhone Mirroring window. No jailbreak, no
Xcode, nothing installed on the phone.

- **Eyes**: Apple's Vision framework reads the window capture, so every visible string comes back
  with a tap-ready centre in global screen points. The phone image is a video stream, which is
  exactly why accessibility cannot see into it and OCR has to.
- **Hands**: synthesized mouse and keyboard events delivered to the mirroring window's own
  process, so the phone is driven **without bringing its window forward and without touching the
  pointer**. The one exception is a scroll: macOS sends wheel events to the window under the real pointer, so
  a scroll would have to borrow it. Under background delivery `ios_scroll` therefore refuses unless the agent
  passes `borrow_pointer: true` (the pointer then moves for the gesture and is put straight back); `ios_swipe`
  never touches it.
- **Session gating**: every action re-checks the session and refuses unless it is `ready`.
  `blocked` (Unlock iPhone, iPhone in Use, connection paused or ended, Mac login), `no-window`
  and `not-running` all come back with what the user has to do about it. Nothing taps through an
  interstitial, and nothing types a password for you.

\u0060\u0060\u0060bash
opencua ios status          # ready | blocked | no-window | not-running
opencua ios observe         # every visible string with a tap-ready centre
opencua ios tap-text "Settings"
opencua ios type "hello"    # exact: the paste path, past iOS autocorrect
opencua ios scroll down --amount 0.4
opencua ios home
\u0060\u0060\u0060

Two rules worth knowing before writing a loop:

- `scroll(direction)` says what you want to **see** ("scroll down" reveals content further down
  the list); `swipe(direction)` says which way the **finger** moves. macOS 26 drops vertical
  touch-drags, so lists move with `scroll`, and `swipe` is for page turns and carousels.
- One action, then one cheap check: `ios observe` returns every label with coordinates, and a
  bounded re-observe beats a fixed sleep.

Setup: pair iPhone Mirroring once by hand, grant the terminal **Accessibility** and **Screen
Recording** (Screen Recording takes effect after the terminal restarts), and keep the phone
unlocked while work runs. The MCP side exposes the same capability as token-guarded `ios_*`
tools. Details:
[`skills/opencua/references/ios-automation.md`](../skills/opencua/references/ios-automation.md).

## Observation cost

Observation is the loop's dominant cost, so the driver keeps the cheap paths cheap. Measured
on an M-series Mac against a Finder window with about 800 accessibility elements, warm runs,
reporting medians:

| Step | Before | Now |
|---|---|---|
| `get_app_state` with screenshot | 4,815 ms | about 1,350 ms |
| Accessibility walk, window-scoped | 3,552 ms | 840 ms |
| Accessibility walk capped at 250 elements | - | 92 ms |
| Running-app lookup | 1,162 ms (`osascript`) | under 1 ms (in-process NSWorkspace) |
| Window screenshot | 198 ms (`screencapture -l`) | 28 ms (native ScreenCaptureKit) |

The walk now runs in one round trip per element (attributes are read together), reads the
parent window instead of the whole app when the target window is known, skips action reads
for non-actionable roles, and enumerates running apps in-process rather than by spawning
AppleScript. Waiting for a settled UI is event-driven: an `AXObserver` on the app element
replaces repeated 250-element poll walks, which cut a Finder observation from a 812 ms
median to 537 ms over five warm runs on the same window. Capture honours the requested
format on every path: JPEG is 4.6x smaller than PNG for a full 1920x1080 display (293 KB
against 1,363 KB) and 5.2x smaller for a 600x400 region (118 KB against 612 KB) at quality
72. Main-display capture falls back to CoreGraphics when the ScreenCaptureKit path is
unavailable; window capture falls back to `screencapture -l` plus `sips` when the native
library or the window itself is not capturable.

## Working while the agent works

The MCP server runs in background delivery by default (set `OPENCUA_DELIVERY=attended` to opt
out); the CLI takes `--background`. Background delivery keeps a run out of your way: input goes
to the target app's own window, so the frontmost app does not change and the cursor does not
move, and `open_app` launches apps with `open -g` so they do not come forward either. Background delivery also drops the frontmost requirement on input: the
driver clicks, types and scrolls a window you are not looking at, while the target app must still
be approved and its window identity and bounds must still match the observation. Anything that
would need the foreground — a global click with no target app, or a route that has to lease focus —
is refused with the action named instead of quietly taking over the machine. Attended delivery
still requires the frontmost app, because a few apps only accept pointer input while they are
frontmost.

To stop it, hold Control+Option+Command together (or run `opencua stop`): every OpenCUA server on the
Mac refuses further input with `user-stopped`, a running `run_steps` or `run_script` batch stops before
its next step, and reads keep working so the agent can tell you what it was doing. Only you resume, with
`opencua resume` (`opencua stop-status` shows the state). The switch is a file
(`~/.opencua/stop.json`, or `$OPENCUA_STATE_DIR`), so one press stops every agent at once. The chord is
read from the keyboard's hardware state and needs no extra permission. The direct CLI input commands (`click`,
`type`, `key`, `drag`, `scroll`, the `apps` writes and the `ios` input commands) refuse too, with exit code 1.

A background click, double click or drag lands because the app behind yours is first told it is active for the
target window (the front app does not change and nothing is raised), which also enables window commands such as
Save and New Folder there. The first click after that is spent on the activation, so a primer click goes to the
target window at a point inside no display and no window; when the display and window layout cannot be read the
primer is skipped, the server logs that on stderr, and the click may be spent instead. The app is told otherwise
2 s after the last background action, or when the server exits. That release is the deactivation AppKit gets
whenever you switch away from an app, and apps whose documents autosave in place (TextEdit, Preview, Pages) answer
it the same way: every document of the app with unsaved changes is written to its file (TextEdit, measured: within
about 120 ms of the release). AppKit does this on every deactivation, so documents you edited in the app yourself
were already autosaved when you last left it; what the release writes is an edit made in the background and left
unsaved, for example by the agent. No release avoids it. Set `OPENCUA_BACKGROUND_ACTIVATION=off` to never tell a
background app it is active: OpenCUA then autosaves nothing, but a first-mouse app such as Finder may spend a
background click on activating its window, and window commands that need the app active are refused with nothing
sent.

Some apps bring themselves forward when background input reaches them. A watcher on its own thread checks
every 10 ms and hands the front back to your app, stopping if you switch apps yourself. Restoration does not
prevent a transient focus change. Finder Go to Folder is therefore refused before dispatch when Finder is
behind your front app, for both its shortcut and menu path. The earlier restoration measurements
(440-675 ms before and 0-14 ms after, four trials sampled every 2 ms) describe the old route, not a guarantee
that background input never takes focus.

In attended delivery, OpenCUA draws its own agent cursor: a click-through arrow pointer modelled on Cua
Driver's default theme (blue fill, white outline, soft glow, tip exactly on the target) at a compact
24-point theme size on a
floating overlay that glides to every action — pointer clicks, accessibility presses, value
writes, text selection, typing and scrolls — ripples on each press, and pulses while the agent
reads an observation. Keyboard input shows a keyboard glyph beside the pointer, including
keyboard-only actions; the menu bar indicator also names the keyboard mode.
It is drawn, not your real cursor. Background delivery stays visually silent,
without cursor artwork or highlights. Set `OPENCUA_CURSOR=off` to hide the attended cursor. Verified on a live session against Cua Driver 0.28.2: a background
click landed with the frontmost app and the real cursor untouched, and the action answer cost
1.4 KB instead of 121 KB because the post-action image is now opt-in (`include_screenshot: true`).

#### Cursor motion

By default the cursor uses its original native glide. Opt in to the planner from
[Cua Cursor Motion](https://github.com/trycua/cua/tree/a7524cfd1d3e959963b43954d43f27c4bd260f08/libs/typescript/cursor-motion)
to change the path and timing of each glide:

```bash
opencua config --cursor-motion spring_settle         # a style name, saved and applied to every registration
opencua config --cursor-motion '{"style":"signature_arc","timing":"fitts","arcSize":0.4,"arcFlow":-0.5}'
opencua config --cursor-motion-timing fixed --cursor-motion-duration 600   # adjust the saved motion
opencua config --cursor-motion off                   # back to the native glide
export OPENCUA_CURSOR_MOTION=comet_swoop              # override for subsequently launched CLI/server processes
```

- **Styles:** `signature_arc`, `spring_settle`, `magnetic`, `comet_swoop`, `adaptive`, `classic`.
- **Timing:** `native` (the chosen Cua style's timing), `fitts` or `fixed`.
- **Fields** (JSON object; only `style` is required, unknown fields and non-finite numbers are rejected): `glideDurationMs`
  0 to 5000, `startHandle` and `endHandle` 0 to 1, `arcSize` 0 to 1, `arcFlow` -1 to 1, `spring` 0.3 to 1,
  `turnRadius` 1 to 1000.
- **Precedence:** a set `OPENCUA_CURSOR_MOTION` (including `off` or an empty value to disable motion) wins; otherwise the low-level CLI uses the saved
  setting. Registered MCP servers receive the saved setting as `OPENCUA_CURSOR_MOTION`. Invalid values are rejected
  before anything is written. `opencua config --show` prints the saved motion. Restart running MCP clients after
  changing their registration environment.
- **Reduced motion** (the macOS accessibility setting) uses the upstream reduced-motion planner instead of an arc.

The upstream planner (MIT, version 0.1.0, pinned to commit `a7524cf`) is vendored in `packages/core/vendor`. OpenCUA
uses it for paths and timing only: it keeps its own native pointer artwork and click, scroll and thinking cues
and does not import the upstream canvas themes or effect rendering.

#### Menu bar indicator

While the cursor overlay is active, a single `opencua` item appears in the menu bar. Its menu shows `opencua running`,
the current mode (`pointer`, `scroll`, `thinking` or `keyboard`) and the last cursor motion style (`default` for the original glide). It means
the overlay is active, not merely that motion is configured.

- All CLI commands and MCP servers share one overlay daemon, so there is one item no matter how many clients are driving.
- The item appears when the cursor is positioned or a target window is highlighted. Mode changes update an existing
  item; they do not create one before the first visible activity. The item is removed when the
  cursor is hidden, when the daemon quits, or after 15 seconds without commands, when the daemon exits on its own.
- The daemon can outlive a short CLI command, so the item may stay for up to 15 seconds after it finishes; the next
  action reuses it.
- Opting out of the agent cursor (`OPENCUA_CURSOR=off`, or the CLI's `--no-cursor`) prevents that caller from starting
  or updating the overlay. Other active clients can still keep the shared item visible.

Observation is aimed at the app's focused window, resolved natively, so a multi-window app is
not scoped by whatever order window enumeration returns; the chosen window id, its title and
any alternatives travel back on the state, and input is validated against that same id.

The knobs that keep this tunable, all per call: `include_screenshot: false` skips the image
and returns only element ids and geometry, which is the cheapest way to re-index before an
element action; `include_accessibility_tree: false` is the mirror image — skip the accessibility
walk and its settle wait and get the window image with no elements and no observation token, the
cheapest way to look at pixels; `settle_ms` caps the pre-capture UI settle wait (0 skips it);
`max_elements` caps a very large tree, `subtree_of` re-observes just one branch with element ids
restarting at 0, and `include_menu_bar` adds application menus when they are part of the task.
When a tree is capped the answer says so in `elementsTruncated`, and a walk at a different budget
is treated as a fresh baseline rather than diffed against a differently truncated one, so a diff
never reports elements that were merely outside the budget as removed. `list_windows` names
targetable top-level windows (including other Spaces in background delivery) with their id, pid,
app, title and bounds so an agent can pick its target
before observing instead of guessing. Drilling in with `subtree_of` costs what the branch costs:
on a Finder window whose full tree is 718 elements, re-observing a row returned 10 elements in
165 ms instead of roughly 810 ms for the window.

#### Background windows in other Spaces

In background delivery, `list_windows` can enumerate windows outside the current Mission Control
Space. Observe the intended `window_id` explicitly; observations and subsequent input stay bound
to that window rather than selecting another document at the same screen position. Capture uses
the window's own pixels, so another Space does not need to become visible.

Off-Space input uses direct process/window routes. It does not raise a window or select a Window
menu entry to make it key. Keyboard input requires the observed window to already be the app's
focused window; minimized windows, an unknown minimized state, or a closed target are refused
rather than restored or silently replaced. Attended delivery keeps its current-Space restriction.
Some applications do not accept background events; verify the resulting state instead of treating
dispatch as success. Mission Control's own overview is not an application window to drive.

#### Visual element analysis

`analyze_screen({app, window_id?})` observes an approved application window and asks the connected
MCP client's vision model to inspect its complete image from top to bottom. It includes icon-only
controls and static text rather than treating OCR text boxes or the main window frame as the
whole interface. The client must support image sampling; no separate model endpoint or API key
is required by the server.

The result preserves the screenshot and original observation token alongside visual regions in
screenshot pixel coordinates, inferred interactions, confidence, coverage, and truncation.
Visual regions are not accessibility IDs or proof that a control is enabled or actionable.
Prefer observed accessibility IDs where available; otherwise inspect the visual region and use
the existing guarded coordinate action, then verify its effect. The analysis covers the approved
window, not unrelated applications sharing the display. Observe other windows individually.
When sampling or capture is unavailable, the tool reports why instead of inventing detections;
use an ordinary screenshot observation for direct inspection by the agent.

## Action surface

Every tool/action exposed by CLI, MCP, and pi-extension:

| Action | Parameters | Returns | What it does |
|---|---|---|---|
| `screenshot` | `targetSize?: { width, height }`, `region?: { x, y, width, height }`, `display?: number`, `format?: "png" \| "jpeg"`, `quality?: number` | `Buffer` + dimensions + mime type | Native ScreenCaptureKit display capture, cropped in CoreGraphics when `region` is given and resized to `targetSize`. Regions, display selection and the main display all honour `format` |
| `click` | `x: number`, `y: number` | void | Single click via CoreGraphics `CGEventCreateMouseEvent` / `CGEventPost` |
| `double_click` | `x: number`, `y: number` | void | Double click via CoreGraphics `CGEventCreateMouseEvent` / `CGEventPost` |
| `type` | `text: string` | void | Type literal text via CoreGraphics `CGEventCreateKeyboardEvent` |
| `key` | `key: string`, `modifiers?: string[]` | void | Key press with optional cmd/alt/ctrl/shift modifiers via CoreGraphics |
| `scroll` | `direction: "up" \| "down" \| "left" \| "right"`, `amount: number` | void | Scroll wheel event via CoreGraphics `CGEventCreateScrollWheelEvent` |
| `drag` | `fromX, fromY, toX, toY` | void | Mouse down, move, up via CoreGraphics `CGEventCreateMouseEvent` |
| `cursor_position` | none | `{ x, y }` | Current mouse coordinates via `CGEventGetLocation` |
| `screen_size` | none | `{ width, height }` | Logical desktop bounds via Finder, with `system_profiler` fallback |

## Permissions

OpenCUA supports **macOS 15 (Sequoia) and macOS 26 (Tahoe)**, the latest release and the one before it, **on Apple
Silicon and Intel Macs**; setup and the doctor refuse anything older. The native binaries are universal (arm64 +
x86_64) and target macOS 15.0, enforced at build time, and CI builds and tests all four combinations. When the capture
library cannot load (for example a binary without this Mac's slice), screenshots fall back to CoreGraphics and
`screencapture`.

macOS keys screen capture and input synthesis to the identity of the process that asks:

1. **The MCP server through the signed helper** (what setup builds and `opencua config --register` configures): grant
   **Screen Recording** and **Accessibility** to **opencua-mcp** in System Settings → Privacy & Security. One grant
   serves every MCP client and survives setup and `opencua update`; only a helper rebuild without the stable signing
   identity in `.signing` asks again.
2. **The CLI, or `node packages/mcp/dist/server.js` run directly**: grant both to the terminal or IDE that launches
   it. Permission is per binary: switching from iTerm2 to Ghostty means granting again.
3. **Apple Events / Automation**: the helper asks once per app it controls (System Events, Finder, approved browsers);
   `opencua permissions grant` asks up front so the dialog never interrupts an agent's task. For the CLI, allow the
   terminal if you use `--target-bundle-id` or permission helpers that query System Events.

Restart the client or terminal after a grant (some apps cache the permission state at launch).
`opencua doctor` reports what is missing without raising a prompt, and `opencua permissions grant` walks through
granting it.

Full walkthrough: [`skills/opencua/references/installation.md`](../skills/opencua/references/installation.md).

## Architecture

```text
+----------------------------------------------------------+
|  Agent / CLI / MCP client / pi session                   |
|  +----------------------------------------------------+  |
|  |  @opencua/core                                   |  |
|  |   ComputerInterface (abstract)                     |  |
|  |   +-- HostComputer  (macOS implemented)            |  |
|  |   +-- VMComputer    (stub: QEMU/Lume/VirtualBox)     |  |
|  |   +-- CloudComputer (stub: cloud provider)         |  |
|  +----------------------------------------------------+  |
|                    |                                     |
|  +-----------------+------------------+                 |
|  |                 |                  |                  |
|  v                 v                  v                  |
|  CLI            MCP server       pi-extension            |
|  commander.js   @modelcontext    registerTool factory    |
|                 protocol/sdk       default export          |
|  +----------------+------------------+                 |
|                    |                                     |
|  v                 v                  v                  |
|  SCK (capture)    koffi/CGEvent    SkyLight/AppKit FFI   |
|  (screenshots)    (global input)   (targeted sessions)   |
+----------------------------------------------------------+
```

| Package | Path | Role |
|---|---|---|
| `@opencua/core` | [`packages/core`](../packages/core) | `ComputerInterface` + platform abstractions (`HostComputer`, `VMComputer`, `CloudComputer`) + `MacOSHostComputer` implementation |
| `@opencua/cli` | [`packages/cli`](../packages/cli) | `commander.js` binary (`opencua`) |
| `@opencua/mcp` | [`packages/mcp`](../packages/mcp) | MCP stdio server (`opencua-mcp`) exposing Codex Computer Use tools |
| `@opencua/pi-extension` | [`packages/pi-extension`](../packages/pi-extension) | Pi coding-agent bridge to the MCP server, with native Anthropic/OpenAI computer-use shapes |
| `skills/opencua` | [`skills/opencua`](../skills/opencua) | OpenCode-style skill definition + installation reference |

## Repository layout

| Path | What lives there |
|---|---|
| [`packages/core`](../packages/core) | Platform-abstracted interfaces, the native macOS computer, the guarded token layer, and targeting (`matchElements`, `openApplication`) |
| [`packages/mcp`](../packages/mcp) | The stdio MCP server (33 tools) and `assets/appicon.png` for the signed helper bundle |
| [`packages/cli`](../packages/cli) | The `opencua` command line |
| [`packages/pi-extension`](../packages/pi-extension) | Pi coding-agent bridge to the MCP server, including native Anthropic/OpenAI computer-use shapes |
| [`skills/opencua`](../skills/opencua) | The portable agent skill: workflow, usage, permissions, harness setup |
| [`docs`](../docs) | Design notes: what OpenCUA took from Codex computer use, Cua Driver and OmO ([unified-cua.md](./internal/unified-cua.md)) |
| [`scripts`](../scripts) | `setup.sh` (sets up a checkout; [`install.sh`](../install.sh) at the root clones one and runs it), the signed helper build, the task benchmark ([`bench-v2`](../scripts/bench-v2/README.md)), and fixture generators |

## Roadmap

| Feature | Status | Notes |
|---|---|---|
| macOS host-native screenshot | Implemented | Native ScreenCaptureKit window and main-display capture, resized to the requested size |
| macOS host-native input | Implemented | Native CoreGraphics CGEvent via koffi for global input; SkyLight/AppKit FFI for targeted app windows |
| QEMU runtime | Interface stub | [`packages/core/src/platform/vm.ts`](../packages/core/src/platform/vm.ts) |
| Lume runtime | Interface stub | Apple Virtualization.Framework VM |
| VirtualBox / Parallels runtime | Interface stub | Planned |
| Cloud provider runtime | Interface stub | [`packages/core/src/platform/cloud.ts`](../packages/core/src/platform/cloud.ts) |
| ScreenCaptureKit capture | Implemented | Window and main-display capture through `libsckit.dylib`, with CoreGraphics and `screencapture -l` fallbacks |
| SkyLight authenticated targeted input | Implemented | TypeScript FFI uses `SLEventPostToPid`, focus-without-raise, AppKit-backed mouse events, and keyboard auth messages |
| Accessibility API queries | Implemented | `AXUIElement` tree extraction, `set_value`, and secondary actions |

## Development

```bash
# Install, build and check everything (safe to re-run)
./scripts/setup.sh

# Install dependencies
pnpm install

# Type check + lint + test
pnpm check

# Test only
pnpm test

# Build all packages
pnpm build

# Build the signed helper bundle (macOS app icon + TCC identity)
./scripts/build-tcc-helper.sh

# Rebuild the universal native binaries (records their input hashes in native/build-inputs.sha256)
pnpm --filter @opencua/core build:native

# Is this Mac ready? (exit 0 when it is)
pnpm doctor
```

Edit without reinstalling: `opencua dev link` points every registered MCP client at a developer checkout's server,
still launched through the installed, already-permitted helper. With `pnpm dev` (a watch build of core, browser, agent,
mcp and cli) running there, the helper's supervisor restarts the server behind the same connection after each rebuild,
so a saved edit reaches the agent without setup, `opencua update`, a helper rebuild or a reconnect. Linking changes
the registration once, so reconnect each client once after `link` and after `unlink`.

```bash
opencua dev link .     # once, from the developer checkout (needs pnpm install and one build there)
pnpm dev               # keep running while you edit
opencua dev status     # which checkout's server the clients run
opencua dev unlink     # back to the installed checkout
```

Native sources (`packages/core/native/*.m`) still need `pnpm --filter @opencua/core build:native`. A helper rebuild
keeps its permission grants as long as it is signed with the stable identity in `.signing`; when that keychain no
longer unlocks, the build stops before touching the working helper and names the repair:
`./scripts/create-signing-identity.sh --repair`, which rebuilds the keychain from the certificate and key kept beside
it, so the identity does not change.

Per-package builds:

```bash
pnpm --filter @opencua/core build
pnpm --filter @opencua/cli build
pnpm --filter @opencua/mcp build
pnpm --filter @opencua/pi-extension build
```

Standards: ultra-strict TypeScript, ESM with `.js` imports, Biome formatting, Vitest, tabs, line width 120. See [`AGENTS.md`](../AGENTS.md) for the full convention.

CI runs setup and `pnpm check` (lint, package and test typechecks, then the full Vitest suite) on macOS 26 and macOS 15,
each on Apple Silicon and on Intel runners, then checks that the native binaries are universal and target macOS 15, that
the helper is built for the runner's CPU, and that the doctor passes everything but the permission grants — see
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml).

## Comparison vs cua / codex

| Dimension | cua | codex | Peekaboo | OpenCUA |
|---|---|---|---|---|
| Language | Rust [1] | Rust CLI (Apache-2.0) [7]; Computer Use ships as a plugin [6] | Swift [4] | TypeScript |
| Sandbox | Cua Driver on the host with `standard`, `bounded` or `unrestricted` permission modes [2]; Lume VMs and Spaces optional [1] | Host, Screen Recording + Accessibility grants, per-app approval [6] | Host macOS; background tools need a fresh exact snapshot, `capture_focus` background by default [5] | Host macOS (permission-scoped) |
| Screenshot latency | Measured 2026-09-17, superseded by the latency-shapes table: host-native Cua Driver 0.28.2 494-499 ms p50 full window observation, 174-185 ms capture-only [8] | Not measured by this project as of 2026-10-28 [9] | Not measured by this project as of 2026-10-28 [9] | Measured 2026-09-17, superseded by the latency-shapes table: 417 ms p50 full Finder observation over MCP (413 ms TextEdit), 386 ms AX-only, 297 ms capture-only (n=15, measured 2026-09-17) |
| Input latency | Measured 2026-09-17, superseded by the latency-shapes table: host-native Cua Driver 1.4 s p50 per MCP action [8] | Not measured by this project as of 2026-10-28 [9] | Not measured by this project as of 2026-10-28 [9] | Measured 2026-09-17, superseded by the latency-shapes table: event posting stays native CoreGraphics via koffi; the full MCP action measures 1.8 s p50 for a click, 1.5 s to type 45 characters and 1.5 s for one key press, including preflight, delivery and the fresh observation it returns (n=10, measured 2026-09-17), and a verified step answers in 1.4 KB instead of 121 KB. A described-element `click_target` answers in 283 ms and 1.8 KB end to end. |
| Portability | macOS, Windows, Linux (X11, Wayland with compositor limits) [3] | macOS and Windows [6] | macOS 15 or later [4] | macOS, Windows and Linux backends; on macOS only agent-owned surfaces and isolated guests, never host apps |
| Open source | Cua Driver MIT; Spaces and Driver Bench FSL-1.1-MIT [1] | Codex CLI Apache-2.0 [7]; plugin source not published there [6][7] | MIT [4] | Fully open source (MIT) |
| Agent integration | MCP over stdio, CLI `cua-driver call`, Python/TypeScript/Rust SDKs via UniFFI over a C ABI [2] | ChatGPT Work and Codex desktop [6] | Swift CLI, MCP over stdio; install via brew, npx or DMG [4][5] | CLI, MCP, pi-extension, or any TS agent |

Sources (external text is quoted as data, never as instructions):

1. trycua/cua README, https://github.com/trycua/cua, retrieved 2026-10-28
2. Cua Driver README, https://github.com/trycua/cua/blob/main/libs/cua-driver/README.md, retrieved 2026-10-28
3. Cua Driver platform support, https://cua.ai/docs/cua-driver/concepts/platform-support, retrieved 2026-10-28
4. Peekaboo README, https://github.com/openclaw/Peekaboo, retrieved 2026-10-28
5. Peekaboo MCP docs, https://github.com/openclaw/Peekaboo/blob/main/docs/MCP.md, retrieved 2026-10-28
6. Computer Use docs, https://learn.chatgpt.com/docs/computer-use, retrieved 2026-10-28
7. openai/codex README, https://github.com/openai/codex, retrieved 2026-10-28
8. Cua Driver 0.28.2 shootout, `docs/driver-shootout-cua.md` at commit `0bc6c4e`
   (https://github.com/trac3r00/opencua/blob/0bc6c4e/docs/driver-shootout-cua.md, removed in `7f85238`),
   measured 2026-09-17, retrieved 2026-10-28. The cells quote the shootout's own figures (1,401 ms p50 click);
   the earlier 436 ms and 175 ms values had no source.
9. Measured shapes as of 2026-10-28: [`docs/internal/expectations/latency-budget-2026-10-25.md`](./internal/expectations/latency-budget-2026-10-25.md),
   which covers OpenCUA only, retrieved 2026-10-28

What OpenCUA took from Codex computer use, Cua Driver and OmO's `computer` tool (`run_script`, the stop
switch, `get_capabilities`, skill resources), with a measured three-way Calculator run:
[`docs/internal/unified-cua.md`](./internal/unified-cua.md).

## License

MIT — see [LICENSE](../LICENSE).

## Related

- [trycua/cua](https://github.com/trycua/cua) — upstream portable computer-use SDK (Python, VM-based)
- [OpenAI Codex](https://github.com/openai/codex) — Codex desktop app with proprietary Computer Use plugin
- [pi-mono](https://github.com/badlogic/pi-mono) — the pi coding-agent runtime
- [pi-cua-integration](https://github.com/code-yeongyu/pi-cua-integration) — pi extension that wraps cua sandboxes (the model for this README)
