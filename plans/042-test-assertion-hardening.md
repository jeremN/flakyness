# Test Assertion Hardening (A1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace four classes of non-biting assertions in the API test suite with assertions that a plausible source mutation would break, and record the mutation proof for each.

**Architecture:** Test-only change across two files. No product source is modified or committed. Each task tightens a group of assertions, then proves the tightening by deliberately breaking the covered source, observing the specific test go red, and reverting with `git checkout --`.

**Tech Stack:** Vitest 4.1.10, Hono 4.12 (`cors`, `secureHeaders`), Drizzle + Postgres.

**Spec:** `docs/superpowers/specs/2026-07-20-test-assertion-hardening-design.md`

## Global Constraints

- **Test files only.** The only files that may appear in any commit are
  `apps/api/src/routes/api.test.ts` and `apps/api/src/routes/projects.test.ts`.
  If `git status` before a commit shows any other file modified, the mutation
  was not reverted — revert it before committing.
- **Every mutation is reverted with `git checkout -- <file>` in the same task
  that applied it.** Never commit a mutated source file.
- **A mutation that leaves the suite green means the fix failed.** Revise the
  assertion; do not weaken, reword, or skip the proof. If an invariant turns
  out to be unprovable with the current fixture, say so explicitly in the task
  report rather than claiming a proof that did not happen.
- **If a mutation proof reveals a genuine product bug, report it — do not fix
  it.** A product fix belongs in its own change with its own review.
- Commits: single-line conventional-commit subject. **NO `Co-Authored-By`
  trailers.** No multi-paragraph body.
- Never `--no-verify`.
- Tests require `DATABASE_URL` and `ADMIN_TOKEN`; both suites are DB-gated via
  `describeWithDb` and will silently skip without them. **Before reporting any
  test result, confirm the tests actually ran** — a skipped suite reports as
  passing. Check the Vitest summary for `skipped` counts.

## File Structure

| File | Responsibility | Tasks |
|------|---------------|-------|
| `apps/api/src/routes/api.test.ts` | Smoke suite: 8 hardcoded requests confirming the app wires up | 1, 2 |
| `apps/api/src/routes/projects.test.ts` | Route suite for `/api/v1/projects/*` | 3 |

No files are created. No product source is modified.

---

### Task 1: Make the security-header assertions falsifiable (F1)

Two assertions in `api.test.ts` are vacuous by type: `Headers.get()` returns
`string | null`, never `undefined`, so `toBeDefined()` can never fail. Both
were proven to pass against a Hono app with `cors()` and `secureHeaders()`
entirely absent.

**Files:**
- Modify: `apps/api/src/routes/api.test.ts` — the `describe('CORS', …)` block
  (lines 42-52 as of `2f51679`) and the two assertions inside
  `it('should include security headers', …)` (lines 110-111 as of `2f51679`)

> **Anchor edits on content, not line numbers.** Step 1 replaces an 11-line
> block with roughly 30 lines, so every line number below it shifts. The
> numbers above are orientation only — locate each region by the quoted text.

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing later tasks depend on.

**Reference — probed behaviour of Hono `cors({ origin: <string>, credentials: true })`:**

| Configured `origin` | Request `Origin` | `access-control-allow-origin` |
|---|---|---|
| `http://localhost:5173` | `http://localhost:5173` | `http://localhost:5173` |
| `http://localhost:5173` | `https://evil.test` | *absent* (`null`) |
| `http://localhost:5173` | *(none)* | *absent* (`null`) |
| `*` | `https://evil.test` | `*` |

Both a matching-origin and a foreign-origin assertion are required: the first
alone would not catch widening to `origin: '*'`; the second alone would not
catch `cors()` being deleted (a bare app also returns `null`).

- [ ] **Step 1: Replace the CORS test**

In `apps/api/src/routes/api.test.ts`, replace this exact block —

```js
  describe('CORS', () => {
    it('should include CORS headers', async () => {
      const res = await app.request('/health', {
        headers: {
          'Origin': 'http://localhost:5173',
        },
      });
      
      expect(res.headers.get('access-control-allow-origin')).toBeDefined();
    });
  });
```

