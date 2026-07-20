# Plan 032: Give ingest a completion signal, so nobody has to race the reconcile

> **Executor instructions**: Follow the plan, run every verification, honor the STOP
> conditions. Do not update `plans/README.md` — the reviewer maintains it.
>
> **Drift check (run first)**: `git rev-parse --short HEAD` at or after `376ff26`. Confirm
> `apps/api/src/routes/reports.ts` still fires `updateFlakyTests(project.id, ...)` in an
> un-awaited `.then().catch()` chain and then `return c.json({ ... }, 201)`. On a structural
> mismatch, STOP and report.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED — changes the behavior (optionally, the latency) of the single most
  important endpoint in the product. The opt-in design keeps the default path untouched.
- **Depends on**: none. **Parallel-safe** with plan 031 (031 is dashboard-side; this is
  API + the GitHub Action, disjoint files).
- **Category**: correctness / DX
- **Planned at**: commit `376ff26`, 2026-07-15

## Why this matters — the same root cause, three symptoms

`apps/api/src/routes/reports.ts` fires flakiness reconciliation **un-awaited** and returns
`201` immediately:

```ts
    // Trigger flakiness detection in background (don't await). ...
    updateFlakyTests(project.id, resolveProjectConfig(project))
      .then(async ({ newlyFlaky, newlyResolved }) => { /* webhook */ })
      .catch((err) => { /* log */ });

    return c.json({ success: true, testRun: { ... } }, 201);
```

This is a deliberate, correct default — a high-throughput CI uploader should not block on
recomputation. But it means **`POST /reports` returns before `flaky_tests` reflects the
report just ingested**, and *every* consumer that reads flakiness state immediately
afterward is racing an invisible background job. This one root cause has now produced three
distinct symptoms:

1. **The GitHub Action misclassifies the very test that just went flaky.** `comment.sh`
   uploads the report, then *immediately* fetches `GET /projects/:id/quarantine` and
   partitions this run's failures against it. On the run where a test crosses the flake
   threshold, the quarantine list fetched milliseconds later still reflects **pre-ingest**
   state — so the test that was *just* auto-detected lands in "needs a look" instead of
   "auto-detected flaky." That is the single case a reviewer most wants correct, and it's
   the one the race corrupts.
2. **Two flaky tests in our own suite** (plans 027, 029) — both were tests reading
   `flaky_tests` right after an ingest, both fixed by polling.
3. **Plan 026's E2E setup has to poll** for an active flaky test to appear before it can
   assert anything.

Polling is a workaround each consumer reimplements. The fix is to let the caller *ask* for a
synchronous answer.

## Design decision (advisor — decided; do not relitigate)

**Add an opt-in `?wait=true` query param to `POST /api/v1/reports`.**

- **Default (`wait` absent or not `true`)**: behavior is **exactly as today** — fire the
  reconcile un-awaited, return `201` immediately. High-throughput callers are unaffected.
  This must be byte-for-byte the current response; do not change the default path's shape.
- **`?wait=true`**: **await** `updateFlakyTests` before responding, and include its result in
  the response body so the caller learns what changed without a second request:

  ```jsonc
  {
    "success": true,
    "testRun": { ... },              // unchanged
    "reconcile": {                   // present ONLY when ?wait=true
      "newlyFlaky": ["test name", ...],
      "newlyResolved": ["test name", ...]
    }
  }
  ```

  On `?wait=true`, the response is only sent **after** `flaky_tests` is consistent, so a
  caller that then reads `/quarantine` or `/flaky` sees post-ingest state. Still `201`.

**Do not compute the reconcile twice.** Create the `updateFlakyTests(...)` promise once. If
`wait=true`, `await` it (and thread the result into both the response and the webhook
branch); otherwise leave it un-awaited exactly as now. A naive implementation that calls
`updateFlakyTests` a second time for the waited path would double every ingest's DB work —
STOP and rethink if you find yourself writing that.

