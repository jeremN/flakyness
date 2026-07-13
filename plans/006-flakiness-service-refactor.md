# Plan 006: Make `updateFlakyTests` transactional, batched, and `ignored`-preserving

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 0f8b0cc..HEAD -- apps/api/src/services/flakiness.ts apps/api/src/services/flakiness.test.ts`
> Plan 004 is EXPECTED to have changed both files (extracted
> `computeFlakiness`, added the `updateFlakyTests` integration suite) — that
> is not drift. Anything else that contradicts the excerpts below is a STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (rewrites the reconcile logic — mitigated by plan 004's suite)
- **Depends on**: plans/004-test-shipped-code.md (MUST be DONE first — its
  integration suite is the regression net for this refactor)
- **Category**: bug / perf
- **Planned at**: commit `0f8b0cc`, 2026-07-10

## Why this matters

`updateFlakyTests` runs after every report upload (fire-and-forget from
`apps/api/src/routes/reports.ts:108`). Today it issues one awaited,
autocommitted statement **per flaky test** plus one per resolution — a project
with 300 flaky tests does 300+ serial DB round-trips per upload, and a process
kill mid-loop (deploys force-exit after 10s — `apps/api/src/index.ts:100-103`)
leaves the `flaky_tests` table half-updated with no atomicity. Separately, the
upsert unconditionally sets `status: 'active'`, which will silently un-mute
any future `ignored` test on the next ingest (`ignored` is already a modeled
status in `apps/api/src/db/schema.ts` and a filter value in
`apps/api/src/routes/projects.ts:11`).

After this plan: one transaction, ≤ a handful of set-based statements
regardless of project size, and `ignored` rows keep their status.

## Current state

`apps/api/src/services/flakiness.ts:144-219` (post-plan-004 line numbers may
shift slightly; the logic is unchanged by 004):

```ts
export async function updateFlakyTests(projectId, config = {}) {
  const analysis = await analyzeFlakiness(projectId, config);
  let updated = 0; let resolved = 0;
  const existingFlaky = await db.query.flakyTests.findMany({
    where: eq(flakyTests.projectId, projectId),
  });
  const existingMap = new Map(existingFlaky.map(f => [f.testName, f]));
  const seenTestNames = new Set<string>();

  for (const test of analysis) {
    seenTestNames.add(test.testName);
    const existing = existingMap.get(test.testName);
    if (test.isFlaky) {
      await db.insert(flakyTests).values({
        projectId, testName: test.testName, testFile: test.testFile,
        firstDetected: new Date(), lastSeen: test.lastSeen,
        flakeCount: test.failCount + test.flakyCount,
        totalRuns: test.totalRuns,
        flakeRate: test.flakeRate.toFixed(4),
        status: 'active',
      }).onConflictDoUpdate({
        target: [flakyTests.projectId, flakyTests.testName],
        set: { testFile: ..., lastSeen: ..., flakeCount: ..., totalRuns: ...,
               flakeRate: ..., status: 'active' },   // <-- clobbers 'ignored'
      });
      updated++;
    } else if (existing && existing.status === 'active') {
      await db.update(flakyTests).set({ status: 'resolved' })
        .where(eq(flakyTests.id, existing.id));      // <-- one stmt per row
      resolved++;
    }
  }
  for (const [testName, existing] of existingMap) {
    if (existing.status === 'active' && !seenTestNames.has(testName)) {
      await db.update(flakyTests).set({ status: 'resolved' })
        .where(eq(flakyTests.id, existing.id));      // <-- one stmt per row
      resolved++;
    }
  }
  return { updated, resolved };
}
```

Semantics that MUST be preserved:

- `firstDetected` is set only on insert; the conflict path never overwrites it.
- Return value `{ updated, resolved }`: `updated` = count of flaky tests
  upserted; `resolved` = count of rows flipped to `'resolved'`.
- `resolved`/`ignored` rows that are flaky again DO get their stats refreshed
  by the upsert (they're in `analysis` with `isFlaky`), and `resolved` rows
  flip back to `'active'`.
- Rows never seen in analysis and not `'active'` are untouched.

Semantics that CHANGE (the point of this plan):

- All writes inside ONE `db.transaction`.
- Upserts batched: one multi-row `insert().values([...]).onConflictDoUpdate()`
  per chunk (chunk size 1000, matching `BATCH_SIZE` in
  `apps/api/src/routes/reports.ts:11` — Postgres bind-param limit).
- Resolutions batched: one `update ... where inArray(id, [...])` per chunk.
- The conflict path preserves `'ignored'`:
  `status = CASE WHEN flaky_tests.status = 'ignored' THEN 'ignored' ELSE 'active' END`.
- `ignored` rows are also EXCLUDED from resolution flips (an ignored test
  going quiet stays `ignored`, not `resolved`) — today's code already only
  resolves `active` rows; keep that.

Related infra: the postgres.js driver + drizzle (`apps/api/src/db/index.ts`);
multi-row upsert with per-column `excluded` references uses
`sql.raw`/`sql` from `drizzle-orm`, e.g.
`set: { lastSeen: sql`excluded.last_seen` , ... }` — column names in
`excluded.*` are the SNAKE_CASE DB names from `schema.ts`.

Plan 004's suite (in `apps/api/src/services/flakiness.test.ts`,
`describeWithDb('updateFlakyTests', ...)`) covers: new-flaky insert,
`firstDetected` preservation, below-threshold → resolved, disappeared →
resolved, and documents the CURRENT ignored-clobbering behavior in its case 5
with a comment referencing this plan.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `pnpm --filter api exec tsc --noEmit` | exit 0 |
| Tests with DB | `docker compose up -d && DATABASE_URL=postgres://postgres:postgres@localhost:5432/flackyness ADMIN_TOKEN=test-admin pnpm --filter api test` | all pass |
| Migrations (fresh DB) | `pnpm db:migrate` | exit 0 |
| Lint | `pnpm lint` | exit 0 |