— with:

```js
  describe('CORS', () => {
    // The allowed origin is `process.env.DASHBOARD_URL || 'http://localhost:5173'`
    // (index.ts:26), read at module load. DASHBOARD_URL is set only in
    // docker-compose.yml and never in CI, so the literal below is what the
    // suite sees. Asserting the expression itself would mirror the
    // implementation and survive any mutation of it.
    const ALLOWED_ORIGIN = 'http://localhost:5173';

    it('echoes the configured origin back to an allowed origin', async () => {
      const res = await app.request('/health', {
        headers: { Origin: ALLOWED_ORIGIN },
      });

      expect(
        res.headers.get('access-control-allow-origin'),
        `expected the CORS middleware to allow ${ALLOWED_ORIGIN}; if DASHBOARD_URL is exported in your shell, unset it`
      ).toBe(ALLOWED_ORIGIN);
    });

    it('sends no allow-origin header for a foreign origin', async () => {
      const res = await app.request('/health', {
        headers: { Origin: 'https://evil.test' },
      });

      // Absent, not '*'. A wildcard here would let any site read authenticated
      // responses from a browser.
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });
  });
```

- [ ] **Step 2: Replace the security-headers assertion**

In the same file, inside `it('should include security headers', …)`, change
this single line —

```js
    expect(headers.get('x-frame-options')).toBeDefined();
```

— to:

```js
    expect(headers.get('x-frame-options')).toBe('SAMEORIGIN');
```

The `x-content-type-options` line immediately above it is already correct
(`toBe('nosniff')`) and must be left untouched.

- [ ] **Step 3: Run the tests and confirm they pass and did not skip**

Run: `pnpm --filter api exec vitest run src/routes/api.test.ts`

Expected: all tests pass. **Confirm the summary shows no `skipped` count.**
If it reports skipped, `DATABASE_URL` is unset — export it and re-run before
continuing. A skipped suite proves nothing.

- [ ] **Step 4: Mutation proof A — delete the CORS middleware**

Edit `apps/api/src/index.ts` and comment out the `cors` middleware (lines 25-28):

```js
// app.use('*', cors({
//   origin: process.env.DASHBOARD_URL || 'http://localhost:5173',
//   credentials: true,
// }));
```

Run: `pnpm --filter api exec vitest run src/routes/api.test.ts`

Expected: **`echoes the configured origin back to an allowed origin` FAILS**
with received `null`. Record the failure line in the task report.

Revert: `git checkout -- apps/api/src/index.ts`

- [ ] **Step 5: Mutation proof B — widen the origin to a wildcard**

Edit `apps/api/src/index.ts:26` to:

```js
  origin: '*',
```

Run: `pnpm --filter api exec vitest run src/routes/api.test.ts`

Expected: **`sends no allow-origin header for a foreign origin` FAILS** with
received `'*'`. Record the failure line.

Revert: `git checkout -- apps/api/src/index.ts`

- [ ] **Step 6: Mutation proof C — delete the security-headers middleware**

Edit `apps/api/src/index.ts:29` to:

```js
// app.use('*', secureHeaders());
```

Run: `pnpm --filter api exec vitest run src/routes/api.test.ts`

Expected: **`should include security headers` FAILS** on the
`x-content-type-options` assertion (it is first) — and would fail on
`x-frame-options` too. To confirm the new `x-frame-options` assertion is
independently load-bearing, temporarily comment out the `nosniff` line, re-run,
and confirm `x-frame-options` then fails on its own. Restore the `nosniff`
line afterwards.

Revert: `git checkout -- apps/api/src/index.ts`

- [ ] **Step 7: Confirm the working tree is clean of mutations**

Run: `git status --short`

