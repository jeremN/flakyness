// Stryker config for apps/api. Two REQUIRED workarounds — do not remove:
//
// 1. `plugins: ["@stryker-mutator/vitest-runner"]` — pnpm's isolated
//    node_modules breaks Stryker's glob-based plugin auto-discovery, so the
//    vitest-runner plugin must be listed explicitly or Stryker won't find it.
//
// 2. `tsconfigFile: "tsconfig.stryker-unused.json"` — points at a
//    deliberately nonexistent file to no-op Stryker core's
//    TSConfigPreprocessor, which unconditionally calls the removed classic
//    API `ts.parseConfigFileTextToJson` and crashes under TypeScript 7
//    (apps/api's pinned version). Safe here: we don't use
//    @stryker-mutator/typescript-checker and apps/api's tsconfig.json has no
//    compilerOptions.paths for this preprocessor's extends/references
//    rewrite to affect. Do NOT create tsconfig.stryker-unused.json; do NOT
//    remove this option.
export default {
  packageManager: 'pnpm',
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  vitest: { configFile: 'vitest.stryker.config.ts' },
  coverageAnalysis: 'perTest',
  concurrency: 2,
  // Generous per-mutant timeout budget: under contention Stryker's default
  // budget can mis-classify a slow-but-Surviving mutant as Timeout (which the
  // gate counts like Killed), inflating scores. A wider budget keeps baselines
  // reproducible; genuine hangs still time out (rare in this code).
  timeoutMS: 15000,
  timeoutFactor: 2,
  mutate: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/db/schema.ts',
    '!src/db/seed.ts',
    '!src/index.ts',
  ],
  reporters: ['html', 'json', 'clear-text', 'progress'],
  thresholds: { high: 90, low: 70, break: null },
  tsconfigFile: 'tsconfig.stryker-unused.json',
};
