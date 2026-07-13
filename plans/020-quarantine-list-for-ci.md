# Plan 020: Expose a machine-readable quarantine list so CI can act on flakiness

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 1642dc4..HEAD -- apps/api/src/routes/projects.ts apps/api/src/db/schema.ts docs/API.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW (new read-only endpoint; no migration; no writes)
- **Depends on**: none (plan 012 already landed the `ignored` status this reads)
- **Category**: direction
- **Planned at**: commit `1642dc4`, 2026-07-13

## Why this matters

Flackyness today is observe-only. It knows exactly which tests are flaky and
which ones an operator has muted, but that knowledge never leaves the
dashboard — so a developer still gets a red pipeline from a test everyone
already agreed is flaky. Nothing in the product lets CI *act* on what
Flackyness knows.

This plan adds one read-only endpoint that publishes the quarantine set in a
shape a CI job can consume directly, including a ready-made Playwright
`--grep-invert` pattern. That is the step from "we have a dashboard about
flakiness" to "flakiness stops breaking our builds."

## Current state

### The data already exists

`apps/api/src/db/schema.ts:69-90` — the `flaky_tests` table. `status` is the
column this plan reads:

```ts
export const flakyTests = pgTable('flaky_tests', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }).notNull(),
  testName: varchar('test_name', { length: 500 }).notNull(),
  testFile: varchar('test_file', { length: 500 }),
  firstDetected: timestamp('first_detected'),
  lastSeen: timestamp('last_seen'),
  flakeCount: integer('flake_count').default(0),
  totalRuns: integer('total_runs').default(0),
  flakeRate: decimal('flake_rate', { precision: 5, scale: 4 }), // 0.0000 to 1.0000
  status: varchar('status', { length: 20 }).default('active'), // active, resolved, ignored
}, (table) => ({
  projectStatusIdx: index('flaky_tests_project_status_idx')
    .on(table.projectId, table.status),
  ...
}));
```

**The three status values mean:**
- `active` — auto-detected as flaky by the current threshold. Machine judgment.
- `ignored` — an operator explicitly muted it (plan 012, `PATCH
  /api/v1/tests/flaky/:id`). Human judgment: "don't fail the build on this."
- `resolved` — was flaky, no longer meets the threshold. System-managed.

There is a composite index on `(project_id, status)` — the exact shape this
endpoint's query needs. No new index, and **no migration**, is required.

### Where the endpoint goes

`apps/api/src/routes/projects.ts:1-14` — the router you will extend. Note it
already applies rate limiting at the router level, so your new route inherits
it automatically (do NOT add a second limiter):

```ts
import { Hono } from 'hono';
import { z } from 'zod';
import { eq, desc, and, gte } from 'drizzle-orm';
import { db, projects, flakyTests, testRuns } from '../db';
import { getProjectStats, analyzeFlakiness, resolveProjectConfig } from '../services/flakiness';
import { apiRateLimit } from '../middleware/rate-limit';

const projectsRouter = new Hono();

const uuidSchema = z.string().uuid();
const flakyStatusSchema = z.enum(['active', 'resolved', 'ignored', 'all']).default('active');

// Apply rate limiting
projectsRouter.use('*', apiRateLimit);
```

The existing `GET /:id/flaky-tests` route in the same file is your structural
exemplar — copy its shape (uuid validation → 400, drizzle select, `c.json`):

```ts
projectsRouter.get('/:id/flaky-tests', async (c) => {
  const parsed = uuidSchema.safeParse(c.req.param('id'));
  if (!parsed.success) {
    return c.json({ error: 'Invalid project ID format' }, 400);
  }
  const projectId = parsed.data;
  ...
  const flakyTestsList = await db
    .select({ /* explicit column list */ })
    .from(flakyTests)
    .where(and(eq(flakyTests.projectId, projectId), /* status filter */))
    .orderBy(desc(flakyTests.flakeRate))
    .limit(limit);
```

### Auth posture (do not change it)

Routes on `projectsRouter` are **unauthenticated reads**, by design. From
`.agent/CONTEXT.md`: *"Unauthenticated read APIs (`/projects/*`, `/tests/*`) —
intentional for the current internal/self-hosted use (concept validation)."*
`GET /:id/flaky-tests` already publishes the same underlying rows with no auth.
Your new endpoint is **no more sensitive than what is already public**, so it
is also unauthenticated. Do NOT add `projectAuth()` or `adminAuth()` — that
would break the convention and force CI to hold a token it doesn't need for a
read.

## Design decisions (advisor — do not relitigate)

1. **Route**: `GET /api/v1/projects/:id/quarantine`, on `projectsRouter` in
   `apps/api/src/routes/projects.ts`.

2. **Two sets, never conflated.** The response separates human judgment from
   machine judgment, because auto-skipping a machine-detected test without
   sign-off can silently hide a real regression:
   - `muted` — `status = 'ignored'`. An operator said so. **Safe to skip.**
   - `flaky` — `status = 'active'`. Auto-detected. **Advisory: retry or
     annotate, do not skip.**

