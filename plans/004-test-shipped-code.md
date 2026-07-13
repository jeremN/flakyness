# Plan 004: Make the tests exercise the shipped code, not re-implemented copies

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 0f8b0cc..HEAD -- apps/api/src/services/ apps/api/src/middleware/auth.ts apps/api/src/middleware/auth.test.ts apps/api/src/routes/*.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. (If plan 001 landed, parser tests
> will have changed — that is expected and not a stop.)

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW (tests + one extract-function refactor)
- **Depends on**: none (but plan 006 depends on THIS)
- **Category**: tests
- **Planned at**: commit `0f8b0cc`, 2026-07-10
- **Refreshed**: 2026-07-10 after an executor STOP — `db/index.ts` throws at
  module scope when `DATABASE_URL` is unset, blocking real-import unit tests
  for BOTH `flakiness.ts` and `auth.ts` (both transitively import `../db`).
  Step 0 (lazy DB init) added as the prerequisite; Step 7 amended (an embedded
  Tests-API block already exists inside `projects.test.ts`). Step 1 is already
  DONE on branch `advisor/004-test-shipped-code` (commit `1f7de6b`).

## Why this matters

The repo's central algorithm — flakiness detection — has zero coverage that
runs against the shipped code. `flakiness.test.ts` defines its own local
`calculateFlakiness()` and asserts against that copy; `auth.test.ts` literally
says "Re-implement the functions here to test without db import" even though
`hashToken`/`generateToken` are exported from `middleware/auth.ts`. A
regression in the real `analyzeFlakiness`/`updateFlakyTests` passes every
test. Additionally, the route integration tests are order-dependent (state
set in one `it` consumed in later ones), pass silently when setup found
nothing (`if (!testProjectId) return;`), never clean up created rows, and the
`tests.ts` routes have no test file at all.

This plan is the safety net required before plan 006 refactors
`updateFlakyTests`.

## Current state

Files:

- `apps/api/src/services/flakiness.ts` — the real logic.
  `analyzeFlakiness(projectId, config)` (lines 40–138) = one DB query (lines
  50–65) + a pure in-memory aggregation (lines 67–137).
  `updateFlakyTests(projectId, config)` (lines 144–219) = upsert/resolve state
  machine (details below). `getProjectStats` (lines 224–280).
- `apps/api/src/services/flakiness.test.ts` — defines a LOCAL
  `calculateFlakiness` (lines 26–64) and tests only that; never imports the
  real module.
- `apps/api/src/middleware/auth.ts` — exports `hashToken` (line 10),
  `generateToken` (line 17), `projectAuth()` (line 28), `adminAuth()` (line 66).
- `apps/api/src/middleware/auth.test.ts` — re-implements `hashToken`/
  `generateToken` locally (lines 5–11); never touches the middleware.
- `apps/api/src/routes/projects.test.ts` — `testProjectId` assigned inside an
  `it` (line ~28) and consumed by later `it`s guarded by
  `if (!testProjectId) return;` (line ~37) — silent pass when no projects exist.
- `apps/api/src/routes/reports.test.ts` — good `beforeAll` pattern (creates a
  project via the admin API, lines 17–35) but no `afterAll` cleanup.
- `apps/api/src/routes/admin.test.ts`, `apps/api/src/routes/api.test.ts` —
  same describe-skip pattern.
- No test file exists for `apps/api/src/routes/tests.ts`
  (`GET /:testName/history`, `GET /flaky/:id`).

The integration-test gating pattern used by every route suite (keep using it):

```ts
const hasDatabase = !!process.env.DATABASE_URL;
const hasAdminToken = !!process.env.ADMIN_TOKEN;
const describeWithDb = hasDatabase && hasAdminToken ? describe : describe.skip;

let app: typeof import('../index').default;
beforeAll(async () => {
  if (hasDatabase && hasAdminToken) {
    app = (await import('../index')).default;
  }
});
```

`updateFlakyTests` behavior to cover (from `flakiness.ts:144-219`):

- For each analyzed test with `isFlaky`: atomic
  `insert().onConflictDoUpdate()` keyed on the `(project_id, test_name)`
  unique index; `firstDetected` set only on insert; conflict path updates
  `testFile`, `lastSeen`, `flakeCount`, `totalRuns`, `flakeRate` and sets
  `status: 'active'`.
- For each analyzed test NOT flaky whose existing row is `active`: update to
  `status: 'resolved'`.
- Existing `active` rows whose testName does not appear in the analysis at
  all: update to `'resolved'`.
- Returns `{ updated, resolved }` counts.
- KNOWN QUIRK (do not "fix" here — plan 006 changes it): the upsert
  unconditionally sets `status: 'active'`, which would also reactivate a row
  in status `'ignored'`. Write the Step 4 test to document CURRENT behavior
  (asserting the row becomes `active`) with a comment
  `// current behavior; plan 006 changes this to preserve 'ignored'`.

Flakiness math (documented intent, `.agent/CONTEXT.md`): a test is flaky when
`(failCount + flakyCount) / totalRuns >= flakeThreshold` (default 0.05) AND
`totalRuns >= minRuns` (default 3); window is 14 days.

Repo conventions: Vitest (`pnpm --filter api test` = `vitest run`); CI runs
tests with a real Postgres 16 service and env
`DATABASE_URL=postgres://postgres:test_password@localhost:5432/flackyness_test`,
`ADMIN_TOKEN=test-admin-token-for-ci` (`.github/workflows/ci.yml` test job).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm --filter api exec tsc --noEmit` | exit 0 |
| Unit tests only (no DB) | `pnpm --filter api test` | pass; integration suites reported as skipped |
| Full tests with DB | `docker compose up -d` then `DATABASE_URL=postgres://postgres:postgres@localhost:5432/flackyness ADMIN_TOKEN=test-admin pnpm --filter api test` | all pass, no skips |
| Migrations (once per fresh DB) | `pnpm db:migrate` (reads `.env`) | exit 0 |
| Lint | `pnpm lint` | exit 0 |

If a local Postgres isn't available, unit-level steps still verify; run the
integration steps' verification in CI and say so in your report.

## Scope

**In scope** (the only files you should modify/create):
- `apps/api/src/db/index.ts` (ONLY the Step 0 lazy-init refactor)
- `apps/api/src/services/flakiness.ts` (ONLY the Step 1 extract-function refactor)
- `apps/api/src/services/flakiness.test.ts` (rewrite)
- `apps/api/src/middleware/auth.test.ts` (rewrite)
- `apps/api/src/routes/projects.test.ts` (fix setup/asserts)
- `apps/api/src/routes/reports.test.ts` (add cleanup)
- `apps/api/src/routes/tests.test.ts` (create)

**Out of scope** (do NOT touch):
- `updateFlakyTests`'s logic/semantics — plan 006's job. This plan only
  extracts the pure part of `analyzeFlakiness` and adds tests.
- `apps/api/src/routes/*.ts` route handlers, `middleware/auth.ts` itself.
- CI workflow files.

## Git workflow

- Branch: `advisor/004-test-shipped-code`
- Conventional-commit, single-line subject only (e.g.
  `test(api): cover shipped flakiness and auth code`). Do NOT add any
  `Co-Authored-By` trailer. Do not push or open a PR unless the operator
  instructed it.

## Steps

### Step 0: Make DB initialization lazy (prerequisite discovered by the first executor)

`apps/api/src/db/index.ts` currently throws at module scope when
`DATABASE_URL` is unset:

```ts
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL environment variable is not set');
}
const queryClient = postgres(connectionString, { max: 20, idle_timeout: 20, connect_timeout: 10 });
export const db = drizzle(queryClient, { schema });
export async function closeDb(): Promise<void> { await queryClient.end(); }
```

Because `middleware/auth.ts` and `services/flakiness.ts` import `../db` at
module scope, merely IMPORTING them in a no-DB unit test crashes. Note
`postgres()` does not connect eagerly (connections open on first query) — the
only eager failure is the explicit throw. Replace with a lazy proxy that
preserves the exact `import { db, closeDb } from '../db'` API and the
fail-fast error message (now thrown on first USE instead of import):

```ts
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

type Db = ReturnType<typeof drizzle<typeof schema>>;

let queryClient: ReturnType<typeof postgres> | null = null;
let realDb: Db | null = null;

function initDb(): Db {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is not set');
  }
  queryClient = postgres(connectionString, {
    max: 20,                // Maximum connections in pool
    idle_timeout: 20,       // Close idle connections after 20s
    connect_timeout: 10,    // Fail connection attempt after 10s
  });
  return drizzle(queryClient, { schema });
}

// Lazy: created on first property access so importing this module never
// requires DATABASE_URL (unit tests import consumers without a DB).
export const db: Db = new Proxy({} as Db, {
  get(_target, prop) {
    realDb ??= initDb();
    const value = Reflect.get(realDb as object, prop);
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(realDb) : value;
  },
});

export async function closeDb(): Promise<void> {
  if (queryClient) {
    await queryClient.end();
    queryClient = null;
    realDb = null;
  }
}

export * from './schema';
```

Commit this step on its own (e.g. `fix(api): lazy database init so imports don't require DATABASE_URL`).

**Verify** (all three):
1. `pnpm --filter api exec tsc --noEmit` → exit 0.
2. No-DB import works: `cd apps/api && node -e "import('./src/middleware/auth.ts')" 2>/dev/null || pnpm --filter api exec tsx -e "import { hashToken } from './src/middleware/auth'; console.log(hashToken('x').length)"` → prints `64` with `DATABASE_URL` unset.
3. Fail-fast preserved: `pnpm --filter api exec tsx -e "import { db } from './src/db'; (db as any).select()"` with `DATABASE_URL` unset → throws `DATABASE_URL environment variable is not set`.

### Step 1: Extract the pure aggregation from `analyzeFlakiness`

In `apps/api/src/services/flakiness.ts`, move the in-memory aggregation
(current lines 67–137: the `testStats` Map build + the flakiness computation
+ sort) into a new exported pure function:

```ts
export interface ResultRow {
  testName: string;
  testFile: string | null;
  status: string;
  createdAt: Date;
}

export function computeFlakiness(
  results: ResultRow[],
  config: FlakinessConfig
): TestFlakiness[] { /* moved code, unchanged logic */ }
```

`analyzeFlakiness` becomes: resolve config → run the existing DB query →
`return computeFlakiness(results, { windowDays, flakeThreshold, minRuns })`.
Behavior must be byte-identical; this is an extract-function refactor only.

**Verify**: `pnpm --filter api exec tsc --noEmit` → exit 0.

### Step 2: Rewrite `flakiness.test.ts` against the real import

Delete the local `calculateFlakiness` copy entirely. Import
`{ computeFlakiness }` from `./flakiness` and port the existing assertions to
it (same cases: below threshold not flaky, above threshold flaky, minRuns
gate, empty input). Add cases the copy never covered:

- mixed statuses accumulate correctly (passed/failed/flaky counts per name);
- `lastSeen` is the max `createdAt` per test;
- results sorted by `flakeRate` descending;
- a test with ONLY failed runs (never passed) still counts toward flakiness
  (documented formula `(failed + flaky) / total` — assert, don't "fix").

**Verify**: `pnpm --filter api test` → flakiness suite passes without a DB; `grep -n "function calculateFlakiness" apps/api/src/services/flakiness.test.ts` → no matches.

### Step 3: Rewrite `auth.test.ts` against the real exports

Import `{ hashToken, generateToken }` from `../middleware/auth` (they hit the
db module transitively via imports — if importing pulls in `db/index.ts` and
that throws without `DATABASE_URL`, see STOP conditions). Keep the existing
assertions (determinism, distinctness, 64-hex output, `flackyness_` prefix).
Add middleware-shape tests that need no DB, using a minimal Hono app:

```ts
import { Hono } from 'hono';
import { adminAuth } from '../middleware/auth';

