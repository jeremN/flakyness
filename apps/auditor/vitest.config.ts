import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Browser-driving tests launch Chromium; give them room on a cold CI box.
    testTimeout: 60_000,
  },
});