3. **`grepInvert` is built from `muted` ONLY.** This is the load-bearing safety
   decision of the plan. The ready-to-use skip pattern must never include
   auto-detected tests.

4. **Regex escaping is mandatory.** Test names routinely contain regex
   metacharacters (`.`, `(`, `)`, `[`, `*`, `+`, `?`, `|`, `$`, `^`). Building
   the `grepInvert` pattern by naive concatenation produces either a broken
   regex or — worse — one that silently matches the wrong tests. Escape every
   name before joining. Write the escape helper and unit-test it (see Test
   plan).

5. **No pagination limit.** Every other list route clamps to 1–100; this one
   must NOT, because a CI consumer needs the *complete* set or the skip list is
   wrong. Apply a hard safety cap of 1000 rows and set a
   `truncated: true` flag on the response if the cap is hit (a project with
   >1000 quarantined tests has a bigger problem than pagination).

6. **`?format=playwright` returns `text/plain`** — the bare `grepInvert`
   regex and nothing else, so a CI job can do
   `curl … > skip.txt` without needing `jq`. Default (no `format`) is JSON.

7. **No new dependency, no migration, no writes.** If you find yourself
   generating a migration or adding a package, you have misread the plan.

### Response shape (JSON, default)

```jsonc
{
  "projectId": "…",
  "muted":  [ { "testName": "…", "testFile": "…", "flakeRate": "0.4200", "lastSeen": "…" } ],
  "flaky":  [ { "testName": "…", "testFile": "…", "flakeRate": "0.1100", "lastSeen": "…" } ],
  "grepInvert": "^(?:escaped\\.name\\ one|escaped\\ name\\ two)$",  // muted only; "" when none
  "truncated": false
}
```

`grepInvert` is `""` (empty string) when `muted` is empty — NOT `null`, and
NOT a regex that matches everything. A CI job doing
`playwright test --grep-invert "$(curl …)"` with an empty pattern must run the
full suite, never zero tests. This is a real footgun; the test plan pins it.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `CI=true pnpm install --frozen-lockfile` | exit 0 |
| Typecheck | `pnpm --filter api exec tsc --noEmit` | exit 0, no output |
| Tests | `pnpm --filter api test` | all pass |
| Lint | `rtk proxy pnpm lint` (plain `pnpm lint` is garbled by a hook) | exit 0 under `--deny-warnings` |

**Disposable Postgres** (DB-gated tests self-skip without it):

```bash
docker run -d --name flackyness-test-pg-020 \
  -e POSTGRES_PASSWORD=test_password -e POSTGRES_DB=flackyness_test \
  -p 5442:5432 postgres:16-alpine
touch .env   # repo root; db:migrate hard-fails if it doesn't exist
DATABASE_URL=postgres://postgres:test_password@localhost:5442/flackyness_test pnpm db:migrate
```

**ALWAYS** remove the container and any temp `.env` when done, even on failure.
**NEVER** run `docker compose up` — it collides with the operator's own stack.

## Scope

**In scope**:
- `apps/api/src/routes/projects.ts` — the new route + the escape helper
- `apps/api/src/routes/projects.test.ts` — new tests
- `docs/API.md` — document the endpoint

**Out of scope** (do NOT touch):
- `apps/api/src/db/schema.ts` — no schema change; this endpoint only reads.
- `apps/api/src/services/flakiness.ts` — do not change how flakiness is
  computed. This plan *publishes* existing state; it does not redefine it.
- `apps/api/src/routes/tests.ts` — the mute PATCH already exists and is correct.
- The dashboard — no UI work in this plan.
- Any auth change to `projectsRouter` (see "Auth posture" above).

## Git workflow

Branch `advisor/020-quarantine-list-for-ci`; single-line conventional-commit
subject (e.g. `feat(api): expose quarantine list for CI consumption`); **no
`Co-Authored-By` trailer**; do not push or open a PR unless the operator
instructed it.

## Steps

### Step 1: Regex-escape helper

In `apps/api/src/routes/projects.ts`, add a module-level helper above the
routes:

