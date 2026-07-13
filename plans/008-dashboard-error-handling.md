# Plan 008: Stop the dashboard from 500-ing wholesale when the API hiccups

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 0f8b0cc..HEAD -- apps/dashboard/src/`
> Plan 007 adds test files (expected). If `lib/api.ts` or any `+page.server.ts`
> changed beyond that, compare against the excerpts before proceeding; on a
> mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW–MED (error-path rewiring; risk of masking real failures — see steps)
- **Depends on**: plans/007-dashboard-vitest-baseline.md (test harness; this
  plan updates tests 007 wrote)
- **Category**: bug
- **Planned at**: commit `0f8b0cc`, 2026-07-10

## Why this matters

Every page's server load awaits `getProjects()` in the root layout with no
try/catch, the overview load is an all-or-nothing `Promise.all` of four
calls, and `fetchJson` throws a plain `APIError` — which SvelteKit renders as
a 500 regardless of the real status. Consequences: if the API is briefly
down, EVERY dashboard page is a generic 500 screen; a legitimate 404 from the
API also renders as 500; one failing widget call (e.g. trend) blanks the
whole overview even though the other three loaded. Meanwhile
`ErrorState.svelte` exists but is imported nowhere, and `LoadingSkeleton.svelte`
is dead code containing an SSR-hydration hazard (`Math.random()` in markup).

## Current state

Files (all under `apps/dashboard/src/`):

- `lib/api.ts` — `fetchJson` (lines 17–38): non-OK → `throw new
  APIError(response.status, ..., path)`; network → `APIError(0, ...)`.
  SvelteKit treats any non-`HttpError` throw from a load as a 500.
- `routes/+layout.server.ts` — 13 lines, no try/catch:
  `const projects = await getProjects();` then param-based selection
  (full excerpt in plan 007's Current state; identical here).
- `routes/+page.server.ts` — overview load:

```ts
export const load: PageServerLoad = async ({ parent }) => {
  const { selectedProject } = await parent();
  if (!selectedProject) {
    return { stats: null, flakyTests: [], recentRuns: [], trendData: null };
  }
  const projectId = selectedProject.id;
  const [stats, flakyTests, recentRuns, trendData] = await Promise.all([
    getProjectStats(projectId),
    getFlakyTests(projectId, 'active'),
    getProjectRuns(projectId, 5),
    getFlakeTrend(projectId, 7),
  ]);
  return { stats, flakyTests, recentRuns, trendData };
};
```

- `routes/+page.svelte` — already null-tolerant: `{#if !data.stats}` renders
  a "No Projects Found" empty state (lines 112–117); the chart renders under
  `{#if data.trendData}` (line 135); flaky table under `{:else}` sections.
- `routes/flaky/+page.server.ts`, `routes/runs/+page.server.ts` — single
  awaited fetch each after the same `!selectedProject` guard.
- `routes/tests/[testName]/+page.server.ts` — throws kit `error(400, ...)`
  for a missing project param (already correct); `getTestHistory` failures
  propagate as 500s.
- `routes/+error.svelte` — decent error page keyed on `$page.status` (404/
  403/500 titles). Renders whatever `message` the error carries.
- `lib/components/ErrorState.svelte` — props `{ message?, onRetry? }`;
  imported nowhere.
- `lib/components/LoadingSkeleton.svelte` — imported nowhere;
  line 30 `style="width: {Math.random() * 40 + 60}%"`.
- Plan 007's tests (if landed): `lib/api.test.ts` cases asserting `APIError`
  semantics; `routes/layout.server.test.ts` case 5 asserting rejection
  propagates. This plan CHANGES those behaviors and must update those tests.

Convention: Svelte 5 runes (`$props()`, `$derived`); Tailwind utility classes
matching the existing pages (`card`, `text-muted`, etc. defined in `app.css`).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `pnpm --filter dashboard check` | 0 errors, 0 warnings |
| Tests | `pnpm --filter dashboard test` | all pass |
| Build | `pnpm --filter dashboard build` | exit 0 |
| Lint | `pnpm lint` | exit 0 |
| Manual smoke | `pnpm dev` with API stopped, open http://localhost:5173 | banner, not 500 (Step 6) |

## Scope

**In scope** (the only files you should modify/delete):
- `apps/dashboard/src/lib/api.ts`
- `apps/dashboard/src/routes/+layout.server.ts`
- `apps/dashboard/src/routes/+layout.svelte` (banner only)
- `apps/dashboard/src/routes/+page.server.ts`
- `apps/dashboard/src/routes/+page.svelte` (per-widget error states only)
- `apps/dashboard/src/routes/flaky/+page.server.ts`, `apps/dashboard/src/routes/runs/+page.server.ts`
- `apps/dashboard/src/lib/components/LoadingSkeleton.svelte` (delete)
- `apps/dashboard/src/lib/api.test.ts`, `apps/dashboard/src/routes/layout.server.test.ts` (update)

**Out of scope** (do NOT touch):
- `apps/api/**` — no API changes.
- `routes/tests/[testName]/+page.server.ts` — its 400 handling is correct;
  its `getTestHistory` failures become proper status pages automatically via
  Step 1. Only touch it if Step 1 verification shows otherwise (then STOP).
- Retry logic, caching, or loading skeletons — display-layer polish beyond
  error correctness is deferred.

## Git workflow

- Branch: `advisor/008-dashboard-error-handling`
- Conventional-commit, single-line subject only (e.g.
  `fix(dashboard): degrade gracefully when the API is unavailable`). Do NOT
  add any `Co-Authored-By` trailer. Do not push or open a PR unless the
  operator instructed it.

## Steps

### Step 1: Map API failures to real statuses in `fetchJson`

In `lib/api.ts`, import `error` from `@sveltejs/kit`. Keep `APIError` exported
(tests use it), but change `fetchJson`:

- Non-OK response: `throw error(response.status >= 500 ? 502 : response.status,
  \`API request failed (\${response.status}) for \${path}\`)` — a 404 from the
  API becomes a 404 page; a 5xx becomes 502 "bad upstream".
- Network/unknown failure: `throw error(503, \`Cannot reach the Flackyness API
  (\${API_URL}). Is it running?\`)`.
- IMPORTANT: kit's `error()` THROWS an `HttpError` — do not wrap it in another
  try/catch that would re-map it (restructure the current single try/catch so
  `HttpError` passes through: catch, check `instanceof Error && 'status' in err`,
  rethrow if so).

Update `lib/api.test.ts` (plan 007 cases 2–3): assert the thrown object has
`.status === 404` / `.status === 503` and a `.body.message` containing the
path/API_URL respectively (kit's `HttpError` shape), instead of `APIError`.

**Verify**: `pnpm --filter dashboard test` → updated cases pass; `pnpm --filter dashboard check` → 0 errors.

### Step 2: Make the layout survive API-down

Rewrite `+layout.server.ts`:

```ts
import type { ServerLoadEvent } from '@sveltejs/kit';
import { getProjects } from '$lib/api';

export async function load({ url }: ServerLoadEvent) {
  let projects: Awaited<ReturnType<typeof getProjects>> = [];
  let apiError: string | null = null;
  try {
    projects = await getProjects();
  } catch (err) {
    apiError = 'Cannot reach the Flackyness API. Showing an empty dashboard.';
  }
  const selectedProjectId = url.searchParams.get('project') || projects[0]?.id || null;
  const selectedProject = projects.find(p => p.id === selectedProjectId) || projects[0] || null;
  return { projects, selectedProject, apiError };
}
```

Rationale: the layout wraps EVERY page; failing it hard means no page can
render. With `selectedProject: null`, every page's existing
`!selectedProject` guard returns its empty state.

Update `layout.server.test.ts` case 5: `getProjects` rejecting →
`{ projects: [], selectedProject: null, apiError: <string> }` (no rejection).

**Verify**: `pnpm --filter dashboard test` → layout cases pass.

### Step 3: Show the failure in the layout UI

In `+layout.svelte`, at the TOP of the `<main>` element (line ~109,
`<main class="flex-1 p-8 overflow-y-auto bg-[var(--color-bg)]">`), add:

```svelte
{#if data.apiError}
  <div class="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
    {data.apiError}
  </div>
{/if}
```

(`data` is already the layout's prop; match the file's existing class style.)

**Verify**: `pnpm --filter dashboard check` → 0 errors, 0 warnings.

### Step 4: Per-widget degradation on the overview

In `+page.server.ts`, replace `Promise.all` with `Promise.allSettled` and
return `null`/empty per failed slot, plus a flag list:

```ts
const [stats, flakyTests, recentRuns, trendData] = await Promise.allSettled([
  getProjectStats(projectId),
  getFlakyTests(projectId, 'active'),
  getProjectRuns(projectId, 5),
  getFlakeTrend(projectId, 7),
]).then(results => results.map(r => (r.status === 'fulfilled' ? r.value : null)));

return {
  stats: stats ?? null,
  flakyTests: flakyTests ?? [],
  recentRuns: recentRuns ?? [],
  trendData: trendData ?? null,
  partialFailure: [stats, flakyTests, recentRuns, trendData].some(v => v === null),
};
```

(Typing note: the mapped array loses tuple types — destructure with explicit
casts or map each settled result individually; keep `check` clean.)

In `+page.svelte`: import `ErrorState` from
`$lib/components/ErrorState.svelte`; where the trend chart renders
(`{#if data.trendData}` at line ~135), add an `{:else if data.partialFailure}`
branch rendering `<ErrorState message="Couldn't load the flake-rate trend." />`
inside the same card. Do not add error UI to the other widgets beyond what
their existing empty states show — `stats === null` already routes to the
page-level empty state; that's acceptable degradation for this plan.

**Verify**: `pnpm --filter dashboard check` → 0 errors; `pnpm --filter dashboard test` → pass.

### Step 5: Delete `LoadingSkeleton.svelte`

It is imported nowhere and contains a nondeterministic-SSR hazard.

**Verify**: `grep -rn "LoadingSkeleton" apps/dashboard/src` → no matches; `pnpm --filter dashboard build` → exit 0.

### Step 6: Manual smoke test (both directions)

1. API stopped, `pnpm --filter dashboard dev`, open `http://localhost:5173`
   → page renders with the red banner and the "No Projects Found" empty
   state; HTTP status 200; no 500 error page.
2. API running (`docker compose up -d && pnpm db:migrate && pnpm db:seed &&
   pnpm --filter api dev`), reload → normal dashboard, NO banner.
3. Visit `/tests/does-not-exist?project=<seeded-project-uuid>` → a status
   page (404 via Step 1 if the API 404s, or 200 with empty history — record
   which; both are acceptable, 500 is not).

**Verify**: the three observations above; paste them into your report.

## Test plan

- Updated: `lib/api.test.ts` cases 2–3 (HttpError statuses 404/502/503);
  `layout.server.test.ts` case 5 (fallback shape, no rejection).
- New: an overview-load test in `routes/page.server.test.ts` (same mocking
  pattern as the layout test): all four fetchers resolve → full shape;
  `getFlakeTrend` rejects → `trendData: null`, `partialFailure: true`, other
  slots intact; parent gives `selectedProject: null` → empty shape.
- Gate: `pnpm --filter dashboard test` all green.

## Done criteria

ALL must hold:

- [ ] `pnpm --filter dashboard test` exits 0, including the new page-server tests
- [ ] `pnpm --filter dashboard check` → 0 errors, 0 warnings; `pnpm --filter dashboard build` exits 0; `pnpm lint` exits 0
- [ ] `grep -rn "LoadingSkeleton" apps/dashboard/src` → no matches
- [ ] `grep -rn "Promise.all(" apps/dashboard/src/routes/+page.server.ts` → no matches (allSettled in place)
- [ ] Step 6 smoke observations recorded (API-down renders 200 + banner)
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Plan 007's harness is absent (no `pnpm --filter dashboard test`) — land 007
  first.
- Kit's `error()` import in `lib/api.ts` breaks the module for the vitest
  node environment (virtual-module resolution failure) — report; a viable
  alternative (rethrowing `APIError` and translating at each load site)
  changes the design and needs the maintainer's sign-off.
- `+layout.svelte`'s structure at line ~109 doesn't match (drift) — re-read
  the file; if a banner slot is unclear, stop rather than guess placement.
- Step 6.1 still renders a 500 — the layout catch didn't take effect;
  investigate which load threw, report if it's a file out of scope.

## Maintenance notes

- The 502/503 mapping in `fetchJson` is now the ONLY place API failures are
  translated — future fetchers must go through `fetchJson` to inherit it
  (reviewer checklist for new endpoints).
- `apiError` in the layout is stringly-typed on purpose (serialized across
  the server/client boundary); don't put Error objects in load returns.
- Deferred: retry buttons (`ErrorState`'s `onRetry` prop is unused — wiring
  it to `invalidateAll()` is a nice follow-up), skeleton loading states, and
  surfacing partial-failure detail per widget.