const app = new Hono();
app.use('/admin/*', adminAuth());
app.get('/admin/ping', (c) => c.json({ ok: true }));
```

Cases: no `Authorization` header → 401; malformed header (`Basic x`,
`Bearer`) → 401; wrong token with `ADMIN_TOKEN` set (use
`vi.stubEnv('ADMIN_TOKEN', 'right-token')`) → 401; correct token → 200;
`ADMIN_TOKEN` unset (`vi.stubEnv` to '') → 500. `projectAuth`'s no-header /
malformed-header 401s can be tested the same way (they throw before any DB
call); its token-lookup path is already covered by the route integration
suites.

**Verify**: `pnpm --filter api test` → auth suite passes without a DB; `grep -n "Re-implement" apps/api/src/middleware/auth.test.ts` → no matches.

### Step 4: Integration tests for `updateFlakyTests` (DB-gated)

Append to `flakiness.test.ts` a `describeWithDb('updateFlakyTests', ...)`
block using the standard gating pattern from "Current state". Setup: create a
project via the admin API (model on `reports.test.ts:17-35`) or insert rows
directly with drizzle (`db.insert(projects)...`) — direct inserts are fine
here since this tests the service, not the routes. For each case, seed
`test_runs` + `test_results` rows shaped to produce the scenario, call
`updateFlakyTests(projectId)`, then read `flaky_tests` and assert:

1. New flaky test → row created, `status='active'`, `firstDetected` set,
   correct `flakeCount`/`totalRuns`/`flakeRate`.
2. Second call with same data → `firstDetected` unchanged (conflict path
   preserves it), stats updated.
3. Test goes below threshold on new data → row flips to `'resolved'`,
   return value counts it in `resolved`.
4. Test disappears from results entirely → active row flips to `'resolved'`.
5. Row manually set to `'ignored'` + still-flaky data → CURRENT behavior:
   row comes back `'active'` (comment: plan 006 changes this).

Cleanup: `afterAll` deletes the created project (FK cascades remove children —
`schema.ts` has `onDelete: 'cascade'` on all child FKs).

**Verify**: with DB env set, `pnpm --filter api test` → the 5 cases pass; without DB env, suite is skipped (not failed).

### Step 5: Fix `projects.test.ts` setup and silent passes

- In `beforeAll`, create a dedicated project via the admin API (same pattern
  as `reports.test.ts:17-35`, name `projects-test-${Date.now()}`) and store
  `testProjectId` from the response.
- Remove every `if (!testProjectId) return;` guard — replace with real
  assertions (the id now always exists).
- Drop the assignment of `testProjectId` inside the list test; keep the list
  test asserting shape only.
- Add `afterAll`: `DELETE /api/v1/admin/projects/:id` for the created project.

**Verify**: `grep -n "if (!testProjectId) return" apps/api/src/routes/projects.test.ts` → no matches; with DB env, suite passes.

### Step 6: Add cleanup to `reports.test.ts`

Capture the created project's `id` in `beforeAll` (the admin create response
includes it) and add `afterAll` calling
`DELETE /api/v1/admin/projects/:id` with the admin token. Assert the delete
returns 200 so cleanup failures are visible.

**Verify**: with DB env, run the suite twice in a row; the second run passes and `psql`-level row counts don't grow (spot-check optional).

### Step 7: Create `apps/api/src/routes/tests.test.ts`

CORRECTION to "Current state": `projects.test.ts` already contains an
embedded `describeWithDb('Tests API Integration Tests', ...)` block covering
parts of `GET /:testName/history` and `GET /flaky/:id`. MOVE that block out of
`projects.test.ts` into the new dedicated `tests.test.ts` (don't duplicate
it), then extend to the full case list below.

Same gating pattern. Setup: create a project, upload
`fixtures/sample-report.json` via `POST /api/v1/reports?commit=abc123` with
the project token (exactly like `reports.test.ts` does). Cases:

- `GET /api/v1/tests/:testName/history?project=<id>` for a test name present
  in the fixture (URL-encode with `encodeURIComponent`) → 200; body has
  `testName`, `stats.totalRuns >= 1`, `history` array with `branch`/`commitSha`.
- Missing `project` param → 400.
- Non-UUID `project` → 400.
- Unknown test name → 200 with empty `history` and `stats.totalRuns === 0`
  (that is the current behavior — assert it).
- `GET /api/v1/tests/flaky/<random-uuid>` → 404; malformed id → 400.

`afterAll`: delete the project via the admin API.

**Verify**: with DB env, new suite passes; without, it skips.

## Test plan

This plan IS the test plan. Final gates: `pnpm --filter api test` green
without DB (unit) and with DB (integration; locally or in CI), `pnpm lint`,
`pnpm --filter api exec tsc --noEmit`.

## Done criteria

ALL must hold:

- [ ] `grep -rn "Re-implement\|function calculateFlakiness\|function hashToken" apps/api/src/**/*.test.ts` → no matches
- [ ] `flakiness.test.ts` imports `computeFlakiness` from `./flakiness`; `auth.test.ts` imports from `../middleware/auth`
- [ ] `apps/api/src/routes/tests.test.ts` exists with the Step 7 cases
- [ ] `pnpm --filter api test` exits 0 without DB env (integration suites skipped, unit suites run)
- [ ] With DB env set: `pnpm --filter api test` exits 0 with no skipped route suites
- [ ] `pnpm --filter api exec tsc --noEmit` and `pnpm lint` exit 0
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- After Step 0, DB-backed tests fail with proxy-related errors (`this`
  binding, `instanceof`, or private-field access inside drizzle) — the lazy
  proxy approach conflicts with the installed drizzle version; report the
  exact error rather than patching drizzle usage call-site by call-site.
- The Step 1 extraction cannot be behavior-identical (e.g. hidden coupling to
  the query's row shape).
- Any Step 4 assertion about CURRENT `updateFlakyTests` behavior fails — that
  means the semantics in this plan are wrong; report, don't adjust the code.
- Admin API create/delete used for fixtures doesn't behave as documented
  (e.g. delete not returning 200).

## Maintenance notes

- Plan 006 (flakiness refactor) relies on Step 4's suite as its regression
  net and will UPDATE case 5 (`ignored` preservation) to the new behavior.
- Reviewers: check that no test re-copies production logic — that is the
  anti-pattern this plan removes; it must not creep back.
- Deferred: `getProjectStats` coverage (straightforward, low-risk read
  aggregation) and `api.test.ts`/`admin.test.ts` hygiene beyond what's listed
  — they already create-and-assert reasonably; revisit if they flake.
