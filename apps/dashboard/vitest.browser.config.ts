import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

// Isolated from vitest.config.ts (node) so the default `pnpm test` stays
// browser-free. Browser mode uses Vite's dev-server transform, which — unlike
// Vitest's node SSR transform — compiles .svelte correctly under Vite 8 +
// vite-plugin-svelte 7.2 (the A3 blocker). See plan 046 / spec A3b.
export default defineConfig({
  plugins: [sveltekit()],
  test: {
    include: ['src/**/*.svelte.test.ts'],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: 'chromium' }],
    },
  },
});
