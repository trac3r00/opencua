// Node's type-stripping runner does not remap emitted `.js` specifiers to TypeScript source.
// This source-only bridge keeps `node --experimental-strip-types src/cli.ts` runnable;
// package builds emit `dist/buddy-i18n.js` directly from `buddy-i18n.ts`.
export * from "./buddy-i18n.ts";
