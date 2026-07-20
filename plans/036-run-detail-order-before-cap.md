# Plan 036: Order run-detail results in SQL before the cap, so truncation never drops the failures

> **Executor instructions**: Follow the plan, run every verification, honor the STOP conditions.
> Do not update `plans/README.md` — the reviewer maintains it.
>
> **Drift check (run first)**: `git rev-parse --short HEAD` at or after `8c19cc4`. Confirm
> `apps/api/src/routes/projects.ts` has the `GET /:id/runs/:runId` handler with a
> `RESULT_STATUS_ORDER` map, a `.limit(RUN_RESULTS_CAP + 1)` fetch with **no `.orderBy(...)`**,
> and a JS `.sort(...)` applied **after** the `truncated`/`slice`. If it already orders in SQL,
> STOP — someone got here first.

## Status

- **Priority**: P3 (low severity — closes open follow-up #9 from the 035 review)
- **Effort**: S
- **Risk**: LOW — one endpoint, ordering only; no response-shape change, no schema change.
- **Depends on**: 035 (DONE, PR #78) — this refines the endpoint 035 added.
- **Category**: correctness (bug fix)
- **Planned at**: commit `8c19cc4`, 2026-07-15

## The bug (found during plan 035's review)

`GET /api/v1/projects/:id/runs/:runId` fetches results, caps them, **then** sorts:

```ts
const rows = await db
  .select({ /* ... */ })
  .from(testResults)
  .where(and(eq(testResults.testRunId, runId), statusFilter))
  .limit(RUN_RESULTS_CAP + 1);            // <-- no ORDER BY; DB returns heap/insertion order

const truncated = rows.length > RUN_RESULTS_CAP;
const results = (truncated ? rows.slice(0, RUN_RESULTS_CAP) : rows).sort((a, b) => {
  const orderDelta = (RESULT_STATUS_ORDER[a.status] ?? 4) - (RESULT_STATUS_ORDER[b.status] ?? 4);
  return orderDelta !== 0 ? orderDelta : a.testName.localeCompare(b.testName);
});
```

Because there is **no `ORDER BY` before `LIMIT`**, the cap keeps an arbitrary (insertion-order)
`RUN_RESULTS_CAP` rows, and only *then* sorts them. So for a run with **more than
`RUN_RESULTS_CAP` (2000) results under `?status=all`**, the truncation can drop the **failures**
— the rows the page most wants to show — while keeping passed rows, because a failing spec that
was ingested late sits in the dropped tail. That directly contradicts the endpoint's
"failures first" intent.

**Severity is LOW**: the default (failures-only) scope essentially never hits the cap (it would
need >2000 failing/flaky results in one run), `truncated: true` already signals a capped set, and
Postgres's insertion-order heap scan means failures are usually interleaved rather than all in
the tail. But it's a real correctness gap in exactly the truncation case, and the fix is small.

## The fix: order in SQL, before the cap

Move the ordering into the query with a status-priority `CASE`, so the `LIMIT` keeps the
**highest-priority** rows and truncation drops **passed** first:

```ts
import { eq, desc, and, gte, inArray, sql } from 'drizzle-orm';   // add `sql`
// ...
const rows = await db
  .select({ /* unchanged column list */ })
  .from(testResults)
  .where(and(eq(testResults.testRunId, runId), statusFilter))
  // Failures first, then flaky, then skipped, then passed; then by name.
  // Ordering in SQL (not JS-after-slice) is what makes the RUN_RESULTS_CAP
  // truncation drop the LOWEST-priority rows (passed) instead of an
  // arbitrary insertion-order tail that could include failures.
  .orderBy(
    sql`CASE ${testResults.status} WHEN 'failed' THEN 0 WHEN 'flaky' THEN 1 WHEN 'skipped' THEN 2 WHEN 'passed' THEN 3 ELSE 4 END`,
    testResults.testName
  )
  .limit(RUN_RESULTS_CAP + 1);

const truncated = rows.length > RUN_RESULTS_CAP;
const results = truncated ? rows.slice(0, RUN_RESULTS_CAP) : rows;
```

- **Remove the JS `.sort(...)`** and the now-unused `RESULT_STATUS_ORDER` map — the SQL `ORDER BY`
  is the single source of ordering truth. (If TypeScript flags `RESULT_STATUS_ORDER` as unused
  after removal, delete its declaration too.)
- The `CASE` priority **must match** the previous JS order exactly: failed(0) → flaky(1) →
  skipped(2) → passed(3) → else(4). The `else 4` keeps any unexpected status value last, same as
  the old `?? 4`.
- Name tiebreak moves from JS `localeCompare` to SQL text ordering. For test names this is
  immaterial (ASCII, and no test asserts an exact *name* order — only status ordering and
  membership). If you want to be conservative you *may* keep a JS `localeCompare` re-sort of the
  already-correctly-truncated `results` for stable display naming, but do **not** let it re-govern
  truncation — prefer the simpler SQL-only version unless you can justify otherwise.
- **Do not** change the response shape, the `status`-filter logic, the `truncated` semantics, the
  cap value, or anything else in the handler.

## Scope

**In scope**:
- `apps/api/src/routes/projects.ts` — the `GET /:id/runs/:runId` handler only (add `sql` import,
  add `.orderBy(...)`, drop the JS sort + `RESULT_STATUS_ORDER`).
- `apps/api/src/routes/projects.test.ts` — add the truncation-ordering test below; the existing
  run-detail tests must still pass unchanged.
- `docs/API.md` — one sentence: results are ordered failures-first and truncation (`truncated:true`)
  drops the lowest-priority (passed) results first. Only if the endpoint's doc doesn't already
  imply it; keep it minimal.

**Out of scope** (do NOT touch):
- `apps/dashboard/**` — the UI renders results in API order; it needs no change.
- The `status` filtering, the ownership 404, the cap value, the response envelope.
- Any other route, the schema, migrations, ingest/parser.

## Steps

### Step 1 — the ordering fix
Apply the change above. **Verify**: `pnpm --filter api exec tsc --noEmit` → 0 errors (this also
confirms `RESULT_STATUS_ORDER` is gone cleanly — an unused-const would surface here or in lint).

### Step 2 — prove truncation now keeps failures (the test that makes #9 real)
Add a test to the `GET /api/v1/projects/:id/runs/:runId` describe block that ingests a run with
**more than `RUN_RESULTS_CAP` results, with the failure(s) positioned LAST in insertion order** —
so that *without* the SQL `ORDER BY`, truncation would drop them. Concretely:

- Build a Playwright report with `RUN_RESULTS_CAP` (2000) passing specs followed by a small number
  (e.g. 2) of **failing** specs — total `> RUN_RESULTS_CAP`. Generate the specs programmatically
  in a loop; each spec uses the real `tests[].results[]` shape (a single `{status:'passed'|'failed', ...}`
  result). Give the failing specs distinctive names (e.g. `zzz-cap-failure-1/2` — note that even a
  name that sorts LAST alphabetically must still appear, proving it's *status* priority, not name,
  that saves it).
- `GET .../runs/:runId?status=all`, then assert: `body.truncated === true`, **and** the failing
  test names ARE present in `body.results`, **and** they appear **before** any `passed` result
  (status ordering held under truncation).
- Export `RUN_RESULTS_CAP` from `projects.ts` (a plain `export const`) so the test can size its
  fixture as `RUN_RESULTS_CAP + 2` rather than hard-coding `2002` — keeps the test correct if the
  cap ever changes. (This is the only new export; it changes no behavior.)

**Prove it bites**: temporarily remove the `.orderBy(...)` (revert to the old fetch-then-JS-sort,
or just delete the `.orderBy` and keep a JS sort) and confirm THIS new test fails — the failures
land in the dropped tail. Restore. Paste what you observed. (This is the whole point of #9; a test
that passes with or without the fix proves nothing.)

**Verify**: the full run-detail block + the new test pass (disposable Postgres; paste counts,
prove not skipped). Existing tests — default failed+flaky, `?status=all`, `?status=passed`,
ordering, 404s, 400s — must be **unchanged and green**.

### Step 3 — full gate
`pnpm --filter api exec tsc --noEmit` → 0; `rtk proxy pnpm lint` → 0; full API suite green
(paste counts). `git diff --name-only main` shows only `projects.ts`, `projects.test.ts`, and
(if touched) `docs/API.md`.

## Done criteria

- [ ] `GET /:id/runs/:runId` orders results in SQL (`ORDER BY CASE… , testName`) **before** `.limit(...)`
- [ ] The JS `.sort(...)` and `RESULT_STATUS_ORDER` are removed (SQL is the single ordering source)
- [ ] New test: a `> RUN_RESULTS_CAP` run with failures ingested LAST returns `truncated:true` AND still includes those failures, ordered before passed
- [ ] That new test is shown to **fail** without the `.orderBy(...)` (bite proof pasted)
- [ ] All existing run-detail tests pass unchanged; full API suite green (counts pasted, not skipped)
- [ ] `tsc --noEmit` 0 errors; `rtk proxy pnpm lint` exit 0
- [ ] `git diff --name-only main` = `projects.ts`, `projects.test.ts` (+ optionally `docs/API.md`); no dashboard/schema change

## Test/verification setup

Disposable Postgres — **never `docker compose up`**, clean up even on failure:
```bash
docker run -d --name flackyness-test-pg-036 -e POSTGRES_PASSWORD=test_password \
  -e POSTGRES_DB=flackyness_test -p 5462:5432 postgres:16-alpine
touch .env
DATABASE_URL=postgres://postgres:test_password@localhost:5462/flackyness_test pnpm db:migrate
docker rm -f flackyness-test-pg-036   # ALWAYS
```
Route suites self-skip without `DATABASE_URL` + `ADMIN_TOKEN` — prove yours ran (paste counts).
The 2000+-row ingest is heavier than the other tests; that's expected and acceptable for one test.

## STOP conditions

- **The `CASE` ordering changes any existing test's expectations** (beyond the new one) → you
  changed ordering semantics; the priority must exactly match the old JS map. STOP and reconcile.
- **You cannot make the new test fail without the `.orderBy`** → then it isn't proving the fix;
  rethink the fixture (the failures must be positioned so insertion-order truncation drops them).
- **The fix seems to need a dashboard or schema change** → it does not (ordering is server-side,
  the UI renders API order). STOP if you believe otherwise.

## Maintenance notes

- Closes follow-up #9. After this, run-detail truncation is order-stable: `truncated:true` always
  means "some *passed* rows were omitted," never "a failure was hidden."
- If results ever need real pagination (a consumer routinely hits `truncated`), that's a separate
  follow-up — this plan only makes the existing cap honest, it does not add paging.
