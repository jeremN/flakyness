import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  // Tailwind's Vite plugin handles `@import "tailwindcss"` natively (and prefixes
  // via Lightning CSS), avoiding Vite 8/Rolldown's bare-import CSS resolution issue.
  // Must come before sveltekit().
  plugins: [tailwindcss(), sveltekit()],
  server: {
    port: 5173,
    host: true,
  },
});
