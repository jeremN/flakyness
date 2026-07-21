import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config';

// Stryker-ONLY: extend the node config (keeps the $lib alias + $env stubs),
// override pool -> 'threads' (@stryker-mutator/vitest-runner requirement).
// `pnpm --filter dashboard test` keeps using vitest.config.ts on 'forks'.
export default mergeConfig(base, defineConfig({ test: { pool: 'threads' } }));
