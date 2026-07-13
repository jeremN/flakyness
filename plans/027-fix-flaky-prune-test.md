# Plan 027: Fix the flaky test in the flaky-test tracker

> **Executor instructions**: Follow this plan step by step. Run every verification
> command and confirm the expected result before moving on. If anything in the
> "STOP conditions" section occurs, stop and report — do not improvise. Do not
> update `plans/README.md`; the reviewer maintains the index.
>
> **Drift check (run first)**:
> `git log --oneline -1 && git diff --stat main -- apps/api/src/routes/admin.test.ts`
> If `admin.test.ts` has changed since commit `38c1eaf`, re-read it before trusting
> the excerpts below.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW — test-only change. No product code.
- **Depends on**: none
- **Category**: correctness / tests
- **Found**: 2026-07-13, in CI, on a **markdown-only PR** (#66) that could not
  possibly have broken anything.

## Why this matters

The failing job is `Tests`, on a pull request that changed nothing but `.md` files.
The same job passed on three other PRs opened minutes earlier. That is the definition
of a flaky test — and it is sitting in the test suite of a **flaky-test tracker**.

There is no version of "we'll retry it" that is acceptable here. Retrying to green is
the precise pathology this product exists to make visible. If we paper over our own
flake we have no standing to tell anyone else not to.

## The failure

```
apps/api/src/routes/admin.test.ts:894
AssertionError: expected { …(10) } to deeply equal { …(10) }

- Expected
+ Received
    "flakeCount": 3,
    "flakeRate": "0.3000",
    "lastSeen": null,
-   "status": "active",
+   "status": "resolved",
    "testFile": "prune.spec.ts",
    "testName": "prune-active-flaky",
    "totalRuns": 10,
```

## Root cause (diagnosed, not guessed)

**The ingest path reconciles flakiness in the background, without awaiting it.**
`apps/api/src/routes/reports.ts:132-135`:

```ts
    // Trigger flakiness detection in background (don't await). If it surfaces
    // a newly-flaky or newly-resolved test and the project has a webhook
    // configured, deliver one best-effort notification for this ingest.
    updateFlakyTests(project.id, resolveProjectConfig(project))
      .then(async ({ newlyFlaky, newlyResolved }) => {
```

This is **deliberate and correct** product behavior — ingest returns `201` without
blocking on recomputation. Do not change it.

The failing test (`admin.test.ts:850`, *"flaky_tests survives a confirmed prune,
including an ignored row"*) does this, in order:

1. calls `ingestBackdatedRun(...)` — which POSTs a report, **firing an un-awaited
   `updateFlakyTests` for this project**,
2. inserts a **fabricated** `flaky_tests` row (`prune-active-flaky`, `status: 'active'`)
   directly via Drizzle — a row with **zero backing `test_results`**,
3. prunes the project,
4. asserts the fabricated row survived *byte-for-byte* (`toEqual(activeRow)`).

If the background reconcile from step 1 lands **after** step 2, it finds
`prune-active-flaky` among the project's existing flaky tests, correctly observes that
it meets no flake threshold (it has no results at all — it was invented), and marks it
`resolved`. Step 4 then fails on exactly the `active` → `resolved` diff we see.

Whether the reconcile lands before or after step 2 depends purely on machine speed and
load. Fast dev laptop: passes. Loaded CI runner: sometimes doesn't. **Nothing is wrong
with the product here — the test is racing a background job it never waited for.**

Note the irony worth preserving in a comment: this test exists *because* plan 021
deletes data and a reviewer demanded proof that `flaky_tests` survives a prune. The
test proves the right thing. It just isn't deterministic.

## The fix

**Wait for the in-flight reconcile to settle before fabricating rows.** After the last
`ingestBackdatedRun(...)` and *before* the `db.insert(flakyTests)` calls, poll until
the background `updateFlakyTests` for that project has demonstrably completed.

The observable signal: `buildFlakinessReport()` produces a test that crosses the flake
threshold, so a completed reconcile leaves at least one row in `flaky_tests` for the
project. Poll `db.query.flakyTests.findMany({ where: eq(flakyTests.projectId, projectId) })`
until it is non-empty, with a bounded timeout (a few seconds) and a clear failure
message if it never settles.

Requirements on the fix:

- **A bounded, condition-based poll — never a fixed `sleep`/`setTimeout(500)`.** A
  fixed wait is just a slower race, and it would be a second flaky test dressed as a
  fix. This is a hard requirement.
- If the poll times out, **fail with an explanatory message** (e.g. "background
  updateFlakyTests never completed — reports.ts:135 fires it un-awaited; this test must
  wait for it before fabricating rows"). A timeout must not silently pass.
- Put the helper next to the other helpers in the `POST /api/v1/admin/projects/:id/prune`
  describe block, and **comment why it exists** — the next person will otherwise delete
  it as pointless.

## Sweep for the same latent bug

This race is not necessarily unique to one test. **Any test that ingests a report and
then asserts on `flaky_tests` without waiting is racing the same un-awaited call.**

Grep the API suites for the pattern (an `/api/v1/reports` POST followed by a
`flakyTests` read or write in the same test) and report what you find:

```
rg -n "api/v1/reports" apps/api/src/routes/*.test.ts
rg -n "flakyTests" apps/api/src/routes/*.test.ts
```

Fix any test that has the same shape. **If a test looks racy but you are not certain,
report it rather than "fixing" it speculatively** — a wrong fix here is worse than an
honest list.

## Scope

**In scope**:
- `apps/api/src/routes/admin.test.ts` — the fix + the settle helper
- Other `apps/api/src/routes/*.test.ts` files, **only** if the sweep proves the same race

**Out of scope** (do NOT touch):
- `apps/api/src/routes/reports.ts` — the un-awaited `updateFlakyTests` is **by design**.
  Do not `await` it to make a test pass. That would change product behavior (ingest
  latency) to paper over a test bug, and it is exactly the wrong trade.
- `apps/api/src/services/flakiness.ts` — resolving a flaky row with no backing results
  is **correct**. Do not weaken it.
- Any product code at all.

## Verification

Run the API suite against a disposable Postgres (unique container name and port, `docker
rm -f` it afterwards even on failure, **never `docker compose up`**):

```
docker run -d --name flackyness-test-pg-027 -e POSTGRES_PASSWORD=test_password \
  -e POSTGRES_DB=flackyness_test -p 5456:5432 postgres:16-alpine
touch .env
DATABASE_URL=postgres://postgres:test_password@localhost:5456/flackyness_test pnpm db:migrate
```

## Done criteria

- [ ] The API suite passes **10 consecutive runs**. Paste all ten. One green run proves
      nothing about a race — that is the entire lesson of this plan.
- [ ] `grep -rn "setTimeout\|sleep(" apps/api/src/routes/admin.test.ts` shows **no fixed
      wait** introduced by this change (a bounded *poll* with a delay between attempts is
      fine; a bare "wait 500ms and hope" is not — be ready to justify anything it prints)
- [ ] `pnpm --filter api exec tsc --noEmit` → exit 0
- [ ] `rtk proxy pnpm lint` → exit 0
- [ ] **No file outside `*.test.ts` is modified** — prove it with `git diff --name-only main`
- [ ] The sweep is reported: which tests share the ingest→assert-on-flaky_tests shape, and
      what you did about each

## STOP conditions

- **The fix requires changing `reports.ts` or `flakiness.ts`.** It does not. If you
  believe it does, STOP and report — you have found something more interesting than a
  flaky test, and it deserves its own plan rather than being smuggled into this one.
- **You cannot make the test deterministic without a fixed sleep.** STOP and report.
  Do not ship a slower race.
- The suite still fails intermittently across 10 runs after your fix. STOP and report the
  failure rate and the diff — an incompletely fixed flake is worse than a known one,
  because the next person will assume it's handled.

## Maintenance notes

- **The underlying sharp edge is worth remembering**: `POST /api/v1/reports` returns
  `201` *before* flakiness has been recomputed. Any consumer — test, dashboard, or E2E
  suite — that reads `flaky_tests` straight after an ingest is racing. Plan 026's E2E
  global setup already handles this correctly by polling for an active flaky test; this
  plan brings the API suite in line with that.
- That gap is arguably also a **product** DX issue (an API client has no way to know when
  reconciliation finished). Recorded as a follow-up in `plans/README.md`; deliberately not
  solved here.
- When this lands, the flake is gone from the suite — but the *record* of it should stay.
  It is the most honest demo material this project will ever have: its own CI produced a
  test that passed on three PRs and failed on a fourth that changed only markdown.
