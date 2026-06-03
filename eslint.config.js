import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Root flat config for the whole pnpm workspace.
// Scope: .ts/.js across apps + packages. `.svelte` files are intentionally
// linted by `svelte-check` (dashboard `check` script), not ESLint, so we don't
// need the svelte parser/plugin resolvable from the workspace root.
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/.svelte-kit/**',
      '**/node_modules/**',
      '**/drizzle/**',
      '**/*.svelte',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,mts,cts,js,mjs,cjs}'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // Surface, don't block: the codebase has intentional `any` (e.g. the
      // Playwright JSON parser) and these are quality signals, not errors.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