A real Postgres is REQUIRED for this plan's verification. If unavailable
locally, do not claim done — say verification ran only in CI.

## Scope

**In scope** (the only files you should modify):
- `apps/api/src/services/flakiness.ts` (`updateFlakyTests` only)
- `apps/api/src/services/flakiness.test.ts` (update case 5; add batch test)

**Out of scope** (do NOT touch):
- `analyzeFlakiness` / `computeFlakiness` — unchanged inputs to this function.
- `apps/api/src/routes/reports.ts` — the fire-and-forget call-site stays
  as-is (making ingestion await the recompute is a product decision, not
  this plan).
- `apps/api/src/db/schema.ts` — no schema changes; the unique index
  `(project_id, test_name)` already exists.
- Adding an endpoint that SETS `ignored` — direction work, out of scope.

## Git workflow

- Branch: `advisor/006-flakiness-service-refactor`
- Conventional-commit, single-line subject only (e.g.
  `fix(api): batch flaky-test reconcile in one transaction`). Do NOT add any
  `Co-Authored-By` trailer. Do not push or open a PR unless the operator
  instructed it.

## Steps

### Step 1: Restructure `updateFlakyTests` into compute-then-write

Keep the same signature and return type. New shape:

```ts
export async function updateFlakyTests(projectId, config = {}) {
  const analysis = await analyzeFlakiness(projectId, config);

  const existingFlaky = await db.query.flakyTests.findMany({
    where: eq(flakyTests.projectId, projectId),
  });
  const existingMap = new Map(existingFlaky.map(f => [f.testName, f]));
  const seenTestNames = new Set(analysis.map(t => t.testName));

  // 1. Rows to upsert (all currently-flaky tests)
  const flakyRows = analysis.filter(t => t.isFlaky).map(test => ({ ...as today... }));

  // 2. Ids to resolve: active rows that are (a) analyzed but no longer flaky,
  //    or (b) absent from the analysis entirely
  const resolveIds = existingFlaky
    .filter(f => f.status === 'active')
    .filter(f => {
      const analyzed = seenTestNames.has(f.testName);
      const stillFlaky = analyzed && analysis.find(t => t.testName === f.testName)!.isFlaky;
      return !stillFlaky;
    })
    .map(f => f.id);

  await db.transaction(async (tx) => {
    for (const chunk of chunks(flakyRows, 1000)) {
      await tx.insert(flakyTests).values(chunk).onConflictDoUpdate({
        target: [flakyTests.projectId, flakyTests.testName],
        set: {
          testFile: sql`excluded.test_file`,
          lastSeen: sql`excluded.last_seen`,
          flakeCount: sql`excluded.flake_count`,
          totalRuns: sql`excluded.total_runs`,
          flakeRate: sql`excluded.flake_rate`,
          status: sql`CASE WHEN ${flakyTests.status} = 'ignored' THEN 'ignored' ELSE 'active' END`,
        },
      });
    }
    for (const chunk of chunks(resolveIds, 1000)) {
      await tx.update(flakyTests).set({ status: 'resolved' })
        .where(inArray(flakyTests.id, chunk));
    }
  });

  return { updated: flakyRows.length, resolved: resolveIds.length };
}
```

