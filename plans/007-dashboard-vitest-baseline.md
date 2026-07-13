# Plan 007: Give the dashboard a test runner and cover its data layer

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 0f8b0cc..HEAD -- apps/dashboard/ .github/workflows/ci.yml`
> If `apps/dashboard/src/lib/api.ts` or the load functions changed (plan 008
> touches them), read the live code before writing tests against the excerpts
> below; on a contradiction, STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW (additive tooling + tests)
- **Depends on**: none (plan 008 builds on this)
- **Category**: tests / dx
- **Planned at**: commit `0f8b0cc`, 2026-07-10

## Why this matters

The dashboard has zero tests and no test runner. Root `pnpm test` runs
`pnpm -r run test`, and pnpm silently skips packages without a `test` script —
so a green root test run verifies only the API while the entire SvelteKit app
(the API client's error mapping, five server load functions, project-selection
logic) ships unverified. CI never runs any dashboard test either
(`.github/workflows/ci.yml` test job runs `pnpm --filter api test` only).

After this plan: `pnpm --filter dashboard test` exists, covers the data layer,
and runs in CI — root `pnpm test` genuinely covers both apps.

## Current state

Files:

- `apps/dashboard/package.json` — scripts: `dev`, `build`, `preview`, `check`,
  `check:watch`, `lint` (dead — plan 005 removes it). No `test`. devDeps
  include `vite ^8.0.16`, `svelte ^5.56.1`, `@sveltejs/kit ^2.61.1`,
  `typescript ^6.0.3` — no vitest.
- `apps/api/package.json` — uses `vitest ^4.1.8` (match this major).
- `apps/dashboard/vite.config.ts` — vite config with `sveltekit()` and
  `tailwindcss()` plugins.
- `apps/dashboard/src/lib/api.ts` — the module under test:
  - `API_URL = env.PUBLIC_API_URL || 'http://localhost:8080'` where `env`
    comes from `$env/dynamic/public` (line 1–4) — a SvelteKit virtual module
    that does NOT resolve under plain vitest; needs an alias/stub (Step 2).
  - `class APIError extends Error { statusCode; endpoint }` (lines 6–15).
  - `fetchJson<T>(path)` (lines 17–38): `fetch(API_URL + path)`; non-OK →
    throws `APIError(response.status, "API request failed: <statusText>. <body>", path)`;
    network/other errors → `APIError(0, "Failed to connect to API: <msg>", path)`.
  - Exported fetchers: `getProjects` (unwraps `.projects`),
    `getProjectStats`, `getFlakyTests(projectId, status='active')` (unwraps
    `.flakyTests`), `getProjectRuns(projectId, limit=20)` (unwraps `.runs`),
    `getTestHistory(testName, projectId)` (encodes the name), `getFlakeTrend`.
- `apps/dashboard/src/routes/+layout.server.ts` — full contents:

```ts
import type { ServerLoadEvent } from '@sveltejs/kit';
import { getProjects } from '$lib/api';

