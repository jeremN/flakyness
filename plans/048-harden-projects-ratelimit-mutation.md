# Harden `projects.ts` + `rate-limit.ts` Mutation Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise the true mutation score of `apps/api/src/routes/projects.ts` and `apps/api/src/middleware/rate-limit.ts` by covering their surviving query-param / parsing / IP-extraction branches with biting tests, then ratchet their `mutation-gate.mjs` floors up to the new reproduced baselines.

**Architecture:** Test-only. Measure survivors first (scoped Stryker run against a disposable Postgres → triage table), then add mutation-proven assertions to the existing test files (`projects.test.ts`, `rate-limit.test.ts`), then re-measure and raise the floors. No product source is modified or committed — every mutation proof breaks the source, observes the specific test go red, and reverts with `git checkout --`.

**Tech Stack:** Vitest 4.1.10, Stryker (`@stryker-mutator/core` + `@stryker-mutator/vitest-runner` `^9.6.1`), Hono 4.12, Drizzle + Postgres 16, zod. Node 24, pnpm 11.

**Spec:** `docs/superpowers/specs/2026-07-21-harden-projects-ratelimit-mutation-coverage-design.md`

**Closes:** backlog follow-up **#13** (`plans/README.md`).

## Global Constraints

- **Test files only in every commit.** The only files that may appear in a
  Task-2/3/4 commit are `apps/api/src/routes/projects.test.ts` (Tasks 2, 3) and
  `apps/api/src/middleware/rate-limit.test.ts` (Task 4). Task 5 commits only
  `scripts/mutation-gate.mjs`, `plans/README.md`, and this plan. If `git status`
  before a commit shows any *product* source modified, a mutation was not
  reverted — revert it before committing.
- **No product-source changes and no `// Stryker disable` annotations** anywhere
  in `projects.ts` / `rate-limit.ts`. Equivalent/defensive mutants are left
  surviving; the floor reflects that.
- **Every mutation is reverted with `git checkout -- <file>` in the same step
  that applied it.** Never commit a mutated source file. A mutation that leaves
  the suite green means the assertion does not bite — revise it; do not weaken,
  reword, or skip the proof. If an invariant is genuinely unprovable with the
  fixture, say so in the task report rather than claiming a proof that did not
  happen.
- **Race-safe tests only.** New DB-backed tests seed state with direct
  `db.insert(...)` and compute expectations from the response body — **never**
  ingest a report and then read `flaky_tests` (the un-awaited
  `updateFlakyTests()` reconcile race documented in AGENTS.md). If a case must
  ingest, use `?wait=true` or poll — **never `sleep`**. `analyzeFlakiness` and
  the `/trend` query read `test_results` / `test_runs` (written synchronously),
  not `flaky_tests`, so those are race-free.
- **Tests self-skip without `DATABASE_URL` + `ADMIN_TOKEN`** (both suites are
  DB-gated via `describeWithDb`). Before reporting any test result, confirm the
  Vitest summary shows **no unexpected `skipped`** — a skipped suite proves
  nothing.
- **Measurement uses a disposable Postgres via `docker run` (never
  `docker compose`); `docker rm -f` the container on every exit**, including on
  failure. The Stryker timeout config (`timeoutMS: 15000`, `timeoutFactor: 2`)
  in `apps/api/stryker.conf.mjs` stays as-is.
- **Floor policy:** `floor = Math.floor(reliableLow) - 5`, where `reliableLow`
  is the lowest of ≥2 post-hardening scored runs for the file. `projects.ts`
  wobbles ~1pp run-to-run (the reconcile race in *other* suites that also cover
  it — AGENTS.md); calibrate off the low, do not over-tighten.
- Commits: single-line conventional-commit subject. **NO `Co-Authored-By`
  trailers.** No multi-paragraph body. Never `--no-verify`.
- If `pnpm`/`stryker` stdout looks garbled (an active RTK proxy hook), re-run the
  command prefixed with `rtk proxy ` (e.g. `rtk proxy pnpm --filter api exec
  stryker run …`). This does not change behavior, only restores clean output.

## File Structure

| File | Responsibility | Tasks |
|------|---------------|-------|
| `apps/api/src/routes/projects.test.ts` | Route suite for `/api/v1/projects/*` — gains clamp/fallback + content-filter + populated-trend coverage | 2, 3 |
| `apps/api/src/middleware/rate-limit.test.ts` | Middleware suite — gains multi-hop XFF / trusted-list-trim / 429-body / constants coverage | 4 |
| `scripts/mutation-gate.mjs` | Per-file mutation floors — `projects.ts` and `rate-limit.ts` floors + baseline comment raised | 5 |
| `plans/README.md` | Backlog index — #13 marked resolved, 048 row added | 5 |

No files are created except this plan. No product source is modified.

## Verified survivor targets (the plan's map)

Confirmed by reading the source against the current suites (Task 1 re-confirms
by measurement and may surface a few more):

**`projects.ts`**
- `/:id/analysis` — only the **upper** clamps are tested (`days=999→90`,
  `threshold=5→1`, `projects.test.ts:635`). The **lower** clamp + non-numeric
  fallbacks survive: `?days=-5→1`, `?days=abc→14`, `?threshold=-1→0`,
  `?threshold=abc→0.05`. (Note `?days=0→14`, not 1 — `parseInt('0')||14`
  swallows the 0 *before* `Math.max(...,1)`; only a negative reaches the clamp.)
- `/:id/trend` — `?days=0→1` lower clamp untested (only `days=abc→7` and
  `days=999→90` exist). The **populated-day rate math** (`projects.ts:470-493`)
  is entirely uncovered: no project in the suite has `test_runs` inside the
  window, so the `data.total > 0 ? … : null` true-branch, the
  `flaky + failed` sum, and the `round((flaky/total)*1000)/10` arithmetic all
  survive.
- `/:id/runs/:runId` — `?status=flaky`, `?status=failed`, and the
  **unparseable-status fallback** (`?status=bogus→failed+flaky`,
  `projects.ts:319-322`) are untested (only default / `all` / `passed` exist).
- `/:id/flaky-tests` — **no `?limit` test at all** (limit clamp survives), and
  the `status !== 'all' ? eq(...) : undefined` filter (`projects.ts:131`) is
  only hit with vacuous `Array.isArray` assertions — the filter *content* is
  unverified and `status=ignored` is untested.

