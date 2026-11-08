# @opencua/core

Platform-abstracted computer-use interfaces for [OpenCUA](../../README.md).

This package is the engine the other surfaces wrap. It provides:

- `ComputerInterface` — screenshot, click, type, key, scroll, drag, cursor, app state, app list,
  and the accessibility operations (set value, secondary actions, selected text).
- `MacOSHostComputer` — the native macOS implementation for the shared host: Accessibility
  observation only. Capture, input, clipboard, focus, window geometry and overlays refuse with
  `HostInteractionDenied`; agent work runs in an isolated desktop (`docs/isolated-desktop.md`). `QemuComputer` and `CloudComputer` are interface stubs.
- The guarded layer — `GuardedComputerInterface`, observation tokens, preflight, and the
  per-app input lanes that stop an action naming an observation it no longer holds.
- Targeting — `matchElements` / `suggestNearMisses` (describe a control by role, label or text)
  and `openApplication` (launch or reopen an app, then wait until it is observable; the default
  launcher refuses with `HostInteractionDenied`, because the shared host takes no desktop actions).

Default keyboard targeting never raises a window or selects it through the Window menu. If another
document owns the app's keyboard focus, input is refused rather than bringing the target over the user's work.
Background delivery remains process/window-addressed and emits no cursor overlay.

```bash
pnpm --filter @opencua/core build
```

```ts
import { MacOSHostComputer, matchElements } from "@opencua/core";
```

## Cursor motion

The agent cursor glides natively by default. Pass a `CursorMotionConfig` to use the planner from
[Cua Cursor Motion](https://github.com/trycua/cua/tree/a7524cfd1d3e959963b43954d43f27c4bd260f08/libs/typescript/cursor-motion)
(MIT, 0.1.0, vendored at that commit in `vendor/`). It plans paths and timing only; OpenCUA keeps its native pointer
artwork and cues and does not import the upstream canvas themes or effects.

```ts
import {
	CURSOR_MOTION_ENV, // "OPENCUA_CURSOR_MOTION"
	CURSOR_MOTION_STYLES,
	type CursorMotionConfig,
	cursorMotionFromEnvironment,
	MacOSHostComputer,
	parseCursorMotion,
} from "@opencua/core";

const motion: CursorMotionConfig = { style: "spring_settle", timing: "fitts", arcSize: 0.35 };
const computer = new MacOSHostComputer({ cursorMotion: motion }); // null keeps the native glide; omit to read the env

parseCursorMotion("magnetic"); // { style: "magnetic" }
parseCursorMotion("off"); // undefined (disabled); throws on unknown styles, fields or out-of-range numbers
cursorMotionFromEnvironment({ [CURSOR_MOTION_ENV]: '{"style":"signature_arc","glideDurationMs":500}' });
```

- Styles (`CURSOR_MOTION_STYLES`): `signature_arc`, `spring_settle`, `magnetic`, `comet_swoop`, `adaptive`, `classic`.
- `timing`: `native`, `fitts` or `fixed`.
- Bounds: `glideDurationMs` 0..5000, `startHandle`/`endHandle`/`arcSize` 0..1, `arcFlow` -1..1, `spring` 0.3..1,
  `turnRadius` 1..1000.
- `OPENCUA_CURSOR_MOTION` takes a style name, `off` or a JSON object. `OPENCUA_CURSOR=off` disables the overlay entirely.

### Menu bar item

The shared overlay daemon shows one `opencua` menu bar item while it is active (mode and motion style in its menu). It
appears on cursor activity, and disappears when the cursor is hidden, the daemon quits, or it has been idle for 15
seconds. The daemon can outlive a short-lived process, so the item may linger briefly. A disabled caller never starts or
updates the overlay; another active client can still keep the shared item visible.

Docs: [root README](../../README.md) · [architecture](../../skills/opencua/references/architecture.md) ·
[permissions](../../skills/opencua/references/installation.md). MIT licensed — see [LICENSE](../../LICENSE).
