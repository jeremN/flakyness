# Plan 025: Answer "is this test getting worse?" — per-test flake-rate trend

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 38c1eaf..HEAD -- apps/api/src/routes/tests.ts apps/api/src/routes/projects.ts docs/API.md`
> On a mismatch with the excerpts below, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW (new read-only endpoint; **no migration**, no new table, no deps)
- **Depends on**: none
- **Category**: direction (finding D4)
- **Planned at**: commit `38c1eaf`, 2026-07-13

## Why this matters

`flaky_tests` stores only a test's **current** `flakeRate`. There is no history,
so the product cannot answer the question every engineer actually asks: *"is this
test getting worse, or is it settling down?"* Plan 016's webhooks fire only on
`active`↔`resolved` transitions, which means a test whose flake rate quietly
triples from 5% to 15% — never crossing a threshold boundary — generates no signal
at all.

## The design question this plan settles (read before you start)

The obvious implementation is a `flaky_test_snapshots` table written on every
ingest. **We are deliberately NOT doing that**, and you should understand why
before you are tempted to add one.

The raw material already exists: `test_results` retains one row per test per run,
each with a `created_at` and a `status`. A per-test daily flake rate is therefore
**derivable on demand** — no new table, no write amplification on the ingest path,
no migration, and no risk of the snapshot table drifting out of sync with the
results it summarizes. The repo already does exactly this kind of daily bucketing
in `GET /projects/:id/trend`.

The honest cost: the trend horizon is bounded by what `test_results` still holds,
so a project with retention configured (plan 021) can only see back as far as its
`retentionDays`. That is a real limitation and you must **document it** (Step 3),
not hide it. If a user later needs history that outlives retention, *that* is when
a snapshot table earns its place — with a concrete requirement behind it rather
than a guess.

## Current state

### The existing daily-bucketing precedent — copy this shape

`apps/api/src/routes/projects.ts`, `GET /:id/trend` (abridged, real code):

```ts
projectsRouter.get('/:id/trend', async (c) => {
  const parsed = uuidSchema.safeParse(c.req.param('id'));
  if (!parsed.success) {
    return c.json({ error: 'Invalid project ID format' }, 400);
  }
  const projectId = parsed.data;
  const days = Math.min(Math.max(parseInt(c.req.query('days') || '7', 10), 1), 90);

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const runs = await db
    .select({ createdAt: testRuns.createdAt, totalTests: testRuns.totalTests,
              flaky: testRuns.flaky, failed: testRuns.failed })
    .from(testRuns)
    .where(and(eq(testRuns.projectId, projectId), gte(testRuns.createdAt, cutoff)))
    .orderBy(testRuns.createdAt);

  // Aggregate by day
  const dailyMap = new Map<string, { total: number; flaky: number }>();
  for (let i = days - 1; i >= 0; i--) {
    …  // zero-fills every day in the window, so gaps appear as 0, not as missing keys
  }
  …
```

Two things to carry over: the **`days` clamp to [1, 90]** (a DoS guard — plan 005
added it deliberately) and the **zero-fill loop**, so a day with no runs is
reported as an explicit zero rather than a hole in the series.

### Where your endpoint goes

`apps/api/src/routes/tests.ts` — the router that already owns per-test reads. Its
head (real code):

```ts
const testsRouter = new Hono();
const uuidSchema = z.string().uuid();

// Apply rate limiting
testsRouter.use('*', apiRateLimit);
```

Rate limiting is applied at the router level — your route inherits it. **Do NOT
add a second limiter.**

The sibling route `GET /:testName/history` shows the conventions to match: it
requires a `project` query param (uuid-validated → 400), joins `test_results` to
`test_runs` to scope by project, and clamps `limit`:

```ts
testsRouter.get('/:testName/history', async (c) => {
  const testName = c.req.param('testName');
  const projectId = c.req.query('project');
  …
  if (!projectId) {
    return c.json({ error: 'project query parameter is required' }, 400);
  }
  const parsedProjectId = uuidSchema.safeParse(projectId);
  if (!parsedProjectId.success) {
    return c.json({ error: 'Invalid project ID format' }, 400);
  }

  const history = await db
    .select({ … })
    .from(testResults)
    .innerJoin(testRuns, eq(testResults.testRunId, testRuns.id))
    .where(and(eq(testResults.testName, testName),
               eq(testRuns.projectId, parsedProjectId.data)))
    .orderBy(desc(testResults.createdAt))
    .limit(limit);
```

**A test name is only unique within a project** — the `flaky_tests` unique index is
`(project_id, test_name)`. So the project scope is not optional: without the
`innerJoin` + `eq(testRuns.projectId, …)`, you would blend two projects' identically
named tests into one bogus trend line.

### How flake rate is defined (match it exactly)

`apps/api/src/services/flakiness.ts`:

```ts
    // Flake rate = (failures + explicit flaky) / total
    const flakeRate = (stats.failCount + stats.flakyCount) / totalRuns;
```

Statuses are `passed`, `failed`, `skipped`, `flaky`. Note `skipped` is counted in
**neither** numerator nor denominator by `computeFlakiness` (it increments no
counter, and `totalRuns = pass + fail + flaky`). Your daily buckets must use the
same definition, or the trend will disagree with the flake rate shown everywhere
else in the product — which is worse than having no trend at all.

## Design decisions (advisor — do not relitigate)

1. **Route**: `GET /api/v1/tests/:testName/trend?project=<uuid>&days=N` on
   `testsRouter`. `days` defaults to 30, clamped to **[1, 90]** (same guard as
   `/projects/:id/trend`).
2. **No new table, no migration, no dependency.** Computed on the fly from
   `test_results`. If you find yourself running `pnpm db:generate`, you have
   misread the plan.
3. **Daily buckets, zero-filled** across the whole window, oldest → newest, so the
   series is always exactly `days` long and a quiet day is an explicit `0`.
4. **A day with no runs reports `flakeRate: null`, not `0`.** This is the one place
   the plan deliberately diverges from `/projects/:id/trend`'s zero-fill: "the test
   didn't run" and "the test ran and never flaked" are completely different facts,
   and rendering both as `0` would draw a reassuring flat line through a gap in the
   data. Include `totalRuns: 0` on those days so a consumer can tell them apart.
   **This is the single most important correctness decision in this plan.**
5. **Also return a `direction` summary**: compare the mean flake rate of the first
   half of the window against the second half (over days that actually have runs),
   and report `'improving' | 'worsening' | 'stable' | 'insufficient-data'`. Use a
   ±0.05 absolute dead-band for `stable`, and `insufficient-data` when either half
   has no runs at all. This is what makes the endpoint *answer the question* rather
   than just hand back numbers.
6. **Unauthenticated read**, consistent with every other route on this router
   (documented as by-design in `.agent/CONTEXT.md`). Do not add auth.

### Response shape

```jsonc
{
  "testName": "Checkout › should complete purchase",
  "projectId": "…",
  "days": 30,
  "direction": "worsening",          // improving | worsening | stable | insufficient-data
  "trend": [
    { "date": "2026-06-14", "totalRuns": 4, "failed": 0, "flaky": 0, "flakeRate": 0 },
    { "date": "2026-06-15", "totalRuns": 0, "failed": 0, "flaky": 0, "flakeRate": null },  // no runs
    { "date": "2026-06-16", "totalRuns": 5, "failed": 2, "flaky": 1, "flakeRate": 0.6 }
  ]
}
```

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Install | `CI=true pnpm install --frozen-lockfile` | exit 0 |
| Typecheck | `pnpm --filter api exec tsc --noEmit` | exit 0 |
| Tests | `pnpm --filter api test` | all pass |
| Lint | `rtk proxy pnpm lint` (plain `pnpm lint` is garbled by a hook) | exit 0 |

**Disposable Postgres** (DB-gated tests self-skip without it):

```bash
docker run -d --name flackyness-test-pg-025 \
  -e POSTGRES_PASSWORD=test_password -e POSTGRES_DB=flackyness_test \
  -p 5451:5432 postgres:16-alpine
touch .env   # repo root; db:migrate hard-fails if it doesn't exist
DATABASE_URL=postgres://postgres:test_password@localhost:5451/flackyness_test pnpm db:migrate
```

**ALWAYS** remove the container and any temp `.env` when done, even on failure.
**NEVER** `docker compose up` — it collides with the operator's stack.

## Scope

**In scope**:
- `apps/api/src/routes/tests.ts` — the new route (+ a small exported pure helper for
  the bucketing/direction maths, so it can be unit-tested without a DB)
- `apps/api/src/routes/tests.test.ts` — new tests
- `docs/API.md` — document the endpoint, including the retention caveat

**Out of scope** (do NOT touch):
- `apps/api/src/db/schema.ts` — **no new table, no migration.** See "The design
  question this plan settles".
- `apps/api/src/services/flakiness.ts` — read the flake-rate definition from it;
  change nothing.
- `apps/api/src/routes/reports.ts` — no writes on the ingest path.
- The dashboard — surfacing this in the UI is a separate plan.
- `apps/api/src/routes/projects.ts` — do not "improve" the existing project trend
  endpoint while you're here.

## Git workflow

Branch `advisor/025-per-test-flake-trend`; single-line conventional-commit subject
(e.g. `feat(api): per-test flake-rate trend endpoint`); **no `Co-Authored-By`**;
do not push or open a PR unless the operator instructed it.

## Steps

### Step 1: Pure helper

In `apps/api/src/routes/tests.ts`, add an exported pure function that takes the raw
rows and the window and returns the response's `trend` + `direction`. Keep it free
of I/O so it can be unit-tested with no database:

```ts
export interface TrendRow { status: string; createdAt: Date }
export interface TrendBucket {
  date: string; totalRuns: number; failed: number; flaky: number; flakeRate: number | null;
}
export function buildTrend(rows: TrendRow[], days: number, now: Date):
  { trend: TrendBucket[]; direction: 'improving' | 'worsening' | 'stable' | 'insufficient-data' }
```

Rules (from design decisions 3–5): zero-fill every day in the window; `skipped` counts
toward nothing; `flakeRate = (failed + flaky) / totalRuns`; **`flakeRate` is `null`
when `totalRuns === 0`**; `direction` compares first-half vs second-half means over
days with runs, ±0.05 dead-band, `insufficient-data` when either half is empty.

Take `now` as a parameter — do not call `new Date()` inside the helper, or the tests
cannot pin the window deterministically.

**Verify**: `pnpm --filter api exec tsc --noEmit` → exit 0.

### Step 2: The route

`GET /:testName/trend` on `testsRouter`, mirroring `/:testName/history`'s validation:
require `project` (uuid → 400 with the existing message strings), clamp `days` to
[1, 90] defaulting to 30, then one query — `test_results` innerJoin `test_runs`,
filtered by `eq(testResults.testName, testName)` **and**
`eq(testRuns.projectId, projectId)` **and** `gte(testResults.createdAt, cutoff)` —
selecting only `status` and `createdAt`. Feed the rows to `buildTrend`.

**Verify**: `pnpm --filter api exec tsc --noEmit` → exit 0.

### Step 3: Docs

Add the endpoint to `docs/API.md` next to the existing per-test history endpoint.
It MUST state:
- `flakeRate: null` means **the test did not run that day** — it is not a zero.
- The trend horizon is bounded by the project's **retention** (plan 021): if
  `retentionDays` is set, days older than that have no `test_results` left and will
  report `totalRuns: 0` / `flakeRate: null`. Say this plainly; a silently truncated
  trend is a trap.
- How `direction` is computed (first vs second half, ±0.05 dead-band).

**Verify**: `rtk proxy pnpm lint` → exit 0.

## Test plan

New tests in `apps/api/src/routes/tests.test.ts`, following the existing suites there.

**Pure unit (no DB — these carry most of the value):**
1. A test that runs every day, never failing → all buckets `flakeRate: 0`,
   `direction: 'stable'`.
2. A test whose flake rate climbs across the window → `direction: 'worsening'`.
3. …and the mirror image → `direction: 'improving'`.
4. **A day with no runs yields `flakeRate: null` and `totalRuns: 0` — NOT `0`.**
   Assert `=== null` explicitly. This is design decision 4 and the plan's key defect
   class.
5. `skipped` results count toward neither numerator nor denominator (a day of only
   skips → `totalRuns: 0`, `flakeRate: null`).
6. A window where one half has no runs at all → `direction: 'insufficient-data'`.
7. The returned series always has exactly `days` entries, oldest first.

**DB-gated:**
8. Two different projects with an **identically named test** → the trend for project
   A does not include project B's results. (Guards the join scope; without it the
   endpoint silently blends projects.)
9. Missing `project` param → 400. Malformed uuid → 400. `days=999` → clamped to 90.

## Done criteria

- [ ] `pnpm --filter api exec tsc --noEmit` exits 0
- [ ] `pnpm --filter api test` passes in BOTH modes (with/without `DATABASE_URL`); all tests above exist and pass
- [ ] `rtk proxy pnpm lint` exits 0
- [ ] **No migration generated** — `git status apps/api/drizzle/` shows nothing new
- [ ] `git status` clean outside the three in-scope files
- [ ] E2E: on a disposable Postgres, ingest a fixture across a few runs, curl the endpoint, and show a plausible series + `direction`

## STOP conditions

- You conclude a snapshot table is necessary after all. Do **not** add one — STOP
  and report your reasoning; that's a product decision with a migration attached.
- The flake-rate definition you derive disagrees with `computeFlakiness`'s
  `(failed + flaky) / total`. Match the service; do not invent a second definition.
- You find yourself tempted to make a no-run day report `flakeRate: 0` "so the chart
  looks nicer". That is the bug this plan exists to avoid.

## Maintenance notes

- **`null` ≠ `0` is the invariant.** Any future consumer (a chart, an alert rule)
  must treat `null` as "no data", never as "healthy". If a dashboard plan later
  renders this, it should break the line at nulls rather than dropping to zero.
- The trend horizon silently shortens for any project that turns on retention. If
  users start asking for history beyond their retention window, *that* is the
  concrete requirement that justifies a snapshot table — and it should be written
  on the ingest path, not backfilled.
- `direction` is a deliberately crude heuristic (two-half means, fixed dead-band).
  It is meant to sort a list, not to be a statistical claim. Resist the urge to
  bolt on regression maths without a user asking for it.
