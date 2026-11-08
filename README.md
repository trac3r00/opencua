<p align="center">
  <img src="./docs/assets/banner.svg" alt="opencua: native macOS computer use for AI agents" width="100%" />
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-3b82f6.svg" alt="License: MIT" /></a>
  <a href="#requirements"><img src="https://img.shields.io/badge/macOS-15%20Sequoia%20%7C%2026%20Tahoe-111827.svg?logo=apple" alt="macOS 15 and 26" /></a>
  <a href="#requirements"><img src="https://img.shields.io/badge/Apple%20Silicon%20%7C%20Intel-universal-6366f1.svg" alt="Apple Silicon and Intel" /></a>
  <a href="#works-with-your-agent"><img src="https://img.shields.io/badge/MCP-stdio%20server-8b5cf6.svg" alt="MCP stdio server" /></a>
</p>

<p align="center">
  <b><a href="#quickstart">Quickstart</a></b> ·
  <a href="#onboarding-in-four-steps">Onboarding</a> ·
  <a href="#see-it-work">See it work</a> ·
  <a href="#features">Features</a> ·
  <a href="#works-with-your-agent">Agent clients</a> ·
  <a href="#safety-and-control">Safety</a> ·
  <a href="docs/reference.md">Full reference</a>
</p>

<p align="center">
  <img src="./docs/assets/architecture.svg" alt="Eyes (ScreenCaptureKit, Accessibility tree, Vision text) feed Hands (CGEvent posted to the app's pid in the background), which drive a shared surface where each agent has its own labeled cursor" width="100%" />
</p>

**Many agents, one window, your Mac untouched.** Agents see apps through ScreenCaptureKit and the Accessibility
tree, and act through input aimed at the app itself (events posted to its process, or an opencua surface's own
input socket), so your cursor and front app stay where you left them.
On a surface window opencua launches, several agents and subagents work at once, each with its own named, colored
cursor; their strokes are merged so none is cut and a cursor that waited still draws its curves.

---

**OpenCUA** (formerly apple-cua) lets AI agents see and operate apps through each OS's native accessibility APIs: the
Accessibility API, ScreenCaptureKit and CoreGraphics on macOS, UI Automation on Windows, and AT-SPI on Linux. It speaks
the app-oriented computer-use vocabulary models already know (`list_apps`, `get_app_state`, `click`, `type_text`,
`press_keys`, `scroll`, `drag`).

On macOS, OpenCUA acts only on surfaces the agent owns and on isolated guests. It never uses your mouse, keyboard,
screen, clipboard or Spaces, and it refuses to capture or send input to your own apps. Agents can drive:

- **OpenCUA surfaces:** web pages opened by the MCP `surface` tool in an OpenCUA window that stays behind yours and
  is never focused. Several workers can share one, each with a named cursor and an optional region. Worker regions must not overlap.
- **An isolated macOS guest** through Tart, or **UTM guests**: see [docs/isolated-desktop.md](docs/isolated-desktop.md)
  and [docs/utm.md](docs/utm.md).
- **The background browser bridge:** see [packages/browser/README.md](packages/browser/README.md) and
  [skills/cua-browser/README.md](skills/cua-browser/README.md).

Upgrading from apple-cua: the old `apple-cua` command, `APPLE_CUA_*` variables and `~/.apple-cua` state keep
working, and setup replaces the old `apple-cua` MCP entry in each client. The helper's macOS bundle ID moved from
`dev.applecua.mcp` to `dev.opencua.mcp`, so after updating, grant "opencua-mcp" its permissions once more; setup
removes the old entries so Privacy & Security lists it only once.

## Quickstart

```bash
curl -fsSL https://raw.githubusercontent.com/trac3r00/opencua/main/install.sh | bash
```

That one line clones OpenCUA into `~/.opencua/app`, builds it, installs the `opencua` command into
`~/.local/bin`, and starts the guided setup: it asks which agent clients to connect, walks you through the macOS
permission dialogs, and finishes with a health check.

<details>
<summary><b>More install options</b></summary>

