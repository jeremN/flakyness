# Plan 013: Per-project flakiness thresholds (columns + admin API + threading)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If
> anything in "STOP conditions" occurs, stop and report — do not improvise.
> When done, update this plan's row in `plans/README.md` — unless a reviewer
> dispatched you and said they maintain the index.
>
> **Drift check (run first)**: `git diff --stat 7609d55..HEAD -- apps/api/src/db/schema.ts apps/api/src/services/flakiness.ts apps/api/src/routes/admin.ts apps/api/drizzle/`
> Also confirm `apps/api/drizzle/` contains exactly `0000_*.sql`, `0001_*.sql`,
> `0002_*.sql` (+ `meta/`). A `0003_*` already present = another plan landed a
> migration first; regenerate cleanly on top of it (it composes) — but if the
> schema excerpts below no longer match `schema.ts`, STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (migration + behavior change: reclassification on next ingest for projects that set custom values)
- **Depends on**: none. **Serial constraint**: plans 013/015/016 each add a drizzle migration — they must land one at a time, this one first.
- **Category**: feature
- **Planned at**: commit `7609d55`, 2026-07-10

## Why this matters

Flakiness is defined by one hardcoded module constant
(`apps/api/src/services/flakiness.ts:13-17`):

```ts
const DEFAULT_CONFIG: FlakinessConfig = {
  windowDays: 14,
  flakeThreshold: 0.05, // 5% flake rate
  minRuns: 3,
};
```

A monorepo tracking a stable unit-test suite and a noisy e2e suite as
separate projects cannot tune them independently — 5%/14d/3-runs is forced
on everyone. The plumbing is already half-there: `analyzeFlakiness` and
`updateFlakyTests` BOTH accept `config: Partial<FlakinessConfig> = {}`
(`flakiness.ts:135` and `:182`) merged over defaults — but **no caller ever
passes project-specific values**, because projects have nowhere to store them.

## Current state

- `apps/api/src/db/schema.ts` — `projects` table columns: `id` (uuid pk),
  `name` (varchar 255, unique+notNull), `gitlabProjectId` (varchar 100),
  `tokenHash` (varchar 64, notNull), `createdAt` — plus `tokenHashIdx`. No
  config columns.
- `apps/api/src/services/flakiness.ts` — `FlakinessConfig` interface (lines
  4–11); `DEFAULT_CONFIG` (13–17); `analyzeFlakiness(projectId, config = {})`
  merges `{ ...DEFAULT_CONFIG, ...config }` (line 137);
  `updateFlakyTests(projectId, config = {})` forwards to `analyzeFlakiness`
  (line 184). The merge-partial pattern means threading = "load project row,
  pass its non-null values".
- `apps/api/src/routes/reports.ts` lines 108–117 — fire-and-forget
  `updateFlakyTests(project.id).catch(...)` after ingest; `project` is the
  full row from `projectAuth()` (`c.get('project')`).
- `apps/api/src/routes/projects.ts:142-165` — `GET /:id/analysis` clamps
  `days` to 1–90 and `threshold` to 0–1, then calls
  `analyzeFlakiness(projectId, { windowDays, flakeThreshold: threshold })`.
  Explicit query params must KEEP overriding; project config only replaces
  the hardcoded fallback defaults.
- `apps/api/src/routes/admin.ts` — `adminAuth()`-guarded router:
  `GET /projects` (line 29), `POST /projects` (71), `POST /projects/:id/rotate-token` (120),
  `DELETE /projects/:id` (163), `GET /health` (197). There is NO
  `PATCH /projects/:id` — this plan adds it.
- Migrations: `apps/api/drizzle/0000..0002_*.sql`; generator:
  `pnpm --filter api db:generate` (drizzle-kit reads `src/db/schema.ts`,
  writes `./drizzle`); applier: root `pnpm db:migrate` (requires root `.env`
  to EXIST — `touch .env` if absent — and `DATABASE_URL` in env).

## Design decisions (advisor — do not relitigate)

1. Three NULLABLE columns on `projects`: `flake_threshold` `decimal(5,4)`,
   `window_days` `integer`, `min_runs` `integer`. NULL = "use default".
   Defaults stay in code (`DEFAULT_CONFIG`), not in the DB — changing a
   default later must not require a data migration.
2. Config resolution is one small exported helper in `flakiness.ts`:
   `resolveProjectConfig(project)` → full `FlakinessConfig` (project
   non-nulls over `DEFAULT_CONFIG`). Callers stay dumb.
