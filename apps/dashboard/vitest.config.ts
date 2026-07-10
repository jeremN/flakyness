import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '$env/dynamic/public': path.resolve(__dirname, 'src/tests/env-stub.ts'),
      '$lib': path.resolve(__dirname, 'src/lib'),
    },
  },
});
