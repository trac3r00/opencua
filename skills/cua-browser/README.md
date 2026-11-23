# Set up cua-browser with an AI

Hand this file to an agent that can run shell commands. The agent installs the background
browser bridge, asks only the questions below with `AskUserQuestion`, and verifies the result
without taking over your screen. Do not run the whole file as a script.

If your host has no `AskUserQuestion` tool (some hosts call it `ask_user_question`), use the
host's equivalent or print the same questions as plain text and wait for an answer before
continuing. Do not guess the answers.

## Contract for the agent

Allowed:

- Build `packages/browser` and `packages/cli`.
- Install or restart the login LaunchAgent `com.opencua.browser.daemon`.
- Write the native messaging host manifest for Brave and open its extensions page in the
  background.
- Copy the unpacked-extension folder path to the clipboard.
- Open two harmless test pages in the background and close them.

Not allowed without a new, explicit request:

- Installing or changing the default browser.
- Copying or reading a browser profile, cookies, passwords, or tokens.
- Clicking or moving one of the person's existing tabs.
- Running `pnpm build` for the whole workspace instead of the two scoped packages.
- Committing, pushing, uninstalling, or deleting browser data.
- Declaring success when the extension is not connected or the window check failed.

Never ask the person for the port or pairing token. `setup` handles the local connection.

## 0. Preflight

Run these and keep the output. Stop if macOS is not the platform.

```sh
uname -s                         # Darwin
node -v                          # must be v20 or newer
pnpm -v
ls -d "/Applications/Brave Browser.app" 2>/dev/null
ls -d "/Applications/Google Chrome.app" "/Applications/Microsoft Edge.app" \
      "/Applications/Arc.app" "/Applications/Vivaldi.app" 2>/dev/null
```

**Node trap:** in some OmO shells `node` resolves to a Bun shim. If `node -v` mentions Bun, use
the real Node binary for every install step, for example:

```sh
/opt/homebrew/bin/node -v
```

The LaunchAgent records the Node that installed it. Installing through the Bun shim would make
the login service run Bun, so use real Node for `install`.

Automatic native-host pairing is implemented for **Brave** on macOS. Chrome, Edge, Arc, and
Vivaldi can control pages, but their native messaging host is not registered by this installer;
they need the manual connection path and a separate host registration. Ask before choosing one
of them.

## 1. Ask with AskUserQuestion

Use one call with up to four questions, `waitForAnswer: true`, and no invented `Other` option.
The tool adds free text automatically.

### Call 1: browser, install consent, test pages

```text
AskUserQuestion({
  questions: [
    {
      question: "Which Chromium browser should opencua control?",
      header: "Browser",
      multiSelect: false,
      options: [
        { label: "Brave", description: "Automatic native-host pairing is implemented for Brave." },
        { label: "Google Chrome", description: "Page control works, but native-host auto-pairing is not registered; manual connection may be needed." }
      ]
    },
    {
      question: "May I build the browser packages, install a login LaunchAgent, register the Brave native messaging host, and open the extensions page in the background?",
      header: "Install",
      multiSelect: false,
      options: [
        { label: "Install now", description: "Build, install or restart the daemon, and open the extensions page." },
        { label: "Show changes first", description: "Print the exact paths and commands, then ask again." },
        { label: "Extension only", description: "Skip the LaunchAgent; I will run the daemon manually." },
        { label: "Cancel", description: "Stop without changing anything." }
      ]
    },
    {
      question: "After setup, may I open example.com and example.org in the background to verify parallel tabs?",
      header: "Test pages",
      multiSelect: false,
      options: [
        { label: "Yes, example sites", description: "Open both, read one, then close everything." },
        { label: "Use my URL", description: "I will type a URL in the free-text field." },
        { label: "Skip live test", description: "Verify only the daemon and extension connection." }
      ]
    }
  ],
  required: true,
  waitForAnswer: true
})
```

If the person chooses **Show changes first**, print these before continuing:

```text
Build:    pnpm --filter @opencua/browser build
Install:  /opt/homebrew/bin/node packages/browser/dist/cli.js install
LaunchAgent: ~/Library/LaunchAgents/com.opencua.browser.daemon.plist
Native host: ~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.opencua.browser.json
State:    ~/.opencua (owner-only browser-connection.json)
Logs:     ~/Library/Logs/OpenCUA Browser/
Then ask again before running them.
```

If the person chooses **Extension only**, skip `install` and start a manual daemon in their own
terminal with `node packages/browser/dist/cli.js serve`, then use the extension options page
with the printed port and token. Do not place the token in chat.

## 2. Build, install, and pair

Run from the OpenCUA checkout. The browser package must be built before `setup`; `setup` is
not a build and fails if `packages/browser/dist/cli.js` is missing.

```sh
pnpm --filter @opencua/browser build
test -f packages/browser/dist/cli.js
/opt/homebrew/bin/node packages/browser/dist/cli.js install
```

`install` is idempotent and **restarts** the LaunchAgent with the current `dist`, which is what
loads a newly built daemon. Expect:

```text
Installed OpenCUA Browser service.
LaunchAgent: /Users/<you>/Library/LaunchAgents/com.opencua.browser.daemon.plist
Native host: /Users/<you>/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.opencua.browser.json
```

Then pair the extension. `setup` copies the extension folder to the clipboard, opens the
extensions page in the background, and waits when `OPENCUA_BROWSER_WAIT=1` is set:

