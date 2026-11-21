// Node's type-stripping runner does not remap emitted `.js` specifiers to TypeScript source.
// This source-only bridge keeps `node --experimental-strip-types src/cli.ts` runnable;
// package builds emit `dist/daemon-executor.js` directly from `daemon-executor.ts`.
export * from "./daemon-executor.ts";
