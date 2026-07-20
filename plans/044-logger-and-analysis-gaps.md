# logger.ts coverage + the two /analysis gaps (A2b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add mutation-proven tests for `logger.ts` and close the two `/analysis` coverage gaps A1 recorded (the clamp and the flaky-subset invariant). Test-only.

**Architecture:** A new `middleware/logger.test.ts` (DB-independent console-spy unit tests) and two appended blocks in `routes/projects.test.ts`. No product source changes — `logger.ts` and `projects.ts` have no defect (probed).

**Tech Stack:** Vitest 4.1.10 (`vi.spyOn`, `vi.resetModules`), Hono 4.12.

**Spec:** `docs/superpowers/specs/2026-07-20-logger-and-analysis-gaps-design.md`

## Global Constraints

- **Test files only in commits.** `middleware/logger.test.ts` (new) and
  `routes/projects.test.ts`. If any product file (`logger.ts`, `projects.ts`)
  appears in a commit, a mutation revert was missed.
- **Every mutation is reverted with `git checkout -- <file>` in the same task.**
- **A mutation that leaves the suite green means the fix failed.** Do not weaken
  or skip a proof. If a proof can't be obtained, say so.
- If a mutation reveals a real product bug, report it — do not fix here.
- Commits: single-line conventional-commit subject. **NO `Co-Authored-By`.**
  Never `--no-verify`.
- The `projects.test.ts` additions are DB-gated (the file self-skips without
  `DATABASE_URL`+`ADMIN_TOKEN`). `logger.test.ts` is **not** DB-gated and must
  run everywhere. Before reporting results, confirm the Vitest summary shows the
  tests ran, no unexpected `skipped`.

## File Structure

| File | Responsibility | Tasks |
|------|---------------|-------|
| `apps/api/src/middleware/logger.test.ts` | logger unit tests (new) | 1 |
| `apps/api/src/routes/projects.test.ts` | clamp + subset-invariant tests | 2, 3 |

---

### Task 1: `logger.test.ts` — status routing, context, prod stack omission, format

**Files:**
- Create: `apps/api/src/middleware/logger.test.ts`

**Interfaces:**
- Consumes: `requestLogger`, `logError`, `logger` from `./logger`.

- [ ] **Step 1: Create the file**

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { requestLogger, logError } from './logger';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('requestLogger', () => {
  it('routes the completion log to a console fn by status class', async () => {
    const info: string[] = [];
    const warn: string[] = [];
    const error: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m) => { info.push(String(m)); });
    vi.spyOn(console, 'warn').mockImplementation((m) => { warn.push(String(m)); });
    vi.spyOn(console, 'error').mockImplementation((m) => { error.push(String(m)); });

    const app = new Hono();
    app.use('*', requestLogger());
    app.get('/ok', (c) => c.json({}, 200));
    app.get('/missing', (c) => c.json({}, 404));
    app.get('/broken', (c) => c.json({}, 500));

    await app.request('/ok');
    await app.request('/missing');
    await app.request('/broken');

    const completed = (arr: string[]) => arr.filter((l) => l.includes('Request completed'));
    // 200 -> info (console.log), 404 -> warn, 500 -> error
    expect(completed(info).some((l) => l.includes('200'))).toBe(true);
    expect(completed(warn).some((l) => l.includes('404'))).toBe(true);
    expect(completed(error).some((l) => l.includes('500'))).toBe(true);
    // and not misrouted: the 200 completion is not a warning
    expect(completed(warn).some((l) => l.includes('200'))).toBe(false);
  });

  it('sets a requestId on context and logs the request start', async () => {
    const info: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m) => { info.push(String(m)); });

    let capturedId: unknown;
    const app = new Hono();
    app.use('*', requestLogger());
    app.get('/x', (c) => {
      capturedId = c.get('requestId');
      return c.json({});
    });
    await app.request('/x');

    expect(typeof capturedId).toBe('string');
    expect((capturedId as string).length).toBeGreaterThan(0);
    expect(info.some((l) => l.includes('Request started'))).toBe(true);
  });
});

