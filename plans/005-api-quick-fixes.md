# Plan 005: API quick fixes (double-decode, hono bump, unbounded list, trend labels, cascade delete, duplicate route, dead lint scripts)

> **Executor instructions**: Follow this plan step by step. The steps are
> independent — if one hits a STOP condition, report it and continue with the
> others. Run every verification command and confirm the expected result
> before moving on. When done, update the status row for this plan in
> `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 0f8b0cc..HEAD -- apps/api/src/routes/ apps/dashboard/src/routes/tests apps/dashboard/src/lib/api.ts apps/api/package.json apps/dashboard/package.json`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch for a given step, treat it as a STOP condition for that step only.

## Status

- **Priority**: P2
- **Effort**: S (per step; ~M total)
- **Risk**: LOW
- **Depends on**: none (Step 6's test is easier after plan 004, but not required)
- **Category**: bug / security / perf / dx
- **Planned at**: commit `0f8b0cc`, 2026-07-10

## Why this matters

Seven small, verified defects with one-sitting fixes: test names containing
`%` crash the test-detail feature end to end; `hono` sits in the range of a
high-severity CORS advisory; the flaky-tests endpoint has no result cap while
the overview fetches the full list to render 5 rows; trend chart x-labels are
off by one day on servers west of UTC; project deletion duplicates FK
cascades with a query that breaks past ~65k runs; `GET /projects/:id` is a
byte-identical duplicate of `/stats`; and both apps ship `lint` scripts that
call an uninstalled `eslint`.

## Current state

All verified at `0f8b0cc`:

1. **Double URL-decode** — both frameworks already decode params:
   - `apps/api/src/routes/tests.ts:20`
     `const testName = decodeURIComponent(c.req.param('testName'));`
     (Hono ≥4 pre-decodes `%`-containing params.)
   - `apps/dashboard/src/routes/tests/[testName]/+page.server.ts:6`
     `const testName = decodeURIComponent(params.testName);`
     (SvelteKit decodes route params.)
   For a name like `loads 100% of items`, the link is single-encoded at the
   source (`apps/dashboard/src/lib/api.ts:73` uses `encodeURIComponent`), the
   framework decodes it back, and the second decode throws `URIError` → 500.

2. **hono advisory** — `apps/api/package.json` has `"hono": "^4.12.23"` and
   the lockfile resolves 4.12.23; GHSA-88fw-hqm2-52qc (CORS middleware
   reflects any origin with credentials when `origin` defaults to wildcard)
   is patched in ≥ 4.12.25. Current config
   (`apps/api/src/index.ts:23-26`) sets an explicit origin with
   `credentials: true` — not the vulnerable default, but keep the dep clean.

3. **Unbounded flaky-tests list** — `apps/api/src/routes/projects.ts:89-108`:
   the `/:id/flaky-tests` select has no `.limit()`. The clamp pattern to copy
   exists 20 lines below in `/:id/runs` (`projects.ts:124-127`):
   ```ts
   const requestedLimit = parseInt(c.req.query('limit') || '20', 10);
   const limit = Math.min(Math.max(requestedLimit, 1), 100);
   ```
   Consumers: `apps/dashboard/src/lib/api.ts:49-57` (`getFlakyTests(projectId,
   status)`), called by `apps/dashboard/src/routes/+page.server.ts:15`
   (overview — renders only `slice(0, 5)` at `+page.svelte:168`) and
   `apps/dashboard/src/routes/flaky/+page.server.ts:12` (full list page).

4. **Trend label timezone** — `apps/api/src/routes/projects.ts:220,226`
   bucket by UTC (`toISOString().slice(0,10)`), but line 238–239 renders
   labels via `new Date(day)` + `toLocaleDateString('en-US', ...)` — `new
   Date('YYYY-MM-DD')` is UTC midnight, and `toLocaleDateString` formats in
   the server's local zone → the label shows the previous day west of UTC.

5. **Delete duplicates cascades** — `apps/api/src/routes/admin.ts:180-201`
   manually deletes test_results (via an UNCHUNKED `inArray` over all run
   ids — breaks past ~65k params), then test_runs, flaky_tests, then the
   project — but `apps/api/src/db/schema.ts` declares `onDelete: 'cascade'`
   on `test_runs.project_id` (line 18), `test_results.test_run_id` (line 40),
   and `flaky_tests.project_id` (line ~63). Deleting the project row alone
   cascades everything.

6. **Duplicate route** — `apps/api/src/routes/projects.ts:39-52` (`GET /:id`)
   and lines 59–72 (`GET /:id/stats`) are identical (`getProjectStats`). No
   caller uses `/:id` (`apps/dashboard/src/lib/api.ts:46` uses `/stats`;
   `docs/API.md` doesn't document `/:id`).

7. **Dead lint scripts** — `apps/api/package.json` has
   `"lint": "eslint src/"`; `apps/dashboard/package.json` has
   `"lint": "eslint ."`. `eslint` is not a dependency anywhere; the repo
   lints with oxlint from the root (`package.json` →
   `oxlint --deny-warnings apps/`).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck API | `pnpm --filter api exec tsc --noEmit` | exit 0 |
| Typecheck dashboard | `pnpm --filter dashboard check` | 0 errors, 0 warnings |
| API tests (no DB) | `pnpm --filter api test` | pass |
| API tests (with DB) | `docker compose up -d && DATABASE_URL=postgres://postgres:postgres@localhost:5432/flackyness ADMIN_TOKEN=test-admin pnpm --filter api test` | pass |
| Lint | `pnpm lint` | exit 0 |
| Audit | `corepack pnpm audit --prod --audit-level=high` | no high/critical findings |

## Scope

**In scope** (the only files you should modify):
- `apps/api/src/routes/tests.ts`
- `apps/dashboard/src/routes/tests/[testName]/+page.server.ts`
- `apps/api/package.json` (hono version, lint script) + `pnpm-lock.yaml` (via `pnpm install` only)
- `apps/api/src/routes/projects.ts`
- `apps/api/src/routes/admin.ts`
- `apps/dashboard/src/lib/api.ts` + `apps/dashboard/src/routes/+page.server.ts` (limit plumbing)
- `apps/dashboard/package.json` (lint script)
- `docs/API.md` (flaky-tests `limit` param; removal of any `GET /projects/:id` mention if present)
- Route test files touched by verification (`apps/api/src/routes/tests.test.ts` if it exists, else add cases to `projects.test.ts`)

**Out of scope** (do NOT touch):
- `updateFlakyTests` / `services/flakiness.ts` (plan 006).
- CORS config in `index.ts` (dropping `credentials: true` was floated in the
  audit; leave it — behavior change needs the maintainer's call).
- Dockerfiles, workflows.

## Git workflow

- Branch: `advisor/005-api-quick-fixes`
- One conventional commit PER STEP (single-line subjects, e.g.
  `fix(api): remove double URL-decode of test names`). Do NOT add any
  `Co-Authored-By` trailer. Do not push or open a PR unless the operator
  instructed it.

## Steps

### Step 1: Remove the double decode (both sides)

- `apps/api/src/routes/tests.ts:20` →
  `const testName = c.req.param('testName');`
- `apps/dashboard/src/routes/tests/[testName]/+page.server.ts:6` →
  `const testName = params.testName;`

Add a regression test in the API route suite (in
`apps/api/src/routes/tests.test.ts` if plan 004 created it; otherwise create a
minimal DB-gated suite with the standard `describeWithDb` pattern copied from
`apps/api/src/routes/reports.test.ts:3-16`): request
`/api/v1/tests/${encodeURIComponent('loads 100% of items')}/history?project=<uuid>`
→ expect 200 (not 500), and a name with spaces/`›` round-trips.

**Verify**: `pnpm --filter api exec tsc --noEmit` → 0; with DB env, the new test passes; `grep -rn "decodeURIComponent" apps/api/src apps/dashboard/src` → no matches.

### Step 2: Bump hono past the advisory

In `apps/api/package.json` set `"hono": "^4.12.25"`, then `pnpm install`.
(Note: `pnpm-workspace.yaml` sets `minimumReleaseAge: 1440` — any release
older than 24h is installable; 4.12.25+ long predates today.)

**Verify**: `grep '"hono"' apps/api/package.json` → `^4.12.25` or later; `corepack pnpm audit --prod --audit-level=high` → no high/critical advisories; `pnpm --filter api test` → pass.

### Step 3: Cap the flaky-tests endpoint and stop over-fetching

- In `apps/api/src/routes/projects.ts` `/:id/flaky-tests` handler, add the
  exact clamp pattern from `/:id/runs` (default `50`, clamp 1–100) and chain
  `.limit(limit)` after `.orderBy(...)`.
- In `apps/dashboard/src/lib/api.ts`, extend
  `getFlakyTests(projectId, status = 'active', limit = 100)` to append
  `&limit=${limit}`.
- In `apps/dashboard/src/routes/+page.server.ts:15`, pass `limit = 5`
  (the overview renders 5). Leave `flaky/+page.server.ts` on the default 100.
- Document the new `limit` param in `docs/API.md`'s flaky-tests section
  (default 50, max 100).

**Verify**: `pnpm --filter dashboard check` → 0 errors; with DB env, existing flaky-tests route tests pass; `grep -n "limit" apps/api/src/routes/projects.ts` shows the clamp in the flaky-tests handler.

### Step 4: Fix trend label timezone

In `apps/api/src/routes/projects.ts:237-241`, format from the UTC key
directly:

```ts
for (const [day, data] of dailyMap) {
  const date = new Date(`${day}T00:00:00Z`);
  trendDays.push(date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }));
  rates.push(data.total > 0 ? Math.round((data.flaky / data.total) * 1000) / 10 : 0);
}
```

Add a unit-testable check if convenient (`TZ=America/Los_Angeles pnpm --filter api test` for the suite if one covers trend), otherwise verify by
inspection + typecheck.

**Verify**: `pnpm --filter api exec tsc --noEmit` → 0; `TZ=America/Los_Angeles node -e "const d=new Date('2026-07-10T00:00:00Z'); console.log(d.toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'}))"` → `Jul 10`.

### Step 5: Let the FK cascades do project deletion

In `apps/api/src/routes/admin.ts:180-201`, replace the four-statement
transaction with a single delete (cascades handle children):

```ts
await db.delete(projects).where(eq(projects.id, projectId));
```

Keep the existence check, logging, and response unchanged. FIRST confirm the
cascades exist in the applied migrations:

**Pre-check**: `grep -rn "on delete cascade" apps/api/drizzle/*.sql` → at least 3 matches (test_runs→projects, test_results→test_runs, flaky_tests→projects). If fewer, STOP (schema.ts declares them but a migration may be missing).

**Verify**: with DB env, the admin delete test (`apps/api/src/routes/admin.test.ts`) passes; manual check: create a project, upload `fixtures/sample-report.json`, delete the project, then `SELECT count(*)` on test_runs/test_results/flaky_tests for that project id → 0 rows (or assert via the API returning 404 for its stats).

### Step 6: Remove the duplicate `GET /projects/:id`

Delete the handler at `apps/api/src/routes/projects.ts:39-52` (keep
`/:id/stats`). Pre-check no internal caller:
`grep -rn "projects/\${" apps/dashboard/src` and confirm every hit targets
`/stats`, `/flaky-tests`, `/runs`, or `/trend`.

CAUTION (route ordering): Hono matches `/:id` before subpaths only by
registration order for identical specificity; removing `/:id` must not break
`/:id/stats` etc. — they are distinct patterns, so no change needed. If any
test asserts `GET /projects/:id` (check `apps/api/src/routes/projects.test.ts`
— at `0f8b0cc` it does, "should return project details"), update that test to
target `/stats` instead.

**Verify**: with DB env, `pnpm --filter api test` → pass; `curl` (or a test) on `/api/v1/projects/<id>` → 404, `/api/v1/projects/<id>/stats` → 200.

### Step 7: Remove the dead eslint scripts

Delete the `"lint"` entries from `apps/api/package.json` and
`apps/dashboard/package.json` (root `pnpm lint` = oxlint covers `apps/`).

**Verify**: `grep -rn '"lint"' apps/api/package.json apps/dashboard/package.json` → no matches; `pnpm lint` → exit 0.

## Test plan

- New: `%`-in-name history regression test (Step 1); flaky-tests `limit`
  assertions if a suite covers that route (add to it); updated `/:id` → 404
  expectation (Step 6).
- Pattern: `apps/api/src/routes/reports.test.ts` for DB-gated setup.
- Gate: full `pnpm --filter api test` with DB env; `pnpm --filter dashboard check`; `pnpm lint`.

## Done criteria

ALL must hold:

- [ ] `grep -rn "decodeURIComponent" apps/api/src apps/dashboard/src` → no matches
- [ ] `corepack pnpm audit --prod --audit-level=high` → no high/critical
- [ ] flaky-tests endpoint has a 1–100 clamped `limit` (default 50); overview requests `limit=5`
- [ ] Trend labels formatted with `timeZone: 'UTC'`
- [ ] Admin delete is a single `db.delete(projects)` statement; children verified gone
- [ ] `GET /api/v1/projects/:id` returns 404; `/stats` still 200
- [ ] No per-app `lint` scripts remain; `pnpm lint` exits 0
- [ ] `pnpm --filter api test` (with DB env) and `pnpm --filter dashboard check` exit 0
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop (that step only) and report if:

- Step 1: removing the decode makes any existing test fail with an
  ENCODED name reaching the DB (would mean the framework didn't decode —
  version drift).
- Step 2: `pnpm install` cannot resolve hono ≥4.12.25 (registry/cooldown
  issue) — report; do not override `minimumReleaseAge`.
- Step 5 pre-check finds missing cascade clauses in migrations.
- Step 6: any dashboard or docs consumer of bare `GET /projects/:id` turns up.

## Maintenance notes

- Step 3's `limit` default (50) is a behavior change for any external
  consumer that scraped the full list — release-note it.
- After Step 5, anyone adding a new child table of `projects` MUST add
  `onDelete: 'cascade'` or deletion regresses — reviewer checklist.
- Plan 003 rewrites API.md's reports section; Step 3/6 here touch other
  API.md sections — merge order between 003 and 005 doesn't matter, but
  resolve doc conflicts in favor of whichever describes the live code.
