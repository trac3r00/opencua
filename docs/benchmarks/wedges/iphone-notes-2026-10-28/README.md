# Wedge B: a real iPhone over MCP (Notes nonce round-trip)

A single-system scenario, not a head-to-head. apple-cua's MCP server, spawned with `OPENCUA_IPHONE=1` (the
`ios_*` tools register only then), drives a real iPhone through macOS iPhone Mirroring. Each repetition:

1. `ios_observe` the Mirroring window (a fresh nonce that is already on screen fails the run as stale state);
2. `ios_open_app` Notes, `ios_press_keys` `cmd+n`, `ios_type_text` the nonce (paste mode);
3. return to the note list (tap the top-left back label, falling back to an edge swipe);
4. `ios_observe` again and compare the OCR read-back with the nonce.

Only that OCR comparison decides a pass: an exact, case-sensitive nonce inside one OCR line, read in the
list view. Tool success flags are recorded but never trusted, and an editor-view read-back does not count. Every
MCP call is bounded (20 s), and text on the phone's screen is treated as data, never as instructions. Nothing is
installed on the phone. Each created note is left in Notes with its nonce as the title.

Run: `node scripts/scenarios/iphone-notes.mjs [--reps 5] [--helper <apple-cua-mcp>]`. It writes `results.json`,
one `rep-<n>.mov` per repetition (`screencapture -v` of the Mirroring window region) and `SHA256SUMS` here.
Unit cases: `node --test scripts/scenarios/iphone-notes.test.mjs`.

## Precondition (2026-10-28T05:03Z)

`apple-cua --json ios status` (the worktree CLI) reported `not-running`: "iPhone Mirroring isn't running — open
the iPhone Mirroring app and connect your phone, then retry." The scenario exited 2 as a readiness failure,
with zero steps attempted and no server spawned; see `precondition-2026-10-28.json`. The repetitions are pending
until a person opens iPhone Mirroring with the phone connected and unlocked.

## Competitor control: documented absence (2026-10-28T05:01:32Z)

```
$ gh search code "iPhone Mirroring" --repo trycua/cua --json path
[{"path":"blog/app-use.md"},{"path":"libs/cua-driver/rust/crates/platform-macos/src/tools/click.rs"}]
$ gh search code "iPhone Mirroring" --repo steipete/Peekaboo --json path
[]
```

- `trycua/cua`: `blog/app-use.md` is the 2025 VM demo. `click.rs` names iPhone Mirroring only in a code
  comment (around line 1303) as an example of a remote-HID proxy that needs focus-without-raise. The search found
  no iPhone Mirroring observation, OCR or tool surface.
- `steipete/Peekaboo`: no match.

Code search is an index lookup, not proof of absence. It shows that neither project publishes a matching
real-iPhone scenario to run as a control, which is why there is no comparison here.
