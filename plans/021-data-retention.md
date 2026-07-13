# Plan 021: Give Flackyness a data retention policy so self-hosted databases stop growing forever

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 1642dc4..HEAD -- apps/api/src/db/schema.ts apps/api/src/routes/admin.ts apps/api/src/services/flakiness.ts docs/API.md .env.example`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED — this plan **deletes user data**. The safety rails below
  (opt-in, dry-run, window guard) are the plan, not decoration.
- **Depends on**: none. **Migration-serial**: generates `0006_*`; if any other
  plan in flight also generates a migration, land one at a time.
- **Category**: direction / tech-debt
- **Planned at**: commit `1642dc4`, 2026-07-13

## Why this matters

Flackyness has **no data lifecycle at all**. Grep the API for
`retention|prune|purge` and you get zero hits. Every ingested report appends
rows to `test_results` forever, and the only `DELETE` in the codebase is
project deletion via FK cascade. A self-hoster who points a busy CI at a small
Postgres will simply grow until the disk or the query planner gives out — and
nothing in the product warns them or offers a way out.

Meanwhile the flakiness computation only ever looks back `windowDays` (default
14), so the overwhelming majority of stored `test_results` rows are already
outside every window the product actually queries. They are pure cost.

After this plan an operator can set a per-project retention and prune old runs
on a schedule they control, without losing the flaky-test history that makes
the product useful.

## Current state

### There is no retention anywhere

```
$ grep -rniE "retention|prune|purge|older than|deleteOld" apps/api/src
(no matches)
```

### The cascade that makes pruning safe and cheap

`apps/api/src/db/schema.ts:46-48` — `test_results` rows hang off `test_runs`
with `onDelete: 'cascade'`:

```ts
export const testResults = pgTable('test_results', {
  id: uuid('id').primaryKey().defaultRandom(),
  testRunId: uuid('test_run_id').references(() => testRuns.id, { onDelete: 'cascade' }).notNull(),
  ...
```

**Consequence you must rely on**: deleting a `test_runs` row deletes its
`test_results` automatically. Your prune therefore deletes from `test_runs`
only — one statement — and Postgres cascades. Do NOT hand-delete
`test_results` first; that is slower and can leave orphans if it half-fails.

`test_runs` also carries the timestamp you prune on
(`apps/api/src/db/schema.ts:37,42`), and it already has a BRIN index sized for
exactly this kind of time-range delete:

```ts
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  projectIdIdx: index('test_runs_project_id_idx').on(table.projectId),
  // BRIN index for time-series queries (very efficient for timestamps)
  createdAtBrinIdx: index('test_runs_created_at_brin_idx').using('brin', table.createdAt),
}));
```

### `flaky_tests` must SURVIVE the prune

`flaky_tests` (`schema.ts:69-90`) is a **computed aggregate keyed on
`(project_id, test_name)`**, not a child of `test_runs` — it hangs off
`projects` directly. It is the product's memory: `firstDetected`, `flakeRate`,
and the operator's `ignored` mutes live there. Pruning old runs must not touch
it. Because `flaky_tests` has no FK to `test_runs`, deleting runs leaves it
alone automatically — but **do not "helpfully" clean it up**.

### The per-project override pattern to copy

Plan 013 established exactly the pattern this plan extends. `schema.ts:4-21`:

```ts
export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).unique().notNull(),
  gitlabProjectId: varchar('gitlab_project_id', { length: 100 }),
  tokenHash: varchar('token_hash', { length: 64 }).notNull(), // SHA-256 hash
  createdAt: timestamp('created_at').defaultNow().notNull(),
  // Per-project flakiness overrides; NULL means "use DEFAULT_CONFIG".
  flakeThreshold: decimal('flake_threshold', { precision: 5, scale: 4 }),
  windowDays: integer('window_days'),
  minRuns: integer('min_runs'),
  webhookUrl: varchar('webhook_url', { length: 2048 }),
}, ...
```

And the admin PATCH that edits them, `apps/api/src/routes/admin.ts:24-54`
(abridged) — you will extend this schema, not create a new route:

```ts
const projectConfigPatchSchema = z
  .object({
    flakeThreshold: z.number().min(0).max(1).nullable().optional(),
    windowDays: z.number().int().min(1).max(90).nullable().optional(),
    minRuns: z.number().int().min(1).max(100).nullable().optional(),
    webhookUrl: z.string().url().max(2048)./* …http(s) refine… */.nullable().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'No fields to update' });
