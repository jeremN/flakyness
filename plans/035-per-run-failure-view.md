# Plan 035 (DESIGN): "What failed on this run?" — a per-run failure view

> **This is a design plan.** It specifies a new feature end-to-end (API endpoint + dashboard
> view) and records the design decisions and their rationale. It is buildable as written, but
> it also has an **Open questions for the maintainer** section — confirm those before or during
> execution. Executor: follow the plan; if you disagree with a recorded decision, STOP and
> raise it rather than silently diverging. Do not update `plans/README.md` — the reviewer
> maintains it.
>
> **Drift check (run first)**: `git rev-parse --short HEAD` at or after `186c1a3`. Confirm
> `apps/api/src/routes/projects.ts` still has `GET /:id/runs` returning aggregate columns only
> (no `test_results` join), and that `apps/dashboard/src/routes/runs/+page.svelte` still
> renders run rows that are **not** links. If a per-run detail endpoint or route already
> exists, STOP — someone got here first.

## Status

- **Priority**: P2 (the highest-value remaining *feature*; direction finding F3)
- **Effort**: M (one read endpoint, one dashboard route, tests; **no schema change, no migration**)
- **Risk**: LOW-MED — new read surface + new page; touches no existing write path and no ingest.
  The main risk is payload size for pathological suites (mitigated below).
- **Depends on**: none structurally. Sits alongside the existing `/runs` list.
- **Category**: direction / feature
- **Planned at**: commit `186c1a3`, 2026-07-15

## The user need (and why it's a real gap)

A CI run fails. The engineer opens Flackyness and wants the first question answered directly:
**"which tests failed on *this* run, and what did they say?"** Today they cannot.

- `GET /api/v1/projects/:id/runs` and the `/runs` dashboard page show, per run, only
  **aggregate counts** — "3 failed, 1 flaky" — with no way to see *which* tests those were.
- Run rows in `/runs` (and the "Recent Test Runs" preview on the overview) are **not clickable**;
  there is no per-run route at all.
- The only place per-result `errorMessage` is visible is `/tests/[testName]`, which pivots on a
  **test name across all runs** — the inverse of what's needed. To use it you must *already know*
  which test failed, which is precisely the thing you're trying to find out.

So the failure detail exists in the database but is unreachable through the product. This plan
makes a run's failures a first-class, navigable view.

## What's already true (grounded facts — verified against the code)

**The data is already stored. No schema change, no migration.** `test_results`
(`apps/api/src/db/schema.ts`) has one row per test result with `testRunId` (FK →
`test_runs.id`, `onDelete: 'cascade'`, **indexed**: `test_results_test_run_id_idx`),
`testName`, `testFile`, `status`, `durationMs`, `retryCount`, `errorMessage` (text),
`tags` (jsonb `string[]`), `annotations` (jsonb `{type, description?}[]`), `createdAt`.
`test_runs` has `branch`, `commitSha`, `pipelineId`, `startedAt`, `finishedAt`,
`totalTests`/`passed`/`failed`/`skipped`/`flaky`, `createdAt`. Everything the view needs is a
single indexed `WHERE testRunId = ?` away.