```ts
/**
 * Escape regex metacharacters so a test name is matched literally inside the
 * generated --grep-invert pattern. Test names routinely contain `.`, `(`, `)`
 * and `[` — unescaped, they silently match the wrong tests.
 */
function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

**Verify**: `pnpm --filter api exec tsc --noEmit` → exit 0.

### Step 2: The route

Add `GET /:id/quarantine` to `projectsRouter`, following the exemplar shape
above:

1. Validate `:id` with `uuidSchema` → 400 `{ error: 'Invalid project ID format' }`
   on failure (match the existing message exactly).
2. One query: select the columns in the response shape from `flakyTests` where
   `projectId` matches and `status` is `'ignored'` OR `'active'` (use
   `inArray(flakyTests.status, ['ignored', 'active'])` — import `inArray` from
   `drizzle-orm`). Order by `desc(flakyTests.flakeRate)`. Cap at 1001 rows so
   you can detect overflow, then slice to 1000 and set `truncated` accordingly.
3. Partition the rows in JS into `muted` (`status === 'ignored'`) and `flaky`
   (`status === 'active'`).
4. Build `grepInvert` from `muted` only: `""` when empty, otherwise
   `^(?:${muted.map(t => escapeRegex(t.testName)).join('|')})$`.
5. If `c.req.query('format') === 'playwright'`: set
   `Content-Type: text/plain; charset=utf-8` and return `c.body(grepInvert)`.
   Otherwise return the JSON shape.

**Verify**: `pnpm --filter api exec tsc --noEmit` → exit 0.

### Step 3: Tests

**Verify**: `pnpm --filter api test` → green in both DB and no-DB modes.

### Step 4: Docs

Add a `GET /api/v1/projects/:id/quarantine` section to `docs/API.md`, placed
next to the existing `flaky-tests` endpoint. It must include:
- both response sets and what they mean (human vs machine judgment),
- an explicit warning that `grepInvert` covers **muted tests only**, and that
  skipping auto-detected flaky tests is deliberately not offered,
- a copy-pasteable Playwright CI snippet:

```bash
SKIP=$(curl -s "$FLACKYNESS_URL/api/v1/projects/$PROJECT_ID/quarantine?format=playwright")
if [ -n "$SKIP" ]; then
  npx playwright test --grep-invert "$SKIP"
else
  npx playwright test
fi
```

(The `-n` guard is not decoration — it is what stops an empty pattern from
being passed to `--grep-invert`. Keep it in the docs.)

**Verify**: `rtk proxy pnpm lint` → exit 0.

## Test plan

New tests in `apps/api/src/routes/projects.test.ts`, following the existing
route tests in that file for structure (`app.request()`, DB-gated suites
self-skip when `DATABASE_URL` is unset).

**Pure unit (must run without a DB):**
1. `escapeRegex` escapes every metacharacter class: a name like
   `should handle a.b(c) [x] $y` produces a pattern that matches that literal
   string and nothing else. Assert with `new RegExp(...)`.
2. `grepInvert` for an empty muted set is `""` — assert `=== ''` explicitly,
   NOT just falsy. (This is the "skip everything" footgun.)

**DB-gated:**
3. Seed a project with three flaky rows — one `ignored`, one `active`, one
   `resolved`. Assert: `muted` contains only the ignored one, `flaky` only the
   active one, and the `resolved` row appears in **neither**.
4. `grepInvert` contains the muted test's name and does **not** contain the
   active test's name.
5. `?format=playwright` returns `text/plain` whose body equals the JSON
   response's `grepInvert` exactly.
6. Unknown project id (well-formed uuid, no rows) → 200 with empty arrays and
   `grepInvert === ''` (not 404 — an empty quarantine is a valid answer).
7. Malformed uuid → 400.

## Done criteria

- [ ] `pnpm --filter api exec tsc --noEmit` exits 0
- [ ] `pnpm --filter api test` passes in BOTH modes (with and without `DATABASE_URL`); the new tests above exist and pass
- [ ] `rtk proxy pnpm lint` exits 0
- [ ] `git diff --name-only` shows ONLY the three in-scope files
- [ ] `git status` clean outside scope; **no migration generated** (`git status apps/api/drizzle/` shows nothing new)
- [ ] E2E: against a disposable Postgres, ingest a fixture, mute one test via `PATCH /api/v1/tests/flaky/:id` (needs `ADMIN_TOKEN`), then `curl` the quarantine endpoint and show the muted test in `grepInvert` and the active one absent

## STOP conditions

Stop and report (do not improvise) if:

- `flaky_tests.status` no longer carries the three values `active` / `ignored` /
  `resolved` (the plan's central assumption).
- You conclude the endpoint needs auth to be safe. It reads rows already served
  unauthenticated by `GET /:id/flaky-tests` — if you believe that premise is
  wrong, that is a product decision for the maintainer, not a call to make mid-plan.
- You find yourself wanting to put `active` (auto-detected) tests into
  `grepInvert`. That is explicitly forbidden by design decision 3; if you think
  the feature is useless without it, STOP and say so.
- A migration or new dependency appears necessary.

## Maintenance notes

- **The `grepInvert` empty-string case is the dangerous one.** Any future
  refactor must keep "no muted tests" → `""` → CI runs the *whole* suite. A
  regression here silently skips every test and turns the pipeline green for
  the wrong reason. The reviewer should look at this first.
- Skipping is only ever driven by human-muted tests. If a future plan adds
  auto-quarantine (machine-detected tests skipped without sign-off), it must
  come with an explicit opt-in per project and an expiry, or it will hide real
  regressions.
- Test names are the join key throughout Flackyness (`flaky_tests` is unique on
  `(project_id, test_name)`). If a test is renamed, its quarantine entry is
  orphaned and a new one will be detected from scratch — expected, worth
  documenting if users complain.
- Deferred out of this plan: a GitHub Action that consumes this endpoint and
  comments on the PR (direction finding D2). It depends on this endpoint
  existing, which is why this lands first.