describe('logError', () => {
  const fakeCtx = () =>
    ({ get: () => 'rid-abc', req: { method: 'POST', path: '/api/v1/x' } }) as unknown as Context;

  it('includes context and the error message (dev format)', () => {
    const out: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((m) => { out.push(String(m)); });

    logError(new Error('boom-message'), fakeCtx());

    const line = out.join('\n');
    expect(line).toContain('POST');
    expect(line).toContain('/api/v1/x');
    expect(line).toContain('rid-abc');
    expect(line).toContain('boom-message');
    // NOTE: the dev formatLog prints only error.message, not error.name — name
    // is asserted in the production-JSON test below.
  });

  it('omits the stack trace in production (no path leak)', async () => {
    vi.resetModules();
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const { logError: prodLogError } = await import('./logger');
      const out: string[] = [];
      vi.spyOn(console, 'error').mockImplementation((m) => { out.push(String(m)); });

      const err = new Error('prod-msg');
      err.stack = 'Error: prod-msg\n    at /secret/internal/path.ts:99:7';
      prodLogError(err, fakeCtx());

      const raw = out[0];
      const parsed = JSON.parse(raw); // production format is JSON
      expect(parsed.error.name).toBe('Error');
      expect(parsed.error.message).toBe('prod-msg');
      expect(parsed.error.stack).toBeUndefined();
      expect(raw).not.toContain('/secret/internal/path.ts');
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
      vi.resetModules();
    }
  });
});

describe('log format', () => {
  it('is JSON in production and a pretty non-JSON line in dev', async () => {
    // Production: re-import under NODE_ENV=production.
    vi.resetModules();
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    let prodLine = '';
    try {
      const { logger } = await import('./logger');
      const out: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((m) => { out.push(String(m)); });
      logger.info('hello', { path: '/p' });
      prodLine = out[0];
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
      vi.resetModules();
    }
    expect(() => JSON.parse(prodLine)).not.toThrow();

    // Dev: default test env (NODE_ENV=test !== 'production' -> isDev).
    const { logger: devLogger } = await import('./logger');
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m) => { out.push(String(m)); });
    devLogger.info('hello', { path: '/p' });
    const devLine = out[0];

    expect(devLine).toMatch(/^\[.*\] INFO/);
    let devIsJson = true;
    try { JSON.parse(devLine); } catch { devIsJson = false; }
    expect(devIsJson).toBe(false);
  });
});
```

- [ ] **Step 2: Run and confirm pass, no skip**

Run: `pnpm --filter api exec vitest run src/middleware/logger.test.ts`
Expected: all pass (5 tests), 0 skipped. This file needs no DB.

- [ ] **Step 3: Mutation A — misroute the status class**

In `logger.ts:96`, change `status >= 500` to `status >= 600`.
Run the file. Expected: **the status-routing test FAILS** (the 500 completion
now goes to `warn`/`info`, not `error`). Revert: `git checkout -- apps/api/src/middleware/logger.ts`

- [ ] **Step 4: Mutation B — leak the stack in production**

In `logger.ts:112`, change `stack: isDev ? err.stack : undefined` to
`stack: err.stack`.
Run the file. Expected: **`omits the stack trace in production` FAILS**
(`error.stack` is defined and the sentinel path appears). Revert with
`git checkout --`.

- [ ] **Step 5: Mutation C — drop the error message**

In `logger.ts:111`, change `message: err.message` to `message: ''`.
Run the file. Expected: **`includes context and the error message` FAILS**.
Revert with `git checkout --`.

- [ ] **Step 6: Confirm tree clean, commit**

Run `git status --short` → only `logger.test.ts` (new). `logger.ts` must be
unmodified.

```bash
git add apps/api/src/middleware/logger.test.ts
git commit -m "test(api): cover logger status routing, context, and prod stack omission"
```

---

### Task 2: `/analysis` clamp test (append to projects.test.ts)

**Files:**
- Modify: `apps/api/src/routes/projects.test.ts` — inside the existing
  `describe('GET /api/v1/projects/:id/analysis', …)` block, after the
  `it('should accept custom window and threshold', …)` test.

**Interfaces:**
- Consumes: `app`, `testProjectId` (already in scope).

- [ ] **Step 1: Append the clamp test**

Locate the `it('should accept custom window and threshold', …)` test inside the
analysis describe (it ends at `projects.test.ts:632`). Immediately after its
closing `});`, add:

```ts
    it('clamps out-of-range window and threshold', async () => {
      const res = await app.request(`/api/v1/projects/${testProjectId}/analysis?days=999&threshold=5`);
      expect(res.status).toBe(200);

      const body = await res.json();
      // days clamped to the 90 cap, threshold to the 1.0 ceiling
      // (projects.ts:387-399). The in-range sibling test (7 / 0.1) passes those
      // through unclamped, so only out-of-range values catch a deleted clamp.
      expect(body.windowDays).toBe(90);
      expect(body.threshold).toBe(1);
    });
```

- [ ] **Step 1b: Refresh A1's now-fulfilled clamp IOU (comment-only)**

The empty-analysis test carries A1's marker (`projects.test.ts:608-609`):
```ts
      // clamps in projects.ts leaves this test green (verified). Proving the
      // clamp needs a request with out-of-range params -> A2.