export async function load({ url }: ServerLoadEvent) {
  const projects = await getProjects();
  const selectedProjectId = url.searchParams.get('project') || projects[0]?.id || null;
  const selectedProject = projects.find(p => p.id === selectedProjectId) || projects[0] || null;

  return { projects, selectedProject };
}
```

- `apps/dashboard/src/routes/+page.server.ts` — overview load: returns nulls
  when no `selectedProject`, else `Promise.all` of 4 fetchers.
- `.github/workflows/ci.yml` — `test` job (Postgres service) ends with
  `- name: Run API tests` / `run: pnpm --filter api test`.

Conventions: Vitest style as in `apps/api/src/**/*.test.ts` (plain
`describe`/`it`/`expect`, no snapshot tests).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| New tests | `pnpm --filter dashboard test` | all pass |
| Typecheck | `pnpm --filter dashboard check` | 0 errors, 0 warnings |
| Root aggregate | `pnpm test` | runs API AND dashboard suites |
| Lint | `pnpm lint` | exit 0 |

## Scope

**In scope** (the only files you should modify/create):
- `apps/dashboard/package.json` (add `vitest` devDep + `test` script)
- `apps/dashboard/vitest.config.ts` (create)
- `apps/dashboard/src/lib/api.test.ts` (create)
- `apps/dashboard/src/routes/layout.server.test.ts` (create — see Step 4 note on placement)
- `apps/dashboard/src/tests/env-stub.ts` (create)
- `.github/workflows/ci.yml` (ONLY adding the dashboard test step)
- `pnpm-lock.yaml` (via `pnpm install` only)

**Out of scope** (do NOT touch):
- `apps/dashboard/src/lib/api.ts` and the load functions themselves — plan
  008 changes their error behavior; this plan tests what EXISTS. If a test
  reveals a bug, document it in your report; don't fix it here.
- Svelte component testing (`@testing-library/svelte`, browser mode) —
  deliberately deferred; this plan covers plain TS modules only.
- `apps/dashboard/vite.config.ts`.

## Git workflow

- Branch: `advisor/007-dashboard-vitest-baseline`
- Conventional-commit, single-line subject only (e.g.
  `test(dashboard): add vitest + data-layer coverage`). Do NOT add any
  `Co-Authored-By` trailer. Do not push or open a PR unless the operator
  instructed it.

## Steps

### Step 1: Add vitest and the test script

In `apps/dashboard/package.json`: add `"vitest": "^4.1.8"` to devDependencies
(same major as the API) and `"test": "vitest run"` to scripts. Run
`pnpm install`.

**Verify**: `pnpm --filter dashboard exec vitest --version` → prints a 4.x version.

### Step 2: Create the vitest config with a `$env` stub

`apps/dashboard/src/tests/env-stub.ts`:

```ts
// Stub for SvelteKit's $env/dynamic/public in plain vitest runs.
export const env: Record<string, string | undefined> = {};
```

`apps/dashboard/vitest.config.ts`:

```ts
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
```

(Do not import the SvelteKit vite plugin here — these are pure TS module
tests; the plugin would drag in the full kit runtime.)

**Verify**: `pnpm --filter dashboard test` → "no test files found" exit 0 or passes trivially (vitest 4 exits 0 with `--passWithNoTests`; if it exits 1 on zero files, proceed — Step 3 adds files — and re-verify after).

### Step 3: Cover `lib/api.ts` in `apps/dashboard/src/lib/api.test.ts`

Use `vi.stubGlobal('fetch', vi.fn(...))` per test (reset in `afterEach` with
`vi.unstubAllGlobals()`). Cases:

1. `fetchJson` success — `getProjects()` with a 200 JSON
   `{ projects: [{id:'a',name:'x',createdAt:'...'}] }` → returns the array;
   fetch called with `http://localhost:8080/api/v1/projects` (the stubbed env
   has no `PUBLIC_API_URL`, so the default applies).
2. Non-OK response — fetch resolves
   `new Response('boom', { status: 404, statusText: 'Not Found' })` → rejects
   with `APIError`, `statusCode === 404`, `endpoint === '/api/v1/projects'`,
   message contains `boom`.
3. Network failure — fetch rejects `new TypeError('fetch failed')` → rejects
   with `APIError`, `statusCode === 0`, message starts
   `Failed to connect to API`.
4. `getFlakyTests('p1', 'resolved')` → URL contains
   `/projects/p1/flaky-tests?status=resolved`.
5. `getProjectRuns('p1', 7)` → URL contains `?limit=7`.
6. `getTestHistory('loads 100% of items', 'p1')` → URL path contains
   `loads%20100%25%20of%20items` (encoded exactly once).

NOTE (import order): `api.ts` computes `API_URL` at module load from the
stubbed env — import it normally; the stub module's `env` is empty so the
localhost default is deterministic.

