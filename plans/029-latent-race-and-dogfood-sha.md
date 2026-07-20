# Plan 029: Kill the second latent test race, and stop dogfooding a phantom commit

> **Executor instructions**: Follow the plan, run every verification, honor the STOP
> conditions. Do not update `plans/README.md` — the reviewer maintains it.
>
> **Drift check (run first)**: `git rev-parse --short HEAD` should be at or after
> `b92fb3f`, and `apps/api/src/routes/tests.test.ts` should still have a top-level
> `beforeAll` at ~line 26 that POSTs to `/api/v1/reports` (~line 46), plus a nested
> `beforeAll` (~line 259) that inserts `patch-route-flaky-test` (~line 266). Line numbers
> may drift; the *shape* is what matters. On a structural mismatch, STOP and report.

## Status

- **Priority**: P1 (the race) / P2 (the SHA)
- **Effort**: S
- **Risk**: LOW — one test file and one CI workflow. No product code.
- **Depends on**: none. **Parallel-safe**: sole owner of `apps/api/src/routes/tests.test.ts`
  and `.github/workflows/ci.yml`. Plans 028 and 030 run alongside and touch neither.
- **Category**: correctness / tests / CI
- **Planned at**: commit `b92fb3f`, 2026-07-13

## Part 1 — the second latent race

### Why this matters

Plan 027 fixed a flaky test that CI caught on a **markdown-only PR**. While fixing it, the
executor swept for the same shape elsewhere and found one more — and, correctly, **reported
it instead of speculatively fixing it** (fixing a race you have never seen fail is how one
flake becomes two). This plan fixes it, now that we understand the mechanism cold.

### The mechanism (identical to 027)

`apps/api/src/routes/reports.ts` fires the reconcile **un-awaited** — deliberate, so ingest
returns `201` without blocking on recomputation:

```ts
    // Trigger flakiness detection in background (don't await). ...
    updateFlakyTests(project.id, resolveProjectConfig(project))
      .then(async ({ newlyFlaky, newlyResolved }) => {
```

`updateFlakyTests` (`apps/api/src/services/flakiness.ts`) then sweeps **every** existing
`flaky_tests` row for the project — not just the names in the latest report — and resolves
any `active` row that the analysis says isn't flaky:

```ts
  const resolveIds = existingFlaky
    .filter(existing => existing.status === 'active')
    .filter(existing => !(isFlakyByName.get(existing.testName) ?? false))
    .map(existing => existing.id);
```

**Both behaviors are correct. Do not change either.**

In `tests.test.ts`:
1. a **top-level `beforeAll`** POSTs a report for `testProjectId` — firing the un-awaited
   reconcile;
2. a **nested `beforeAll`** inside `describe('PATCH /api/v1/tests/flaky/:id')` later
   fabricates a `patch-route-flaky-test` row for **that same project** — a row with zero
   backing `test_results`.

If the background reconcile lands after the fabrication, it finds that row, correctly sees
it meets no flake threshold, and resolves it — flipping `status` out from under whatever
asserts on it.

It has not been observed failing, because a whole `describe('GET .../history')` block with
several real HTTP round-trips happens to run in between, giving the reconcile time to land
first. **That is luck, not design** — the exact same luck the 027 test enjoyed on every dev
laptop right up until a loaded CI runner took it away.

### The fix

Mirror what plan 027 landed in `admin.test.ts`: **wait for the in-flight reconcile to
demonstrably complete before fabricating any `flaky_tests` row.**

`admin.test.ts` already has the pattern — read `waitForFlakyReconcile()` there and follow
it. It uses the file's generic `waitFor(predicate, {timeoutMs, intervalMs})` poller, polls
until `flaky_tests` for the project is non-empty, and throws an explanatory error on
timeout.

**Hard requirement: a bounded, condition-based poll. Never a fixed `sleep`/`setTimeout(500)`
before an assertion.** A fixed wait is just a slower race, and shipping one here would be a
second flaky test dressed as a fix.

