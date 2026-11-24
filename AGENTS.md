# OpenCUA Agent Conventions

## TypeScript Standards
- Ultra-strict TypeScript with all strict flags enabled
- ESM modules with `.js` import suffixes under Node16 resolution
- Tabs for indentation (width 3 for display), line width 120 — enforced by Biome
- No `any`, `@ts-ignore`, `@ts-expect-error`, or non-essential type assertions
- Use `import type` for type-only imports

## Project Structure
- Monorepo with pnpm workspaces
- `packages/core`: Platform-abstracted computer-use interfaces
- `packages/cli`: Command-line interface
- `packages/mcp`: Model Context Protocol server
- `packages/pi-extension`: Pi coding agent extension
- `skills/`: Agent skill definitions

## Testing
- Bun's native test runner for all package and script tests (`bun test --isolate`)
- Use Bun's `bun:test` APIs; shared Vitest compatibility helpers live only in
  `scripts/test-support/bun.ts`
- Register `mock.module` fakes before dynamically importing code that binds
  native, process, or network dependencies
- Never run tests that post input to the host desktop; use fake-only seams or
  an explicitly owned virtual workspace
- Test naming: `#given #when #then` pattern
- Coverage: `bun test --coverage` (`--coverage-reporter=text` or `lcov`)

## Fast Checks
- Run the focused tests for what changed first: `bun test --isolate packages/<pkg>`; for `packages/mcp`, build
  first (`pnpm --filter @opencua/core build:ts && pnpm --filter @opencua/browser build`) and run
  `scripts/bun-test.sh packages/mcp`
- `pnpm lint` and `pnpm typecheck:tests` take seconds; run them before the suite. `bun test` does not type-check
- Run `pnpm check` once at the end, not after every edit
- CI: the Linux `preflight` job (Biome, shellcheck, actionlint) gates the four macOS runners; put any new check that
  does not need macOS there, so a mistake fails in seconds instead of after minutes of macOS time

## Agent Shell Output
- Use [rtk](https://github.com/rtk-ai/rtk) to compress the shell output agents read: `brew install rtk && rtk init -g`
  (`rtk init -g --codex`, `--gemini`, `--agent pi`, ... for other agents). Exit codes pass through unchanged
- When a full, unfiltered output is needed (a log to quote, a diff to apply), run `rtk bypass <command>`

## macOS Native APIs
- Screenshot: ScreenCaptureKit/IOSurface (preferred) or `screencapture` CLI fallback
- Input: koffi-bound CoreGraphics CGEvent (CGEventPost for global, CGEventPostToPid for per-PID); no CLI fallback
- Accessibility: `osascript` for UI queries when needed

## Platform Abstraction
- Abstract `ComputerInterface` with methods: screenshot, click, doubleClick, type, key, scroll, drag, getCursorPosition
- Implementations: `MacOSHostComputer` (native), `QemuComputer` (interface only), `CloudComputer` (interface only)
- All unimplemented platforms should have interface stubs with `throw new Error("Not implemented")`
