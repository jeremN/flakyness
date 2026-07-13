# Plan 014: Surface the real-time analysis endpoint in the dashboard

> **Executor instructions**: Follow step by step; run every verification
> command. On any STOP condition, stop and report. Update your row in
> `plans/README.md` when done — unless a reviewer dispatched you and said
> they maintain the index.
>
> **Drift check (run first)**: `git diff --stat 7609d55..HEAD -- apps/dashboard/src/lib/api.ts apps/dashboard/src/routes/+layout.svelte apps/api/src/routes/projects.ts apps/dashboard/src/lib/components/`
> Contradictions with the excerpts below → re-read live code; if the analysis
> endpoint's response shape changed, STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW (purely additive page; no API changes)
- **Depends on**: 012 (soft — both edit `lib/api.ts` and nav-adjacent files; land 012 first to avoid conflicts). Composes with 013 (defaults may become project-specific) but does not require it.
- **Category**: feature (direction D5)
- **Planned at**: commit `7609d55`, 2026-07-10

## Why this matters

The API ships a real-time what-if endpoint the dashboard never calls:
`GET /api/v1/projects/:id/analysis?days=&threshold=`
(`apps/api/src/routes/projects.ts:142-165`) recomputes flakiness live with
caller-chosen window and threshold and returns
`{ windowDays, threshold, flakyTests, allTests }` — where each entry is a
`TestFlakiness` (`services/flakiness.ts:19-29`):
`{ testName, testFile, totalRuns, passCount, failCount, flakyCount, flakeRate, isFlaky, lastSeen }`,
sorted by `flakeRate` desc. The `/flaky` page only shows the *cached
verdict* (`flaky_tests` table at the fixed defaults). An operator asking
"what would count as flaky at 10% over 30 days?" has no UI — this page is
that UI, and it's mostly assembling parts that already exist.

## Current state

- `apps/dashboard/src/lib/api.ts` — all fetchers go through `fetchJson`
  (maps non-OK → kit `error(status>=500?502:status,…)`, network →
  `error(503, …)`). No analysis fetcher. Exemplar to copy —
  `getFlakeTrend` (lines 79–86):

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

- `apps/dashboard/src/routes/+layout.svelte` — nav is a `navItems` array:
  `[{href:'/',label:'Overview',…},{href:'/flaky',label:'Flaky Tests',…},{href:'/runs',label:'Test Runs',…}]`.
  Adding a page = adding one entry.
- Existing page pattern to imitate: `apps/dashboard/src/routes/flaky/`
  (`+page.server.ts` load reads `url.searchParams` + selected project,
  calls a fetcher, returns data; `+page.svelte` renders filter pills via
  href links and a table). Project selection convention: `?project=<id>`
  handled in layout/load code — read how `flaky/+page.server.ts` resolves
  `selectedProject` and do the same.
- `apps/dashboard/src/lib/components/ErrorState.svelte` — has an `onRetry`
  prop that is currently NEVER wired by any page (known dangling affordance).
- Server-side clamps already exist (days 1–90, threshold 0–1,
  `projects.ts:148-152`) — the UI mirrors them but need not enforce them.
- Types live in `apps/dashboard/src/app.d.ts` (`Project`, `FlakyTest`, …) —
  add the new response types there, matching that file's style.

## Design decisions (advisor — do not relitigate)

1. New route `/analysis`: SSR `+page.server.ts` load reading `days` +
   `threshold` from `url.searchParams` (defaults 14 / 0.05) — controls are a
   plain GET `<form>` (SSR-friendly, shareable URLs, zero client fetch). No
   runes-driven client refetch in v1.