Details:
- Use a `Map` for the per-name `isFlaky` lookup instead of `analysis.find`
  inside the filter (avoid O(n²) on large projects).
- Add a small local `chunks<T>(arr, size)` helper (or reuse one if the repo
  gains one — none exists at `0f8b0cc`).
- Import `inArray` and `sql` from `drizzle-orm` (the file already imports
  `eq, and, gte, sql, desc`).
- `firstDetected: new Date()` stays in the insert values; the conflict `set`
  must NOT include it.
- Guard the empty cases: skip the transaction entirely when both
  `flakyRows` and `resolveIds` are empty (return `{updated:0, resolved:0}`).

**Verify**: `pnpm --filter api exec tsc --noEmit` → exit 0.

### Step 2: Update the plan-004 suite for the new `ignored` semantics

In `flakiness.test.ts`'s `updateFlakyTests` suite:

- Case 5 (`ignored` + still flaky): flip the assertion — the row must REMAIN
  `'ignored'` while `flakeCount`/`totalRuns`/`flakeRate`/`lastSeen` are
  refreshed. Remove the "plan 006 changes this" comment.
- Add case 6: an `ignored` row whose test disappears from analysis stays
  `'ignored'` (not resolved).
- Add case 7 (batching): seed data producing ≥ 25 flaky tests (25 test names
  × 4 results each, ≥2 failures per name, is enough), call once, assert all
  25 rows exist with `status='active'` and the return is
  `{ updated: 25, resolved: 0 }`.
- Add case 8 (mixed reconcile): 3 flaky + 2 previously-active-now-clean +
  1 previously-active-now-absent → returns `{ updated: 3, resolved: 3 }` and
  statuses match.

**Verify**: with DB env, `pnpm --filter api test` → all `updateFlakyTests` cases pass, including the four existing behavior cases from plan 004 (unchanged semantics for non-ignored paths).

### Step 3: Full regression pass

Run the entire API suite with the DB up, plus lint.

**Verify**: `DATABASE_URL=... ADMIN_TOKEN=... pnpm --filter api test` → all pass; `pnpm lint` → exit 0.

## Test plan

Covered in Step 2 (extends plan 004's suite in
`apps/api/src/services/flakiness.test.ts`; pattern: that same suite). Gate:
full DB-backed test run.

## Done criteria

ALL must hold:

- [ ] `updateFlakyTests` contains exactly one `db.transaction` and no awaited statement inside a per-test `for` loop (`grep -n "await db.insert\|await db.update" apps/api/src/services/flakiness.ts` → no matches inside `updateFlakyTests`; only `tx.*` calls remain, inside chunk loops)
- [ ] Conflict `set` uses the `CASE ... 'ignored'` expression and does not touch `firstDetected`
- [ ] With DB env: `pnpm --filter api test` exits 0, including cases 5–8
- [ ] `pnpm --filter api exec tsc --noEmit` and `pnpm lint` exit 0
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Plan 004 is not DONE (no `updateFlakyTests` integration suite exists) —
  this refactor must not proceed without its net.
- Drizzle rejects the multi-row `onConflictDoUpdate` with `excluded.*`
  references on your installed version — report the exact error; do NOT fall
  back to per-row statements (that would silently reintroduce the bug this
  plan fixes).
- Any plan-004 behavior case (1–4) fails after the refactor — the rewrite
  changed semantics it must preserve.
- The `CASE` expression can't reference the existing row's status in the
  conflict set (dialect limitation) — report; an alternative design decision
  (e.g. pre-partitioning ignored names in JS) belongs to the reviewer.

## Maintenance notes

- The fire-and-forget call-site (`reports.ts:108`) still allows two
  concurrent recomputes of the same project to interleave BETWEEN
  transactions; the unique index + transaction make the outcome consistent
  (last-writer-wins per row) but a per-project queue/lock remains a possible
  follow-up if uploads become very frequent — deferred deliberately.
- When an "ignore/mute" endpoint is added (direction item), its tests should
  reuse cases 5–6 here as the contract.
- Reviewer focus: the `resolveIds` derivation (the double-condition filter)
  is where a logic slip would silently resolve wrong rows.