```bash
# Also put ~/.local/bin on your PATH (your shell startup file is backed up first)
curl -fsSL https://raw.githubusercontent.com/trac3r00/opencua/main/install.sh | bash -s -- --add-to-path

# Connect specific agent clients during install
curl -fsSL https://raw.githubusercontent.com/trac3r00/opencua/main/install.sh | bash -s -- --register claude,codex

# Unattended (CI, provisioning): ask nothing; the closing doctor run lists what is left
curl -fsSL https://raw.githubusercontent.com/trac3r00/opencua/main/install.sh | bash -s -- --yes

# Pin a branch, tag or commit, or install somewhere else
curl -fsSL https://raw.githubusercontent.com/trac3r00/opencua/main/install.sh | OPENCUA_REF=main OPENCUA_HOME=~/tools/opencua bash

# Read the script first, then run it
curl -fsSL https://raw.githubusercontent.com/trac3r00/opencua/main/install.sh -o install.sh && less install.sh && bash install.sh

# From a clone of your own
git clone https://github.com/trac3r00/opencua.git opencua && cd opencua && ./scripts/setup.sh
```

| Variable | Default | Meaning |
|---|---|---|
| `OPENCUA_HOME` | `~/.opencua` | State directory; the checkout lives in `app/` |
| `OPENCUA_REPO` | `https://github.com/trac3r00/opencua.git` | Repository to clone |
| `OPENCUA_REF` | `main` | Branch, tag or commit to install |
| `OPENCUA_BIN_DIR` | `~/.local/bin` | Where the `opencua` command goes |

The installer is safe to re-run: every step checks before it acts, and a run after a failure picks up where the
last one stopped. Node.js 20+ is used from `PATH`, or the official LTS build is downloaded into `~/.opencua/node`
and verified against nodejs.org's `SHASUMS256.txt`. Client config files are merged, never replaced, and each one is
backed up before it changes.

</details>

### Requirements

- **macOS 15 (Sequoia) or macOS 26 (Tahoe)**, on **Apple Silicon or Intel** (native binaries are universal)
- **Xcode Command Line Tools** — the installer tells you to run `xcode-select --install` if they are missing
- Node.js 20+ is optional; the installer fetches it when needed

## Onboarding in four steps

**1 · Install**