3. Admin API: new `PATCH /api/v1/admin/projects/:id` accepting any subset of
   `{ flakeThreshold, windowDays, minRuns }` (all nullable — sending `null`
   clears back to default). Validation: threshold 0–1; windowDays int 1–90
   (same cap as the analysis route, DoS guard); minRuns int 1–100.
4. v1 is API-only — no dashboard settings UI (separate future plan if wanted).
5. Reclassification on next ingest is ACCEPTED behavior (tightening a
   threshold resolves rows; loosening activates new ones) — document it in
   the API docs, don't fight it.

## Commands you will need

Same toolbox as every plan in this repo:
typecheck `pnpm --filter api exec tsc --noEmit`; tests `pnpm --filter api test`
(DB-gated suites need `DATABASE_URL` + `ADMIN_TOKEN` env); lint `pnpm lint`
(garbled output → `rtk proxy pnpm lint`). Disposable DB:
`docker run -d --name flackyness-test-pg-013 -e POSTGRES_PASSWORD=test_password -e POSTGRES_DB=flackyness_test -p 5434:5432 postgres:16-alpine`,
`touch .env` at repo root, then
`DATABASE_URL=postgres://postgres:test_password@localhost:5434/flackyness_test pnpm db:migrate`.
ALWAYS clean up container + temp `.env`. Never `docker compose up`.

## Scope

**In scope**: `apps/api/src/db/schema.ts`, generated `apps/api/drizzle/0003_*`
(+ meta journal — generated, never hand-edited), `apps/api/src/services/flakiness.ts`,
`apps/api/src/services/flakiness.test.ts`, `apps/api/src/routes/admin.ts`,
`apps/api/src/routes/admin.test.ts`, `apps/api/src/routes/reports.ts` (one
call-site line), `apps/api/src/routes/projects.ts` (analysis fallback only),
`docs/API.md`.

**Out of scope**: dashboard (any file); `computeFlakiness` internals; the
trend endpoint; token/auth handling in admin routes.

## Git workflow

Branch `advisor/013-per-project-flakiness-config`; single-line conventional
commits (e.g. `feat(api): per-project flakiness thresholds`); NO
`Co-Authored-By` trailers; no push/PR unless the operator instructed it.

## Steps

### Step 1: Schema + migration

In `schema.ts`, add to the `projects` table (match existing column style;
import `decimal`/`integer` from `drizzle-orm/pg-core` if not present):

```ts
// Per-project flakiness overrides; NULL means "use DEFAULT_CONFIG".
flakeThreshold: decimal('flake_threshold', { precision: 5, scale: 4 }),
windowDays: integer('window_days'),
minRuns: integer('min_runs'),
```

Run `pnpm --filter api db:generate` → expect ONE new `drizzle/0003_*.sql`
containing exactly three `ADD COLUMN`s on `projects` (read it and confirm —
anything else means schema drift; STOP). Apply it to a disposable DB via
`pnpm db:migrate` → success.

### Step 2: Resolution helper

In `flakiness.ts`, below `DEFAULT_CONFIG`, add and export:

```ts
/** Shape of the projects row fields relevant to config resolution. */
export interface ProjectFlakinessOverrides {
  flakeThreshold: string | null; // drizzle decimal maps to string
  windowDays: number | null;
  minRuns: number | null;
}

/**
 * Merge a project's stored overrides (NULL = unset) over DEFAULT_CONFIG.
 */
export function resolveProjectConfig(project: ProjectFlakinessOverrides): FlakinessConfig {
  return {
    windowDays: project.windowDays ?? DEFAULT_CONFIG.windowDays,
    flakeThreshold:
      project.flakeThreshold !== null ? Number(project.flakeThreshold) : DEFAULT_CONFIG.flakeThreshold,
    minRuns: project.minRuns ?? DEFAULT_CONFIG.minRuns,
  };
}
```

Note the `decimal → string` mapping: drizzle returns numerics as strings —
`Number()` it exactly once, here, so no caller ever sees a string threshold.

**Verify**: `pnpm --filter api exec tsc --noEmit` → exit 0.

### Step 3: Thread through callers

- `reports.ts` lines 108–117: change the fire-and-forget call to
  `updateFlakyTests(project.id, resolveProjectConfig(project))` (the
  `projectAuth()` middleware already loads the full row — confirm the new
  columns are on it; drizzle `findMany`/`select()` full-row queries include
  them automatically).
