// Node's type-stripping runner does not remap emitted `.js` specifiers to TypeScript source.
// This source-only bridge keeps `node --experimental-strip-types src/cli.ts` runnable;
// package builds emit `dist/browser-fork.js` directly from `browser-fork.ts`.
export * from "./browser-fork.ts";
