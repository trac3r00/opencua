# Experimental: Windows and Linux surfaces

Status on 2026-11-08: merged for the record, not wired. The macOS paths are the supported ones.

The TypeScript parts of the Windows and Linux pieces are typechecked and unit tested on macOS CI; the native shells
(the C# projects and the GTK script) are not built there. No OpenCUA launch path starts them yet, and none of them
has been run end to end on Windows or Linux:

- `packages/core/native/windows/OpenCuaSurface` and `OpenCuaCapture` are not built or packaged; `openOwnedSurface`
  still launches the macOS `native/opencua-surface`, and the package excludes `native/windows/**`.
- `packages/core/native/linux/opencua-surface-gtk.py` has no launcher or package entry, and
  `startOwnedLinuxSession` is not called by production code.
- `startSurfaceDriver` (`packages/core/src/surface/surface-driver.ts`) is not called by production code, and
  `DRAG_BRIDGE_SCRIPT` is never installed in a surface.
- The surface helpers in `owned-surfaces.ts` (regions, intent badges, `speakOnSurface`) and the replay exporter are
  not re-exported from `@opencua/core`.

Fixed before merge (review of 2026-11-08): unhandled spawn errors in the Linux display server and the surface
driver, display numbers that ignored X lock files (now retried), master pointer names that two agents could share,
a GTK click after every drag, retargeted cursor flights without a t = 0 keyframe, a replay crash on a `__proto__`
cursor id, `pw-record` left running after a timeout, the WinRT assembly of `BitmapDecoder`, the render-loopback flag
on process-loopback capture, OCR under PowerShell 7 (OCR now runs in Windows PowerShell 5.1), a missing
`recognizeWindowText` on Windows, hit testing from the wrong top-level window, window-relative points sent to the
WebView unconverted, in-flight cursor moves shared across cursors and connections, AX diffs across a different
capture or a reused pid, and colliding speech clip names.

## Known limitations (review of 2026-11-08, not fixed)

Linux:

- When `pw-dump` is missing, audio streams come from `pactl` (PulseAudio sink-input indexes), but recording goes
  through `pw-record`, which needs PipeWire node ids; and a broken `pw-dump` prevents the `pactl` fallback.
- `recordAudio` records any stream target it is given; it does not check that the stream belongs to the app.
- The GTK shell starts its first navigation before `init`, so first-load page scripts can miss the mouth script, and
  pointer or speech commands sent before the page loads can be lost.

Windows:

- Desktop mode kills only the outer launcher on close or timeout; its child PowerShell and the apps it launched keep
  running. `launchApp` passes arguments without quoting, so arguments with spaces change.
- `pointLParam` maps NaN and infinities to 0; `readGpuCapture` checks only four bytes of the PNG signature.
- A 10 s recording can exceed the 15 s request timeout once activation takes its 5 s.
- The surface shell's first navigation races its `init` script; a JSON command with a non-string `t` or `kind` can
  fault the UI callback; cursor names, regions and badges refresh only with the next pointer mark.

Shared surface code:

- The drag bridge proceeds when the source cancels `dragstart` and fires `dragend` before the destination's `drop`.
- The `stop()` that `startSurfaceDriver` returns clears the timer, closes the listener and kills the shell, but leaves
  existing agent sockets open, so a connected agent can keep the driver alive after the shell exits;
  the driver wakes every 8 ms even when idle; `parseAgentLine` rejects a leading `+` the native parser accepts.
- The corpus recorder can write a corpus from the wrong number of outputs.
- The replay page opens at its end (the first Play does nothing), rebuilds all history on every frame, and its
  scrubber has no accessible name.
- On macOS, a speech clip sent right after the surface socket appears can run before the page defines
  `window.__opencuaSpeak`.

Tests that cover less than their names say: the display-number property test does not model lock files, the drag
bridge test supplies no `text/uri-list`, an owned-surfaces fixture never represents a running surface, the drag
message property test does not check intermediate points, the retarget junction assertion compares the same sample,
the mouth tests check only the `init` tag and need a Unix `python3`, the Windows capture fixture is not a valid PNG,
the Linux audio test bypasses `helper.ts`, and a replay color assertion allows extra properties.