Run the [one-liner](#quickstart). Setup builds everything, including a small signed helper app,
**opencua-mcp**. macOS ties its privacy permissions to that helper, so one grant covers every agent client.

**2 · Grant permissions**

Setup opens each macOS dialog and waits for you. You can run it again later:

```bash
opencua permissions grant
```

Grant **Accessibility** (read windows, send input), **Screen Recording** (screenshots) and **Automation** (Apple
Events) to **opencua-mcp**.

**3 · Connect your agent**

```bash
opencua config --detect          # which clients are installed
opencua config --register claude # or omo, codex, gemini, cursor, ...
```

**4 · Verify**

```bash
opencua doctor        # read-only; exit 0 when ready
opencua doctor --fix  # repair what is safe, ask before the rest
```

Restart the agent client, and ask it to use an app by name.

### UTM virtual machines

Control UTM guests through native background scripting with `opencua utm list`, `opencua utm key Windows win+r`,
and `opencua utm screenshot Windows -o windows.png`. Enable MCP tools with `OPENCUA_UTM=1`.
See [UTM support](docs/utm.md) for setup, guest coordinates, and backend limits.

### Browser and iPhone

The same agent registration exposes the background browser tools once the browser bridge is
installed. One command installs it, opens the extensions page in the background, and copies the
unpacked-extension folder path:

```bash
opencua browser setup     # one human step: Developer mode -> Load unpacked
opencua browser status
```

Agent pages stay in a minimized background window; they are never raised or moved into your
Space. For the phone, enable the iPhone Mirroring tools once (the phone must be paired by hand,
and the screen unlocked while the agent works):

```bash
opencua config --iphone
opencua ios status
```

Use the `cua-browser` skill for web pages and the `opencua` skill for native apps and the
phone. Both skills explain the one-cursor-per-subagent workflow and the non-disruption rules.
For a question-driven install an AI can run end to end, see the
[AI setup guide](skills/cua-browser/README.md).

`cua-history` is an opt-in, private, local record of recent desktop activity for answering "what
was I just doing?". `opencua history start` installs an always-on native menu-bar watcher (a
launchd login item) that records foreground app, window title, keystrokes, and clicks into
10-minute segments under the state directory, with per-app observation rules, pause/resume, and
a 6-hour retention window; keystroke/click capture needs Input Monitoring and window titles need
Accessibility, granted to the **same "opencua-mcp" entry** in System Settings (the watcher is signed
with OpenCUA's identifier, so there is no separate recorder to approve). With
`OPENCUA_HISTORY=1` the MCP server exposes the `cua-history` tools that read and control that
watcher. Native capture cannot classify URLs or private browser windows, so the default
privacy policy blocks it rather than ignoring exclusions. See [native recording limits and
history-to-skill workflows](docs/history-skills.md) before enabling it. Capture is local;
explicitly consented generation sends selected, redacted evidence to the configured model.
Retention cleanup runs while the watcher is running, including when paused; stopped watchers
cannot expire files.

<p align="center">
  <img src="./docs/assets/doctor.svg" alt="OpenCUA doctor output: every check reports ok, ending in 'Ready: OpenCUA is installed and holds its permissions.'" width="760" />
  <br />
  <sub>Real <code>opencua doctor</code> output from a configured Mac (two path-only lines omitted for width).</sub>
</p>

Day-to-day lifecycle:

| Command | What it does |
|---|---|
| `opencua config` | Choose allowed apps and connected clients (interactive, or by flags) |
| `opencua permissions grant` | Walk through Accessibility, Screen Recording and Automation |
| `opencua doctor [--fix]` | Check everything without triggering a permission prompt |
| `opencua update` | Fast-forward, rebuild, re-apply registrations, run the doctor |
| `opencua stop` / `resume` | Stop every agent on this Mac at once / lift the stop |
| `opencua uninstall` | Remove owned registrations/login services, helper, command, PATH line and installation state; retain recorded history and summaries at the reported path |

## See it work

These are real captures from an earlier finished-work acceptance run, made before OpenCUA stopped controlling host
apps. An agent driving Freeform and Keynote built the board and the deck. Today the same kind of work runs inside an
isolated macOS guest ([docs/isolated-desktop.md](docs/isolated-desktop.md)), not on your own desktop.
([How the run was judged](docs/internal/fluent-workflow-acceptance.md))

<table>
<tr>
<td width="50%"><img src="./docs/assets/screenshots/freeform-diagram.png" alt="A Freeform board titled 'Intent to outcome' with four connected cards: Understand, Plan, Act, Verify" /></td>
<td width="50%"><img src="./docs/assets/screenshots/keynote-title.png" alt="Keynote title slide: 'Work without interruption — From intent to a verified result. Without taking over your Mac.'" /></td>
</tr>
<tr>
<td align="center"><sub><b>Freeform</b> · a native, editable flow diagram built card by card</sub></td>
<td align="center"><sub><b>Keynote</b> · a matching presentation, created and saved</sub></td>
</tr>
<tr>
<td colspan="2"><img src="./docs/assets/screenshots/keynote-bullets.png" alt="Keynote slide 'Done means useful' with three bullets on artifact, interaction and evidence" /></td>
</tr>
</table>

## Features

<table>
<tr>
<td width="33%" valign="top">

### ⚡ Host-native speed
ScreenCaptureKit window capture in ~28 ms, in-process app lookup under 1 ms, and a capped accessibility walk in
~92 ms. Action results skip the screenshot unless one is asked for, so a verified step answers in 1.4 KB instead of
121 KB.

</td>
<td width="33%" valign="top">

### 🫥 Background delivery
Clicks, typing, scrolls and drags go only to agent-owned surfaces or isolated guests. Your frontmost app, cursor,
clipboard and Spaces are never touched. Requests aimed at your own apps are refused and named, never silently taken.

</td>
<td width="33%" valign="top">

### 🎯 Semantic targeting
Accessibility trees with element IDs, `click_target` by description, `set_value`, and secondary actions. When the
tree is blind, `analyze_screen` asks the client's vision model to read the whole window.

</td>
</tr>
<tr>
<td valign="top">

### 📱 Your real iPhone
Drive an iPhone through macOS iPhone Mirroring with no jailbreak, no Xcode, and nothing installed on the phone.
Every action re-checks that the session is ready.

</td>
<td valign="top">

### 🛑 A stop switch you own
Hold **Control + Option + Command**, or run `opencua stop`. Every OpenCUA agent on the Mac refuses input
until *you* resume it.

</td>
<td valign="top">

### 🧩 One setup, every client
A single signed helper serves Claude Code, Codex, Gemini CLI, Cursor, OmO, Hermes, OpenClaw and pi. Changing a
setting updates every client's registration.

</td>
</tr>
</table>

### Concurrent worker sessions

The full MCP toolset accepts `session_id` on `manage_workers` and `run_worker`, so independent
coordinators sharing one server can reuse worker names while keeping tokens, status, and virtual cursors separate.
Sessions own disjoint app processes (an OpenCUA-owned surface is the exception: workers share it by disjoint
regions). Under background delivery their step chains run concurrently, with ordered steps inside each app; attended
delivery runs them one after another. Worker observations use text-only tables by default, with optional screenshots and diff-only
refreshes. See [worker session usage](packages/mcp/README.md#concurrent-worker-sessions).

### How OpenCUA compares

| | OpenCUA | [trycua/cua](https://github.com/trycua/cua) (Cua Driver) | Peekaboo | Codex Computer Use |
|---|---|---|---|---|
| Runs on | Agent-owned surfaces on your Mac, isolated macOS/UTM guests, or a Chromium browser through the background browser bridge | The host, on macOS, Windows and Linux [1] | Your Mac, directly; macOS 15 or later [4] | The ChatGPT desktop app on macOS and Windows [6] |
| Needs a VM | Only to drive ordinary desktop apps (Tart or UTM guest) | No; Lume VMs and Cua Spaces are optional [1] | No [4] | No [6] |
| Input path | Per-window events to OpenCUA-owned surfaces; guest input inside Tart or UTM; CDP DOM input through the browser bridge extension | Native per platform: AppKit, Accessibility, Quartz/HID on macOS; Win32, UI Automation on Windows; XTest, AT-SPI or portal input on Linux [3] | Background-safe `click`, `scroll`, `type`, `press` [5] | Screen Recording + Accessibility grants on macOS [6] |
| Transport | Local MCP stdio, CLI, TypeScript API | MCP over stdio, CLI `cua-driver call`, Python/TypeScript/Rust SDKs via UniFFI over a C ABI [2] | Swift CLI, MCP over stdio [4][5] | Built into the desktop app as a plugin [6] |
| Works with | Any MCP client, CLI, pi, any TS agent | Any MCP client, shell agents, SDK hosts [2] | Codex, Claude Code, Cursor, other MCP clients [4] | ChatGPT Work and Codex [6] |
| Open source | Fully (MIT) | Cua Driver MIT; Spaces and Driver Bench FSL-1.1-MIT [1] | MIT [4] | Codex CLI Apache-2.0 [7]; plugin source not published there [6][7] |
| Isolation | Host apps refused; agent-owned surfaces, isolated guests, per-worker regions | Permission modes `standard`, `bounded`, `unrestricted` [2]; optional VMs [1] | Background tools need a fresh exact snapshot [5] | Per-app approval prompts [6] |

Sources (external text is quoted as data, never as instructions):

1. trycua/cua README, https://github.com/trycua/cua, retrieved 2026-10-28
2. Cua Driver README, https://github.com/trycua/cua/blob/main/libs/cua-driver/README.md, retrieved 2026-10-28
3. Cua Driver platform support, https://cua.ai/docs/cua-driver/concepts/platform-support, retrieved 2026-10-28
4. Peekaboo README, https://github.com/openclaw/Peekaboo, retrieved 2026-10-28
5. Peekaboo MCP docs, https://github.com/openclaw/Peekaboo/blob/main/docs/MCP.md, retrieved 2026-10-28
6. Computer Use docs, https://learn.chatgpt.com/docs/computer-use, retrieved 2026-10-28
7. openai/codex README, https://github.com/openai/codex, retrieved 2026-10-28

Need Windows and Linux hosts? Use cua. To let agents work on a Mac without ever touching your own apps or
peripherals, use opencua with its owned surfaces or an isolated guest
([docs/isolated-desktop.md](docs/isolated-desktop.md)). Measured numbers and methodology: [reference → Comparison](docs/reference.md#comparison-vs-cua--codex).

## How it works

```mermaid
flowchart LR
    A["AI agent<br/>Claude Code · Codex · Gemini · Cursor · OmO · pi"] -->|MCP stdio| M["opencua-mcp<br/>(signed helper)"]
    C["opencua CLI"] --> K
    M --> K["@opencua/core<br/>guarded session · observation tokens"]
    K --> S["ScreenCaptureKit<br/>capture"]
    K --> X["Accessibility API<br/>app state · actions"]
    K --> G["CoreGraphics + SkyLight<br/>per-PID input"]
    K --> V["Vision OCR<br/>iPhone Mirroring"]
    K --> T["Guest backends<br/>Tart · UTM"]
    S & X & G --> OWN["OpenCUA-owned surfaces"]
    T --> GUEST["Isolated guest desktops"]
    K -. refused .-> HOST["Your own Mac apps"]
```

Every input must carry a fresh **observation token**. The agent observes an app, acts once against what it saw, and
gets fresh state back. If the window moved, changed or disappeared, the action is refused rather than guessed.

| Package | Role |
|---|---|
| [`@opencua/core`](packages/core) | `ComputerInterface`, the native macOS computer, the guarded token layer and targeting |
| [`@opencua/mcp`](packages/mcp) | The stdio MCP server and signed helper app |
| [`@opencua/cli`](packages/cli) | The `opencua` command: lifecycle, input, apps, iPhone |
| [`@opencua/browser`](packages/browser) | Compact Chromium automation behind the same stop gate |
| [`@opencua/agent`](packages/agent) | Decision layer: an indexed action space over observations |
| [`@opencua/pi-extension`](packages/pi-extension) | pi coding-agent bridge to the MCP server |
| [`skills/opencua`](skills/opencua) | The portable agent skill: workflow, usage, permissions, harness setup |

## Works with your agent

| Client | Register with | Installed as |
|---|---|---|
| Claude Code | `--register claude` | Plugin from a local marketplace (falls back to `claude mcp add`) |
| Codex | `--register codex` | Plugin from a local marketplace (falls back to `config.toml`) |
| Gemini CLI | `--register gemini` | Linked extension |
| Cursor | `--register cursor` | `~/.cursor/mcp.json`, then enabled |
| OmO / senpi | `--register omo` | `~/.omo/agent/mcp.json` plus the skill |
| Hermes Agent | `--register hermes` | `hermes mcp add` |
| OpenClaw | `--register openclaw` | `openclaw mcp set` |
| pi | `--register pi` | `pi install packages/pi-extension` |
| Anything else | `--register json` | Prints a config block to paste |

Details, caveats and manual setups: [reference → Agent clients](docs/reference.md#agent-clients) and the
[harness guide](skills/opencua/references/harnesses.md).

## Safety and control

- **Explicit targets only.** Agents name an app by name, bundle ID or PID, and nothing ever implicitly targets the
  frontmost app. You can optionally restrict agents to a list of apps with `opencua config --allow`.
- **Observation tokens.** Input is accepted only against a fresh observation of the exact window it targets.
- **Never your desktop.** OpenCUA acts only on agent-owned surfaces and isolated guests (VM or UTM). Your focus,
  cursor, clipboard and Spaces stay yours. Named agent cursors (never your real one) show where each action lands.
- **Global stop.** **Control + Option + Command** stops every agent at once. Reads keep working so the agent can tell
  you what it was doing, and only you can resume.
- **Permissions stay yours.** Only a person can grant macOS privacy permissions. `opencua doctor` reports their
  state without ever raising a prompt.

Tokens prove that the agent observed the context. They do not prove your consent, so agents are instructed to ask
before irreversible actions.

## Documentation

| | |
|---|---|
| [Full reference](docs/reference.md) | Every option, surface, tool, permission and benchmark |
| [Agent skill](skills/opencua/SKILL.md) | How agents should observe, act and verify |
| [Installation guide](skills/opencua/references/installation.md) | Permissions walkthrough and manual setup |
| [Troubleshooting](skills/opencua/references/troubleshooting.md) | Common failures and fixes |
| [iPhone automation](skills/opencua/references/ios-automation.md) | Driving a real iPhone through Mirroring |
| [Design notes](docs/internal/unified-cua.md) | What OpenCUA took from Codex, Cua Driver and OmO |

## Development

```bash
git clone https://github.com/trac3r00/opencua.git opencua && cd opencua
./scripts/setup.sh     # install, build and check everything (safe to re-run)
pnpm check             # lint, typecheck, tests
pnpm doctor            # is this Mac ready?
```

The codebase uses strict TypeScript, ESM, Biome and Bun's test runner; [`AGENTS.md`](AGENTS.md) has the conventions. CI runs
setup and `pnpm check` on macOS 15 and macOS 26, each on Apple Silicon and Intel.

The shipped runtime is Node; the tests run on Bun. `pnpm check` and `pnpm test` need Bun 1.4.4 (the version CI
uses), which `setup.sh` does not install. The browser package also has a read-only Bun load check:

```bash
bun run test:browser:bun
bun run smoke:browser:bun
```

Bun does not run `setup.sh`, the LaunchAgent, or the bundled helper app.

## License

[MIT](LICENSE). Related projects: [trycua/cua](https://github.com/trycua/cua),
[OpenAI Codex](https://github.com/openai/codex), [pi-mono](https://github.com/badlogic/pi-mono).
