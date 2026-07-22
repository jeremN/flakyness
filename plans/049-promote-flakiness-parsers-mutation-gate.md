# Promote `flakiness.ts` + parsers into the mutation gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise the true mutation score of `services/flakiness.ts`,
`parsers/junit.ts`, and `parsers/playwright.ts` by killing their killable
survivors, then promote all three into `scripts/mutation-gate.mjs`'s `HARDENED`
set with baseline-calibrated floors. Closes backlog follow-up **#14**.

**Architecture:** Test-only, survivor-driven hardening (identical methodology to
plan 048/#13). No product-source changes; no `// Stryker disable`. Floors are set
from post-hardening re-measurement, `floor = floor(reliableLow of ≥2 runs) − 5`.

**Tech Stack:** Stryker (`@stryker-mutator/core` + vitest-runner), Vitest 4,
Drizzle/Postgres (flakiness only — parsers are pure), the existing per-package
`apps/api/stryker.conf.mjs` + `scripts/mutation-gate.mjs`.

**Spec:** `docs/superpowers/specs/2026-07-22-promote-flakiness-parsers-mutation-gate-design.md`

## Global Constraints

- **Test-only. Zero product-source changes** to `flakiness.ts` / `junit.ts` /
  `playwright.ts`; **no `// Stryker disable` annotations** anywhere in product
  code. Both must be byte-identical to base at the end.
- **Every added/strengthened assertion is mutation-proven:** hand-edit the
  covered product line to the mutant → run the specific test → it goes **red** →
  revert the source **byte-clean** → record the proof in the task report. Never
  commit mutated or weakened source.
- **Race-safe `flakiness` DB tests:** seed via direct
  `db.insert(...).values(...)`; assert on the **awaited** `updateFlakyTests()`
  return value or the resulting `flaky_tests` / `test_results` rows (helpers
  `seedProject`/`seedRun`/`getFlakyRow` already exist). **Never** rely on the
  un-awaited reconcile (AGENTS.md — poll, never `sleep`). Clean up via the
  existing `afterAll` FK-cascade delete.
- **Disposable Postgres for flakiness only.** `flakiness.test.ts` self-skips
  without `DATABASE_URL`; parser suites need no DB. Stand up a throwaway Postgres
  via `docker run` (NEVER `docker compose`), `docker rm -f` on every exit even on
  failure. Migrate with `DATABASE_URL=… pnpm --filter api exec drizzle-kit migrate`.
- **RTK shell quirk:** the rtk hook garbles `pnpm`/`stryker` stdout in this repo —
  run those prefixed with `rtk proxy` for trustworthy output/exit codes.
- **Floor policy = reliable-low:** `floor = floor(reliableLow of ≥2 post-hardening
  runs) − 5`. Do not over-tighten off a lucky-high run. Timeouts count like Killed
  in the score; note any in the calibration.
- **Don't chase equivalents.** Leave true equivalent/defensive mutants surviving
  and document them. Existing suites stay green (API 362+, dashboard 89,
  `check` 0-err, oxlint clean).
- Commits: single-line conventional-commit subject. **No `Co-Authored-By`
  trailers.** `main` is branch-protected — work on the branch; the PR needs green
  CI + explicit user approval to merge.

---

## Task 1: Measure & triage (COMPLETE — reference)

This task was executed during planning; its results are baked in below so the
hardening tasks have a concrete work-list. No code changes.

**Pre-hardening baselines** (of-total mutation score; single scoped run each,
`apps/api` Stryker config, parsers Postgres-free, flakiness on disposable PG):

| File | Score | Killed | Timeout | Survived | NoCov | Mutants |
|------|-------|--------|---------|----------|-------|---------|
| `services/flakiness.ts` | 80.65% | 123 | 2 | 29 | 1 | 155 |
| `parsers/junit.ts` | 78.01% | 188 | 0 | 47 | 6 | 241 |
| `parsers/playwright.ts` | 73.32% | 272 | 0 | 91 | 8 | 371 |

**Triage principle:** a survivor is *killable* if a test can assert on an
observable behavior the mutant changes; *accepted* if equivalent (mutant can't
change any observable output) or defensive (needs an implausible/expensive
fixture, e.g. a >`BATCH_SIZE` row set). Each hardening task lists its killable
targets; the rest are accepted and recorded in Task 5's summary.

**Note the scoped-measurement caveat (from #13):** scoped `--mutate` runs can
UNDER-report kills for DB-service files via a Stryker `perTest` coverage-mapping
miss — so `flakiness.ts`'s aggregate may be a conservative under-estimate. Per
assertion, the hand mutation-proof (edit line → red → revert) is the reliable
signal; the scored floor's −5 margin absorbs the rest.

---

## Task 2: Harden `services/flakiness.ts`

**Files:**
- Modify (test only): `apps/api/src/services/flakiness.test.ts`
- Product (read-only reference, DO NOT EDIT): `apps/api/src/services/flakiness.ts`

**Interfaces:** uses existing test helpers `row`/`rows` (pure) and
`seedProject`/`seedRun`/`repeat`/`getFlakyRow` (DB block); the DB block is gated
by `const describeWithDb = hasDatabase ? describe : describe.skip`.

**Killable survivor work-list** (line → mutant → killing assertion):

| Line | Survivor | Kill with |
|------|----------|-----------|
| 85 | `testFile: result.testFile \|\| ''` (Logical/Conditional) | `computeFlakiness` on rows whose `testFile` is `null` → assert output `testFile === ''`; and a real `testFile` → assert preserved |
| 105 | `result.createdAt > existing.lastSeen` → `true` (always update) | two rows same test, older then newer `createdAt` → assert `lastSeen` equals the newer; also newer-then-older order → still the newer |
| 219 | `flakeCount: test.failCount + test.flakyCount` → `-` | DB: seed a test with BOTH `failed` AND `flaky` statuses → assert persisted `flakeCount === failCount + flakyCount` (existing tests use only `failed`, so `+`/`-` are indistinguishable) |
| 301 | `if (!project) return null` → removed / never | DB: `getProjectStats('<random uuid>')` → assert `=== null` |
| 307,312 | `count(*)` / `status='active'` string → `''` | DB: seed 2 active + 1 resolved flaky rows → assert `getProjectStats(...).activeFlakyTests === 2` |
| 318,321,326 | resolved-week window `setDate(getDate()-7)` + `count(*)` / `status='resolved'` | DB: seed a `resolved` row with `lastSeen = now` → assert `resolvedThisWeek === 1`; seed a `resolved` row with `lastSeen = 30 days ago` → assert it is NOT counted (kills the `-7 → +7` window flip) |
| 333 | `select({ totalRuns, totalTests })` → `{}` | DB: seed N runs with known `totalTests` → assert `getProjectStats(...).totalRuns === N` and `totalTests` sum |
| 345–348 | `Number(x?.count ?? 0)` → `x?.count && 0` | covered by the count assertions above (with a real non-zero count, `?? 0` yields the count but `&& 0` yields 0) |

**Accepted (do NOT chase):** L189/L190 `chunks()` (needs a >`BATCH_SIZE`=1000-row
fixture); L254 `flakyRows.length > 0 || resolveIds.length > 0 → >= 0` (running an
empty transaction is an unobservable no-op); the L345–348 `OptionalChaining`
removals (the aggregates always return exactly one row, so `x?.` and `x.` are
equivalent); L159 `setDate` window `MethodExpression` (time-dependent edge).

- [ ] **Step 1: Add the pure `computeFlakiness` assertions** (testFile fallback,
  lastSeen recency) to the existing `describe('computeFlakiness')` block.

```ts
it('falls back to empty string when a result has no testFile', () => {
  const result = computeFlakiness(
    [
      { testName: 't', status: 'failed', testFile: null, createdAt: new Date() },
      { testName: 't', status: 'passed', testFile: null, createdAt: new Date() },
      { testName: 't', status: 'passed', testFile: null, createdAt: new Date() },
    ],
    defaultConfig
  );
  expect(result[0].testFile).toBe('');
});

it('reports the most recent createdAt as lastSeen regardless of input order', () => {
  const older = new Date('2026-01-01T00:00:00Z');
  const newer = new Date('2026-02-01T00:00:00Z');
  const result = computeFlakiness(
    [
      { testName: 't', status: 'passed', testFile: 's.ts', createdAt: newer },
      { testName: 't', status: 'failed', testFile: 's.ts', createdAt: older },
      { testName: 't', status: 'passed', testFile: 's.ts', createdAt: older },
    ],
    defaultConfig
  );
  expect(result[0].lastSeen.toISOString()).toBe(newer.toISOString());
});
```

- [ ] **Step 2: Run them, mutation-prove each.** `rtk proxy pnpm --filter api exec vitest run src/services/flakiness.test.ts -t "testFile|lastSeen"`.
  Then for each: edit the product line to the mutant (`|| ''`→`&& ''`; `>`→`true`),
  confirm the test goes red, revert byte-clean. Record in the report.

- [ ] **Step 3: Add the `flakeCount` sum assertion** to the DB block. Seed a test
  with 2 `passed` + 1 `failed` + 2 `flaky` (totalRuns 5, flakeCount 3, rate 0.6):

```ts
it('sums failCount and flakyCount into the persisted flakeCount', async () => {
  const projectId = await seedProject('flakecount-sum');
  await seedRun(projectId, [
    ...repeat(2, 'test-a', 'passed'),
    ...repeat(1, 'test-a', 'failed'),
    ...repeat(2, 'test-a', 'flaky'),
  ]);
  await updateFlakyTests(projectId);
  const row = await getFlakyRow(projectId, 'test-a');
  expect(row!.flakeCount).toBe(3); // 1 failed + 2 flaky — kills failCount - flakyCount
  expect(row!.totalRuns).toBe(5);
});
```

- [ ] **Step 4: Add a `getProjectStats` DB describe block** (currently untested at
  the DB level — its whole surface survived). Cover: nonexistent project → `null`;
  active count; resolved-this-week window (in-window counted, 30-days-ago excluded);
  totalRuns/totalTests. Use `seedProject`/`seedRun` and direct
  `db.insert(flakyTests).values(...)` for the active/resolved rows (set `lastSeen`
  explicitly to control the 7-day window). Import `getProjectStats` from `./flakiness`.

```ts
describeWithDb('getProjectStats', () => {
  it('returns null for a project that does not exist', async () => {
    expect(await getProjectStats('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('counts active flaky tests, resolved-this-week, and run totals', async () => {
    const projectId = await seedProject('stats');
    await seedRun(projectId, [...repeat(3, 'x', 'passed')]); // 1 run, totalTests 3
    const base = { projectId, testFile: 's.ts', flakeCount: 1, totalRuns: 3, flakeRate: '0.3300' };
    await db.insert(flakyTests).values([
      { ...base, testName: 'a', status: 'active', firstDetected: new Date(), lastSeen: new Date() },
      { ...base, testName: 'b', status: 'active', firstDetected: new Date(), lastSeen: new Date() },
      { ...base, testName: 'c', status: 'resolved', firstDetected: new Date(), lastSeen: new Date() },
      { ...base, testName: 'd', status: 'resolved', firstDetected: new Date(),
        lastSeen: new Date(Date.now() - 30 * 864e5) }, // outside the 7-day window
    ]);
    const stats = await getProjectStats(projectId);
    expect(stats!.activeFlakyTests).toBe(2);   // kills status='active'→'' and count(*)→''
    expect(stats!.resolvedThisWeek).toBe(1);    // kills the -7→+7 window flip and status='resolved'
    expect(stats!.totalRuns).toBe(1);
    expect(stats!.totalTests).toBe(3);          // kills the select({}) mutant
  });
});
```

- [ ] **Step 5: Run the full flakiness suite against the disposable Postgres**,
  confirm green, and mutation-prove each new DB assertion (edit line → red →
  revert). `rtk proxy pnpm --filter api exec vitest run src/services/flakiness.test.ts`.

- [ ] **Step 6: Commit.** `git add apps/api/src/services/flakiness.test.ts && git commit -m "test(flakiness): cover testFile/lastSeen, flakeCount sum, getProjectStats"`

---

## Task 3: Harden `parsers/junit.ts`

**Files:**
- Modify (test only): `apps/api/src/parsers/junit.test.ts`
- Product (read-only reference): `apps/api/src/parsers/junit.ts`

Pure parser — **no DB**. Run/measure Postgres-free.

**Killable survivor work-list.** Read the source at each line and the existing
test, then add an assertion that the mutant breaks. The survivors cluster in
small helpers whose behavior is directly assertable:

| Area | Lines | Kill with |
|------|-------|-----------|
| `clamp(s,n)` truncation bound | 23 | a string shorter than the cap → unchanged (kills `>`→`true`, always-truncate); a name at/over `MAX_NAME_LENGTH` → truncated to exactly `n` (kills `>`→`>=` only if length hits `n` exactly, else accept) |
| `parseTimeMs` guards | 63,65 | `''`/whitespace → `undefined`; `'abc'` (non-finite) → `undefined`; `'1.5'` → `1500` |
| `parseTimestamp` guards | 71 | `''` → `null`; invalid string → `null`; valid ISO → a `Date` |
| `extractIssueMessage` branches | 84–90 | `null` → `''`; plain string → itself; `{ '@_message':'m', '#text':'t' }` → `'m: t'` (kills `message && text` and the `${message}: ${text}` template); `{ '#text':'t' }` only → `'t'` (kills `message \|\| text`) |
| nested `<testsuite>` flatten | 130 | a fixture with a nested `testsuite` → its testcases appear in the parsed output (kills `!== undefined`→`true/false`) |
| classname handling | 142 | a testcase with a non-string `@_classname` vs a string one → assert the resulting `testFile`/name reflects the guard |
| `MAX_TESTCASES` cap | 231 | assert the cap boundary is respected (accept if it needs a 50k-case fixture — document) |
| status mapping | 239 | a testcase with a `<failure>` vs a passing one → assert `status` differs (kills `!== 'passed'`) |
| startedAt/finishedAt from suite timestamps | 250–257 | two suites with different timestamps → assert `startedAt` = earliest, `finishedAt` = latest+duration (kills the min/max comparisons and the `finishedAt` boolean) |

**Accepted (document, don't chase):** zod schema-shape mutants
(`.passthrough()`, `@_name` `.min(1)` → the parser's validation strictness is
exercised only by malformed-XML fixtures — kill the high-value ones, accept the
rest); `ArrayDeclaration`/`ObjectLiteral` `[]`/`{}` mutants on internal
accumulators that a downstream assertion already indirectly covers.

- [ ] **Step 1:** Read `junit.ts` + `junit.test.ts`. For each killable area,
  add a focused test (extend existing fixtures or add new minimal XML strings).
- [ ] **Step 2:** Run `rtk proxy pnpm --filter api exec vitest run src/parsers/junit.test.ts` — green.
- [ ] **Step 3:** Mutation-prove **every** new assertion (edit the product line
  → run the covering test → red → revert byte-clean). Record each in the report.
- [ ] **Step 4:** Commit. `git commit -m "test(junit-parser): cover clamp/time/timestamp/message/nesting/status survivors"`

**Target:** meaningfully raise from 78.01% (kill the clearly-killable helper
survivors); the exact re-measured score is Task 5's job. Accept + list the
schema-strictness residuals.

---

## Task 4: Harden `parsers/playwright.ts`

**Files:**
- Modify (test only): `apps/api/src/parsers/playwright.test.ts`
- Product (read-only reference): `apps/api/src/parsers/playwright.ts`

Pure parser — **no DB**. Same methodology as Task 3.

**Killable survivor areas** (91 survived + 8 nocov — read the source at these
lines; the report survivor list is saved for reference, but re-deriving from a
fresh scoped run is fine):

| Area | Lines (approx) | Kill with |
|------|----------------|-----------|
| suite title `.ts`/`.js` file detection | 205,215 | a suite whose `title` ends `.ts` vs one that doesn't → assert the `testFile` attribution differs (kills the `endsWith` logical/conditional mutants) |
| status/outcome mapping conditionals | throughout | passing vs failing vs flaky (retry) attempts → assert the mapped `status` for each (the `ConditionalExpression`/`EqualityOperator` cluster) |
| string literals in status/outcome | throughout | assert the exact `status` string values ('passed'/'failed'/'flaky'/'skipped') the parser emits |
| numeric/duration handling | where present | assert duration/attempt counts from a known fixture |

**Accepted (document, don't chase):** the zod input-schema mutants
(`z.string().min(1000)`, `z.string().min(10_000)`, `z.object({}).optional()`,
`ObjectLiteral {}` on optional `stats`/attachment sub-schemas) — these change
validation strictness only for oversized/malformed inputs and many wrap
`.optional()` fields that are stripped anyway; kill the ones a realistic fixture
exercises, accept the rest as equivalents.

- [ ] **Step 1:** Read `playwright.ts` + `playwright.test.ts`. Add focused tests
  for the killable behavioral survivors (status mapping, file detection, outcome
  branches). Use the existing nested `suites[].specs[].tests[].results[]` fixtures.
- [ ] **Step 2:** Run `rtk proxy pnpm --filter api exec vitest run src/parsers/playwright.test.ts` — green.
- [ ] **Step 3:** Mutation-prove **every** new assertion. Record each.
- [ ] **Step 4:** Commit. `git commit -m "test(playwright-parser): cover status mapping, file detection and outcome-branch survivors"`

**Target:** meaningfully raise from 73.32%; exact re-measured score set in Task 5.

---

## Task 5: Re-measure & promote into the gate

**Files:**
- Modify: `scripts/mutation-gate.mjs` (add 3 `HARDENED` entries + calibration comment)
- Modify: `plans/README.md` (#14 → resolved, durable triage summary)

- [ ] **Step 1: Re-measure all three files (≥2 runs each for the reliable low).**
  Stand up a disposable Postgres (for flakiness). Because each `stryker run`
  OVERWRITES `apps/api/reports/mutation/mutation.json`, do the API measurement as
  ONE consolidated scoped run covering all target files (plus the already-gated
  three, so the same report proves the gate later):

```bash
DATABASE_URL=… ADMIN_TOKEN=… rtk proxy pnpm --filter api exec stryker run \
  --mutate "src/middleware/logger.ts,src/middleware/rate-limit.ts,src/routes/projects.ts,src/services/flakiness.ts,src/parsers/junit.ts,src/parsers/playwright.ts"
```

  Run it **twice** (parsers are deterministic; flakiness may wobble ±1–2pp and
  may show a Timeout or two). Record each file's per-run scores; `reliableLow` =
  the lowest across runs.

- [ ] **Step 2: Also produce the dashboard report** (the gate reads both):
  `rtk proxy pnpm --filter dashboard test:mutation` (no Postgres).

- [ ] **Step 3: Add three entries to the `HARDENED` array** in
  `scripts/mutation-gate.mjs`, `floor = floor(reliableLow) − 5`, with a
  `// baseline: <score>%` comment each, and extend the calibration comment block
  to explain the new files (and note flakiness's timeout/wobble if any):

```js
{ report: 'apps/api/reports/mutation/mutation.json', file: 'src/services/flakiness.ts', floor: /* floor(reliableLow)-5 */ },
{ report: 'apps/api/reports/mutation/mutation.json', file: 'src/parsers/junit.ts',       floor: /* … */ },
{ report: 'apps/api/reports/mutation/mutation.json', file: 'src/parsers/playwright.ts',  floor: /* … */ },
```

- [ ] **Step 4: Prove the gate green-on-clean across all 10 entries.** With the
  consolidated API report (all 6 API files) + the dashboard report present:
  `node scripts/mutation-gate.mjs` → **exit 0**, `GATE PASSED`, 10/10 `PASS`.
  (A report missing any gated file makes the gate exit 2 — that's why Step 1 is
  one consolidated run.)

- [ ] **Step 5: Run the gate's unit test + the full API suite.**
  `node --test scripts/mutation-gate.test.mjs` (or the repo's gate-test command)
  and `DATABASE_URL=… ADMIN_TOKEN=… rtk proxy pnpm --filter api test` → all green.

- [ ] **Step 6: Mark #14 resolved in `plans/README.md`** with the durable
  killed-vs-accepted summary per file (baselines → post-hardening scores →
  floors; notable accepted equivalents), mirroring #13's resolution bullet.

- [ ] **Step 7: Commit.**
  `git commit -m "chore(mutation): promote flakiness.ts + parsers into the gate with calibrated floors (#14)"`

---

## Self-Review (planning)

- **Spec coverage:** all 6 success criteria map to tasks — honest floors (T5),
  green-on-clean (T5 S4), mutation proofs (T2–T4), durable triage (T5 S6),
  zero product-source (global constraint + T2–T4 read-only), gate+README bumped
  (T5). ✅
- **Placeholder scan:** the only intentional blanks are the Task-5 floor numbers,
  which are *derived* from the re-measurement (a value that cannot be known before
  the run) — the derivation (`floor(reliableLow) − 5`) is fully specified. ✅
- **Type consistency:** test helpers (`row`/`rows`/`seedProject`/`seedRun`/
  `getFlakyRow`/`repeat`) and imports (`getProjectStats`) match `flakiness.test.ts`. ✅
