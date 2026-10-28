import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  // Tailwind's Vite plugin handles `@import "tailwindcss"` natively (and prefixes
  // via Lightning CSS), avoiding Vite 8/Rolldown's bare-import CSS resolution issue.
  // Must come before sveltekit().
  plugins: [
    tailwindcss(),
    // SvelteKit 3 reads its configuration here; svelte.config.js is gone.
    // No `paths.origin`: it is fixed at build time, and the published image
    // must accept ORIGIN at runtime. server.js does that (see its header).
    sveltekit({
      preprocess: vitePreprocess(),
      adapter: adapter({ out: 'build' }),
      csp: {
        mode: 'auto',
        directives: {
          'default-src': ['self'],
          'script-src': ['self'],
          'style-src': ['self', 'unsafe-inline'],
          'font-src': ['self'],
          'img-src': ['self', 'data:'],
          'connect-src': ['self'],
          'object-src': ['none'],
          'base-uri': ['self'],
          'frame-ancestors': ['none'],
        },
      },
    }),
  ],
  server: {
    port: 5173,
    host: true,
  },
});