Expected: **only** `apps/api/src/routes/api.test.ts` is listed as modified. If
`apps/api/src/index.ts` appears, a revert was missed — run
`git checkout -- apps/api/src/index.ts`.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/api.test.ts
git commit -m "test: assert CORS and frame-options values instead of definedness"
```

---

### Task 2: Name the reports smoke tests after what they assert (F2, F3)

Two tests in `api.test.ts` claim to test request validation. `routes/reports.ts:62`
mounts `reports.use('*', projectAuth())` before the handler, and neither request
carries an `Authorization` header — so both are rejected with 401 before
validation or JSON parsing is reached. The test named "should reject invalid
JSON body" never parses JSON. The multi-value `toContain` sets conceal this,
and one of them admits `500`, so a crash on bad input would also pass.

Real validation coverage already exists in `reports.test.ts` with a valid
token: `should require commit parameter` (:121), `should default branch to
main` (:133), `should reject invalid JSON body` (:148), `should reject invalid
Playwright report structure` (:160). Nothing is lost by renaming these two.

They are renamed rather than deleted: the smoke check that `projectAuth()` is
still mounted on the reports route is worth keeping, and that is precisely what
the new names claim.

**Files:**
- Modify: `apps/api/src/routes/api.test.ts` — the whole
  `describeWithDb('Request Validation', …)` block

> **Do not use line numbers.** Task 1 already edited this file and shifted
> every line below the CORS block. Locate the region by the text below.

**Interfaces:**
- Consumes: nothing from Task 1 (a different, non-overlapping block of the
  same file). Task 1 is committed before this task starts, so the file on
  disk already contains its changes.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Replace the whole `Request Validation` block**

In `apps/api/src/routes/api.test.ts`, replace the block that begins with
`describeWithDb('Request Validation', () => {` and ends with the `});` closing
it — three closing braces after `expect([400, 401, 500]).toContain(res.status);`
— with:

```js
describeWithDb('Reports Route Authentication', () => {
  // reports.ts:62 mounts `reports.use('*', projectAuth())` ahead of the
  // handler, so an unauthenticated request is rejected before validation or
  // JSON parsing runs. These are smoke checks that the guard is still mounted.
  // Real input-validation coverage lives in reports.test.ts:120-171, which
  // sends a valid project token.
  describe('POST /api/v1/reports', () => {
    it('rejects an unauthenticated request before validating the body', async () => {
      const res = await app.request('/api/v1/reports', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(401);
    });

    it('rejects an unauthenticated request before parsing the body', async () => {
      const res = await app.request('/api/v1/reports?project=test&branch=main&commit=abc', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        // Deliberately unparseable. A 401 proves the auth guard runs first;
        // a 500 would mean the body reached a parser that crashed on it.
        body: 'invalid json',
      });

      expect(res.status).toBe(401);
    });
  });
});
```

- [ ] **Step 2: Run the tests and confirm they pass and did not skip**

Run: `pnpm --filter api exec vitest run src/routes/api.test.ts`

Expected: all pass, no `skipped` count.

- [ ] **Step 3: Mutation proof — remove the auth guard from the reports route**

Edit `apps/api/src/routes/reports.ts:62` to:

```js
// reports.use('*', projectAuth());
```

Run: `pnpm --filter api exec vitest run src/routes/api.test.ts`

Expected: **both new tests FAIL**, receiving something other than 401 (a 400
from validation, or a 500 if the unparseable body reaches a parser). Record
both received statuses in the task report — they are informative: they show
what the old `toContain` sets were silently accepting.

If either received status is `500`, note it in the report as an observation.
Do not fix it: with the guard restored it is unreachable, and per the Global
Constraints a product change belongs in its own review.

Revert: `git checkout -- apps/api/src/routes/reports.ts`

- [ ] **Step 4: Confirm the working tree is clean of mutations**

Run: `git status --short`

Expected: only `apps/api/src/routes/api.test.ts` modified.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/api.test.ts
git commit -m "test: rename reports smoke tests to match the layer they assert"
```

---

### Task 3: Assert the analysis endpoint's invariants (F4)

`projects.test.ts:589-592` runs four existence checks on a response the suite
provoked. A handler returning `null` for all four fields would satisfy them.
The endpoint's actual shape (`projects.ts:405-410`) makes the real invariant
checkable:

```js
return c.json({
  windowDays,
  threshold,
  flakyTests: analysis.filter((t) => t.isFlaky),
  allTests: analysis,
});
```