2. Table = `allTests` with flaky rows visually flagged (`isFlaky` badge,
   reuse the flaky page's badge classes); summary line above:
   "N of M tests flaky at ≥X% over Y days".
3. No chart in v1 (Chart.svelte registers only LineChart — a new chart type
   silently renders blank unless registered; out of scope here).
4. Bonus (small, in scope): wire `ErrorState`'s `onRetry` where the
   component is rendered with a retry affordance —
   `onRetry={() => invalidateAll()}` (`$app/navigation`). Touch ONLY the
   pages that already render `ErrorState`; no behavior redesign.

## Commands you will need

Dashboard check `pnpm --filter dashboard check`; tests
`pnpm --filter dashboard test` (vitest; needs `.svelte-kit/` — the test
script runs `svelte-kit sync` first); lint `pnpm lint` (garbled output →
`rtk proxy pnpm lint`). For the e2e smoke you need the API up: disposable
Postgres (`docker run -d --name flackyness-test-pg-014 -e POSTGRES_PASSWORD=test_password -e POSTGRES_DB=flackyness_test -p 5435:5432 postgres:16-alpine`),
`touch .env` at repo root,
`DATABASE_URL=postgres://postgres:test_password@localhost:5435/flackyness_test pnpm db:migrate`,
API via `pnpm --filter api dev` with that DATABASE_URL + a test
`ADMIN_TOKEN`, seed one project + upload `apps/api/fixtures/real-report.json`
(see `docs/GETTING_STARTED.md` curl examples). ALWAYS clean up container +
temp `.env`. Never `docker compose up`. Note: `pnpm --filter dashboard preview -- --port N`
does NOT forward the flag — use `npx vite preview --port N` from
`apps/dashboard/`, or just use `dev`.

## Scope

**In scope**: `apps/dashboard/src/lib/api.ts` (one fetcher),
`apps/dashboard/src/app.d.ts` (types), new `apps/dashboard/src/routes/analysis/`
(+page.server.ts, +page.svelte), `apps/dashboard/src/routes/+layout.svelte`
(one navItems entry), pages currently rendering `ErrorState` (onRetry wiring
only), `apps/dashboard/src/lib/api.test.ts` or sibling test files (follow
existing layout), `AGENTS.md`/docs ONLY if a route list exists there (none
expected).

**Out of scope**: ALL of `apps/api/`; Chart.svelte; the flaky page's own
behavior; any client-side state management additions.

## Git workflow

Branch `advisor/014-analysis-view-ui`; single-line conventional commits
(e.g. `feat(dashboard): /analysis what-if view`); NO `Co-Authored-By`
trailers; no push/PR unless the operator instructed it.

## Steps

### Step 1: Types + fetcher

`app.d.ts`: add `TestFlakiness` and
`AnalysisResponse { windowDays: number; threshold: number; flakyTests: TestFlakiness[]; allTests: TestFlakiness[] }`
(note `lastSeen` arrives as an ISO string over JSON — type it `string`).
`lib/api.ts`: add `getAnalysis(projectId: string, days = 14, threshold = 0.05): Promise<AnalysisResponse>`
following the `getFlakeTrend` exemplar (query string
`?days=${days}&threshold=${threshold}`).

**Verify**: `pnpm --filter dashboard check` → 0 errors 0 warnings.

### Step 2: Load function

`routes/analysis/+page.server.ts`, modeled line-for-line on
`routes/flaky/+page.server.ts` (same project resolution): parse
`days` (int, fallback 14) and `threshold` (float, fallback 0.05) from
`url.searchParams`, mirror the server clamps (days 1–90, threshold 0–1) so
the UI never shows values the API silently corrected, call `getAnalysis`,
return `{ analysis, days, threshold, selectedProject, projects }` (match
whatever the flaky page returns for the project switcher to keep working).

### Step 3: Page

`routes/analysis/+page.svelte`, visually consistent with
`flaky/+page.svelte` (same card/table/badge classes — copy its markup
skeleton):

- GET form: number input `days` (min 1 max 90), number input `threshold`
  (min 0 max 1 step 0.01), hidden input preserving the current `project`
  search param, submit "Analyze". Plain form submit = full SSR round trip —
  correct here, do not preventDefault.
- Summary line + table of `allTests`: Test Name / File / Runs / Passed /
  Failed / Flaky count / Flake Rate (percent, 1 decimal) / a "flaky" badge
  when `isFlaky`. Empty state when `allTests` is empty (copy the flaky
  page's empty-state markup).
- Add `{href:'/analysis',label:'Analysis',…}` to `navItems` in
  `+layout.svelte`, matching the existing entries' shape exactly (they may
  carry an icon field — replicate whatever is there).

**Verify**: `pnpm --filter dashboard check` → 0 errors;
`pnpm --filter dashboard test` → all pass.

### Step 4: onRetry wiring

Find every page rendering `<ErrorState` (grep `apps/dashboard/src/routes`).
Where the component supports `onRetry` and the page renders it for a load
failure, pass `onRetry={() => invalidateAll()}` (import from
`$app/navigation`). Confirm `ErrorState.svelte` renders a retry button only
when the prop is provided (read the component first) — if it renders one
unconditionally that no-ops today, this wiring makes it functional; if the
prop doesn't exist anymore, skip this step and note it in your report.

**Verify**: check → 0 errors; tests pass.

### Step 5: Tests + e2e smoke

- Follow the existing dashboard test patterns (see how current tests stub
  `$env/dynamic/public` via the vitest alias and exercise load functions):
  a load test for the analysis page (param parsing incl. clamping and
  garbage input like `days=abc` → fallback), and a `getAnalysis` fetcher
  test if `api.ts` fetchers have per-fetcher tests (mirror them).
- E2E smoke with the API stack from Commands: `curl -s "http://localhost:5173/analysis?project=<id>&days=30&threshold=0.1"` →
  SSR HTML contains the summary line and at least one table row; nav link
  present on `/`. With the API stopped, `/analysis` renders the ErrorState
  (not a blank 500).

**Verify**: assertions above; cleanup done (container, temp `.env`, dev
servers killed).

## Done criteria

- [ ] `/analysis` renders SSR with controls defaulting to 14/0.05; form GET round-trips and re-renders with new params
- [ ] URL params clamped in load; garbage input falls back to defaults
- [ ] Nav shows Analysis on every page; visual style matches the flaky page
- [ ] `getAnalysis` fetcher + types added following `getFlakeTrend` pattern
- [ ] `ErrorState.onRetry` wired (or reported as no-longer-existing)
- [ ] Gates green: dashboard check + tests, `pnpm lint`; API untouched (`git diff --stat` shows nothing under `apps/api/`)

## STOP conditions

- The analysis response shape differs from the excerpt (e.g. plan 013 landed
  and added fields) — additive fields are fine, missing/renamed ones are a STOP.
- The project-selection convention in `flaky/+page.server.ts` is more
  involved than searchParams (e.g. cookies) and copying it doesn't work → report.
- `ErrorState` has no `onRetry` prop anymore → skip Step 4, note it.

## Maintenance notes

- If plan 013 (per-project thresholds) lands, the analysis route's DEFAULTS
  become project-specific; this page's hardcoded 14/0.05 fallbacks will then
  disagree with the server's resolved defaults for configured projects.
  Cheap fix at that point: read `windowDays`/`threshold` from the RESPONSE
  (the API echoes what it used) instead of assuming the request values.
- The endpoint recomputes in memory per request (comment at
  `projects.ts:148-149`) — if this page grows autorefresh or gets embedded
  in dashboards, revisit rate limiting/caching first.