**Verify**: `pnpm --filter dashboard test` → 6+ tests pass.

### Step 4: Cover the layout selection logic

Create `apps/dashboard/src/routes/layout.server.test.ts` (co-located `.test.ts`
files are the repo pattern; the `include` glob picks it up — SvelteKit route
globbing ignores non-`+`-prefixed files, so this filename is safe inside
`routes/`).

Mock the api module: `vi.mock('$lib/api', () => ({ getProjects: vi.fn() }))`,
then import `{ load }` from `./+layout.server`. Build a minimal event:
`{ url: new URL('http://x/?project=b') } as any`. Cases:

1. `?project=b` with projects `[a, b]` → `selectedProject.id === 'b'`.
2. No param → first project selected.
3. Unknown param id → falls back to first project.
4. Empty project list → `{ projects: [], selectedProject: null }`.
5. (Characterization) `getProjects` rejecting → `load` rejects (today there
   is no error handling — assert the rejection propagates; plan 008 will
   change this and update the test).

**Verify**: `pnpm --filter dashboard test` → all cases pass; `pnpm --filter dashboard check` → 0 errors (the test files must typecheck).

### Step 5: Wire the dashboard tests into CI and the root

In `.github/workflows/ci.yml`, `test` job, add AFTER the "Run API tests"
step:

```yaml
      - name: Run Dashboard tests
        run: pnpm --filter dashboard test
```

(The dashboard tests need no database; keeping them in the same job avoids a
fourth setup block. `svelte-kit sync` is not needed because the vitest config
doesn't import kit — if vitest errors on missing `./$types`, run the check
script's sync first: change the step to
`pnpm --filter dashboard exec svelte-kit sync && pnpm --filter dashboard test`.)

Root `pnpm test` (`pnpm -r run test`) now automatically includes the
dashboard — no root change needed.

**Verify**: `pnpm test` from the repo root → BOTH `api` and `dashboard` test scripts execute (visible in pnpm's per-package output); exit 0.

## Test plan

This plan is the test plan (Steps 3–4). Pattern: `apps/api/src/parsers/playwright.test.ts` for structure. Gate: `pnpm test` at root runs both packages green.

## Done criteria

ALL must hold:

- [ ] `apps/dashboard/package.json` has a `test` script; `pnpm --filter dashboard test` exits 0 with ≥ 11 passing tests
- [ ] `pnpm test` at the root runs api AND dashboard suites (dashboard no longer skipped)
- [ ] `.github/workflows/ci.yml` test job contains the dashboard test step
- [ ] `pnpm --filter dashboard check` → 0 errors, 0 warnings
- [ ] `pnpm lint` exits 0
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- vitest 4.x cannot resolve the `$env/dynamic/public` alias as configured
  (error persisting after checking the path) — report the exact resolution
  error; do not restructure `api.ts` to avoid the virtual module (out of
  scope here; that refactor belongs to plan 008's owner to decide).
- Importing `./+layout.server` from a test pulls in other `$app/*` virtual
  modules that can't be aliased the same way — report which; component-level
  refactors to enable testing are out of scope.
- Case 5 of Step 4 does NOT reject (would mean error handling already exists
  — plan 008 may have landed first; adapt the case to assert the fallback
  shape instead and note it).

## Maintenance notes

- Plan 008 changes `fetchJson`'s error behavior (throwing SvelteKit `error()`
  instead of bare `APIError` for load contexts) and the layout's error
  handling — it MUST update Step 3 case 2/3 and Step 4 case 5 assertions as
  part of its diff.
- When someone adds component tests later, extend `vitest.config.ts` with the
  Svelte plugin + jsdom environment in a separate `test.projects` entry
  rather than changing this node-env config.
- Deferred: E2E (Playwright) tests for the dashboard — tracked as a roadmap
  item in `.agent/CONTEXT.md`, intentionally not part of this baseline.