`flakyTests` is literally a filtered subset of `allTests`, and both
`windowDays` and `threshold` are clamped (`projects.ts:387-399`) — to `[1, 90]`
and `[0, 1]` respectively. Those are the properties worth asserting.

**Files:**
- Modify: `apps/api/src/routes/projects.test.ts:584-593`

**Interfaces:**
- Consumes: `testProjectId`, already defined in the suite.
- Produces: nothing.

- [ ] **Step 1: Inspect the fixture before writing the invariant**

The subset mutation in Step 4 is only detectable if the fixture contains at
least one **non-flaky** test. Find out before relying on it.

Temporarily add this test immediately after the existing
`it('should return real-time flakiness analysis', …)`:

```js
    it('TEMP fixture probe', async () => {
      const res = await app.request(`/api/v1/projects/${testProjectId}/analysis`);
      const body = await res.json();
      expect({
        allTests: body.allTests.length,
        flakyTests: body.flakyTests.length,
        nonFlaky: body.allTests.filter((t: { isFlaky: boolean }) => !t.isFlaky).length,
      }).toEqual({ allTests: -1, flakyTests: -1, nonFlaky: -1 });
    });
```

Run: `pnpm --filter api exec vitest run src/routes/projects.test.ts -t "TEMP fixture probe"`

The forced failure prints the real counts. (Vitest suppresses `console.log` in
this suite; a failed assertion is the reliable way to read a value out.)

**Record the three counts in the task report.** Then delete the temporary test.

- If `nonFlaky` is `0`, the subset mutation in Step 4 is **not provable** with
  this fixture. Keep the assertion — it is still correct and still catches the
  `null` case — but report the proof as unavailable rather than claiming it.
  Do not add fixture data to manufacture a proof; that is a change to test
  data outside this plan's scope, and it belongs to a task that can be
  reviewed on its own terms.

- [ ] **Step 2: Replace the four existence checks**

In `apps/api/src/routes/projects.test.ts`, inside
`it('should return real-time flakiness analysis', …)`, replace this exact
block —

```js
      const body = await res.json();
      expect(body.windowDays).toBeDefined();
      expect(body.threshold).toBeDefined();
      expect(body.flakyTests).toBeDefined();
      expect(body.allTests).toBeDefined();
```

— with:

```js
      const body = await res.json();

      // windowDays and threshold are clamped by the handler (projects.ts:387-399).
      expect(typeof body.windowDays).toBe('number');
      expect(body.windowDays).toBeGreaterThanOrEqual(1);
      expect(body.windowDays).toBeLessThanOrEqual(90);

      expect(typeof body.threshold).toBe('number');
      expect(body.threshold).toBeGreaterThanOrEqual(0);
      expect(body.threshold).toBeLessThanOrEqual(1);

      expect(Array.isArray(body.flakyTests)).toBe(true);
      expect(Array.isArray(body.allTests)).toBe(true);

      // The endpoint defines flakyTests as allTests.filter(t => t.isFlaky),
      // so both of these hold by construction — and break if that filter does.
      expect(body.flakyTests.every((t: { isFlaky: boolean }) => t.isFlaky)).toBe(true);
      const allNames = new Set(body.allTests.map((t: { testName: string }) => t.testName));
      expect(
        body.flakyTests.every((t: { testName: string }) => allNames.has(t.testName))
      ).toBe(true);
```

- [ ] **Step 3: Run the tests and confirm they pass and did not skip**

Run: `pnpm --filter api exec vitest run src/routes/projects.test.ts`

Expected: all pass, no `skipped` count.

- [ ] **Step 4: Mutation proof A — drop the flaky filter**

Edit `apps/api/src/routes/projects.ts:408` to:

```js
    flakyTests: analysis,
```

Run: `pnpm --filter api exec vitest run src/routes/projects.test.ts`

Expected (if Step 1 reported `nonFlaky > 0`): **`should return real-time
flakiness analysis` FAILS** on the `every(t => t.isFlaky)` assertion.

If Step 1 reported `nonFlaky === 0`, this mutation will **not** fail. Report
that outcome honestly — do not present it as a proof.