**Webhook delivery stays fire-and-forget even under `wait=true`.** The point of `wait` is
"`flaky_tests` is consistent," not "the webhook was delivered." Awaiting a best-effort
network POST (which can hang on a slow/unreachable receiver) would turn `?wait=true` into an
unbounded-latency request. So: await the *reconcile*, never the *webhook*.

**Bound the wait.** `updateFlakyTests` is DB-bound and normally fast, but `?wait=true` must
not hang a request forever if the DB is pathologically slow. If there is an existing request
timeout / the reconcile is naturally bounded, note that and rely on it; if not, wrap the
awaited reconcile so a failure or excessive delay still returns a coherent response (the
ingest itself already succeeded and was committed — a reconcile that errors under `wait=true`
should still return `201` for the ingest, with `reconcile` reporting the failure rather than
500ing the whole upload). Decide, implement, and document the exact semantics.

## Make the GitHub Action use it (closes symptom 1)

`.github/action-scripts/comment.sh` uploads the report, then fetches the quarantine list.
Change the upload to `POST .../reports?...&wait=true` so that by the time it fetches
`/quarantine`, the just-ingested run's flaky transitions are already reflected. This is the
concrete fix for the misclassification in symptom 1 — verify it end-to-end (see done
criteria), don't just set the flag and assume.

Keep `comment.sh`'s existing "degrade quietly, never fail the build" contract intact — a
`wait=true` upload that errors must still not fail the consumer's pipeline.

## Scope

**In scope**:
- `apps/api/src/routes/reports.ts` — the `?wait=true` branch
- `apps/api/src/routes/reports.test.ts` — tests for both paths
- `docs/API.md` — document `?wait=true`, the `reconcile` field, and the latency trade-off
- `.github/action-scripts/comment.sh` — add `&wait=true` to the upload
- `action.yml` / `docs/GITHUB_ACTION.md` — only if a doc mention is warranted; keep minimal

**Out of scope** (do NOT touch):
- The un-awaited default path's response shape — it must not change at all.
- `apps/api/src/services/flakiness.ts` — `updateFlakyTests` already returns
  `{ newlyFlaky, newlyResolved, ... }`; consume it, change it only if you can justify why.
- `apps/dashboard/**` — plan 031 is working there in parallel. **Do not touch it**, even to
  "use the new signal" — that's a separate follow-up.
- `docs/GETTING_STARTED.md` — plan 031 owns it this wave.
- `.agent/CONTEXT.md`, `AGENTS.md`.
- Do **not** convert the whole ingest path to synchronous, and do **not** add a job
  queue/worker — this is a query-param opt-in, nothing more.

## Steps

### Step 1: The `?wait=true` branch

Parse `c.req.query('wait') === 'true'` (strict, same idiom as the codebase's other boolean
query params). Create the reconcile promise once. If waiting, `await` it and attach the
result as `reconcile` on the response; otherwise keep the current fire-and-forget chain
verbatim. Ensure the webhook branch still runs off the same result (fire-and-forget) in both
modes.

**Verify**: `pnpm --filter api exec tsc --noEmit` → 0 errors.

### Step 2: Tests (prove both modes)