Check whether `tests.test.ts` already has a `waitFor`-style helper; if not, add one (or
mirror `admin.test.ts`'s). Comment *why* the wait exists, or the next reader deletes it as
pointless.

## Part 2 — our own dogfood step records a commit that doesn't exist

### Why this matters

Plan 024 shipped a GitHub Action for **other people's repos**, and a reviewer caught that it
used `github.sha` — which on a `pull_request` event is the SHA of an **ephemeral
auto-generated merge commit** (`refs/pull/N/merge`): a commit that exists nowhere in the
contributor's branch and is regenerated whenever the base branch moves. It was fixed to
`github.event.pull_request.head.sha || github.sha`.

**Our own CI does not apply that fix.** `.github/workflows/ci.yml`'s dogfood step:

```yaml
          REF_NAME: ${{ github.ref_name }}
          COMMIT_SHA: ${{ github.sha }}
          RUN_ID: ${{ github.run_id }}
```

Confirmed in the CI log of PR #69: the dogfooded run was recorded with branch **`69/merge`**
and the phantom merge SHA. So Flackyness's own reference dataset — the one a prospective
user looks at to decide whether this tool works — attributes every PR run to a branch that
isn't a branch and a commit that can't be checked out.

The severity is low (it's demo data). The **inconsistency** is the problem: the action we
ship gets this right; the tool's own dogfood does not. That is precisely the kind of detail
that quietly erodes trust in a measurement tool.

### The fix

```yaml
          REF_NAME: ${{ github.head_ref || github.ref_name }}
          COMMIT_SHA: ${{ github.event.pull_request.head.sha || github.sha }}
```

On `pull_request`, the left sides resolve to the real head branch and head commit; on
`push`, they're empty and the right sides (correct there) take over. This is exactly the
pattern `action.yml` now uses — **read `action.yml` and match it**, including the spirit of
its comment explaining why it can't be "simplified".

Keep passing these through `env:` rather than interpolating `${{ }}` into the `run:` shell —
that is a deliberate shell-injection defense (branch names are attacker-influenceable), and
a repo security hook flags the direct form.

## Scope

**In scope** (this plan owns these files exclusively):
- `apps/api/src/routes/tests.test.ts`
- `.github/workflows/ci.yml`

**Out of scope** (do NOT touch — parallel plans own these):
- `apps/api/src/routes/reports.ts` — the un-awaited reconcile is **by design**. Do not
  `await` it to make a test pass: that changes product behavior (ingest latency) to paper
  over a test bug, and it is exactly the wrong trade.
- `apps/api/src/services/flakiness.ts` — resolving a row with no backing results is
  **correct**. Do not weaken it.
- `apps/api/src/routes/tests.ts`, `projects.ts`, the dashboard, `docs/API.md` — plan 028
- `.agent/CONTEXT.md`, `AGENTS.md` — plan 030
- `action.yml` — read it, change nothing.
- **Any product code at all.**

## Done criteria

- [ ] The API suite passes **10 consecutive runs**. Paste all ten. One green run proves
      nothing about a race — that is the entire point.
- [ ] No fixed `sleep`/`setTimeout`-before-assertion introduced (a bounded *poll* with an
      interval is fine; be ready to justify any hit)
- [ ] `ci.yml` uses the head ref/SHA fallbacks, still passes them via `env:`, and parses as YAML
- [ ] `pnpm --filter api exec tsc --noEmit` → 0 errors; `rtk proxy pnpm lint` → exit 0
- [ ] **Only `tests.test.ts` and `ci.yml` modified** — prove with `git diff --name-only main`

## Test/verification setup

Disposable Postgres — **never `docker compose up`**, always clean up even on failure:

```bash
docker run -d --name flackyness-test-pg-029 -e POSTGRES_PASSWORD=test_password \
  -e POSTGRES_DB=flackyness_test -p 5458:5432 postgres:16-alpine
touch .env
DATABASE_URL=postgres://postgres:test_password@localhost:5458/flackyness_test pnpm db:migrate
# ... work ...
docker rm -f flackyness-test-pg-029   # ALWAYS
```

The API route suites **self-skip** without `DATABASE_URL` + `ADMIN_TOKEN`. A "green" run
that actually skipped everything is worthless — **prove your tests ran** by pasting the
assertion counts.

## STOP conditions

- **The fix seems to require changing `reports.ts` or `flakiness.ts`.** It does not. If you
  believe it does, STOP and report — you've found something more interesting than a test
  race, and it deserves its own plan rather than being smuggled into this one.
- **You cannot make the test deterministic without a fixed sleep.** STOP and report. Do not
  ship a slower race.
- The suite fails intermittently across the 10 runs. STOP and report the failure rate and
  the diff — a half-fixed flake is worse than a known one, because the next person assumes
  it's handled.

## Maintenance notes

- **The sharp edge worth internalising**: `POST /api/v1/reports` returns `201` *before*
  flakiness has been recomputed. Any consumer — test, dashboard, E2E suite, or third-party
  integrator — that reads `flaky_tests` immediately after an ingest is racing. Plan 026's
  E2E setup polls; plan 027 made `admin.test.ts` poll; this plan does `tests.test.ts`.
  **That the same bug keeps recurring is itself the finding** — an ingest-completion signal
  is a recorded product follow-up, and it is the real fix.
- After this lands, the API suite should have **no** ingest-then-assert-on-`flaky_tests`
  race left. If you find a third one during this work, report it.
