import { defineEnvVars } from '@sveltejs/kit/env';

// Runtime environment variables, read through `$app/env/public` and
// `$app/env/private`. A missing variable becomes '' so every reader keeps its
// own fallback (`PUBLIC_API_URL || 'http://localhost:8080'`,
// `COOKIE_SECURE === 'true'`), exactly as with the old `$env/dynamic/*`.
// Tests replace both modules with `src/tests/env-*-stub.ts`.
export const variables = defineEnvVars({
  PUBLIC_API_URL: { public: true, schema: (input) => input ?? '' },
  READ_TOKEN: { schema: (input) => input ?? '' },
  COOKIE_SECURE: { schema: (input) => input ?? '' },
});