- `projects.ts` analysis route: load the project row first (404 if absent —
  currently the route doesn't check existence; keep behavior: only add the
  lookup, use it for defaults). Replace the hardcoded fallbacks: `days`
  defaults to the project's `windowDays ?? 14`, `threshold` to its
  resolved value, and pass `minRuns` from the resolved config too (today the
  route silently uses default minRuns — now it uses the project's). Explicit
  query params still win; the 1–90 / 0–1 clamps stay.

**Verify**: tsc exit 0.

### Step 4: Admin PATCH route

In `admin.ts`, add below the rotate-token route, following the file's exact
patterns (uuid param validation, zod safeParse, error JSON shape):

`PATCH /projects/:id` — body schema:

```ts
const projectConfigPatchSchema = z
  .object({
    flakeThreshold: z.number().min(0).max(1).nullable().optional(),
    windowDays: z.number().int().min(1).max(90).nullable().optional(),
    minRuns: z.number().int().min(1).max(100).nullable().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'No fields to update' });
```

Build the drizzle `.set()` object only from keys present in the parsed body
(`'flakeThreshold' in data` etc.; convert number→string for the decimal
column: `data.flakeThreshold === null ? null : data.flakeThreshold.toFixed(4)`).
`.returning()` the row; 404 when empty. Response `{ project }` — mirror what
`GET /projects` returns per row (check it doesn't leak `tokenHash`; if the
GET handler selects explicit columns, select the same set + the three new
ones — and add the three to the GET while you're in the file so operators
can read what they set).

**Verify**: tsc exit 0.

### Step 5: Tests

- `flakiness.test.ts`: unit tests for `resolveProjectConfig` (all-null →
  DEFAULT_CONFIG; string decimal `'0.2000'` → number 0.2; partial override).
  Plus one DB-gated integration case: seed results at ~10% failure rate,
  `updateFlakyTests(projectId, { flakeThreshold: 0.5 })` → not flaky;
  with `{ flakeThreshold: 0.05 }` → flaky. Follow the existing seed-helper
  patterns in that file.
- `admin.test.ts` (DB-gated): PATCH happy path (set + read back via GET),
  clear-to-null, validation rejects (threshold 1.5 → 400, windowDays 0 →
  400, empty body → 400), unknown id → 404, no/bad auth → 401.
- End-to-end (DB-gated, in admin or flakiness suite): create project via
  admin POST, PATCH `flakeThreshold: 0.9`, ingest a report with a mildly
  flaky test through the reports route, assert NO active `flaky_tests` row
  appears (ingest is fire-and-forget — poll/await briefly like existing
  ingest tests do; check how `reports.test.ts` handles this and copy it).

**Verify**: with DB env `pnpm --filter api test` → all pass (105 baseline +
new); without DB env → exit 0 with skips.

### Step 6: Docs

`docs/API.md`: document the PATCH (fields, ranges, null-clears-to-default)
and add a "Tuning flakiness detection" note: changes apply on the next
report ingest and MAY reclassify existing flaky tests (tighten → resolves,
loosen → activates). Mention the three defaults.

## Done criteria

- [ ] `0003_*.sql` adds exactly 3 nullable columns; applies cleanly to a fresh DB
- [ ] `resolveProjectConfig` exported + unit-tested (incl. decimal-string case)
- [ ] Ingest path and analysis route use project config; explicit query params still override
- [ ] Admin PATCH validates/clamps, clears with null, 404s, is admin-authed; GET /projects exposes the three fields; no tokenHash leak
- [ ] Full gates green: api tsc, api tests (DB + no-DB modes), `pnpm lint`
- [ ] `git status` clean outside scope; migration meta journal committed with the SQL

## STOP conditions

- `db:generate` emits anything beyond the three ADD COLUMNs → schema drift; STOP.
- `projectAuth()` turns out to select explicit columns (not the full row) so
  the new fields are missing in `reports.ts` → extend that select, but if it
  lives outside the scope list, report instead of editing.
- The analysis route's missing-project behavior is load-bearing in dashboard
  tests (adding a 404 breaks them) → keep the old no-check behavior, report
  the discrepancy.

## Maintenance notes

- Plan 016 (webhooks) also alters `projects` — it must regenerate ITS
  migration after this one lands (serial ordering).
- Plan 014 (analysis UI) reads the analysis route — its default-threshold
  display should show the project's resolved values once both land; note for
  that reviewer.
- Anyone changing `DEFAULT_CONFIG` later: NULL columns mean stored projects
  silently pick up the new default — that's the intended design.
