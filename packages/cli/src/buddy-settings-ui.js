// Node's type-stripping runner does not remap emitted `.js` specifiers to TypeScript source.
// This source-only bridge keeps `node --experimental-strip-types src/cli.ts` runnable;
// package builds emit `dist/buddy-settings-ui.js` directly from `buddy-settings-ui.ts`.
export * from "./buddy-settings-ui.ts";