```
Replace the second sentence so it points at the test we just added, instead of
claiming the gap is still open:
```ts
      // clamps in projects.ts leaves this test green (verified). The clamp
      // itself is proven by the out-of-range sibling test below (plan 044).
```

- [ ] **Step 2: Run and confirm pass**

Run: `pnpm --filter api exec vitest run src/routes/projects.test.ts`
Expected: pass, no unexpected skip. (Needs `DATABASE_URL` + `ADMIN_TOKEN`.)

- [ ] **Step 3: Mutation — remove the window clamp**

In `projects.ts`, replace the `windowDays` clamp
```ts
  const windowDays = Math.min(
    Math.max(
      parseInt(c.req.query('days') || String(resolvedConfig.windowDays), 10) || resolvedConfig.windowDays,
      1
    ),
    90
  );
```
with the un-clamped
```ts
  const windowDays = parseInt(c.req.query('days') || String(resolvedConfig.windowDays), 10) || resolvedConfig.windowDays;
```
Run the file. Expected: **`clamps out-of-range window and threshold` FAILS**
(`windowDays === 999`). Revert: `git checkout -- apps/api/src/routes/projects.ts`

- [ ] **Step 4: Mutation — remove the threshold clamp**

In `projects.ts`, change
```ts
    ? Math.min(Math.max(rawThreshold, 0), 1)
```
to
```ts
    ? rawThreshold
```
Run the file. Expected: **the same test FAILS** on `threshold === 5`.
Revert with `git checkout --`.

- [ ] **Step 5: Confirm tree clean, commit**

Run `git status --short` → only `projects.test.ts`.

```bash
git add apps/api/src/routes/projects.test.ts
git commit -m "test(api): prove the analysis endpoint clamps out-of-range params"
```

---

### Task 3: `/analysis` flaky-subset invariant (append to projects.test.ts)

**Files:**
- Modify: `apps/api/src/routes/projects.test.ts` — a new sibling describe
  immediately after the existing `describe('GET /api/v1/projects/:id/analysis', …)`
  block closes.

**Interfaces:**
- Consumes: `app`, `adminToken`, `hasDatabase`, `hasAdminToken`, `randomUUID`,
  `beforeAll`, `afterAll` (all already imported / in scope).

- [ ] **Step 1: Append the subset-invariant describe**

After the analysis describe's closing `});`, add:

```ts
  describe('GET /api/v1/projects/:id/analysis — flaky-subset invariant (populated)', () => {
    let subsetProjectId: string;

    beforeAll(async () => {
      if (!(hasDatabase && hasAdminToken)) return;
      const createRes = await app.request('/api/v1/admin/projects', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `subset-invariant-${randomUUID()}` }),
      });
      const createBody = await createRes.json();
      subsetProjectId = createBody.project.id;
      const token = createBody.token;

      // One upload, two specs, each with THREE `tests[]` entries so both reach
      // minRuns=3 in a single ingest (the shape reports.test.ts:601 documents;
      // three results[] in ONE tests[] entry would collapse to one row). Probed:
      // A-flaky -> isFlaky true (2 passed, 1 failed), B-stable -> isFlaky false.
      const exec = (status: string, sec: string) => ({
        results: [{ workerIndex: 0, status, duration: 1, retry: 0, startTime: `2026-07-15T10:00:0${sec}.000Z` }],
      });
      const report = {
        config: {},
        suites: [{
          title: 's',
          file: 's.spec.ts',
          specs: [
            { title: 'A-flaky', ok: false, tests: [exec('passed', '0'), exec('passed', '1'), exec('failed', '2')] },
            { title: 'B-stable', ok: true, tests: [exec('passed', '0'), exec('passed', '1'), exec('passed', '2')] },
          ],
        }],
      };
      const ingest = await app.request('/api/v1/reports?branch=main&commit=subset001', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(report),
      });
      expect(ingest.status).toBe(201);
    });

    afterAll(async () => {
      if (subsetProjectId) {
        await app.request(`/api/v1/admin/projects/${subsetProjectId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${adminToken}` },
        });
      }
    });

    it('flakyTests is exactly the flaky subset of allTests', async () => {
      const res = await app.request(`/api/v1/projects/${subsetProjectId}/analysis`);
      expect(res.status).toBe(200);

      const body = await res.json();
      // analyzeFlakiness reads test_results (written synchronously during
      // ingest), not flaky_tests, so this does not race the un-awaited
      // updateFlakyTests() reconcile described in AGENTS.md.

      // Anti-vacuity: BOTH a flaky and a non-flaky test must be present, or the
      // every()/subset checks below are trivially true on a degenerate set (the
      // trap A1 fell into with an empty analysis).
      expect(body.allTests.length).toBeGreaterThanOrEqual(2);
      expect(body.allTests.some((t: { isFlaky: boolean }) => t.isFlaky === false)).toBe(true);
      expect(body.flakyTests.length).toBeGreaterThanOrEqual(1);

      // The endpoint defines flakyTests as allTests.filter(t => t.isFlaky).
      expect(body.flakyTests.every((t: { isFlaky: boolean }) => t.isFlaky)).toBe(true);
      const allNames = new Set(body.allTests.map((t: { testName: string }) => t.testName));
      expect(body.flakyTests.every((t: { testName: string }) => allNames.has(t.testName))).toBe(true);
    });
  });
