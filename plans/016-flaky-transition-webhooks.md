# Plan 016: Webhook notifications on flaky-test transitions

> **Executor instructions**: Follow step by step; run every verification
> command. On any STOP condition, stop and report. Update your row in
> `plans/README.md` when done — unless a reviewer dispatched you and said
> they maintain the index.
>
> **Drift check (run first)**: `git diff --stat 7609d55..HEAD -- apps/api/src/db/schema.ts apps/api/src/services/flakiness.ts apps/api/src/routes/reports.ts apps/api/src/routes/admin.ts apps/api/drizzle/`
> Plans 013/015 likely landed migrations before this one — expected; yours is
> the next number. If `updateFlakyTests` no longer matches the excerpt below
> (compute-then-write with `flakyRows`/`resolveIds`/`existingFlaky`), STOP.

## Status

- **Priority**: P2
- **Effort**: M–L
- **Risk**: MED (touches the ingest hot path; outbound HTTP from the API; SSRF surface)
- **Depends on**: 013 (soft — reuses its admin `PATCH /projects/:id` route pattern; if 013 hasn't landed, create the PATCH route per plan 013's Step 4 shape for the webhook field only). **Serial constraint**: last of the 013/015/016 migration series.
- **Category**: feature (direction D2)
- **Planned at**: commit `7609d55`, 2026-07-10

## Why this matters

`docs/GETTING_STARTED.md:244` promises: "**Set up alerts** (coming soon) for
new flaky tests". Today the only way to notice a newly-flaky test is to look
at the dashboard. A per-project webhook (Slack/Discord/Mattermost-compatible
generic JSON POST) closes the loop: CI ingests a report → a test crosses the
threshold → the team's channel hears about it within seconds.

## Current state

- `apps/api/src/services/flakiness.ts` — `updateFlakyTests(projectId, config = {})`
  (lines 180–250): computes `analysis`, loads `existingFlaky` (all
  `flaky_tests` rows for the project), builds `flakyRows` (every
  currently-flaky test, upserted with a `CASE … 'ignored'` status guard) and
  `resolveIds` (active rows no longer flaky), applies both in ONE
  `db.transaction` with BATCH_SIZE-1000 chunking, returns
  `{ updated: flakyRows.length, resolved: resolveIds.length }`.
  **Key gap**: the return can't distinguish NEWLY-flaky from still-flaky —
  but everything needed is already in memory: `existingFlaky` has the prior
  status of every row.
- `apps/api/src/routes/reports.ts` lines 108–117 — fire-and-forget after
  ingest: `updateFlakyTests(project.id).catch(logger.error-ish)` (201
  response does not wait). `project` = full row from `projectAuth()`.
- `apps/api/src/db/schema.ts` — `projects` has no webhook column (see plan
  013 for the current column list).
- `apps/api/src/routes/admin.ts` — admin router; if plan 013 landed there is
  a `PATCH /projects/:id`; otherwise routes are GET/POST/POST/DELETE/health.
- No outbound-HTTP code exists anywhere in the API today; Node 24 global
  `fetch` is available (no new dependency needed).

## Design decisions (advisor — do not relitigate)

1. Schema: single nullable `webhook_url` `varchar(2048)` on `projects`.
   No secret/signing in v1 (the payload contains nothing sensitive beyond
   test names); document that.
2. Transition detection stays INSIDE `updateFlakyTests` (the data is
   already loaded — zero extra queries), exposed via the return value:
   `{ updated, resolved, newlyFlaky: string[], newlyResolved: string[] }`
   (test names). Definitions:
   - `newlyFlaky` = flakyRows whose testName is NOT in `existingFlaky`, OR
     is there with prior status `'resolved'` (re-activation). Prior
     `'ignored'` is NOT a transition (the upsert keeps it ignored — muted
     stays silent). Prior `'active'` is not a transition either.
   - `newlyResolved` = testNames of the `resolveIds` rows.
3. Sending lives in a new `apps/api/src/services/notifications.ts`:
   `sendFlakyTransitionWebhook(url, payload)` — `fetch` POST, JSON body,
   `AbortSignal.timeout(5000)`, treat non-2xx as failure; failures are
   LOGGED and swallowed (never affect ingest). No retries in v1.
