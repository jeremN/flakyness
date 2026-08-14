// Stryker config for apps/dashboard. THREE REQUIRED workarounds — do not remove:
//
// 1. `plugins: ["@stryker-mutator/vitest-runner"]` — pnpm's isolated
//    node_modules breaks Stryker's glob-based plugin auto-discovery, so the
//    vitest-runner plugin must be listed explicitly or Stryker won't find it.
//
// 2. `buildCommand: "svelte-kit sync"` — Stryker copies the project into a
//    fresh `.stryker-tmp/sandbox-*` dir per test-runner process, and its
//    sandbox file-collection hardcodes an ALWAYS_IGNORE list in core
//    (`node_modules`, `.git`, `*.tsbuildinfo`, `.next`, `.nuxt`,
//    `.svelte-kit`) — it does NOT read the repo `.gitignore` for this. So
//    the generated `.svelte-kit/tsconfig.json` that `tsconfig.json` extends
//    never makes it into the sandbox even if you ran `svelte-kit sync` at
//    the repo root first (the sandbox is a fresh copy). `buildCommand` runs
//    inside each sandbox after the copy, before the dry run — regenerating
//    `.svelte-kit` there fixes it. Verified
//    2026-07-21: without this, every run fails identically with `vite:
//    [TSCONFIG_ERROR] Failed to load tsconfig for '...test.ts': Tsconfig
//    not found`, with or without a root-level `svelte-kit sync` beforehand.
//    (The `test:mutation` script still runs `svelte-kit sync` at the repo
//    root first too, matching the other dashboard test scripts.)
//    Do NOT remove this option.
//
//    CORRECTION 2026-08-14: "this buildCommand is the load-bearing fix" was
//    true locally and FALSE on CI. The nightly Mutation workflow failed on
//    all 24 of its runs (2026-07-22 .. 2026-08-14, i.e. every run since it
//    shipped) with exactly the TSCONFIG_ERROR above — the in-sandbox
//    `svelte-kit sync` does not produce `.svelte-kit` on ubuntu-latest, and
//    Stryker's execa call captures its output so nothing reaches the Actions
//    log. Why it no-ops there is still unknown. The fix does not depend on
//    the answer: `ignorePatterns: ['!.svelte-kit']` below negates the entry
//    in core's ALWAYS_IGNORE so the ALREADY-SYNCED directory is copied into
//    the sandbox, which removes the dependency on the buildCommand working
//    at all. buildCommand is kept as the second layer, not the first.
//
// 4. `ignorePatterns: ["!.svelte-kit"]` — see the correction above. User
//    patterns are appended AFTER core's hardcoded ALWAYS_IGNORE
//    (`core/dist/src/fs/project-reader.js`), and the walker honours `!`
//    negation, so this is the supported way to un-ignore one of them. It
//    only has anything to copy if `.svelte-kit` exists at
//    `apps/dashboard/` when Stryker starts — which is why the workflow must
//    invoke `pnpm --filter dashboard run test:mutation` (`svelte-kit sync &&
//    stryker run`) and NOT `pnpm --filter dashboard exec stryker run`.
//    Reproduced 2026-08-14: with `.svelte-kit` absent from the sandbox the
//    dry run dies on 21 files; present (even as `{}`) it passes 21 files /
//    230 tests.
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
  ignorePatterns: ['!.svelte-kit'],
  vitest: { configFile: 'vitest.stryker.config.ts' },
  coverageAnalysis: 'perTest',
  concurrency: 2,
  mutate: ['src/lib/**/*.ts', '!src/lib/**/*.test.ts'],
  reporters: ['html', 'json', 'clear-text', 'progress'],
  thresholds: { high: 90, low: 70, break: null },
  tsconfigFile: 'tsconfig.stryker-unused.json',
};