**The data-fidelity ceiling (state this in the UI — it's a decided limitation, not a bug).**
The parser (`apps/api/src/parsers/playwright.ts`) persists only the fields above. It captures
`errorMessage` (the first non-empty attempt error `message`, **truncated to 10,000 chars**) but
**drops** stack traces, code snippets, stdout/stderr, and attachments (screenshots/traces/
videos). JUnit reports carry even less (`retryCount` always 0, no tags/annotations). So this
view can show **name, file, status, duration, retry count, the first error message, tags, and
annotations — and nothing richer.** A view with stack traces or screenshots would require
extending both the parser's `ParsedTestResult` and the `test_results` schema — **explicitly out
of scope here** and noted as a follow-up. Do not promise detail the data doesn't have.

**The existing endpoint this one mirrors** (`routes/projects.ts:199-231`):

```ts
projectsRouter.get('/:id/runs', async (c) => {
  const parsed = uuidSchema.safeParse(c.req.param('id'));
  if (!parsed.success) return c.json({ error: 'Invalid project ID format' }, 400);
  const projectId = parsed.data;
  const requestedLimit = parseInt(c.req.query('limit') || '20', 10);
  const limit = Math.min(Math.max(requestedLimit, 1), 100);
  const runs = await db.select({ /* aggregate cols only */ })
    .from(testRuns).where(eq(testRuns.projectId, projectId))
    .orderBy(desc(testRuns.createdAt)).limit(limit);
  return c.json({ runs });
});
```

Conventions to follow (all verified): read routes are **public/unauthenticated**;
`router.use('*', apiRateLimit)` (100/min per IP, a no-op under Vitest); path ids validated with
`z.string().uuid().safeParse(...)` → `{ error: '...' }, 400`; **named-key response envelope**
(`{ runs }`, `{ flakyTest }` — never `{ data }`); pagination is a **clamped `limit`**, and the
quarantine endpoint's `truncated: boolean` flag is the precedent for capping large result sets.

**The dashboard patterns this view follows** (all verified):
- API client `apps/dashboard/src/lib/api.ts` — a typed helper per endpoint over a private
  `fetchJson<T>` that maps `5xx→502`, other non-ok→passthrough, network→503. Base URL is
  `env.PUBLIC_API_URL || 'http://localhost:8080'` from `$env/dynamic/public`.
- Every page uses **`+page.server.ts` `load`**, gets `selectedProject` via `await parent()`,
  then calls `$lib/api` helpers. Component: `let { data }: Props = $props()`.
- **Prior art for failure rows** — `/tests/[testName]/+page.svelte` already renders an
  expandable error row that this view should mirror almost verbatim:
  ```svelte
  {#if run.errorMessage}
    <tr class="bg-red-50"><td colspan="6" class="py-3 px-4">
      <pre class="text-red-600 text-xs font-mono whitespace-pre-wrap">{run.errorMessage}</pre>
    </td></tr>
  {/if}
  ```
  and a `getStatusBadgeClass(status)` mapping (`passed→badge-green`, `failed→badge-red`,
  `flaky→badge-orange`, `skipped→badge-gray`) that is **duplicated** in both
  `tests/[testName]/+page.svelte` and `flaky/+page.svelte`.
- Only two shared components exist (`Chart.svelte`, `ErrorState.svelte`); tables, badges, and
  empty states are inline Tailwind-v4 patterns (`.card`, `.badge badge-*`, `<table class="w-full">`
  with `<thead>` `text-left text-xs text-muted uppercase ...`).
- Tests: vitest (node env, `*.test.ts` beside source) mock `$lib/api` for `load` tests and stub
  `fetch` for `api.ts` URL tests; E2E is Playwright over data seeded by `e2e/global-setup.ts`
  (ingests `real-report.json` 3×), read via `readSeed()`.

## Design decisions (decided — with rationale; override only via the Open Questions section)

### D1. New endpoint: `GET /api/v1/projects/:id/runs/:runId`
Nested under the project (not a flat `/runs/:runId`) for three reasons: it matches the existing
`/projects/:id/runs` list; it lets the handler **verify the run belongs to the project** and
`404` otherwise (no cross-project confusion); and the dashboard always has both ids in scope
(`?project=` + the run id). Returns:

```jsonc
{
  "run": {
    "id": "...", "branch": "main", "commitSha": "...", "pipelineId": "...",
    "startedAt": "...", "finishedAt": "...", "createdAt": "...",
    "totalTests": 120, "passed": 116, "failed": 3, "skipped": 0, "flaky": 1
  },
  "results": [
    { "testName": "...", "testFile": "...", "status": "failed",
      "durationMs": 5231, "retryCount": 0, "errorMessage": "...",
      "tags": ["@smoke"], "annotations": [{ "type": "issue", "description": "..." }] }
  ],
  "truncated": false
}
```

- **Validation**: both `:id` and `:runId` validated with the existing `uuidSchema.safeParse`;
  invalid → `{ error: 'Invalid project ID format' }` / `'Invalid run ID format'`, `400`.
- **Not found**: if no `test_runs` row matches `id = runId AND projectId = projectId`, return
  `{ error: 'Run not found' }, 404`. (One query; select the run scoped by both ids.)
- **Which results** (see D2 for the default): fetch `test_results WHERE testRunId = runId`,
  ordered `status`-priority then `testName` (failed/flaky first — see D3), capped (see D4).
- **Public**, `apiRateLimit`, named-key envelope, exactly like its siblings.

### D2. Default result scope: **non-passing only** (`failed` + `flaky`), widenable via `?status`
The view's whole purpose is "what failed." A green run has hundreds of passed rows that are pure
noise here, and the run's summary already reports the passed count. So:
- **Default** (`?status` absent): return only `failed` and `flaky` results.
- `?status=all` → every result. `?status=failed|flaky|passed|skipped` → just that status.
- Validate with `z.enum(['all','failed','flaky','passed','skipped']).default(...)`.

This keeps the common payload tiny and the DB scan cheap, while still allowing "show me
everything" for the curious. Rationale for making failures the default rather than all: it's the
answer to the actual question, and it bounds the response for large suites without needing
pagination in v1.

### D3. Result ordering: failures first, then by name
Order results so the interesting ones are on top: `failed`, then `flaky`, then `skipped`, then
`passed`; within a status, by `testName` ascending (stable, readable). Implement with a SQL
`CASE`/ordinal or order in JS after the fetch (the set is capped, so JS sort is fine and clearer).

### D4. Cap the result set with a `truncated` flag (mirror the quarantine endpoint)
Even `?status=all` on a 10k-test suite shouldn't return 10k rows. Cap at a constant
(recommend `RUN_RESULTS_CAP = 2000`, matching the spirit of `QUARANTINE_ROW_CAP = 1000`) and set
`truncated: true` when the cap is hit. The default (failures-only) scope will essentially never
hit this; the cap is a guard for `?status=all`. **Do not** build cursor pagination in v1 — the
clamped-cap + flag is the established pattern; a full paginated results browser is a follow-up if
anyone asks for it.

### D5. Dashboard route: `/runs/[runId]`, and make the list rows link to it
- New route `apps/dashboard/src/routes/runs/[runId]/+page.svelte` + `+page.server.ts`, mirroring
  the `/tests/[testName]` structure (dynamic segment, `?project=` for the sidebar/selector).
- **Wire navigation** (this is half the value): make each run row in `runs/+page.svelte` a link to
  `/runs/{run.id}?project={projectId}`, and make the "Recent Test Runs" rows on the overview
  (`routes/+page.svelte`) link the same way. Use the existing sidebar-preserving `?project=`
  convention. Rows should read as clickable (cursor, hover state already present).
- The page shows: a **run header** (branch, short commit, pipeline, started/finished + computed
  duration, and the summary badges passed/failed/flaky/skipped), then a **failures table**
  (testName, testFile, status badge, duration, retryCount) with the **expandable red `<pre>`
  error row** copied from the `/tests/[testName]` prior art, plus tags/annotations rows.
- **Empty state**: when the default (failures) set is empty, show a positive empty state — e.g.
  "No failures on this run 🎉 — all {passed} tests passed." (Reuse the inline `.card p-12 ...`
  empty-state pattern.) Offer a way to see all results (a link/toggle to `?status=all`) — see
  Open Question OQ2 on whether v1 includes the toggle.

### D6. Reuse vs. scope: extract only the badge-class helper
`getStatusBadgeClass` is already duplicated twice and this view needs a third use. Extract the
**pure mapping** into `$lib` (e.g. `src/lib/status.ts` → `statusBadgeClass(status)`) and use it
here; optionally update the two existing copies to import it (low-risk, same behavior). **Do
NOT** extract shared `<table>`/`<Badge>`/empty-state Svelte components in this plan — that's a
cross-cutting refactor touching unrelated pages and belongs in its own change. Match the existing
inline table markup so this page looks like its siblings.

## API spec (build this)

- File: `apps/api/src/routes/projects.ts` (add the handler next to `/:id/runs`).
- Route: `GET /:id/runs/:runId?status=<enum>`.
- Query the run scoped by `(id, runId)`; `404` if absent. Then query `test_results` for that
  `testRunId`, filtered by the `status` enum (default failed+flaky), capped at `RUN_RESULTS_CAP`,
  ordered per D3. Return `{ run, results, truncated }`.
- Select **only** the columns listed in D1 (do not leak internal ids beyond what the list already
  exposes; `test_results.id` is not needed by the view — omit it unless the UI needs a key, in
  which case include it deliberately).
- **Docs**: add the endpoint to `docs/API.md` (there's a section per endpoint; follow the
  `/:id/runs` entry's format — params table, example response, the `status` values, the
  `truncated` semantics, and a one-line note that error detail is the first message only, ≤10k
  chars, no stack/stdout/attachments).

## UI spec (build this)

- `apps/dashboard/src/lib/api.ts`: add `getRunDetail(projectId, runId, status?)` following the
  `getProjectRuns` shape (encode nothing — both are UUIDs; pass `?status=` when provided).
- `apps/dashboard/src/lib/app.d` (or wherever `TestRun` lives): add a `RunResult` type and a
  `RunDetail` (`{ run: TestRun; results: RunResult[]; truncated: boolean }`).
- `apps/dashboard/src/routes/runs/[runId]/+page.server.ts`: `load` gets `selectedProject` via
  `await parent()`, reads the `runId` param, calls `getRunDetail`. If `selectedProject` is null,
  return an empty/guard shape like the sibling pages. Use the established **resilient-load**
  pattern (a `try/catch` that degrades one widget, as `/tests/[testName]` does) so an API hiccup
  shows `ErrorState`, not a white screen.
- `apps/dashboard/src/routes/runs/[runId]/+page.svelte`: header + failures table + expandable
  error rows + empty state, per D5. Reuse `statusBadgeClass` from D6, `formatDuration`/`formatDate`
  helpers (copy the small local ones already used on sibling pages, or lift them to `$lib` if you
  prefer — but don't over-refactor).
- Link wiring in `runs/+page.svelte` and `routes/+page.svelte` per D5.

## Test plan

- **API route test** (`apps/api/src/routes/projects.test.ts`, following the existing suite —
  needs `DATABASE_URL` + `ADMIN_TOKEN`, else self-skips): create a project, ingest a report that
  yields a mix of passed/failed/flaky results (reuse the `tests[].results[]` fixture shape the
  032 tests used to cross thresholds), then:
  - `GET /:id/runs/:runId` (default) returns `run` with correct summary and `results` containing
    the failed/flaky tests **and not** the passed ones; `truncated: false`.
  - `?status=all` includes passed results; `?status=passed` returns only passed.
  - A `runId` from a **different project** → `404` (proves the ownership scoping).
  - A malformed `:runId` → `400`.
  - Ordering: failed/flaky appear before passed.
- **Dashboard `load` test** (`runs/[runId]/page.server.test.ts`): `vi.mock('$lib/api')`, assert the
  returned data shape and the degradation path (api throws → the resilient branch).
- **API-client test** (`lib/api.test.ts`): assert `getRunDetail` builds
  `/api/v1/projects/{id}/runs/{runId}` and appends `?status=` when passed.
- **E2E** (`apps/dashboard/e2e/run-detail.spec.ts`): using `readSeed()` (the 3 ingested runs),
  fetch the run list, navigate to `/runs/{runId}?project={projectId}`, and assert the failures
  table renders the seeded flaky/failed test names and that an error message is visible. Also
  assert a run row on `/runs` is now a link that lands on the detail page. (The seed ingests
  `real-report.json`, which has failing specs — confirm the seeded run actually has a non-passing
  result to assert on; if not, the E2E should assert the positive empty state instead, honestly.)

## Open questions for the maintainer (confirm at review/execution)

1. **OQ1 — default scope.** D2 makes the default **failures-only** (`failed`+`flaky`). Alternative:
   default to **all results** and let the user filter down. Recommendation: failures-only (it's the
   question being asked, and it bounds the payload). Confirm or override.
2. **OQ2 — include the `?status=all` toggle in the UI v1?** The endpoint supports it regardless
   (cheap). The question is only whether the *page* ships a toggle/link to "show all results" in
   this first cut, or stays failures-only in the UI with `all` reserved for API consumers.
   Recommendation: ship a minimal toggle (it's a few lines and answers the obvious "did anything
   else run?" follow-up). Low stakes either way.
3. **OQ3 — surface the (unstored) richer detail as an explicit "not captured" affordance?** e.g. a
   small note "stack traces & screenshots aren't stored — see the raw CI logs." Recommendation:
   yes, one muted line, so users don't think the tool is hiding data. Trivial.

None of these block building the endpoint; they only shape the UI's edges. If you want them
decided before any code, answer them on this plan and the executor proceeds; otherwise the
recommendations above are the default.

## Scope

**In scope**:
- `apps/api/src/routes/projects.ts` (+ its test), `docs/API.md`.
- `apps/dashboard/src/lib/api.ts`, `src/lib/app.d` (types), `src/lib/status.ts` (extracted badge
  helper), `src/routes/runs/[runId]/**`, and the link wiring in `src/routes/runs/+page.svelte`
  and `src/routes/+page.svelte`. Dashboard `load`/api/e2e tests.

**Out of scope** (do NOT do here):
- **Any schema change or migration** — the data is already stored. If you find yourself writing a
  migration, STOP: you've misread the design.
- Storing/serving stack traces, stdout/stderr, or attachments (needs parser + schema work — a
  separate follow-up).
- Cursor/offset pagination for results (the cap + `truncated` flag is v1).
- Extracting shared table/badge/empty-state **components** (badge-class *function* extraction is
  in scope; components are not).
- Auth on the new read endpoint (the read API is public by design; don't change that here).
- Touching ingest, flakiness reconciliation, or any write path.

## Done criteria

- [ ] `GET /api/v1/projects/:id/runs/:runId` returns `{ run, results, truncated }`; default scope is failed+flaky; `?status` widens/narrows; cross-project `runId` → 404; malformed id → 400 — all proven by route tests (counts pasted, not skipped)
- [ ] **No migration and no `schema.ts` change** (`git diff` proves it)
- [ ] `/runs` run rows and the overview "Recent Test Runs" rows link to `/runs/[runId]?project=...`
- [ ] The detail page shows the run header + a failures table with expandable error messages, matching the `/tests/[testName]` visual patterns; a positive empty state when there are no failures
- [ ] `getRunDetail` client helper + `load` test + `api.ts` URL test + an E2E spec, all green
- [ ] `docs/API.md` documents the endpoint incl. the `status` values, `truncated`, and the "first error message only, no stack/stdout/attachments" limitation
- [ ] `pnpm --filter api exec tsc --noEmit`, `pnpm --filter dashboard check`, `rtk proxy pnpm lint` all clean; API + dashboard suites green
- [ ] The data-fidelity limitation is surfaced honestly in the UI (per OQ3, if accepted)

## STOP conditions

- **You need a migration or a `schema.ts` edit** → you've misread the design; the data exists. STOP.
- **The default (failures-only) query would require touching the ingest/parser** → it does not
  (everything is a `SELECT`). If you believe it does, STOP and report.
- **The seeded E2E run has no non-passing result to assert on** → don't fake one; assert the
  positive empty state and note it, or extend the seed deliberately (coordinate — `global-setup.ts`
  is shared E2E infra).
- **The result payload is unbounded** for `?status=all` on a big suite → that's what `RUN_RESULTS_CAP`
  + `truncated` is for; don't ship without the cap.

## Maintenance notes

- This closes direction finding **F3**. After it lands, the obvious next asks are: (a) richer
  failure detail (stack traces / screenshots) — which is the parser+schema follow-up this plan
  deliberately defers; and (b) results pagination if a consumer hits `truncated`. Record those as
  follow-ups, don't scope-creep them in.
- The badge-class extraction (D6) is a first step toward a shared status-badge component; if a
  third page-level pattern duplicates again, that's the signal to extract the component properly.
- Watch the interaction with retention/prune (plan 021): deleting a run cascades its
  `test_results` (FK `onDelete: 'cascade'`), so a bookmarked `/runs/[runId]` for a pruned run must
  degrade to the 404 path — the route test's 404 case already covers the endpoint side; make sure
  the page renders the not-found gracefully rather than crashing.
