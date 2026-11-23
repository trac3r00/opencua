# Computer history, memories and skill suggestions

OpenCUA history works like Codex's computer history. It records what you do on this Mac as
interaction events and accessibility text and summarizes each activity session into a Markdown
memory. You, or your agent, can then ask "what was I doing?" or "find that document again". When
you repeat real multi-step work, OpenCUA suggests a skill for it. It records no screenshots and no
audio.

## One menu bar icon

`opencua history start` installs the recorder as a login item. OpenCUA shows **one** menu bar icon,
and that menu holds everything:

- History: Pause / Resume, Don't record (the front app), Open timeline, Clear (last 10 minutes,
  hour, day, or everything), suggested skills, Reveal data folder.
- Agent controls while an agent is driving apps (Stop / Resume).
- **Buddy settings…** and **Stop buddy talking**, whether or not an agent is connected.

## What is recorded

Events are grouped into 10-minute segments under `~/.opencua/cua-history/segments/` (the state
directory may differ; `opencua history status` and `cua_history_status` print the paths):

- Which app and window you were in: the window title, and the browser URL or document path when
  Accessibility exposes them.
- What you acted on: clicks, shortcuts and text input with the target element's role and label.
- Accessibility text snapshots of the window.
- What you typed: characters are coalesced into one text run per field.

### Where typed text goes

Typed text is stored only in the raw segments, as `keyboard.text_input` events (`keyboard.text`)
in `segments/<id>/events.jsonl` on this Mac. It is deleted with the segment after 48 hours. It is
never sent to a model and never written into a memory, even with the model-sharing switch (below)
on: summaries and suggestions see only which field was typed into and how many characters.
Secure Event Input (most password fields) suppresses capture. Excluded apps are not recorded.

## Memories and the timeline

Activity sessions become memory files:

```
~/.opencua/cua-history/memories/2026-11-23/0930-paid-october-invoices.md
```

Each is readable Markdown you can edit or delete. Its YAML front matter holds `title`, `start`,
`end`, `apps`, `segments` and, when the session looked like repeatable work, `suggestedSkill`. A
short summary follows.

```sh
opencua history timeline           # memories by day and time, newest first
opencua history summarize          # summarize recent activity into memories now
```

With the model-sharing switch on, a model writes the summary. With it off, OpenCUA writes a local,
deterministic summary.

## Ask your agent

With `OPENCUA_HISTORY=1` the MCP server adds the history tools:

| Tool | What it does |
| --- | --- |
| `cua_history_status` | State (running, paused, stopped), data paths and retention hours |
| `cua_history_timeline` | Memories newest first, as front matter plus first summary paragraph; optional `day` and `limit` |
| `cua_history_read_memory` | One memory by its timeline path (`YYYY-MM-DD/HHMM-slug.md`), up to 64 KiB; other paths are refused |
| `cua_history_suggest_skills` | Repeated multi-step workflows as numbered skill candidates; asks no model |
| `cua_history_save_skill` | Saves a draft you approved to `~/.agents/skills/<name>/SKILL.md`; never overwrites |
| `cua_history_get_settings` / `cua_history_update_settings` | Read and replace what is observed |
| `cua_history_pause` / `cua_history_resume` | Pause and resume recording |

Ask "what was I working on this morning?" and the agent reads the timeline, then opens the
memories it needs. For detail within the last 48 hours it can also search the raw events.

## Skill suggestions

A workflow is suggested only when **all** of these hold:

- It has several steps and at least one substantive action: typing into a field, pressing a labeled
  control, or opening a document or URL.
- It can be parameterized. The suggestion names its steps and its parameters, such as the field you
  filled. It never names the values you typed.
- It was seen in at least two sessions.

Switching between apps or windows and clicking around are navigation; they are never suggested. A
suggestion is a detected repeat, not a verified macro. Nothing is saved until you review the draft.

Ask your agent "what skills could I make from my history?". It shows the numbered list. You pick
one, the agent drafts SKILL.md in the chat, and after you approve the draft it saves the skill.

From the terminal:

```sh
opencua history suggest            # numbered list of repeated workflows
opencua history record start       # mark one deliberate run
opencua history record stop        # prints the prompt to give your agent
```

When the agent later runs a saved skill, it must observe fresh app state before acting. Saving a
skill does not run it or prove that it works.

## Model sharing

The model-sharing switch is:

```sh
opencua history descriptions on|off     # on by default
```

While it is on, each suggestion's recorded steps go to a small model for a name and summary
(`OPENCUA_HISTORY_MODEL`, default `haiku`, through Claude Code when it is installed, else OmO;
`OPENCUA_HISTORY_AGENT` names another executable), and memories are summarized by a model. What the
model receives: app names, window titles of apps other than browsers, the host of each web page (no
path, no query), file paths, control and field labels, and counts of typed characters. Browser window
titles and page paths are left out because they can repeat what you searched for; the local memory file
keeps them. A window title in another app (a document name, for example) still reaches the model. While it is off, nothing recorded leaves the machine through history. Unavailable credentials or
executables produce an error, not a fake result.

## Retention and clearing

- Raw segments are deleted 48 hours after they end. The recorder prunes while it runs, including
  while paused; a stopped recorder cannot prune.
- Memories are kept until you delete them.
- Clear a recent window, deleting both its events and its memories, from the menu bar or with
  `opencua history clear --last 10m` (or `1h`, `1d`).
- `opencua history list` shows each segment; `opencua history delete` removes exact segment ids,
  `--last <duration>` or `--all` (it needs `--yes`).
- `opencua uninstall` stops this checkout's history service but keeps recorded history, memories
  and summaries, and lists their paths. It never erases them silently.

## Native recording limits

The recorder enforces application exclusions but cannot identify browser URLs or private windows.
It therefore pauses capture, without installing an input event tap, when the settings exclude
private browsing, set `defaultURLBehavior` to `do_not_observe`, or contain any URL block rule. The
menu reports the unsupported policy, and `cua-history/state.json` records the reason. The default
settings (observe every app, private browsing included, no URL rules) are enforceable, so with
them private browser windows are recorded too. Do not loosen settings merely to make recording
start; after choosing a supported policy, resume recording explicitly.

Pausing survives a recorder restart. launchd restarts the recorder after an unexpected exit, not
after Quit.

### Permissions

The recorder is signed as `dev.opencua.mcp`, so it appears under the same **opencua-mcp** entry in
System Settings as the rest of OpenCUA. Window titles, element labels and accessibility text need
Accessibility. Keystrokes and clicks need Input Monitoring; without it only window changes are
recorded.

## Legacy web page

```sh
opencua history open --web [--skills-dir /absolute/path] [--no-open]
```

The older localhost page lets you select segments, preview their redacted evidence, and, after
you enable sharing on the page, generate a summary or skill draft through the OmO CLI. Typed text,
selection text, accessibility snapshots and element values are left out of that evidence. App
names, window titles and labels can still be private, so inspect the preview. Generation is
bounded to 120 seconds, 12 segments and 120,000 UTF-8 bytes. The page listens only on
`127.0.0.1` behind a random session path. It closes after 15 minutes without activity, and closing
it does not stop the recorder.

## Updating an existing recorder

Menu and recording changes need a recorder rebuilt from the updated source; updating TypeScript
alone does not change the running native menu. Run the normal install or update, then restart the
history recorder.