```sh
OPENCUA_BROWSER_WAIT=1 opencua browser setup --browser "Brave"
```

If `opencua` is not on `PATH`, use:

```sh
OPENCUA_BROWSER_WAIT=1 node packages/cli/dist/cli.js browser setup --browser "Brave"
```

Do not use `--no-wait` unless the person is going to load the extension later.

## 3. Human extension step

This is the one step an agent cannot do. The extension folder path is already on the clipboard.

1. Open `brave://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select the folder `packages/browser/extension` (the path on the clipboard).
5. Confirm the extension appears with ID `mlnfdbnljbighojpekgblaphpojllkdf`.
6. Keep the extension enabled.

Ask:

```text
AskUserQuestion({
  questions: [{
    question: "The extension folder is on your clipboard. Have you loaded it in Brave?",
    header: "Extension",
    multiSelect: false,
    options: [
      { label: "Loaded", description: "The unpacked extension is enabled." },
      { label: "Show me the steps", description: "Print the six steps above and wait." },
      { label: "Skip for now", description: "Stop before live verification." }
    ]
  }],
  waitForAnswer: true
})
```

After an OpenCUA upgrade, reload the unpacked extension. A stale extension keeps the old
worker even when the daemon is new.

## 4. Verify the connection

Run the human-readable status, then the JSON status:

```sh
opencua browser status
opencua browser status --json
```

Require all of these:

- `daemon: running`
- `extension: connected`
- `actions: available`
- `spaces: 0`

`daemon: running` with `extension: not connected` is the normal intermediate state after
`install` and before the extension is loaded. Do not report success yet.

## 5. Background smoke test

Use the bundled CLI, which talks to the same daemon as the MCP server. This opens two pages in
one call; both must load concurrently in the minimized window.

```sh
node skills/cua-browser/scripts/browser.mjs call \
  '{"action":"open_many","space":"setup-check","urls":["https://example.com","https://example.org"]}'
```

Require `pages` with two entries (`p1`, `p2`) and `failed: []`. Then wait for the test text on
the first page:

```sh
node skills/cua-browser/scripts/browser.mjs call \
  '{"action":"wait","space":"setup-check","page":"p1","text":"Example Domain","timeoutMs":5000}'
```

Require `matched: true`. Close the whole space:

```sh
node skills/cua-browser/scripts/browser.mjs call \
  '{"action":"finish","space":"setup-check"}'
```

Then confirm `spaces: 0` in `opencua browser status --json`.

The smoke test does not click, fill, select, upload, or open a popup. Do not add such a step
without asking.

## 6. Window check

The whole point is that the agent never takes the screen.

```text
AskUserQuestion({
  questions: [{
    question: "Did any browser window appear on your screen while the two test pages opened?",
    header: "No takeover",
    multiSelect: false,
    options: [
      { label: "No window appeared", description: "The agents stayed in the background." },
      { label: "A window appeared", description: "Stop and report this as a failed setup." },
      { label: "Not sure", description: "Report the result as unverified, not passed." }
    ]
  }],
  required: true,
  waitForAnswer: true
})
```

If a window appeared, do not retry with a visible window. Report the browser, version, and what
happened. Native page popups can still activate a Chromium window; the test pages do not open
one.

## 7. Report

Give the person a short report with these fields, using only what you observed:

```text
Browser:        <name and version>
Extension:      mlnfdbnljbighojpekgblaphpojllkdf, connected
Daemon:         com.opencua.browser.daemon, running
Port:           local only; never print the pairing token
Smoke test:     open_many p1+p2, wait matched, finish, spaces 0
Window check:   no window appeared / failed / unverified
Limits:         native popups may activate Brave; Chrome/Edge/Arc/Vivaldi need manual native-host registration
Uninstall:      opencua browser uninstall, then remove the unpacked extension
```

## Recovery

| Signal | Action |
|---|---|
| `node -v` says Bun | Use `/opt/homebrew/bin/node` for `install` and the daemon command; reinstall so the LaunchAgent records real Node |
| `browser package is not built` | Run `pnpm --filter @opencua/browser build` |
| `opencua: command not found` | Use `node packages/cli/dist/cli.js` or install the CLI package |
| `extension: not connected` | Reload the unpacked extension; confirm the native host JSON exists; read the `StandardErrorPath` in `~/Library/LaunchAgents/com.opencua.browser.daemon.plist`. The installer creates `~/Library/Logs/OpenCUA Browser/`; if that directory is missing, `mkdir -p` it and restart the agent with `launchctl kickstart -k gui/$(id -u)/com.opencua.browser.daemon` |
| Port 47953 already in use | `lsof -nP -iTCP:47953 -sTCP:LISTEN`; do not kill an unrelated process; use a manual daemon on `OPENCUA_BROWSER_PORT` |
| Wrong browser selected | `opencua browser uninstall`, load the extension in the intended browser, then repeat with `--browser` |
| Page moved to a user window | Stop. The extension pauses input on a move; do not move it back silently |
| Human took over | Ask the person to use **Give back** in the extension popup; then observe again before acting |

Uninstall removes the LaunchAgent and native host registration only. Remove the unpacked
extension from the browser manually. The pairing key in `~/.opencua/browser-connection.json`
is retained by design.

## Copy-paste prompt

```text
Read skills/cua-browser/README.md and set up cua-browser for me.
Use AskUserQuestion only at the checkpoints in that file, and do not ask me for a port or token.
Run the background smoke test, report what you observed, and stop if any verification fails.
```