```

- [ ] **Step 1b: Refresh A1's now-fulfilled subset IOU (comment-only)**

The empty-analysis test's block-comment (`projects.test.ts:591` and `:597-598`)
frames the invariant as still open. Update the two framing lines so they
back-reference the sibling describe just added — leave the rest of the comment
(the vacuous-`every` reasoning, the `minRuns`/`flakiness.ts` refs) intact, it is
still accurate about why *this* empty test cannot prove it.

Change the opening line from:
```ts
    // COVERAGE GAP, deliberately left for A2: no fixture in this file can prove
```
to:
```ts
    // Why this empty case cannot prove the endpoint's subset invariant: no
```
and change the closing sentence from:
```ts
    // Proving the invariant needs a project with >= 3 ingests, which is new
    // fixture setup and belongs in its own reviewed change.
```
to:
```ts
    // Proving the invariant needs a project carrying >= minRuns runs of both a
    // flaky and a non-flaky test; that is the dedicated sibling describe below
    // (plan 044), not this empty case.
```

- [ ] **Step 2: Run and confirm pass, no unexpected skip**

Run: `pnpm --filter api exec vitest run src/routes/projects.test.ts`
Expected: pass. Watch for the ingest `201` assertion in `beforeAll`.

- [ ] **Step 3: Mutation — drop the flaky filter**

In `projects.ts`, change `flakyTests: analysis.filter((t) => t.isFlaky),` to
`flakyTests: analysis,`.
Run the file. Expected: **`flakyTests is exactly the flaky subset` FAILS** —
`flakyTests` now includes `B-stable` (isFlaky false), so
`every(t => t.isFlaky)` reds. This is the proof A1 could not obtain.
Revert: `git checkout -- apps/api/src/routes/projects.ts`

- [ ] **Step 4: Confirm tree clean, commit**

Run `git status --short` → only `projects.test.ts`.

```bash
git add apps/api/src/routes/projects.test.ts
git commit -m "test(api): prove the analysis flaky-subset invariant on a populated project"
```

---

### Task 4: Final gate + plan index

- [ ] **Step 1: Full suite, lint, typecheck**

```bash
pnpm --filter api test
pnpm --filter dashboard test
pnpm run lint
pnpm --filter api exec tsc --noEmit
```
Expected: all green. Record counts; confirm `logger.test.ts` ran (5 tests) and
no unexpected `skipped`.

- [ ] **Step 2: Branch diff is test-only**

Run: `git diff --name-only main...HEAD`
Expected: `logger.test.ts`, `projects.test.ts`, the spec, this plan,
`plans/README.md`. **No `logger.ts` or `projects.ts`** — their presence means a
mutation was committed.

- [ ] **Step 3: Index the plan**

In `plans/README.md`, add after the 043 row (match the columns):

```
| 044 | Cover logger.ts and close the two /analysis coverage gaps A1 recorded (clamp + flaky-subset invariant); A2b of the mutation-testing effort | P3 | S | A1 (plan 042), A2a (plan 043) | TODO |
```

- [ ] **Step 4: Commit**

```bash
git add plans/README.md
git commit -m "docs: index plan 044"
```

## Self-Review Notes

**Spec coverage:** logger status routing / requestId / context / prod stack
omission / format → Task 1. clamp gap → Task 2. subset invariant → Task 3.

**Probed facts the code relies on:** the three-`tests[]`-entry shape reaches
minRuns=3 in one ingest (else analysis is empty); `vi.resetModules()` +
`NODE_ENV=production` re-imports a prod logger cleanly; dev `formatLog` prints
`message` not `name`; `/analysis` reads `test_results` synchronously (no
reconcile race). All verified before writing.

**Sharp edges:** the prod-path logger tests must restore `NODE_ENV` and
`resetModules` in `finally`, or later tests see a prod logger. Console spies are
restored globally in `afterEach`.
