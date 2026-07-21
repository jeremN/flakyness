import { defineConfig } from 'vitest/config';

// Stryker-ONLY Vitest config. @stryker-mutator/vitest-runner requires
// pool:'threads'. The normal `pnpm --filter api test` has NO vitest config and
// uses Vitest's default 'forks' pool — that stays untouched. This file is
// referenced only from stryker.conf.mjs (vitest.configFile).
export default defineConfig({
  test: {
    pool: 'threads',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