Revert: `git checkout -- apps/api/src/routes/projects.ts`

- [ ] **Step 5: Mutation proof B — break the threshold clamp**

Edit `apps/api/src/routes/projects.ts:397` to remove the upper clamp:

```js
    ? Math.max(rawThreshold, 0)
```

Run: `pnpm --filter api exec vitest run src/routes/projects.test.ts -t "should accept custom window and threshold"`

This alone will not fail — the existing test passes `threshold=0.1`, already in
range. Instead run the whole file and check whether any test drives the
threshold above 1. If none does, **the clamp is unproven by the current suite**;
report that as a coverage gap for A2 rather than adding a test here.

Revert: `git checkout -- apps/api/src/routes/projects.ts`

- [ ] **Step 6: Confirm the working tree is clean of mutations**

Run: `git status --short`

Expected: only `apps/api/src/routes/projects.test.ts` modified.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/projects.test.ts
git commit -m "test: assert analysis invariants instead of field definedness"
```

---

### Task 4: Verify the F1 class is closed and the suite is green

The spec claims F1 (`toBeDefined()` on a `Headers.get()` result) is closed
completely, not sampled. Confirm that, then run the full gate.

**Files:** none modified (verification only, unless the grep finds something).

- [ ] **Step 1: Confirm no vacuous header assertion remains**

Run:

```bash
grep -rn "headers.get(.*)).toBeDefined()" --include="*.ts" --include="*.svelte" apps/
```

Expected: **no output** (exit 1). If any line is returned, it is the same
vacuous-by-type defect — fix it the same way as Task 1 and note it in the
report.

- [ ] **Step 2: Full test suite**

Run: `pnpm test`

Expected: green. Record the pass count and confirm no unexpected `skipped`.

- [ ] **Step 3: Lint and both typechecks**

```bash
pnpm lint
pnpm --filter api exec tsc --noEmit
pnpm --filter dashboard check
```

Expected: all clean. The inline type annotations added in Task 3
(`(t: { isFlaky: boolean })`) exist because `res.json()` returns `any` and
oxlint/tsc would otherwise flag the implicit-any parameters.

- [ ] **Step 4: Confirm no product source is in the branch diff**

Run: `git diff --stat main...HEAD`

Expected: exactly two files — `apps/api/src/routes/api.test.ts` and
`apps/api/src/routes/projects.test.ts` — plus the spec and this plan. **Any
other product file in this list means a mutation was committed.** Investigate
before proceeding.

- [ ] **Step 5: Update the plan index**

Two edits in `plans/README.md`:

1. Plan 041's row (line 287 as of `2f51679`) still reads `TODO` even though it
   merged. Change its final column to:

   ```
   DONE (merged via PR #95, commit `2f51679`)
   ```

2. Add this row immediately after plan 041's, matching the table's columns
   (`| Plan | Title | Priority | Effort | Depends on | Status |`):

   ```
   | 042 | Replace four classes of non-biting assertions in the API suite with assertions a source mutation breaks (A1 of the mutation-testing effort) | P3 | S | — | TODO |
   ```

- [ ] **Step 6: Commit**

```bash
git add plans/README.md
git commit -m "docs: index plan 042 and mark 041 done"
```

---

## Self-Review Notes

**Spec coverage:** F1 → Task 1 + Task 4 Step 1. F2 → Task 2. F3 → Task 2
(same two tests; the `500` admission is called out in Task 2 Step 3). F4 →
Task 3. Success criteria → Task 4.

**Known limitations, stated rather than hidden:**

1. Task 3's subset proof depends on the fixture containing a non-flaky test.
   Step 1 makes the executor establish this before claiming the proof.
2. Task 3 Step 5 will likely find the threshold clamp unproven. That is a
   real coverage gap and is routed to A2, not papered over.
3. All the tightened tests are DB-gated (`describeWithDb`). They bite in CI,
   where a database is present, and do not run at all without one. Making
   `api.test.ts` DB-independent — it only needs the app, which imports the DB
   module — is a genuine improvement but is out of A1's scope; it is noted
   here as an A2 candidate.
