# Plan 028: Make the flake trend honest, and make the per-test one visible

> **Executor instructions**: Follow this plan step by step. Run every verification
> command and confirm the expected result before moving on. Honor the STOP conditions.
> Do not update `plans/README.md` — the reviewer maintains the index.
>
> **Drift check (run first)**: `git rev-parse --short HEAD` should be at or after
> `b92fb3f`. Then confirm `apps/api/src/routes/projects.ts` still contains the line
> quoted in "Current state" below. On a mismatch, STOP and report.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED — changes the response shape of a **shipped** endpoint that the
  dashboard's headline chart renders. Read the migration note carefully.
- **Depends on**: none. **Parallel-safe**: this plan is the sole owner of
  `apps/api/src/routes/projects.ts`, `apps/dashboard/src/lib/api.ts`, and the
  dashboard trend pages. Two other plans (029, 030) run alongside it and touch
  neither.
- **Category**: correctness + direction
- **Planned at**: commit `b92fb3f`, 2026-07-13

## Why this matters

Two problems, one theme: **the trend chart currently lies, and the honest trend is
invisible.**

### Problem 1 — the chart on the front page reports `0%` for days that never ran

`apps/api/src/routes/projects.ts` (the `GET /:id/trend` endpoint that feeds the
dashboard's headline "Flake Rate Trend" chart) ends its daily loop with:

```ts
  for (const [day, data] of dailyMap) {
    const date = new Date(`${day}T00:00:00Z`);
    trendDays.push(date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }));
    rates.push(data.total > 0 ? Math.round((data.flaky / data.total) * 1000) / 10 : 0);
  }

  return c.json({ days: trendDays, rates });
```

A day with **no runs at all** (`data.total === 0`) pushes **`0`**. So a weekend, an
outage, or a paused pipeline renders as a confident flat **0% flake rate** — visually
identical to "CI ran and nothing flaked."

This is the exact invariant plan 025 was built to protect on the *per-test* endpoint:
**"the test didn't run" and "the test ran and never flaked" are different facts.**
Collapsing them draws a reassuring line straight through a hole in the data — and it
reassures you hardest in precisely the situation where the tool knows nothing. The
per-test endpoint gets this right; the one actually on screen does not.

### Problem 2 — the `days` clamp lets `NaN` through

Same file, same endpoint:

```ts
  const days = Math.min(Math.max(parseInt(c.req.query('days') || '7', 10), 1), 90);
```

`parseInt('abc', 10)` is `NaN`, and **every** `Math.min`/`Math.max` comparison against
`NaN` is `false`, so `NaN` sails straight through a clamp that looks airtight. The loop
`for (let i = NaN - 1; i >= 0; i--)` then never executes, and the endpoint returns
`{"days": [], "rates": []}` — an empty chart, for what is really a typo'd query param.
The clamp guards the *range* but not the *type*.

(Plan 025 fixed this in `tests.ts`. `projects.ts` is where the pattern was **copied
from** and was left alone to keep that diff in scope. This is the cleanup.)

### Problem 3 — we shipped a per-test trend endpoint nobody can see

Plan 025 landed `GET /api/v1/tests/:testName/trend` — a per-test daily flake-rate series
plus a `direction` (`improving` / `worsening` / `stable` / `insufficient-data`). The
dashboard has a `/tests/[testName]` detail page. **They have never been connected.**
`apps/dashboard/src/lib/api.ts` has no fetcher for it, and
`routes/tests/[testName]/+page.server.ts` loads only `getTestHistory`. The feature is
dead weight until it's on screen.

## Current state (verified — quote these exactly)

`apps/dashboard/src/lib/api.ts`:

```ts
export async function getFlakeTrend(
  projectId: string,
  days: number = 7
): Promise<{ days: string[]; rates: number[] }> {
  return fetchJson<{ days: string[]; rates: number[] }>(
    `/api/v1/projects/${projectId}/trend?days=${days}`
  );
}
```

`apps/dashboard/src/routes/tests/[testName]/+page.server.ts` (complete):

```ts
import type { PageServerLoad } from './$types';
import { getTestHistory } from '$lib/api';
import { error } from '@sveltejs/kit';

export const load: PageServerLoad = async ({ params, url }) => {
  const testName = params.testName;
  const projectId = url.searchParams.get('project');

  if (!projectId) {
    throw error(400, 'Project ID is required');
  }

  const testHistory = await getTestHistory(testName, projectId);

  return {
    testHistory,
    projectId,
  };
};
```

The overview chart's tooltip in `apps/dashboard/src/routes/+page.svelte` — **this will
need to handle `null`**, or a no-data day renders as `Flake Rate: null%`:

```ts
      formatter: (params: unknown) => {
        const p = params as Array<{ name: string; value: number }>;
        return `${p[0].name}<br/>Flake Rate: <b>${p[0].value}%</b>`;
      },
```

The per-test trend endpoint you are surfacing already returns:
`{ testName, projectId, days, direction, trend: [{ date, totalRuns, failed, flaky, flakeRate }] }`,
where **`flakeRate` is `null` on a day the test did not run**. Read
`apps/api/src/routes/tests.ts` (`buildTrend` + the `/:testName/trend` route) before you
build the UI — do not re-derive its semantics from this plan.

## Design decisions (advisor — do not relitigate)

1. **`rates` becomes `(number | null)[]`.** A day with zero runs is `null`, never `0`.
   This is a deliberate, breaking-ish response change to a shipped endpoint, and it is
   the whole point of the plan. Document it in `docs/API.md`.
2. **ECharts renders `null` in a line series as a gap** — that is the correct visual:
   the line should *break* where there is no data, not flatline at zero. Do **not** set
   `connectNulls: true`; a connected line across a gap re-tells the same lie.
3. **The `days` clamp gets an explicit `Number.isNaN` guard**, defaulting to `7` (this
   endpoint's existing default — *not* 30; `tests.ts` uses 30, this one uses 7, and both
   are correct for their own contract). Do **not** use `parseInt(...) || 7` — that would
   also swallow `days=0` into 7 instead of clamping it to 1. Do **not** use
   `z.coerce.number().min(1).max(90).catch(7)` — `.catch()` fires on *any* failure, so
   `days=999` would fall back to 7 instead of clamping to 90.
4. **On the per-test page, show the trend chart AND the `direction`.** The direction is
   the answer to the question a human actually asks ("is this getting worse?"). Render
   `insufficient-data` honestly — do not disguise it as `stable`.
5. **The dashboard degrades gracefully on API failure** (plan 008 established this).
   Follow the existing pattern in the neighbouring `+page.server.ts` files; a failed
   trend fetch must not 500 the whole page.

## Scope

**In scope** (this plan owns these files exclusively):
- `apps/api/src/routes/projects.ts` — the `NaN` guard + `null`-not-`0`
- `apps/api/src/routes/projects.test.ts` — tests for both
- `docs/API.md` — document the `rates` shape change and the clamp
- `apps/dashboard/src/lib/api.ts` — `getFlakeTrend` return type; new `getTestTrend`
- `apps/dashboard/src/routes/+page.svelte` — tooltip/chart must handle `null`
- `apps/dashboard/src/routes/tests/[testName]/+page.server.ts` and `+page.svelte`
- Dashboard unit tests (co-located `*.test.ts`, e.g. `src/lib/api.test.ts`)

**Out of scope** (do NOT touch — other plans own these, running in parallel):
- `apps/api/src/routes/tests.ts` and `tests.test.ts` — plan 029 owns the test file;
  **read `tests.ts` for the endpoint contract, change nothing in it**
- `.github/workflows/ci.yml` — plan 029
- `.agent/CONTEXT.md`, `AGENTS.md` — plan 030
- `apps/api/src/services/flakiness.ts` — the flake-rate definition is correct; leave it
- `apps/dashboard/src/lib/components/Chart.svelte` — if you need a new ECharts series
  type, STOP and report (it must be registered in `echarts.use([...])`, and there is now
  a `chart-registration.test.ts` that will fail loudly if you forget — do not "fix" that
  test to make it pass)
- **No migration.** Nothing here needs a schema change.

## Steps

### Step 1: Fix the API (`projects.ts`)

Guard the parse, and emit `null` for empty days:

```ts
const rawDays = parseInt(c.req.query('days') ?? '', 10);
const days = Number.isNaN(rawDays) ? 7 : Math.min(Math.max(rawDays, 1), 90);
```

and

```ts
rates.push(data.total > 0 ? Math.round((data.flaky / data.total) * 1000) / 10 : null);
```

(type `rates` as `(number | null)[]`). Add a comment on the `null` explaining *why* it
isn't `0` — the next person will otherwise "simplify" it back.

**Verify**: `pnpm --filter api exec tsc --noEmit` → 0 errors.

### Step 2: Test the API

In `projects.test.ts`, add tests asserting:
- `?days=abc` → 200, and the series has the **default 7** entries (not empty)
- `?days=999` → clamped to 90 entries (guard the clamp you didn't break)
- a day with no runs has `rates[i] === null`, **explicitly `=== null` and `!== 0`**

**Prove your null test bites**: temporarily revert `null` → `0` and show the test
failing, then restore. Paste both. A test that would pass anyway proves nothing — that
is the entire lesson this repo keeps re-learning.

### Step 3: Surface the per-test trend

Add `getTestTrend(testName, projectId, days)` to `lib/api.ts`, load it in
`routes/tests/[testName]/+page.server.ts` alongside the existing history, and render on
`+page.svelte`: a line chart of `flakeRate` over time (nulls = gaps) and the `direction`.

### Step 4: Make the overview chart null-safe

`+page.svelte`'s tooltip formatter must not print `null%`. Show something honest like
"no runs" for a null bucket. Update the `getFlakeTrend` return type.

**Verify**: `pnpm --filter dashboard check` → 0 errors; `pnpm --filter dashboard test`.

## Done criteria

- [ ] `?days=abc` on **both** trend endpoints returns a default-length series, not an empty one
- [ ] `GET /projects/:id/trend` returns `null` (not `0`) for a day with no runs, proven by a test that fails when reverted (paste both)
- [ ] The per-test trend is visible on `/tests/[testName]`, showing the chart **and** the direction
- [ ] The overview chart renders gaps (not a flat 0% line) across no-run days, and its tooltip never prints `null%`
- [ ] `pnpm --filter api exec tsc --noEmit`, `pnpm --filter dashboard check`, `rtk proxy pnpm lint` → all clean
- [ ] `pnpm test` green; `pnpm --filter dashboard test:e2e` still green **3 consecutive runs** (you changed the page its specs assert on)
- [ ] `docs/API.md` documents the `rates` null semantics
- [ ] **No file outside the "In scope" list is modified** — prove with `git diff --name-only main`

## Test/verification setup

Disposable Postgres — **never `docker compose up`**, and always clean up, even on failure:

```bash
docker run -d --name flackyness-test-pg-028 -e POSTGRES_PASSWORD=test_password \
  -e POSTGRES_DB=flackyness_test -p 5457:5432 postgres:16-alpine
touch .env
DATABASE_URL=postgres://postgres:test_password@localhost:5457/flackyness_test pnpm db:migrate
# ... work ...
docker rm -f flackyness-test-pg-028   # ALWAYS
```

For the E2E run the API must be up (it reads `API_PORT`, **not** `PORT`; default 8080)
and `PUBLIC_API_URL` must point at it. Playwright's `reuseExistingServer` is on locally —
**kill any running `node build` before an E2E run** or you will test a stale build and
draw a false conclusion.

## STOP conditions

- **The E2E suite fails after your dashboard change.** That is a real finding about your
  change (its specs assert on the overview and chart). Fix your change — do **not** edit
  the specs to accommodate it, and do **not** touch `chart-registration.test.ts`.
- **You need a new ECharts series type.** STOP and report — it must be registered in
  `Chart.svelte`, which is out of scope.
- **Making `rates` nullable breaks something you can't see how to fix honestly.** STOP and
  report rather than reverting to `0`. Reverting re-introduces the lie.
- A test you write passes both with and without the bug. STOP — you have written a
  decoration, not a test.

## Maintenance notes

- **The null-not-zero rule is now repo-wide**: `tests.ts` (plan 025) and `projects.ts`
  (this plan) both hold it. Any future time series must too. "No data" ≠ "zero".
- The two trend endpoints deliberately have **different defaults** (7 for project, 30 for
  per-test). That is not a bug; do not "harmonise" them without a reason.
- Both trends are bounded by retention (plan 021): a project with `retentionDays: 30`
  structurally cannot return 90 days of history, because the underlying runs are gone.