```

The admin router is already fully gated (`admin.ts:15-16`) — your new route
inherits both; do NOT add a second limiter or auth call:

```ts
adminRouter.use('*', adminAuth());
adminRouter.use('*', adminRateLimit);
```

### The window your retention must not undercut

`apps/api/src/services/flakiness.ts:13-36`:

```ts
const DEFAULT_CONFIG: FlakinessConfig = {
  windowDays: 14,
  flakeThreshold: 0.05, // 5% flake rate
  minRuns: 3,
};

export function resolveProjectConfig(project: ProjectFlakinessOverrides): FlakinessConfig {
  return {
    windowDays: project.windowDays ?? DEFAULT_CONFIG.windowDays,
    ...
```

`analyzeFlakiness` selects `test_results` newer than
`now - windowDays`. **If retention deletes rows still inside that window, flake
rates silently change and tests spuriously "resolve".** Guarding against this
is design decision 3 below and is the single most important correctness
property of this plan.

## Design decisions (advisor — do not relitigate)

1. **Opt-in, never automatic.** New nullable column `projects.retention_days`.
   **NULL = keep forever** (today's behavior). No existing install starts
   deleting data because they upgraded. There is no global default.

2. **Manual trigger, no scheduler.** Expose
   `POST /api/v1/admin/projects/:id/prune` on the existing admin router.
   Operators call it from cron / a CI job on a cadence they choose. Building an
   in-process scheduler is explicitly **out of scope** — it multiplies blast
   radius (what runs it on multi-replica? what if it fires mid-ingest?) for no
   gain at this stage.

3. **Retention may never undercut the flakiness window.** Reject
   `retentionDays < resolveProjectConfig(project).windowDays` with a `400` and
   a message naming both numbers. This applies in **two** places:
   - on `PATCH` when setting `retentionDays` (validate against the project's
     *resolved* window, not the raw nullable column), and
   - at prune time (re-check, because `windowDays` may have been raised *after*
     `retentionDays` was set — the stored pair can be stale and invalid).
   A prune that runs anyway would corrupt flake rates. Fail loudly instead.

4. **Dry-run is the default.** `POST …/prune` **without** `?confirm=true`
   returns the counts it *would* delete and deletes nothing. Deletion requires
   the explicit `?confirm=true`. An admin token plus a `curl` typo should not
   be able to destroy history.

5. **Delete `test_runs` only; let the FK cascade handle `test_results`.**
   One `DELETE … WHERE project_id = $1 AND created_at < $2`. Never touch
   `flaky_tests` (see "Current state").

6. **Bound the blast radius per call.** Delete in batches (e.g. 5000 run-ids
   per statement, matching the repo's existing `BATCH_SIZE`-style chunking in
   `services/flakiness.ts:184-193`) so a first prune of a year-old database
   doesn't take one enormous lock. Report the total deleted.

7. **Column limits**: `retentionDays` is `integer`, validated to `[1, 3650]`
   (10 years) — same style as the existing `windowDays: z.number().int().min(1).max(90)`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `CI=true pnpm install --frozen-lockfile` | exit 0 |
| Generate migration | `pnpm db:generate` | creates `apps/api/drizzle/0006_*.sql` |
| Apply migration | `pnpm db:migrate` | `migrations applied successfully` |
| Typecheck | `pnpm --filter api exec tsc --noEmit` | exit 0 |
| Tests | `pnpm --filter api test` | all pass |
| Lint | `rtk proxy pnpm lint` (plain `pnpm lint` is garbled by a hook) | exit 0 |

**Disposable Postgres** (required — this plan has a migration):

```bash
docker run -d --name flackyness-test-pg-021 \
  -e POSTGRES_PASSWORD=test_password -e POSTGRES_DB=flackyness_test \
  -p 5443:5432 postgres:16-alpine
touch .env   # repo root; db:migrate hard-fails if it doesn't exist
DATABASE_URL=postgres://postgres:test_password@localhost:5443/flackyness_test pnpm db:migrate
```

**ALWAYS** remove the container and any temp `.env` when done, even on failure.
**NEVER** run `docker compose up` — it collides with the operator's own stack.

## Scope

**In scope**:
- `apps/api/src/db/schema.ts` — one nullable column on `projects`
- `apps/api/drizzle/0006_*.sql` — generated, committed
- `apps/api/src/routes/admin.ts` — extend `projectConfigPatchSchema`; add the prune route
- `apps/api/src/routes/admin.test.ts` — new tests
- `docs/API.md` — document `retentionDays` + the prune endpoint

**Out of scope** (do NOT touch):
- `apps/api/src/services/flakiness.ts` — read `resolveProjectConfig` from it,
  change nothing in it.
- Any scheduler, cron, or background timer (design decision 2).
- `flaky_tests` — must survive pruning untouched.
- The dashboard — no UI for retention in this plan.
- Table partitioning / `VACUUM` tuning — different problem, different plan.

## Git workflow

Branch `advisor/021-data-retention`; single-line conventional-commit subject
(e.g. `feat(api): per-project data retention with admin prune endpoint`); **no
`Co-Authored-By` trailer**; do not push or open a PR unless the operator
instructed it.

## Steps

### Step 1: Schema + migration

Add to `projects` in `apps/api/src/db/schema.ts`, immediately after `minRuns`,
with a comment in the style of the existing override block:

```ts
  // Per-project data retention. NULL means "keep forever" (the default for
  // every existing install). When set, `POST /admin/projects/:id/prune`
  // deletes test_runs older than this many days; test_results cascade.
  // Must never be lower than the resolved flakiness windowDays — see
  // routes/admin.ts.
  retentionDays: integer('retention_days'),
```

Generate the migration with `pnpm db:generate` and **read the generated SQL**:
it must be exactly one `ALTER TABLE … ADD COLUMN "retention_days" integer;`.

**Verify**: `pnpm db:generate` produces `0006_*.sql` containing a single
ADD COLUMN; `pnpm db:migrate` applies 0000→0006 on a fresh database.

**STOP** if the generated migration contains anything else (a DROP, a rename,
a type change) — that means the schema drifted and you must not apply it.

### Step 2: Accept `retentionDays` in the admin PATCH

Extend `projectConfigPatchSchema` in `apps/api/src/routes/admin.ts` with:

```ts
    retentionDays: z.number().int().min(1).max(3650).nullable().optional(),
```

Then, in the PATCH handler, **before writing**, enforce design decision 3: if
the incoming `retentionDays` is a number, resolve the project's effective
window (`resolveProjectConfig`, imported from `../services/flakiness`, using
the project's row — including any `windowDays` in the same PATCH body) and
reject with 400 when `retentionDays < windowDays`:

```
{ "error": "retentionDays (7) must be >= the flakiness windowDays (14)" }
```

Note the subtlety: if the same request sets **both** `windowDays` and
`retentionDays`, validate the new retention against the **new** window, not the
stored one.

**Verify**: `pnpm --filter api exec tsc --noEmit` → exit 0.

### Step 3: The prune route

Add to `apps/api/src/routes/admin.ts` (inherits `adminAuth()` +
`adminRateLimit` from the router — do not re-apply them):

`POST /projects/:id/prune`

1. Validate `:id` with `uuidSchema` → 400 on failure (match existing message).
2. Load the project → 404 `{ error: 'Project not found' }` if absent (copy the
   existing `DELETE /projects/:id` handler's lookup).
3. If `project.retentionDays == null` → **400**
   `{ error: 'No retention configured for this project' }`. Pruning without a
   configured retention is always a mistake.
4. Re-check the window guard (design decision 3) against the *stored* config —
   if `retentionDays < resolveProjectConfig(project).windowDays`, return 400
   naming both numbers. Do not delete.
5. Compute `cutoff = now - retentionDays days`.
6. Count the `test_runs` rows for this project older than `cutoff` (and, for the
   report, the `test_results` that would cascade).
7. If `c.req.query('confirm') !== 'true'` → return **200** with
   `{ dryRun: true, cutoff, runsToDelete, resultsToDelete }` and **delete
   nothing**.
8. Otherwise delete `test_runs` for this project older than `cutoff`, in chunks
   (design decision 6), and return
   `{ dryRun: false, cutoff, runsDeleted, resultsDeleted }`.
9. Log the outcome with the structured logger (`middleware/logger.ts`; never
   `console.log`) — a destructive admin action must leave a trace.

**Verify**: `pnpm --filter api exec tsc --noEmit` → exit 0.

### Step 4: Tests

**Verify**: `pnpm --filter api test` → green in DB and no-DB modes.

### Step 5: Docs

`docs/API.md`: document `retentionDays` on the config PATCH and the new prune
endpoint — the dry-run default, the `?confirm=true` requirement, the window
guard (with the 400 shape), and that `flaky_tests` history survives pruning.
Include a cron-style example:

```bash
# Nightly prune (dry-run first; drop --dry to actually delete)
curl -sX POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$FLACKYNESS_URL/api/v1/admin/projects/$PROJECT_ID/prune?confirm=true"
```

**Verify**: `rtk proxy pnpm lint` → exit 0.

## Test plan

New tests in `apps/api/src/routes/admin.test.ts` (DB-gated; follow the existing
admin route tests for env/auth setup — they already juggle `ADMIN_TOKEN`).

1. **Dry-run deletes nothing**: seed runs older than the cutoff, POST without
   `confirm` → 200, `dryRun: true`, non-zero `runsToDelete`, and a follow-up
   count query proves **the rows are still there**. (The most important test in
   this plan.)
2. **Confirmed prune deletes old runs and cascades**: POST with `?confirm=true`
   → old `test_runs` gone AND their `test_results` gone (assert both counts).
3. **Recent runs survive**: a run inside the retention window is untouched.
4. **`flaky_tests` survives**: assert the project's `flaky_tests` rows — including
   one with `status='ignored'` — are byte-for-byte still present after a
   confirmed prune. This is the regression that would quietly destroy the
   product's memory.
5. **Window guard on PATCH**: `retentionDays: 7` against a project with
   `windowDays: 14` → 400, and the column is not written.
6. **Window guard at prune time**: set `retentionDays: 30`, then raise
   `windowDays` to 60, then prune → 400, nothing deleted. (Covers the stale-pair
   case decision 3 calls out.)
7. **No retention configured** → 400, nothing deleted.
8. **Unauthenticated / bad admin token** → 401 (inherited from `adminAuth`;
   one test to prove the route is actually behind it).

## Done criteria

- [ ] `pnpm db:generate` produced exactly one migration, `0006_*.sql`, containing exactly one ADD COLUMN; it is committed
- [ ] Fresh Postgres migrates 0000→0006 cleanly
- [ ] `pnpm --filter api exec tsc --noEmit` exits 0
- [ ] `pnpm --filter api test` passes in BOTH modes; all 8 tests above exist and pass
- [ ] `rtk proxy pnpm lint` exits 0
- [ ] `git status` clean outside the in-scope list
- [ ] E2E on a disposable Postgres: ingest a report, backdate its run's `created_at` past the retention, dry-run (rows survive), then `?confirm=true` (rows gone, `flaky_tests` intact)

## STOP conditions

Stop and report (do not improvise) if:

- The generated migration is not a single ADD COLUMN.
- `test_results.test_run_id` no longer has `onDelete: 'cascade'` — the whole
  prune strategy depends on it; without it you would be leaving orphaned rows.
- You conclude the prune should also delete `flaky_tests` rows. It must not.
  If you believe the aggregates go stale in a way that matters, STOP and
  report — do not delete them.
- You are tempted to add a scheduler/timer so pruning "just happens". Out of
  scope by design decision 2.
- Any test requires deleting data to make it pass in a way not described above.

## Maintenance notes

- **The window guard is the load-bearing invariant.** Any future change to
  `windowDays` semantics (e.g. per-branch windows) must re-check retention, or
  flake rates start silently drifting as history disappears underneath the
  analysis. A reviewer should scrutinize both guard sites.
- `flaky_tests.totalRuns` / `flakeCount` are historical aggregates that will
  now describe runs that no longer exist in `test_runs`. That's intended (it's
  the product's memory), but it means "drill into the runs behind this flake
  rate" can legitimately come up empty for old entries. Worth a UI note if a
  future plan surfaces retention in the dashboard.
- Deferred here: automatic scheduling, global (non-per-project) retention
  defaults, and table partitioning for very large installs. Partitioning is the
  real answer above ~1M `test_results` rows; retention buys time first.