In `reports.test.ts`:
- **Default path unchanged**: `POST /reports` (no `wait`) returns `201` with **no**
  `reconcile` field and the current body shape. (Because the reconcile is async, the default
  test should NOT assert on post-ingest `flaky_tests` state — that's the race.)
- **`?wait=true` is synchronous**: ingest a report that crosses the flake threshold **in one
  call** (needs ≥ `minRuns` = 3 executions of a failing/flaky test — the parser collapses
  `spec.results[]` to one row per spec, so use the `tests[].results[]` shape or ingest a
  fixture that genuinely reaches 3; verify your fixture actually produces a flaky row).
  Assert the response contains `reconcile.newlyFlaky` naming that test, **and** that an
  immediately-following `GET /projects/:id/quarantine` (or `/flaky`) already reflects it —
  with **no poll**. That "no poll needed" assertion is the whole point; make it explicit.
- **The reconcile-error path** (if you implemented bounded handling): a `wait=true` ingest
  whose reconcile fails still returns `201` for the ingest.

**Prove the wait test bites**: temporarily make the `wait=true` branch NOT await (i.e.
behave like the default). The "no poll" assertion should then fail intermittently or
reliably. If it can't be made to fail, your test isn't actually proving synchronicity —
rethink it. Report what you observed honestly (this is genuinely hard to make deterministic;
an honest "here's the best signal I could get" beats a fake proof).

### Step 3: Wire the Action + verify end-to-end

Add `&wait=true` to `comment.sh`'s upload. Then reproduce symptom 1 end-to-end against a
disposable API: ingest a report 3× so a test is on the cusp, then run the comment.sh flow on
the ingest that crosses the threshold, and confirm the just-flaky test is rendered under
**"auto-detected flaky"**, not "needs a look". Paste the rendered comment body.

## Done criteria

- [ ] Default `POST /reports` (no `wait`) is byte-for-byte unchanged: `201`, no `reconcile` field
- [ ] `?wait=true` returns only after `flaky_tests` is consistent; an immediate `/quarantine` read reflects the ingest with **no poll**, proven by a test
- [ ] `updateFlakyTests` is invoked **once** per ingest in both modes (not twice) — confirm by reading your diff
- [ ] Webhook delivery remains fire-and-forget in both modes (a hung receiver cannot stall a `wait=true` response)
- [ ] `comment.sh` uploads with `&wait=true`; the just-flaky test renders as "auto-detected flaky" (comment body pasted); the "never fail the build" contract still holds
- [ ] `docs/API.md` documents `?wait=true`, the `reconcile` field, and the latency trade-off
- [ ] `pnpm --filter api exec tsc --noEmit`, `rtk proxy pnpm lint` clean; API suite green (paste counts, prove not skipped)
- [ ] `git diff --name-only main` shows nothing under `apps/dashboard/`, `docs/GETTING_STARTED.md`, or the doc-context files

## Test/verification setup

Disposable Postgres — **never `docker compose up`**, clean up even on failure:
```bash
docker run -d --name flackyness-test-pg-032 -e POSTGRES_PASSWORD=test_password \
  -e POSTGRES_DB=flackyness_test -p 5461:5432 postgres:16-alpine
touch .env
DATABASE_URL=postgres://postgres:test_password@localhost:5461/flackyness_test pnpm db:migrate
docker rm -f flackyness-test-pg-032   # ALWAYS
```
API reads `API_PORT` (default 8080). Route suites self-skip without `DATABASE_URL` +
`ADMIN_TOKEN` — prove yours ran by pasting assertion counts. Admin routes are 5/min — pace
project creation. Never echo a token into output.

## STOP conditions

- **You find yourself calling `updateFlakyTests` twice** (once for the response, once for the
  webhook). STOP and restructure — one promise, awaited or not.
- **Making `?wait=true` synchronous requires changing `flakiness.ts`.** It shouldn't —
  `updateFlakyTests` already returns the transition result. If it genuinely does, STOP and
  report.
- **You cannot write a test that distinguishes waited from un-waited** without flakiness.
  Report the best signal you got rather than shipping a test that passes regardless — a test
  that can't tell the two modes apart is testing nothing.

## Maintenance notes

- `?wait=true` is the sanctioned answer to "how do I know reconciliation finished?" When a
  future consumer (dashboard, a new integration) needs post-ingest consistency, it uses this
  instead of reinventing a poll. Plan 026's E2E setup and plans 027/029's test polls could
  eventually migrate to it, but that's cleanup, not this plan.
- The default stays async on purpose. If a future high-throughput scenario makes even the
  opt-in await too slow, the next step is a real job queue — explicitly out of scope here.
- Note the interaction with plan 021 (retention) and the trend endpoints: none — `wait`
  only affects when the *response* is sent, not what gets stored.
