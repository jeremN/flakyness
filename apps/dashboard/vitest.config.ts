import { defineConfig, configDefaults } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'runtime/**/*.test.ts'],
    // Browser-mode render tests (*.svelte.test.ts) run via vitest.browser.config.ts
    // in Chromium — keep them out of the node run so `pnpm test` stays browser-free.
    exclude: [...configDefaults.exclude, 'src/**/*.svelte.test.ts'],
  },
  resolve: {
    alias: {
      '$app/env/public': path.resolve(__dirname, 'src/tests/env-stub.ts'),
      '$app/env/private': path.resolve(__dirname, 'src/tests/env-private-stub.ts'),
    },
  },
});
