# Plan 037 (DESIGN): Capture & surface richer per-run failure detail (stack, snippet, stdout/stderr, attachments)

> **This is a DESIGN plan.** It records the decisions, the data shapes, the migration, and the
> end-to-end change so a later `execute` pass (or two) can build it with zero context from this
> session. It is written to be buildable directly; the **Execution note** below explains how the
> reviewer may split it into two executor passes if the single diff would be too large to review.
>
> **Executor instructions** (when this is dispatched to build): follow the plan, run every
> verification, honor the STOP conditions. Do **not** update `plans/README.md` — the reviewer
> maintains it.
>
> **Drift check (run first)**: `git rev-parse --short HEAD` at or after `cb12646`. Confirm the two
> facts this plan is built on still hold, and STOP if either has changed:
> 1. `apps/api/src/parsers/playwright.ts` — `ParsedTestResult` (near line 162) has exactly
>    `{ testName, testFile, status, durationMs, retryCount, errorMessage, tags, annotations }`
>    and **no** `failureDetail`. The Zod `TestErrorSchema`/`TestResultSchema` already parse
>    `stack`, `snippet`, `value`, `errors[]`, `stdout`, `stderr`, `attachments` (they are read
>    then dropped — see "Current state").
> 2. `apps/api/src/db/schema.ts` — `testResults` has `errorMessage: text('error_message')` and
>    `tags`/`annotations` jsonb columns, but **no** `failure_detail` column. Latest migration on
>    disk is `apps/api/drizzle/0006_*.sql`.

## Status

