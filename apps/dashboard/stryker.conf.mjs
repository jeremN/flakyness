// Stryker config for apps/dashboard. THREE REQUIRED workarounds — do not remove:
//
// 1. `plugins: ["@stryker-mutator/vitest-runner"]` — pnpm's isolated
//    node_modules breaks Stryker's glob-based plugin auto-discovery, so the
//    vitest-runner plugin must be listed explicitly or Stryker won't find it.
//
// 2. `buildCommand: "svelte-kit sync"` — Stryker copies the project into a
//    fresh `.stryker-tmp/sandbox-*` dir per test-runner process (respecting
//    root `.gitignore`, which excludes `.svelte-kit/`), so the generated
//    `.svelte-kit/tsconfig.json` that `tsconfig.json` extends never makes it
//    into the sandbox even if you ran `svelte-kit sync` at the repo root
//    first. `buildCommand` runs inside each sandbox after the copy, before
//    the dry run — regenerating `.svelte-kit` there fixes it. Verified
//    2026-07-21: without this, every run fails identically with `vite:
//    [TSCONFIG_ERROR] Failed to load tsconfig for '...test.ts': Tsconfig
//    not found`, with or without a root-level `svelte-kit sync` beforehand.
//    (The `test:mutation` script still runs `svelte-kit sync` at the repo
//    root first too, matching the other dashboard test scripts — harmless,
//    but NOT sufficient on its own; this buildCommand is the load-bearing
//    fix.) Do NOT remove this option.
//
// 3. `tsconfigFile: "tsconfig.stryker-unused.json"` — points at a
//    deliberately nonexistent file to no-op Stryker core's
//    TSConfigPreprocessor. apps/dashboard itself is pinned to TypeScript 6
//    (where the classic API this preprocessor calls,
//    `ts.parseConfigFileTextToJson`, still exists) — but Stryker core treats
//    `typescript` as an optional peer resolved via plain Node module
//    resolution, NOT via this package's own pinned dependency. That walk
//    lands on the workspace's hoisted `typescript@7.0.2` (apps/api's pin,
//    shared in the pnpm virtual store), which removed the classic API — so
//    the crash reproduces here too, for the same underlying reason as
//    apps/api. Verified 2026-07-21: without this no-op, Stryker throws
//    `TypeError: ts.parseConfigFileTextToJson is not a function` even
//    though `apps/dashboard/node_modules/typescript` resolves to 6.0.3.
//    Safe here: we don't use @stryker-mutator/typescript-checker and the
//    $lib/$env aliases resolve at runtime via vitest.config.ts's
//    resolve.alias, not tsconfig `paths`. Do NOT create
//    tsconfig.stryker-unused.json; do NOT remove this option.
export default {
  packageManager: 'pnpm',
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  buildCommand: 'svelte-kit sync',
  vitest: { configFile: 'vitest.stryker.config.ts' },
  coverageAnalysis: 'perTest',
  concurrency: 2,
  mutate: ['src/lib/**/*.ts', '!src/lib/**/*.test.ts'],
  reporters: ['html', 'json', 'clear-text', 'progress'],
  thresholds: { high: 90, low: 70, break: null },
  tsconfigFile: 'tsconfig.stryker-unused.json',
};