**`rate-limit.ts`** (`getClientIp` basics are already covered — the gaps are subtler)
- Multi-hop / whitespaced `x-forwarded-for`: the existing trusted-proxy test
  uses a single bare value, so `.split(',')[0].trim()` (`rate-limit.ts:40`)
  survives.
- The trusted-proxy list `.map((s) => s.trim())` (`rate-limit.ts:31`): the
  existing test matches the **first, non-space-prefixed** entry, so dropping the
  per-entry `.trim()` survives.
- The 429 response body `{ error: message, retryAfter: 60 }`
  (`rate-limit.ts:62`): the enforcement test checks only status codes.
- `REPORT_RATE_LIMIT` / `API_RATE_LIMIT` values (`rate-limit.ts:19-20`): only
  `ADMIN_RATE_LIMIT` is pinned.

---

### Task 1: Measure survivors & write the triage

Stand up a disposable Postgres, run Stryker scoped to just the two target files
(fast — ~350 mutants, not the whole package), record each file's pre-hardening
score, and dump the survivor list into a triage table that classifies each
survivor **killable** (a real assertion/coverage gap) vs **accepted**
(equivalent or defensive — not worth contorting a test to kill). No source or
test changes in this task.

**Files:** none modified. Produces a triage artifact recorded in the task report
(and, in Task 5, distilled into `plans/README.md` #13 + the gate comment).

**Interfaces:**
- Consumes: nothing.
- Produces: `projectsBaseline` and `rateLimitBaseline` (the two pre-hardening
  scores) and the killable-survivor list, consumed by Tasks 2-5.

- [ ] **Step 1: Start a disposable Postgres and migrate**

```bash
docker run -d --name flackyness-mut-pg \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=flackyness \
  -p 55432:5432 postgres:16-alpine

# Wait until it accepts connections (poll, never sleep-and-hope):
until docker exec flackyness-mut-pg pg_isready -U postgres >/dev/null 2>&1; do :; done

export DATABASE_URL="postgres://postgres:postgres@localhost:55432/flackyness"
export ADMIN_TOKEN="test-admin-token"
touch .env               # pnpm db:migrate hard-fails on a missing root .env
pnpm db:migrate
```

Expected: migrations apply cleanly (`… applied` with no error).

- [ ] **Step 2: Scoped baseline mutation run**

The repo's `apps/api/stryker.conf.mjs` mutates `src/**/*.ts`; override the glob
on the CLI to the two target files so the run is fast:

```bash
pnpm --filter api exec stryker run \
  --mutate "src/routes/projects.ts,src/middleware/rate-limit.ts"
```

Expected: Stryker completes (no dry-run failure). It writes
`apps/api/reports/mutation/mutation.json`. If stdout is garbled, re-run with
`rtk proxy ` prefixed (see Global Constraints).

- [ ] **Step 3: Extract per-file scores and the survivor list**

Read the two files' of-total scores (the same formula the gate uses) and list
every `Survived` / `NoCoverage` mutant with its location:

```bash
node --input-type=module -e '
import { readFileSync } from "node:fs";
const j = JSON.parse(readFileSync("apps/api/reports/mutation/mutation.json","utf8"));
for (const f of ["src/routes/projects.ts","src/middleware/rate-limit.ts"]) {
  const ms = j.files[f].mutants;
  let det=0, val=0;
  for (const m of ms) {
    if (m.status==="Killed"||m.status==="Timeout"){det++;val++;}
    else if (m.status==="Survived"||m.status==="NoCoverage"){val++;}
  }
  console.log(`\n=== ${f}  score ${(det/val*100).toFixed(2)}%  [${det}/${val}] ===`);
  for (const m of ms.filter(m=>m.status==="Survived"||m.status==="NoCoverage"))
    console.log(`  ${m.status}  L${m.location.start.line}  ${m.mutatorName}  ${JSON.stringify(m.replacement).slice(0,60)}`);
}
'
```

Expected: prints `projects.ts` (~53-58%, race-wobbly) and `rate-limit.ts`
(~62%) with their survivor lists. **Record both scores as `projectsBaseline` /
`rateLimitBaseline` in the task report.**

- [ ] **Step 4: Classify survivors into a triage table**

In the task report, tabulate each survivor as **killable** or **accepted**.
Cross-check against the "Verified survivor targets" section above — those are
the killable ones Tasks 2-4 already cover. Mark a survivor **accepted** only if
it is a genuine equivalent mutant (no observable behavior change — e.g. a log
string, `standardHeaders: 'draft-7'`, a `Math.min` upper bound needing >100/
>2000 fixture rows) and note *why*. If Task 1 surfaces a **killable** survivor
not in the section above, add it to the report so Task 2/3/4 can cover it with
the same technique.

Table columns: `file | line | mutator | verdict (killable/accepted) | reason / which task covers it`.

- [ ] **Step 5: Tear down the container**

```bash
docker rm -f flackyness-mut-pg
```

This runs **even if a previous step failed** — never leave the container up.

- [ ] **Step 6: Record the baseline (no commit)**

This task commits nothing. The triage table and the two baseline scores live in
the task report; Task 5 distils the durable summary into `plans/README.md` #13
and the gate comment.

---

### Task 2: Harden `projects.ts` query-param clamp & fallback branches (fixture-free)

Add biting assertions for the analysis lower/non-numeric clamps, the trend
lower clamp, and the runs/:runId status variants + unparseable fallback. All use
the existing empty `testProjectId` or the already-ingested run-detail fixture —
no new seeding.

**Files:**
- Modify: `apps/api/src/routes/projects.test.ts` — inside
  `describe('GET /api/v1/projects/:id/analysis', …)`,
  `describe('GET /api/v1/projects/:id/trend', …)`, and
  `describe('GET /api/v1/projects/:id/runs/:runId', …)`.

> **Anchor edits on the quoted `it(...)` text, not line numbers** — later steps
> in this task shift line numbers within the file.

**Interfaces:**
- Consumes: `testProjectId` (top-level `beforeAll`), `runDetailProjectId` /
  `runId` (the run-detail `describe`'s `beforeAll`, already ingesting one
  passed + one failed + one flaky result).
- Produces: nothing later tasks depend on.

> **DB prerequisite (this is a fresh subagent):** these are DB-gated route
> tests. Stand up the disposable Postgres exactly as in Task 1 Step 1
> (`docker run … flackyness-mut-pg`, `pg_isready` poll, `export DATABASE_URL/
> ADMIN_TOKEN`, `touch .env`, `pnpm db:migrate`) before Step 4, and
> `docker rm -f flackyness-mut-pg` after Step 8. Without it the suite self-skips
> and the proofs prove nothing.

- [ ] **Step 1: Add the analysis lower-bound + non-numeric test**

In `describe('GET /api/v1/projects/:id/analysis', …)`, immediately after the
existing `it('clamps out-of-range window and threshold', …)`, add:

```js
    it('clamps the lower bound and falls back on non-numeric window/threshold', async () => {
      // The sibling test above only covers the UPPER clamps (999→90, 5→1).
      // These cover the lower clamp and the non-numeric fallbacks, which are
      // distinct branches (projects.ts:387-397). testProjectId ingests nothing,
      // so analysis is empty — but windowDays/threshold still echo the resolved
      // values. Defaults are 14 / 0.05 (flakiness.ts DEFAULT_CONFIG; this
      // project sets no overrides).

      // days=-5 reaches Math.max(...,1) → 1. (days=0 would NOT: parseInt('0')||14
      // swallows the 0 into 14 before the clamp — hence a negative here.)
      const neg = await app.request(`/api/v1/projects/${testProjectId}/analysis?days=-5`);
      expect((await neg.json()).windowDays).toBe(1);

      // days=abc → parseInt NaN → `|| resolvedConfig.windowDays` → 14.
      const nanDays = await app.request(`/api/v1/projects/${testProjectId}/analysis?days=abc`);
      expect((await nanDays.json()).windowDays).toBe(14);

      // threshold=-1 → Math.max(rawThreshold,0) → 0.
      const negT = await app.request(`/api/v1/projects/${testProjectId}/analysis?threshold=-1`);
      expect((await negT.json()).threshold).toBe(0);

      // threshold=abc → parseFloat NaN → !Number.isFinite → resolvedConfig → 0.05.
      const nanT = await app.request(`/api/v1/projects/${testProjectId}/analysis?threshold=abc`);
      expect((await nanT.json()).threshold).toBe(0.05);
    });
```

- [ ] **Step 2: Add the trend lower-clamp test**

In `describe('GET /api/v1/projects/:id/trend', …)`, after the existing
`it('clamps days=999 down to the 90-entry cap, …')`, add:

```js
    it('clamps days=0 up to a 1-entry series (lower bound)', async () => {
      // trend uses Number.isNaN(rawDays) ? 7 : Math.max(rawDays,1) — unlike
      // /analysis, there is no `|| default` to swallow 0, so days=0 DOES reach
      // the Math.max(...,1) lower clamp (projects.ts:439).
      const res = await app.request(`/api/v1/projects/${testProjectId}/trend?days=0`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.days.length).toBe(1);
      expect(body.rates.length).toBe(1);
    });
```

- [ ] **Step 3: Add the runs/:runId status-variant + fallback tests**

In `describe('GET /api/v1/projects/:id/runs/:runId', …)`, after the existing
`it('?status=passed returns only the passed result', …)`, add:

```js
    it('?status=flaky returns only the flaky result', async () => {
      const res = await app.request(`/api/v1/projects/${runDetailProjectId}/runs/${runId}?status=flaky`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.results.length).toBe(1);
      expect(body.results[0].testName).toBe('flakes on retry');
      expect(body.results[0].status).toBe('flaky');
    });

    it('?status=failed returns only the failed result', async () => {
      const res = await app.request(`/api/v1/projects/${runDetailProjectId}/runs/${runId}?status=failed`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.results.length).toBe(1);
      expect(body.results[0].testName).toBe('fails consistently');
      expect(body.results[0].status).toBe('failed');
    });

    it('an unparseable ?status falls back to the default failed+flaky scope', async () => {
      // projects.ts:315-322: safeParse fails → status === undefined → the
      // `inArray(['failed','flaky'])` fallback, NOT a 400 and NOT `all`.
      const res = await app.request(`/api/v1/projects/${runDetailProjectId}/runs/${runId}?status=bogus`);
      expect(res.status).toBe(200);

      const body = await res.json();
      const names = body.results.map((r: { testName: string }) => r.testName);
      expect(body.results.length).toBe(2);
      expect(names).toContain('fails consistently');
      expect(names).toContain('flakes on retry');
      expect(names).not.toContain('passes reliably');
    });
```

- [ ] **Step 3b: Add the malformed-project-id 400 coverage (Task-1 finding)**

Task 1's measurement surfaced that the `uuidSchema.safeParse → 400` guard —
identical across endpoints — is only tested on `/quarantine` and `/runs/:runId`;
**no test sends a non-UUID id to `/stats`, `/flaky-tests`, `/runs`, `/analysis`,
or `/trend`** (~21 survivors: the `!parsed.success` conditional, the return
block, and the error body on each). One loop test closes all five. Add it inside
`describeWithDb('Projects API Integration Tests', …)` (e.g. after the
`describe('GET /api/v1/projects/:id/stats', …)` block):

```js
  describe('malformed project id → 400 (shared uuid guard)', () => {
    it('rejects a non-UUID id with 400 and the standard error on every id-guarded endpoint', async () => {
      // The guard exists on every endpoint but is only asserted on /quarantine
      // and /runs/:runId today. These five share the identical guard, untested.
      for (const path of ['stats', 'flaky-tests', 'runs', 'analysis', 'trend']) {
        const res = await app.request(`/api/v1/projects/not-a-uuid/${path}`);
        expect(res.status, `${path} must 400 on a malformed id`).toBe(400);
        expect((await res.json()).error).toBe('Invalid project ID format');
      }
    });
  });
```

- [ ] **Step 4: Run the file and confirm green, no skips**

Run: `pnpm --filter api exec vitest run src/routes/projects.test.ts`
Expected: all pass, summary shows **no `skipped`**. (Requires the `DATABASE_URL`
/ `ADMIN_TOKEN` exports and a running Postgres from Task 1 Step 1 — re-run that
step if the container was torn down.)

- [ ] **Step 5: Mutation proof — analysis lower/NaN clamps**

Apply each mutation, run the named test, confirm it FAILS, revert. Record each
failure line in the report.

1. `projects.ts:391` — change the days lower clamp `1` to `0`
   (`Math.max(…, 1)` → `Math.max(…, 0)`). The `?days=-5` assertion (expects 1)
   receives 0 → FAIL.
2. `projects.ts:396` — change the threshold lower clamp
   `Math.max(rawThreshold, 0)` → `Math.max(rawThreshold, -1)`. The
   `?threshold=-1` assertion (expects 0) receives -1 → FAIL.
3. `projects.ts:397` — change the fallback `: resolvedConfig.flakeThreshold`
   → `: 0`. The `?threshold=abc` assertion (expects 0.05) receives 0 → FAIL.

```bash
pnpm --filter api exec vitest run src/routes/projects.test.ts -t "clamps the lower bound and falls back"
git checkout -- apps/api/src/routes/projects.ts   # after EACH mutation
```

- [ ] **Step 6: Mutation proof — trend lower clamp**

`projects.ts:439` — change `Math.max(rawDays, 1)` → `Math.max(rawDays, 0)`.
Then `?days=0` yields a 0-length series → the `days.length === 1` assertion
FAILS.

```bash
pnpm --filter api exec vitest run src/routes/projects.test.ts -t "clamps days=0"
git checkout -- apps/api/src/routes/projects.ts
```

- [ ] **Step 7: Mutation proof — runs/:runId status branches**

1. `projects.ts:324` — change `eq(testResults.status, status)` →
   `inArray(testResults.status, ['failed','flaky'])`. `?status=flaky` (expects
   1 flaky) and `?status=failed` (expects 1 failed) then return 2 rows → FAIL.
2. `projects.ts:322` — change the unparseable fallback
   `inArray(testResults.status, ['failed', 'flaky'])` → `undefined`. Then
   `?status=bogus` returns ALL results (incl. `passes reliably`) → the
   `length === 2` / `not.toContain('passes reliably')` assertion FAILS.

```bash
pnpm --filter api exec vitest run src/routes/projects.test.ts -t "status="
git checkout -- apps/api/src/routes/projects.ts   # after EACH mutation
```

- [ ] **Step 7b: Mutation proof — malformed-id guard**

Prove the loop test bites for at least one endpoint each way, then revert:

1. `projects.ts:369` (analysis) — change `!parsed.success` → `false`. The guard
   is skipped, `/analysis` no longer 400s on `not-a-uuid` → the loop's
   `toBe(400)` FAILS for `analysis`.
2. `projects.ts:370` — change the error object `{ error: 'Invalid project ID
   format' }` → `{}` (or blank the string). The `.error` assertion FAILS.

```bash
pnpm --filter api exec vitest run src/routes/projects.test.ts -t "malformed"
git checkout -- apps/api/src/routes/projects.ts   # after EACH mutation
```

- [ ] **Step 8: Confirm the tree is clean of mutations, then commit**

```bash
git status --short   # expect ONLY apps/api/src/routes/projects.test.ts modified
git add apps/api/src/routes/projects.test.ts
git commit -m "test(projects): cover analysis/trend clamps, runs/:runId status branches and malformed-id guards"
```

If `git status` lists `apps/api/src/routes/projects.ts`, a revert was missed —
run `git checkout -- apps/api/src/routes/projects.ts` before committing.

---

### Task 3: Harden `projects.ts` content-filters & populated-trend math (seeded fixtures)

Cover the flaky-tests status-filter *content* + limit clamp, and the trend
populated-day rate arithmetic. Both need seeded data, added race-safely via
direct `db.insert` into dedicated projects (never via ingest-then-read).

**Files:**
- Modify: `apps/api/src/routes/projects.test.ts` — add two new `describe`
  blocks; extend the top-of-file import.

**Interfaces:**
- Consumes: `db`, `flakyTests`, and (new) `testRuns` from `../db`; `adminToken`,
  `app`, `randomUUID`.
- Produces: nothing later tasks depend on.

> **DB prerequisite (this is a fresh subagent):** DB-gated route tests. Stand up
> the disposable Postgres as in Task 1 Step 1 before Step 4, and
> `docker rm -f flackyness-mut-pg` after Step 7.

- [ ] **Step 1: Extend the db import**

Change the top-of-file import —

```js
import { db, flakyTests } from '../db';
```

— to:

```js
import { db, flakyTests, testRuns } from '../db';
```

- [ ] **Step 2: Add the flaky-tests status-content + limit describe**

Add this `describe` block inside `describeWithDb('Projects API Integration Tests', …)`
(e.g. immediately after the existing `describe('GET /api/v1/projects/:id/flaky-tests', …)`):

```js
  describe('GET /api/v1/projects/:id/flaky-tests — status filter & limit (seeded)', () => {
    let ftProjectId: string;

    beforeAll(async () => {
      if (!(hasDatabase && hasAdminToken)) return;
      const createRes = await app.request('/api/v1/admin/projects', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `flaky-filter-${randomUUID()}` }),
      });
      ftProjectId = (await createRes.json()).project.id;

      // Direct seed — this route reads flaky_tests rows only; it does not race
      // the un-awaited reconcile (nothing is ingested here).
      await db.insert(flakyTests).values([
        { projectId: ftProjectId, testName: 'ft-active-1', testFile: 'f.spec.ts', status: 'active', flakeCount: 5, totalRuns: 10, flakeRate: '0.5000' },
        { projectId: ftProjectId, testName: 'ft-active-2', testFile: 'f.spec.ts', status: 'active', flakeCount: 3, totalRuns: 10, flakeRate: '0.3000' },
        { projectId: ftProjectId, testName: 'ft-resolved', testFile: 'f.spec.ts', status: 'resolved', flakeCount: 0, totalRuns: 10, flakeRate: '0.0000' },
        { projectId: ftProjectId, testName: 'ft-ignored', testFile: 'f.spec.ts', status: 'ignored', flakeCount: 4, totalRuns: 10, flakeRate: '0.4000' },
      ]);
    });

    afterAll(async () => {
      if (ftProjectId) {
        await app.request(`/api/v1/admin/projects/${ftProjectId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${adminToken}` },
        });
      }
    });

    const names = (body: { flakyTests: { testName: string }[] }) =>
      body.flakyTests.map((t) => t.testName);

    it('status=active returns only the active rows (default status)', async () => {
      const res = await app.request(`/api/v1/projects/${ftProjectId}/flaky-tests`);
      const got = names(await res.json());
      expect(got.sort()).toEqual(['ft-active-1', 'ft-active-2']);
    });

    it('status=ignored returns only the ignored row', async () => {
      const res = await app.request(`/api/v1/projects/${ftProjectId}/flaky-tests?status=ignored`);
      expect(names(await res.json())).toEqual(['ft-ignored']);
    });

    it('status=resolved returns only the resolved row', async () => {
      // Task-1 finding: the `'resolved'` enum value (projects.ts:12) had no
      // content-asserting test old or new; this pins it.
      const res = await app.request(`/api/v1/projects/${ftProjectId}/flaky-tests?status=resolved`);
      expect(names(await res.json())).toEqual(['ft-resolved']);
    });

    it('an unparseable status falls back to active (the default)', async () => {
      // Task-1 finding: /flaky-tests's `: 'active'` unparseable fallback
      // (projects.ts:109) was untested (the /runs/:runId sibling gets this via
      // Task 2, /flaky-tests did not). safeParse fails → 'active'.
      const res = await app.request(`/api/v1/projects/${ftProjectId}/flaky-tests?status=bogus`);
      const got = names(await res.json());
      expect(got.sort()).toEqual(['ft-active-1', 'ft-active-2']);
    });

    it('status=all returns every row regardless of status', async () => {
      const res = await app.request(`/api/v1/projects/${ftProjectId}/flaky-tests?status=all`);
      const got = names(await res.json());
      expect(got.sort()).toEqual(['ft-active-1', 'ft-active-2', 'ft-ignored', 'ft-resolved']);
    });

    it('limit is applied and clamped up to a minimum of 1', async () => {
      // 4 rows exist under status=all; limit=1 must return exactly 1.
      const one = await app.request(`/api/v1/projects/${ftProjectId}/flaky-tests?status=all&limit=1`);
      expect((await one.json()).flakyTests.length).toBe(1);

      // limit=0 → Math.max(0,1) → 1, NOT 0 rows.
      const zero = await app.request(`/api/v1/projects/${ftProjectId}/flaky-tests?status=all&limit=0`);
      expect((await zero.json()).flakyTests.length).toBe(1);
    });
  });
```

- [ ] **Step 3: Add the populated-trend describe**

Add this `describe` block inside the same integration describe (e.g. after the
existing `describe('GET /api/v1/projects/:id/trend', …)`):

```js
  describe('GET /api/v1/projects/:id/trend — populated day (seeded)', () => {
    let trendProjectId: string;

    beforeAll(async () => {
      if (!(hasDatabase && hasAdminToken)) return;
      const createRes = await app.request('/api/v1/admin/projects', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `trend-populated-${randomUUID()}` }),
      });
      trendProjectId = (await createRes.json()).project.id;

      // Direct testRuns insert — /trend aggregates test_runs, never flaky_tests,
      // so this is race-free. createdAt defaults to now() → today's bucket.
      // rate = round(((flaky + failed) / total) * 1000) / 10 = round(3/10*1000)/10 = 30.0
      await db.insert(testRuns).values({
        projectId: trendProjectId,
        branch: 'main',
        commitSha: 'trendpopulated01',
        totalTests: 10,
        passed: 7,
        failed: 1,
        skipped: 0,
        flaky: 2,
      });
    });

    afterAll(async () => {
      if (trendProjectId) {
        await app.request(`/api/v1/admin/projects/${trendProjectId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${adminToken}` },
        });
      }
    });

    it('computes the flake rate for the day that has runs (non-null, exact)', async () => {
      const res = await app.request(`/api/v1/projects/${trendProjectId}/trend?days=7`);
      expect(res.status).toBe(200);

      const body = await res.json();
      // Buckets run oldest→today; the seeded run is today, so it lands in the
      // LAST bucket. rate = (2 flaky + 1 failed) / 10 total = 30.0%.
      const today = body.rates[body.rates.length - 1];
      expect(today).toBe(30);
      expect(today).not.toBeNull();
    });
  });
```

- [ ] **Step 4: Run the file and confirm green, no skips**

Run: `pnpm --filter api exec vitest run src/routes/projects.test.ts`
Expected: all pass, **no `skipped`**.

- [ ] **Step 5: Mutation proof — flaky-tests filter & limit**

1. `projects.ts:131` — change the status filter
   `status !== 'all' ? eq(flakyTests.status, status) : undefined` →
   `undefined` (always unfiltered). Then `status=ignored` (and `status=resolved`)
   return all 4 rows → the `toEqual(['ft-ignored'])` / `toEqual(['ft-resolved'])`
   assertions FAIL.
2. `projects.ts:113` — change the limit lower clamp `Math.max(requestedLimit, 1)`
   → `Math.max(requestedLimit, 0)`. Then `?limit=0` returns 0 rows → the
   `length === 1` assertion FAILS.
3. `projects.ts:109` — change the unparseable-status fallback `: 'active'` →
   `: 'ignored'`. Then `?status=bogus` returns the ignored row → the
   `toEqual(['ft-active-1', 'ft-active-2'])` assertion FAILS.

```bash
pnpm --filter api exec vitest run src/routes/projects.test.ts -t "flaky-tests"
git checkout -- apps/api/src/routes/projects.ts   # after EACH mutation
```

- [ ] **Step 6: Mutation proof — populated-trend math**

1. `projects.ts:476` — drop the failed term:
   `existing.flaky += (run.flaky || 0) + (run.failed || 0)` →
   `existing.flaky += (run.flaky || 0)`. Then rate = 2/10 = 20 → the
   `toBe(30)` assertion FAILS.
2. `projects.ts:493` — change `data.total > 0` → `data.total > 999`. Then the
   populated day reports `null` instead of 30 → FAILS.

```bash
pnpm --filter api exec vitest run src/routes/projects.test.ts -t "computes the flake rate"
git checkout -- apps/api/src/routes/projects.ts   # after EACH mutation
```

- [ ] **Step 7: Confirm the tree is clean of mutations, then commit**

```bash
git status --short   # expect ONLY apps/api/src/routes/projects.test.ts modified
git add apps/api/src/routes/projects.test.ts
git commit -m "test(projects): cover flaky-tests status/limit filtering and populated-trend math"
```

---

### Task 4: Harden `rate-limit.ts` IP-extraction, 429 body & constants

`getClientIp`'s basic branches are already covered; add the subtler survivors —
multi-hop/whitespaced XFF, the trusted-list per-entry `.trim()`, the 429
response body, and the two unpinned limit constants.

**Files:**
- Modify: `apps/api/src/middleware/rate-limit.test.ts`.

**Interfaces:**
- Consumes: the existing `fakeCtx({ socketIp, xff })` helper (top of the file),
  the `getClientIp` import, and the `TRUSTED_PROXY_IPS` save/restore in the
  `getClientIp` describe's `beforeEach`/`afterEach`.
- Produces: nothing.

> These are node-only unit tests (no DB) — they run under
> `pnpm --filter api exec vitest run src/middleware/rate-limit.test.ts`
> regardless of Postgres.

- [ ] **Step 1: Add the multi-hop XFF + trusted-list-trim tests**

Inside `describe('getClientIp', …)`, after the existing
`it('ignores X-Forwarded-For when the socket IP is NOT trusted …')`, add:

```js
  it('takes the first hop of a multi-value X-Forwarded-For and trims it', () => {
    process.env.TRUSTED_PROXY_IPS = '1.2.3.4';
    // Whitespaced, multi-hop XFF — proves `.split(',')[0].trim()`, not the
    // whole header and not the second hop.
    expect(getClientIp(fakeCtx({ socketIp: '1.2.3.4', xff: '  9.9.9.9 , 10.0.0.1' }))).toBe('9.9.9.9');
  });

  it('trims each entry of TRUSTED_PROXY_IPS when matching the socket IP', () => {
    // '5.5.5.5' is the SECOND, space-prefixed entry — matching it requires the
    // per-entry .trim() in the map (the existing test only hits the first,
    // already-trimmed entry).
    process.env.TRUSTED_PROXY_IPS = '1.2.3.4, 5.5.5.5';
    expect(getClientIp(fakeCtx({ socketIp: '5.5.5.5', xff: '9.9.9.9' }))).toBe('9.9.9.9');
  });

  it('falls back to the socket IP when a trusted proxy sends an empty X-Forwarded-For', () => {
    // Task-1 finding: `if (forwarded)` (rate-limit.ts:41) had no present-but-blank
    // XFF test. An empty header must be treated as absent → return the socket IP,
    // not ''. Mutating the guard to `if (true)` would return '' here.
    process.env.TRUSTED_PROXY_IPS = '1.2.3.4';
    expect(getClientIp(fakeCtx({ socketIp: '1.2.3.4', xff: '' }))).toBe('1.2.3.4');
  });
```

- [ ] **Step 2: Add the 429-body test**

Inside `describe('rate limiter enforcement', …)`, after the existing
`it('a factory-built limiter 429s once its limit is exceeded', …)`, add:

```js
  it('the 429 response body carries the message and retryAfter: 60', async () => {
    const { Hono } = await import('hono');
    const { createRateLimit, ADMIN_RATE_LIMIT, __setRateLimitEnabled } = await import('./rate-limit');

    __setRateLimitEnabled(true);
    try {
      const app = new Hono();
      app.use('*', createRateLimit(ADMIN_RATE_LIMIT, () => 'shared', 'slow down please'));
      app.get('/x', (c) => c.json({ ok: true }));

      let last: Response | undefined;
      for (let i = 0; i < ADMIN_RATE_LIMIT.limit + 1; i++) last = await app.request('/x');

      expect(last!.status).toBe(429);
      expect(await last!.json()).toEqual({ error: 'slow down please', retryAfter: 60 });
    } finally {
      __setRateLimitEnabled(false);
    }
  });
```

- [ ] **Step 3: Pin the REPORT and API limit constants**

Inside `describe('rate limiter enforcement', …)`, after the existing
`it('ADMIN_RATE_LIMIT is 5 requests per 60s', …)`, add:

```js
  it('REPORT_RATE_LIMIT and API_RATE_LIMIT are the documented values', async () => {
    const { REPORT_RATE_LIMIT, API_RATE_LIMIT } = await import('./rate-limit');
    expect(REPORT_RATE_LIMIT).toEqual({ windowMs: 60_000, limit: 60 });
    expect(API_RATE_LIMIT).toEqual({ windowMs: 60_000, limit: 100 });
  });
```

- [ ] **Step 3b: Exercise the real `reportRateLimit` key generator + message (Task-1 finding)**

Task 1 found `reportRateLimit`'s real key generator
(`c.get('project')?.id || 'anonymous'`, `rate-limit.ts:75-77`) and its baked-in
message (`rate-limit.ts:79`) are never exercised — the Step-2 body test builds
its *own* synthetic limiter. Add a test that drives the real export. Inside
`describe('rate limiter enforcement', …)`, after the Step-2 body test:

```js
  it('reportRateLimit keys by the project id (separate buckets) and 429s with its own message', async () => {
    const { Hono } = await import('hono');
    const { reportRateLimit, REPORT_RATE_LIMIT, __setRateLimitEnabled } = await import('./rate-limit');

    __setRateLimitEnabled(true);
    try {
      const app = new Hono();
      // Per-request project id (from a header) so two ids get two buckets. This
      // proves the key generator actually reads `c.get('project')?.id`: if it
      // were mutated to always return 'anonymous', project B below would share
      // A's exhausted bucket and 429 instead of 200. Unique ids ('rl-a'/'rl-b')
      // keep reportRateLimit's module-level store isolated from other tests.
      app.use('*', async (c, next) => { c.set('project', { id: c.req.header('x-proj') }); await next(); });
      app.use('*', reportRateLimit);
      app.get('/x', (c) => c.json({ ok: true }));

      let last: Response | undefined;
      for (let i = 0; i < REPORT_RATE_LIMIT.limit + 1; i++) {
        last = await app.request('/x', { headers: { 'x-proj': 'rl-a' } });
      }
      expect(last!.status).toBe(429);
      expect(await last!.json()).toEqual({
        error: 'Too many report uploads. Please wait before retrying.',
        retryAfter: 60,
      });

      // A different project id is a different bucket → still allowed.
      const other = await app.request('/x', { headers: { 'x-proj': 'rl-b' } });
      expect(other.status).toBe(200);
    } finally {
      __setRateLimitEnabled(false);
    }
  });
```

- [ ] **Step 4: Run the file and confirm green, no skips**

Run: `pnpm --filter api exec vitest run src/middleware/rate-limit.test.ts`
Expected: all pass, no `skipped`.

- [ ] **Step 5: Mutation proofs**

Apply each mutation, run, confirm FAIL, `git checkout -- apps/api/src/middleware/rate-limit.ts`:

1. `rate-limit.ts:40` — remove `.trim()` from
   `c.req.header('x-forwarded-for')?.split(',')[0].trim()`. Then the first hop
   is `'  9.9.9.9 '` (untrimmed) → the multi-hop test (expects `'9.9.9.9'`)
   FAILS.
2. `rate-limit.ts:40` — change `.split(',')[0]` → `.split(',')[1]`. The
   multi-hop test then gets `' 10.0.0.1'` → FAILS. (Confirms the first-hop
   selection.)
3. `rate-limit.ts:31` — remove `.map((s) => s.trim())` from the
   `TRUSTED_PROXY_IPS` parse. Then `' 5.5.5.5'` never equals `'5.5.5.5'` →
   socket not trusted → the trusted-list-trim test (expects `'9.9.9.9'`) gets
   `'5.5.5.5'` → FAILS.
4. `rate-limit.ts:62` — change `retryAfter: 60` → `retryAfter: 0`. The 429-body
   `toEqual` FAILS.
5. `rate-limit.ts:19` — change `limit: 60` → `limit: 61`. The constants test
   FAILS. (Analogously for `rate-limit.ts:20` `API` `limit: 100`.)
6. `rate-limit.ts:41` — change `if (forwarded)` → `if (true)`. Then a trusted
   proxy's empty XFF returns `''` → the empty-XFF fallback test (expects
   `'1.2.3.4'`) FAILS.
7. `rate-limit.ts:77` — change the key generator `project?.id || 'anonymous'`
   → `'anonymous'` (ignore the project id). Then project `rl-b` shares `rl-a`'s
   exhausted bucket → the `other.status === 200` assertion FAILS. Separately,
   blank `rate-limit.ts:79`'s message string → the `toEqual` on the 429 body
   FAILS.

Run each with:
`pnpm --filter api exec vitest run src/middleware/rate-limit.test.ts`

- [ ] **Step 6: Confirm the tree is clean of mutations, then commit**

```bash
git status --short   # expect ONLY apps/api/src/middleware/rate-limit.test.ts modified
git add apps/api/src/middleware/rate-limit.test.ts
git commit -m "test(rate-limit): cover XFF trim/empty, trusted-list trim, 429 body, constants and reportRateLimit keying"
```

---

### Task 5: Re-measure, ratchet the floors, update docs

Re-run the scoped Stryker measurement (≥2 runs for `projects.ts`), compute the
new floors, raise them in `scripts/mutation-gate.mjs`, prove the gate is
green-on-clean, and mark #13 resolved.

**Files:**
- Modify: `scripts/mutation-gate.mjs` (two floors + the baseline comment).
- Modify: `plans/README.md` (#13 resolution + the 048 row).

**Interfaces:**
- Consumes: `projectsBaseline` / `rateLimitBaseline` (Task 1), the committed
  test hardening (Tasks 2-4).
- Produces: the ratcheted floors.

- [ ] **Step 1: Re-stand-up Postgres and re-measure (run twice)**

Repeat Task 1 Steps 1-2 (fresh `docker run … flackyness-mut-pg`, migrate,
scoped `stryker run --mutate`), then Step 3's score extractor. Do this **twice**
for `projects.ts` (the race makes it wobble ~1pp); `rate-limit.ts` reproduces
exactly. Record all runs.

Let `projectsLow` = the **lower** of the two `projects.ts` scores;
`rateLimitScore` = the `rate-limit.ts` score.

Expected: both scores are meaningfully higher than their Task-1 baselines
(projects.ts 54.36%, rate-limit.ts 64.00%). If a target file did **not** rise, a
hardening test is not biting under Stryker — investigate before touching floors.

> **Measurement-anomaly caveat (from Task 1):** the scoped `--mutate` run
> *under-reports* kills for some `projects.ts` mutants — Task 1 directly verified
> three mutants Stryker marked `Survived` are actually killed under plain Vitest
> (including a pure unit-test case, so it is a Stryker `perTest` coverage-mapping
> miss, not the reconcile race). Consequences: (a) the `projects.ts` aggregate is
> **directional**, an under-estimate of the true score — which makes the
> `floor − 5` calibration conservatively safe, not unsafe; (b) the per-assertion
> mutation proofs in Tasks 2-4 (apply→run→FAIL→revert) are the reliable
> per-mutant signal, not the aggregate; (c) if `projects.ts` comes back higher
> than the added coverage alone predicts, that is consistent with this anomaly,
> not a bug. `rate-limit.ts` showed no such anomaly (Task 1 found no
> counter-evidence) — treat its score as trustworthy.

- [ ] **Step 2: Compute the new floors**

```
newProjectsFloor  = Math.floor(projectsLow)   - 5
newRateLimitFloor = Math.floor(rateLimitScore) - 5
```

Sanity: both must be **≥** the current floors (48 / 57). If either is lower, do
not lower the existing floor — investigate (a floor never regresses).

- [ ] **Step 3: Edit `scripts/mutation-gate.mjs`**

Update the two floors and their baseline comments in the `HARDENED` array. The
current lines read:

```js
  { report: 'apps/api/reports/mutation/mutation.json',       file: 'src/middleware/rate-limit.ts', floor: 57 }, // baseline: 62.00%
  { report: 'apps/api/reports/mutation/mutation.json',       file: 'src/routes/projects.ts',       floor: 48 }, // baseline: ~53.7% (reliable low; race-wobbly)
```

Set `floor:` to `newRateLimitFloor` / `newProjectsFloor` and rewrite each
trailing `// baseline:` comment to the newly measured score (keep the
`race-wobbly` note on `projects.ts`, updated to the new reliable low).

Then update the calibration comment block above the array (lines 4-22): the
`rate-limit.ts` and `projects.ts` narrative now reflects a **hardened** score,
not the old thin-coverage one — note that plan 048 covered the query-param /
IP-extraction survivors and record the new baselines. Leave the `logger.ts`
paragraph untouched.

- [ ] **Step 4: Prove the gate is green-on-clean at the new floors**

> **The gate is all-or-nothing across ALL 7 hardened entries, in TWO report
> files** — `apps/api/reports/mutation/mutation.json` (logger.ts, rate-limit.ts,
> projects.ts) and `apps/dashboard/reports/mutation/mutation.json` (the 4 `$lib`
> files). A projects+rate-limit-only report makes the gate exit **2** (missing
> logger.ts entry). And **each `stryker run --mutate` OVERWRITES `mutation.json`
> — it does not merge** — so the final API report must come from ONE consolidated
> run covering all three API files:
> `--mutate "src/middleware/logger.ts,src/middleware/rate-limit.ts,src/routes/projects.ts"`.
> Generate the dashboard report too (`pnpm --filter dashboard test:mutation`, no
> Postgres). This mirrors plan 047's green-on-clean proof.

With both complete reports present:

```bash
node scripts/mutation-gate.mjs
```

Expected: **exit 0**, `GATE PASSED`, all 7 lines print `PASS` with
`score ≥ floor` (projects.ts and rate-limit.ts at their new floors; the other
5 unchanged).

- [ ] **Step 5: Run the gate's own unit test and the full API suite**

```bash
node --test scripts/mutation-gate.test.mjs
pnpm --filter api exec vitest run
```

Expected: the gate test passes (6/6 — unchanged; this task edits data, not the
evaluator), and the full API suite is green with no unexpected `skipped`.

- [ ] **Step 6: Tear down Postgres**

```bash
docker rm -f flackyness-mut-pg
```

- [ ] **Step 7: Update `plans/README.md`**

1. Resolve follow-up **#13** (the entry beginning "`projects.ts` /
   `rate-limit.ts`'s per-file mutation floors (48 / 57) are coarse …"): prepend
   a `[RESOLVED on branch test/harden-projects-ratelimit-mutation]` marker and
   append the durable triage summary — the new floors, the killed-vs-accepted
   counts from Task 1's triage, and the notable **accepted** equivalents (so a
   future pass does not re-audit them), mirroring #15's resolution style.
2. Add the 048 row to the plans table (match the existing column layout,
   `| Plan | Title | Priority | Effort | Follow-up it closes | Status |`):

   ```
   | 048 | Harden `projects.ts` + `rate-limit.ts` mutation coverage; ratchet their gate floors | P3 | S–M | #13 | DONE |
   ```

- [ ] **Step 8: Commit**

```bash
# (plans/048-*.md was already committed when the plan landed — not re-added here.)
git add scripts/mutation-gate.mjs plans/README.md
git commit -m "chore(mutation): ratchet projects.ts + rate-limit.ts floors after coverage hardening (#13)"
```

---

## Self-Review Notes

**Spec coverage:**
- Decision 1 (test-only, no `// Stryker disable`) → Global Constraints + every
  task commits only `*.test.ts` (Tasks 2-4) / gate+docs (Task 5).
- Decision 2 (survivor-driven triage) → Task 1 measures & classifies; Tasks 2-4
  harden the killable set; accepted equivalents recorded (Task 1 Step 4, Task 5
  Step 7).
- Decision 3 (measure-first, re-measure-last, reliable-low) → Task 1 baseline,
  Task 5 two-run re-measure + `floor(reliableLow) - 5`.
- Decision 4 (both files, one plan, per-file tasks) → Tasks 2-3 (projects.ts),
  Task 4 (rate-limit.ts).
- Constraints (race-safe, mutation-proven, disposable Postgres, floor policy) →
  Global Constraints + per-task proof steps + Task 3's direct-insert fixtures.
- Success criteria 1-6 → Task 5 (floors raised, green-on-clean, docs), Tasks 2-4
  (proofs, zero product-source), Task 1 + Task 5 Step 7 (triage record).

**Known limitations, stated not hidden:**
1. `projects.ts`'s `Math.min(...,100)` / `RUN_RESULTS_CAP` / `QUARANTINE_ROW_CAP`
   upper bounds need >100 / >2000-row fixtures to kill; they are **accepted**
   equivalents-for-cost at this scale (Task 1 records them) — the floor sits
   below them. Not chased.
2. The `projects.ts` score still wobbles ~1pp because *other* suites that cover
   it hit the reconcile race (AGENTS.md). The new tests add no wobble (all
   race-safe), but the residual wobble is why Task 5 calibrates off the low.
3. Task 1's measurement surfaced killable survivors beyond the original
   "Verified survivor targets"; the high-value cheap ones were folded into the
   tasks: the malformed-id→400 guard on 5 endpoints (Task 2 Step 3b, ~21
   mutants), `?status=resolved`/`?status=bogus` fallback (Task 3), and the
   empty-XFF + `reportRateLimit` keygen/message (Task 4 Steps 1/3b).
4. **Accepted residuals** (recorded in Task 5's README #13 summary, not chased):
   the `QUARANTINE_ROW_CAP`/`RUN_RESULTS_CAP` truncation caps (need >1000/>2000
   fixtures); the trend date-label cosmetics (`projects.ts:491-492`, only
   `.length` is asserted, not label text); the `apiRateLimit`/`adminRateLimit`
   baked-in messages (`rate-limit.ts:88,99` — pinning them means flooding the
   module-level singletons, which would pollute the shared `'unknown'` bucket
   other enforcement tests depend on); `standardHeaders: 'draft-7'` and the
   defensive deep optional-chain (`rate-limit.ts:34,60`); and the ~13
   `projects.ts` mutants Task 1 flagged as measurement-anomaly mis-reports
   (already killed in reality — no new test needed).
```