4. Call-site = `reports.ts`'s existing fire-and-forget chain: after
   `updateFlakyTests` resolves, if `project.webhookUrl` and
   (`newlyFlaky.length || newlyResolved.length`), send ONE webhook per
   ingest (both lists in one payload). Payload:

   ```json
   {
     "event": "flaky_tests_changed",
     "project": { "id": "…", "name": "…" },
     "newlyFlaky": ["test a", "test b"],
     "newlyResolved": ["test c"],
     "run": { "branch": "…", "commitSha": "…" },
     "dashboardUrl": null
   }
   ```

   (`dashboardUrl` null in v1 — the API doesn't know the dashboard origin.)
5. SSRF stance: the URL is set ONLY by the admin (admin-token-guarded
   route), same trust level as the operator's shell. v1 validation:
   `z.string().url().max(2048)` + protocol must be `http:`/`https:`. No IP
   deny-list in v1 — record this in the docs as a deliberate single-operator
   tradeoff (consistent with `.agent/CONTEXT.md`'s documented-tradeoffs style).

## Commands you will need

Same toolbox: `pnpm --filter api exec tsc --noEmit`; `pnpm --filter api test`
(DB-gated needs `DATABASE_URL`+`ADMIN_TOKEN`); `pnpm lint` (garbled →
`rtk proxy pnpm lint`). Disposable DB:
`docker run -d --name flackyness-test-pg-016 -e POSTGRES_PASSWORD=test_password -e POSTGRES_DB=flackyness_test -p 5437:5432 postgres:16-alpine`,
`touch .env` at root, `DATABASE_URL=postgres://postgres:test_password@localhost:5437/flackyness_test pnpm db:migrate`.
For webhook e2e, a capture endpoint: run a tiny Node http server on :9999
from the scratchpad (10 lines: log body, reply 200) — NOT a third-party
service; never send data off-machine. ALWAYS clean up (container, temp
`.env`, capture server).

## Scope

**In scope**: `apps/api/src/db/schema.ts` + generated migration,
`apps/api/src/services/flakiness.ts` (+test), NEW
`apps/api/src/services/notifications.ts` (+test), `apps/api/src/routes/reports.ts`
(call-site chain), `apps/api/src/routes/admin.ts` (+test — webhook field on
PATCH/GET), `docs/API.md`, `docs/GETTING_STARTED.md` (replace the line-244
"coming soon" promise with the real feature).

**Out of scope**: dashboard (any file); retries/queues/digests; email or
other channels; Slack-specific message formatting (a generic JSON consumer
can adapt); signing.

## Git workflow

Branch `advisor/016-flaky-transition-webhooks`; single-line conventional
commits (e.g. `feat(api): webhook on flaky transitions`); NO
`Co-Authored-By` trailers; no push/PR unless the operator instructed it.

## Steps

### Step 1: Schema + admin plumbing

Add `webhookUrl: varchar('webhook_url', { length: 2048 })` to `projects`.
`pnpm --filter api db:generate` → one migration, one ADD COLUMN (verify by
reading it). Extend the admin `PATCH /projects/:id` body schema with
`webhookUrl: z.string().url().max(2048).refine(u => /^https?:$/.test(new URL(u).protocol)).nullable().optional()`
(create the PATCH route in plan-013 style if it doesn't exist yet), and
expose the field in `GET /projects`. Admin tests: set, clear (null), reject
`ftp://…` and non-URLs, no-auth 401.

**Verify**: tsc → 0; DB-gated admin tests pass; migration applies to fresh DB.

### Step 2: Transition detection in `updateFlakyTests`

Before the transaction (all data already in memory):

```ts
const priorStatusByName = new Map(existingFlaky.map(e => [e.testName, e.status]));
const newlyFlaky = flakyRows
  .filter(row => {
    const prior = priorStatusByName.get(row.testName);
    return prior === undefined || prior === 'resolved';
  })
  .map(row => row.testName);
const resolveIdSet = new Set(resolveIds);
const newlyResolved = existingFlaky
  .filter(e => resolveIdSet.has(e.id))
  .map(e => e.testName);
```

Return `{ updated, resolved, newlyFlaky, newlyResolved }` (update the
signature's return type). IMPORTANT: transitions are computed from the same
snapshot the transaction writes — document with a short comment that
concurrent ingests for the same project may double-report (accepted; the
reconcile itself is already last-writer-wins across ingests).

Tests in `flakiness.test.ts` (DB-gated, reuse its seeders): fresh flaky →
in `newlyFlaky`; still-flaky second run → NOT in it; resolved→flaky again →
in it; ignored stays out of BOTH lists even while meeting the threshold;
active→resolved → in `newlyResolved`. Existing assertions on
`{updated, resolved}` must keep passing untouched.

**Verify**: DB-env `pnpm --filter api test` → all pass.

### Step 3: Notification service

New `services/notifications.ts` — small and dependency-free:

```ts
export interface FlakyTransitionPayload { /* shape from design decision 4 */ }

export async function sendFlakyTransitionWebhook(
  url: string,
  payload: FlakyTransitionPayload
): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
```

Returns success boolean; the CALLER logs. Unit tests without a DB: stub
global `fetch` (`vi.stubGlobal`) — success → true; non-2xx → false; network
throw → false; timeout → false (mock a never-resolving fetch and
`vi.useFakeTimers`, or assert the signal is passed — pick the simpler,
follow existing test style).

### Step 4: Call-site in reports.ts

Extend the existing fire-and-forget chain (keep it fire-and-forget — the
201 must not wait):

```ts
updateFlakyTests(project.id /*, resolveProjectConfig(project) if 013 landed */)
  .then(async ({ newlyFlaky, newlyResolved }) => {
    if (!project.webhookUrl || (newlyFlaky.length === 0 && newlyResolved.length === 0)) return;
    const ok = await sendFlakyTransitionWebhook(project.webhookUrl, { …payload… });
    if (!ok) console.error(`[webhook] delivery failed for project ${project.id}`);
  })
  .catch(existing-error-handler);
```

Match the file's actual logging idiom (read lines 108–117 first — if it
uses a logger util, use that, not console). `run.branch`/`run.commitSha`
come from the just-inserted testRun values already in scope.

**Verify**: tsc → 0; full API suite green in both modes.

### Step 5: E2E + docs

Disposable stack: capture server on :9999 (scratchpad script), project with
`webhookUrl=http://localhost:9999/hook` set via admin PATCH; POST a report
whose tests are flaky (upload the real fixture 2–3× with different
`commit`s if needed to cross minRuns) → capture server logs ONE payload
with the expected testNames; a SECOND identical upload produces NO webhook
(no transition). Kill the capture server mid-test and upload again → ingest
still 201s, API log shows the delivery-failed line, process alive.

Docs: `docs/API.md` — `webhookUrl` field + payload schema + "no signing,
no retries, admin-set URLs only (v1)" note; `docs/GETTING_STARTED.md:244` —
replace "(coming soon)" with a short how-to (PATCH example).

## Done criteria

- [ ] Migration: one nullable `webhook_url` column; applies to fresh DB (and on top of 013/015's if present)
- [ ] `updateFlakyTests` returns `newlyFlaky`/`newlyResolved`; all five transition tests green; `ignored` never notifies
- [ ] Webhook: 5s timeout, one POST per ingest, failures logged + swallowed, ingest 201 never blocked (e2e-proven with dead endpoint)
- [ ] Admin PATCH/GET handle `webhookUrl` with protocol validation
- [ ] GETTING_STARTED line-244 promise replaced with real instructions
- [ ] Gates green: api tsc + tests (both modes), `pnpm lint`; `git status` clean outside scope

## STOP conditions

- `updateFlakyTests` no longer has `existingFlaky`/`flakyRows`/`resolveIds`
  in the described shape → STOP (the detection design assumes it).
- The reports fire-and-forget chain has been restructured (e.g. into a job
  queue) → STOP.
- Anything requires sending a request to a non-localhost URL during testing
  → don't; STOP and report.

## Maintenance notes

- Retries/digests/Slack-formatting are the obvious v2; keep
  `notifications.ts` the single seam for them.
- If ingest ever becomes concurrent per project (queue/worker), transition
  detection must move to DB-level (e.g. upsert `RETURNING` with
  `xmax`-style tricks or a status-history table) — the in-memory diff
  assumes one reconcile at a time per project.
- The webhook fires from the INGEST path only; a threshold change via plan
  013's PATCH doesn't notify until the next report arrives — document is
  in API.md wording ("on the next ingest").