- **Priority**: P2 (highest-value remaining *feature*; direct follow-on to 035's per-run view)
- **Effort**: M–L (parser + schema/migration + ingest + endpoint + docs + dashboard + tests)
- **Risk**: LOW–MEDIUM. The parser already validates every field we want — this is mostly
  "stop discarding," not "start parsing." The one real risk is payload/DB **size** (stdout/stderr
  and stacks are large); mitigated by hard caps. Migration is an additive nullable column (no
  table rewrite, no backfill).
- **Depends on**: 035 (DONE, PR #78) — the endpoint and dashboard route this extends. Independent
  of 036.
- **Category**: direction / feature (closes the deferred "richer failure detail" follow-on the
  035 UI and `docs/API.md` both explicitly flag as not-captured).
- **Planned at**: commit `cb12646`, 2026-07-15.

## Why this, why now

035 shipped a per-run "what failed on this run?" view, but it can only show a **single error
message string** per test. The dashboard says so out loud
(`apps/dashboard/src/routes/runs/[runId]/+page.svelte:173-176`):

> "Flackyness stores the first error message only — stack traces, stdout/stderr, and screenshots
> or other attachments aren't captured. Consult the CI job's own logs for those."

and `docs/API.md:284-287` repeats it. That honesty note is the feature request. When a test fails
in CI, the stack trace + the code snippet Playwright captures are the difference between "I can
see why it broke from the dashboard" and "I have to go dig through the CI job's raw logs." This is
the single most useful thing the per-run view is missing.

## Current state (what's parsed vs. what's kept)

The Playwright parser **already parses** all the detail — it just narrows it away. In
`apps/api/src/parsers/playwright.ts`:

```ts
// TestErrorSchema (lines 51-56) already validates:
const TestErrorSchema = z.object({
  message: z.string().max(10_000).optional(),
  stack:   z.string().max(10_000).optional(),
  value:   z.string().max(10_000).optional(),
  snippet: z.string().max(10_000).optional(),
});

// TestResultSchema (lines 58-70) already accepts:
//   error, errors[], stdout[], stderr[], attachments[], steps[]

// ...but ParsedTestResult (lines 162-171) keeps only:
export interface ParsedTestResult {
  testName: string;
  testFile: string;
  status: 'passed' | 'failed' | 'skipped' | 'flaky';
  durationMs: number;
  retryCount: number;
  errorMessage: string | null;   // <-- only the FIRST error's .message, via extractErrorMessage()
  tags: string[];
  annotations: { type: string; description?: string }[];
}
```

And the storage layer only has a place for that one string. In `apps/api/src/db/schema.ts`
(`testResults`, lines 52-72): `errorMessage: text('error_message')`, plus `tags`/`annotations`
jsonb. **No column** for stack/snippet/stdout/stderr/attachments.

So the detail is dropped at **two** layers: `ParsedTestResult` (narrowing) and the schema (no
column). Both must change.

`errorMessage` is **kept as-is** — it is read by the trend endpoint
(`apps/api/src/routes/tests.ts:162`) and used as the dashboard's display fallback, and the JUnit
parser produces it too. The new detail is strictly **additive**; nothing that reads `errorMessage`
changes.

## Design decisions

**D1 — Storage: one nullable `failure_detail jsonb` column on `test_results`.** NULL when there's
nothing to store (passing/skipped rows, and failures with no captured detail). This mirrors the
existing `tags`/`annotations` jsonb columns exactly (NULL-when-absent), avoids a wide sparse table
of mostly-NULL discrete columns, and the data is **display-only** (never filtered or joined on),
so discrete columns would buy nothing. One additive migration.

**D2 — Blob shape** (`FailureDetail`), every field optional, only present sub-fields included:

```ts
export interface FailureDetail {
  // All errors from all attempts, deduped by message+stack, capped to MAX_ERRORS.
  // Each string field capped to 10_000 chars (same bound the parser already enforces).
  errors: Array<{ message?: string; stack?: string; snippet?: string; value?: string }>;
  stdout?: string;   // flattened from stdout[] chunks, capped to 10_000
  stderr?: string;   // flattened from stderr[] chunks, capped to 10_000
  attachments?: Array<{ name: string; contentType: string; path?: string }>;  // METADATA only
}
```

The whole column is `null` when `errors` is empty **and** there's no stdout/stderr/attachments.

**D3 — Attachments: metadata only (name, contentType, path) — NOT the bytes.** *(Confirm — see
Open Question OQ1.)* Flackyness ingests the JSON report only; Playwright's `attachments[]`
reference screenshots/videos/traces by `path` on the CI runner, and the actual bytes are present
in the JSON only if the report was configured to inline base64 `body` (non-default, and can be
megabytes each). v1 stores `{ name, contentType, path }` and never the `body`. The dashboard lists
the attachment and is honest that the file itself lives in the CI artifacts. Rationale: keeps the
DB lean, avoids storing potentially-PII screenshot bytes, and sidesteps an unbounded-size column.

**D4 — stdout/stderr: captured, flattened + capped to 10k each.** *(Confirm — see OQ2.)* These are
the most useful debugging context after the stack. Playwright emits them as arrays of
`{ text?: string } | { buffer?: string } | string`; flatten to a single string (`text` chunks
joined; ignore `buffer`/binary), cap at 10k. If the user prefers to omit them (noise/PII/size),
drop `stdout`/`stderr` from D2 and the parser helper — nothing else changes.

**D5 — Detail is populated only when non-empty.** In practice that's failed/flaky rows. Passing and
skipped rows get `failure_detail = NULL`, so the column costs nothing for the overwhelming
majority of rows.

**D6 — API: the run-detail endpoint adds `failureDetail` to its select + response, additively.**
No new query param, default scope unchanged (`?status` absent → failed+flaky). `failureDetail` is
`null` for rows without detail (e.g. passing rows under `?status=all`). Backward-compatible: an
existing consumer that ignores the field is unaffected.

**D7 — Dashboard: expand the single red `<pre>` into a detail panel** for rows that have
`failureDetail`: per-error message + code snippet + a collapsed-by-default stack (`<details>`),
collapsible stdout/stderr blocks, and an attachment list (name · contentType · path) with a note
that the bytes live in CI artifacts. Rows with only the legacy `errorMessage` (pre-migration runs,
or JUnit) keep rendering exactly as today. Update the bottom honesty note (see Step 6).

**D8 — JUnit: light support only.** The JUnit parser (`parsers/junit.ts`) already folds the
`<failure>` node's message+text into `errorMessage`; that text is often a stack. v1 may populate
`failureDetail.errors[0] = { message, stack: <failure #text> }` from what JUnit already has, but
**stdout/stderr and attachments are Playwright-only for v1** (JUnit `system-out`/`system-err` is a
follow-on, out of scope here). If wiring JUnit detail adds meaningful complexity, leave JUnit
producing `failureDetail: null` and note it — the Playwright path is the target.

**D9 — No backfill.** Rows ingested before the migration keep `failure_detail = NULL`. The UI and
docs say detail is available "for runs ingested after upgrading." Backfilling is impossible anyway
(the source reports aren't retained).

## Open questions — RESOLVED by the maintainer 2026-07-15

- **OQ1 — Attachments: LOCKED = metadata-only (D3).** Store `{ name, contentType, path }` only;
  never the base64 `body`. This is a hard guarantee with a bite-proof test (Test plan).
- **OQ2 — stdout/stderr: LOCKED = include, capped 10k each (D4).** Flatten `text` chunks, cap at
  10k, omit the field when empty.
- **OQ3 — Build split: LOCKED = Pass A first** (storage + API), dashboard as a later Pass B after
  Pass A merges. See Execution note.

## Execution note (for the reviewer, not baked into the build)

The change spans parser → schema/migration → ingest → endpoint → docs → dashboard → tests. That is
larger than one 035-sized diff. Recommended split when dispatching to execute:

- **Pass A — storage + API**: `parsers/playwright.ts` (+ optionally `junit.ts`), `db/schema.ts` +
  generated `drizzle/0007_*.sql`, `routes/reports.ts`, `routes/projects.ts` (select), `docs/API.md`,
  and the API-side tests (parser unit test, reports ingest test, projects run-detail test). Fully
  verifiable server-side; ships a working API with the new field.
- **Pass B — dashboard**: `routes/runs/[runId]/+page.svelte` (+ the load type if needed), the honesty
  note, and the dashboard/E2E test. Depends on Pass A being merged (needs the API field).

The steps below are written end-to-end and are numbered so either "all of it" or "Steps 1–5 = Pass
A, Step 6 = Pass B" is a clean cut. **If splitting, each pass is its own branch/PR with its own
green CI.**

## Scope

**In scope (Pass A):**
- `apps/api/src/parsers/playwright.ts` — add `FailureDetail` type + an `extractFailureDetail()`
  helper; add `failureDetail` to `ParsedTestResult`; populate it (do NOT change `errorMessage`,
  `status`, or any existing field's logic).
- `apps/api/src/parsers/junit.ts` — D8 light support (or explicit `failureDetail: null`).
- `apps/api/src/db/schema.ts` — add `failureDetail: jsonb('failure_detail').$type<FailureDetail>()`
  to `testResults`.
- `apps/api/drizzle/0007_*.sql` + `apps/api/drizzle/meta/*` — **generated** by `db:generate`, not
  hand-written. Must be a single `ADD COLUMN "failure_detail" jsonb;` (nullable, no default).
- `apps/api/src/routes/reports.ts` — map `result.failureDetail` into the insert row.
- `apps/api/src/routes/projects.ts` — add `failureDetail: testResults.failureDetail` to the
  run-detail select (line ~328-337). Nothing else in that handler.
- `docs/API.md` — update the run-detail response example + the Note (lines ~268-287).
- API tests (see Test plan).

**In scope (Pass B):**
- `apps/dashboard/src/routes/runs/[runId]/+page.svelte` — the detail panel + updated note.
- `apps/dashboard/src/lib/api.ts` if the run-detail result type is declared there (add
  `failureDetail`).
- Dashboard test / E2E (see Test plan).

**Out of scope (do NOT touch):**
- `errorMessage` semantics anywhere (trend endpoint, dashboard fallback, JUnit message).
- The `status` filter, ownership 404, the `RUN_RESULTS_CAP` cap or its ordering (that's 036 — do
  not re-open it), the response envelope shape beyond adding the one field.
- `flaky_tests`, the flakiness algorithm, `updateFlakyTests`, webhooks.
- Storing attachment **bytes** (unless OQ1 is flipped), `system-out`/`system-err` for JUnit,
  Playwright `steps[]` (step-level timing is a separate, larger feature).
- Any index on `failure_detail` (display-only, never queried).

## Steps

### Step 1 — parser: define the type + extractor (no behavior change to existing fields)
In `parsers/playwright.ts`:
- Add and **export** the `FailureDetail` interface from D2.
- Add `failureDetail: FailureDetail | null` to `ParsedTestResult`.
- Add a helper `extractFailureDetail(results: TestResult[]): FailureDetail | null` that:
  - Collects errors from every result's `error` (single) and `errors[]`, in order, **deduped** by
    `` `${message ?? ''} ${stack ?? ''}` ``, capped to `MAX_ERRORS` (define, e.g. 10). Each
    field passes through the existing `clamp(_, 10_000)`.
  - Flattens `stdout[]`/`stderr[]`: for each chunk use `typeof chunk === 'string' ? chunk :
    (chunk?.text ?? '')`, join with `''`, `clamp(_, 10_000)`; omit the field if the result is empty.
    *(If OQ2 = omit, skip stdout/stderr entirely.)*
  - Maps `attachments[]` to `{ name, contentType, path }` (metadata only — never `body`), dropping
    entries with no `name`, capped to `MAX_ATTACHMENTS` (e.g. 25). *(If OQ1 = inline, add `body`
    under a size cap here.)*
  - Returns `null` if `errors` is empty AND no stdout/stderr AND no attachments.
- In the main loop (around line 399), set `failureDetail: extractFailureDetail(results)` on the
  pushed `ParsedTestResult`. **Leave `errorMessage` and everything else exactly as-is.**
- **Verify**: `pnpm --filter api exec tsc --noEmit` → 0.

### Step 2 — schema + migration
- In `db/schema.ts`, add to `testResults` (after `annotations`):
  `failureDetail: jsonb('failure_detail').$type<FailureDetail>(),` and
  `import type { FailureDetail } from '../parsers/playwright';` (type-only import — acyclic, the
  parser does not import the schema). No index, no `.notNull()`, no default.
- Generate the migration: `rtk proxy pnpm --filter api db:generate`. Confirm it produced
  `drizzle/0007_*.sql` containing exactly one `ALTER TABLE "test_results" ADD COLUMN
  "failure_detail" jsonb;` (plus the `meta/0007_snapshot.json` + `_journal.json` update). **Commit
  the generated files as-is — do not hand-edit them.** If `db:generate` wants to emit anything
  beyond that single ADD COLUMN, STOP — the schema drifted.
- **Verify** the migration applies cleanly against a fresh disposable Postgres (Test/verification
  setup below): `pnpm db:migrate` runs through 0007 with no error.

### Step 3 — ingest: persist the field
- In `routes/reports.ts`, in the `rows` map (lines 154-164), add
  `failureDetail: result.failureDetail,` to each inserted row. Nothing else changes (batching,
  transaction, reconcile all untouched).
- **Verify**: `tsc --noEmit` → 0.

### Step 4 — endpoint: expose the field
- In `routes/projects.ts`, add `failureDetail: testResults.failureDetail,` to the run-detail
  `.select({...})` (the block at lines 328-337). Do not touch the `.orderBy`/`.limit`/filter/404
  logic (036 owns the ordering).
- **Verify**: `tsc --noEmit` → 0.

### Step 5 — docs
- In `docs/API.md`, add `failureDetail` to the run-detail response example (around line 275) showing
  a realistic shape (an `errors` entry with `message`+`stack`+`snippet`, a short `stdout`, and one
  attachment metadata entry), and note that it is `null` for passing rows and for runs ingested
  before this feature. Rewrite the Note (lines 284-287): Flackyness now stores the error stack,
  snippet, stdout/stderr, and attachment **metadata**; the attachment **files themselves**
  (screenshots/videos/traces) still live in the CI artifacts, and detail is absent (`null`) for
  runs ingested before the upgrade.

### Step 6 — dashboard (Pass B)
- In `routes/runs/[runId]/+page.svelte`, replace the single `{#if result.errorMessage}` `<pre>`
  block (lines 143-149) with a detail renderer for `result.failureDetail`:
  - For each `errors[]` entry: the message, then the `snippet` in a `<pre>`, then the `stack` inside
    a collapsed `<details><summary>Stack trace</summary><pre>…</pre></details>`.
  - `stdout`/`stderr` each in their own collapsed `<details>` when present.
  - `attachments[]` as a small list: `name` · `contentType` · `path`, with a one-line note that the
    file lives in the CI job's artifacts.
  - **Fallback**: when `failureDetail` is null but `errorMessage` is set (pre-migration rows, JUnit),
    render the existing `<pre>{errorMessage}</pre>` exactly as today.
  - Keep the existing Tailwind semantic classes / red styling; match the surrounding table markup
    (colspan, `bg-red-50`).
- Update the bottom note (lines 173-176) to match the new reality (attachment files live in CI;
  pre-upgrade runs have no detail).
- If the run-detail result type is declared in `lib/api.ts` (`getRunDetail`), add the
  `failureDetail` field to it so `svelte-check` stays green.
- **Verify**: `pnpm --filter dashboard check` → 0.

### Step 7 — full gate
`pnpm --filter api exec tsc --noEmit` → 0; `pnpm --filter dashboard check` → 0 (Pass B);
`rtk proxy pnpm lint` → 0; full API suite green; dashboard suite green. `git diff --name-only main`
matches the scope for the pass(es) being shipped.

## Test plan

Follow the existing suites as patterns — do not invent a new harness.

- **Parser unit test** (`parsers/playwright.test.ts`): add a case feeding a report whose failing
  result has `error.stack`, `error.snippet`, an `errors[]` with a second assertion, `stdout`/
  `stderr` chunks (mixed string + `{text}`), and two `attachments` (one with `path`, one with a
  `body` that must be **dropped**). Assert the produced `ParsedTestResult.failureDetail` has the
  deduped errors, flattened+capped stdout/stderr, and attachment **metadata only** (no `body`
  key). Assert a **passing** result yields `failureDetail: null`. Assert each field respects its
  10k / count caps (feed an oversized stack + >MAX_ATTACHMENTS).
- **Ingest round-trip** (`routes/reports.test.ts`): POST a report with failure detail, then read the
  row back (via the run-detail endpoint or a direct select) and assert `failure_detail` persisted
  and round-trips through jsonb intact.
- **Endpoint** (`routes/projects.test.ts`): assert the run-detail response includes `failureDetail`
  on a failed row and `null` on a passed row (under `?status=all`). This is additive to 035's
  existing run-detail tests, which must stay green.
- **Bite-proof for the drop-the-bytes guarantee**: the parser test's "attachment `body` is dropped"
  assertion is the one that matters most — temporarily make the extractor copy `body` through and
  confirm the test fails (a screenshot's base64 must never land in the DB under the metadata-only
  decision). Paste the observed failure.
- **Dashboard** (Pass B): extend the run-detail page test / E2E to assert the stack `<details>` and
  attachment list render for a row with `failureDetail`, and that a row with only `errorMessage`
  still renders the legacy `<pre>`.

## Done criteria

- [ ] `failure_detail jsonb` column added via a **generated** `0007_*.sql` (single nullable ADD
      COLUMN; migration applies clean on a fresh DB)
- [ ] Parser populates `failureDetail` from stack/snippet/errors[]/stdout/stderr/attachment-metadata,
      `null` for passing rows, all fields capped; **attachment `body` bytes never stored** (proven
      to bite)
- [ ] `errorMessage` and everything that reads it are unchanged (additive only)
- [ ] Ingest persists the field; run-detail endpoint returns it (additive, default scope unchanged)
- [ ] `docs/API.md` updated (example + Note)
- [ ] (Pass B) dashboard renders stack/snippet/stdout/stderr/attachments, keeps the `errorMessage`
      fallback, honesty note updated
- [ ] `tsc --noEmit` 0; `pnpm --filter dashboard check` 0 (Pass B); `pnpm lint` 0; API + dashboard
      suites green
- [ ] `git diff --name-only main` matches the pass's scope; no change to 036's ordering, the cap,
      the flakiness algorithm, or `flaky_tests`

## Test/verification setup

Disposable Postgres — **never `docker compose up`**, clean up even on failure:
```bash
docker run -d --name flackyness-test-pg-037 -e POSTGRES_PASSWORD=test_password \
  -e POSTGRES_DB=flackyness_test -p 5463:5432 postgres:16-alpine
touch .env
DATABASE_URL=postgres://postgres:test_password@localhost:5463/flackyness_test pnpm db:migrate  # must apply 0007
docker rm -f flackyness-test-pg-037   # ALWAYS
```
Route suites self-skip without `DATABASE_URL` + `ADMIN_TOKEN` — prove yours ran (paste counts).

## STOP conditions

- **`db:generate` wants to emit more than the single `failure_detail` ADD COLUMN** → the schema
  drifted from `cb12646`; STOP and report rather than committing an unexpected migration.
- **Adding the type-only import to `schema.ts` creates a circular import** (it should not — the
  parser imports only `zod`) → STOP; move `FailureDetail` to a standalone `types.ts` instead of
  inlining a fix.
- **Storing full detail balloons a realistic payload past a sane size** (e.g. a run's response
  exceeds a few MB) → the caps aren't tight enough; STOP and reconsider caps rather than shipping
  an unbounded column.
- **The change seems to require touching the flakiness algorithm, `flaky_tests`, or 036's
  ordering/cap** → it does not; STOP if you believe otherwise.
- **OQ1/OQ2 are still unresolved at build time** → build the recommended defaults (metadata-only,
  include stdout/stderr) and note it; do not inline base64 bodies without an explicit decision.

## Maintenance notes

- After this, the per-run view is self-sufficient for most failures — the remaining honest gap is
  attachment **bytes** (screenshots/videos), which stay in CI artifacts by design (D3/OQ1).
- The `failure_detail` blob is display-only and uncapped-by-schema; the parser caps are the only
  size guard. Any future field added to `FailureDetail` must carry its own cap.
- If a consumer ever needs to *query* failure detail (e.g. "tests whose stack mentions X"), that's a
  different design (a discrete column or a GIN index) — this plan deliberately does not enable it.
- `retentionDays` prune already deletes old `test_runs` (cascade to `test_results`), so detail ages
  out with the run — no separate retention needed.
