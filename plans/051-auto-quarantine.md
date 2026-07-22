# Auto-quarantine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in, per-project automatic quarantine: a flaky test crossing a stricter threshold auto-mutes (skipped in CI) with a mandatory TTL and entry/exit notifications, then auto-releases with a clean slate.

**Architecture:** A new `services/quarantine.ts` engine runs *after* the existing `updateFlakyTests` reconcile, operating on the just-reconciled `flaky_tests` rows. It automatically promotes qualifying `active` tests into the existing `ignored` (muted) state — so `buildGrepInvert()` and the `projects.ts:191-193` invariant are unchanged; we only add a machine writer of `ignored`. Default-off per project ⇒ zero behavior change until opted in.

**Tech Stack:** TypeScript 7 (`apps/api`), Hono, Drizzle + Postgres, Zod, Vitest, drizzle-kit.
Spec: `docs/superpowers/specs/2026-07-22-auto-quarantine-design.md`.

## Global Constraints

- **Default-off = zero change.** `projects.auto_quarantine_enabled` defaults **false**; the engine's Promote phase must never run for a non-opted-in project. `buildGrepInvert()` and the load-bearing comment at `routes/projects.ts:191-193` (`grepInvert` from `muted`/`ignored` only) stay unchanged — auto-quarantine writes the `ignored` status, it does NOT add `active`/`flaky` to `grepInvert`.
- **Migration is additive + nullable/defaulted.** Existing rows/installs untouched; every pre-existing `ignored` row has `mute_source = NULL` and must be treated as an indefinite manual mute (never auto-released).
- **The reconcile race is real** (AGENTS.md): any test that reads `flaky_tests`/quarantine state after an ingest must **poll**, never `sleep`.
- **Trigger bar:** `quarantine_threshold` (default **0.20**) must be **≥ resolved `flakeThreshold`** (default 0.05). `quarantine_min_runs` default = resolved `minRuns` (3), `≥ 1`. `quarantine_ttl_days` default **7**, `1 ≤ n ≤ 365`.
- **Clean slate:** a released test (`quarantine_released_at` set) re-quarantines only when it has `≥ quarantine_min_runs` `test_results` recorded **after** `quarantine_released_at`. A never-released candidate uses its stored `total_runs ≥ quarantine_min_runs`.
- **Manual precedence:** `mute_source='manual'` (and legacy `NULL`) rows are never auto-released. Auto-release/promote only touch `mute_source='auto'`.
- Structured logger (`middleware/logger.ts`), never `console.log`. zod-validate every input; Drizzle query builder only (no raw SQL with input — parameterized `sql` fragments for set-expressions are fine, matching the existing upsert). New `projects` child table uses `onDelete: 'cascade'`. New endpoints/config update `docs/API.md`, add a route test, apply rate limiting; any new **read** endpoint mounts `readAuth()` and bumps the route-count guard deliberately.
- DB-backed tests use a **disposable Postgres via `docker run`** (never `docker compose`); `docker rm -f` on exit. Prefix every `pnpm` with `rtk proxy` (the RTK hook garbles pnpm stdout). Follow the existing `describeWithDb` pattern in `apps/api/src/services/flakiness.test.ts` (self-skips without `DATABASE_URL`).
- Commits: single-line conventional subject, **NO `Co-Authored-By`**, never `--no-verify`. `main` branch-protected — PR needs green CI + explicit user approval.

---

### Task 1: Schema + migration (config columns, provenance columns, audit table)

**Files:**
- Modify: `apps/api/src/db/schema.ts` (projects +4 cols, flaky_tests +3 cols, new `quarantineEvents` table + type exports)
- Generate: `apps/api/drizzle/0008_*.sql` (via `drizzle-kit generate`)
- Test: `apps/api/src/db/quarantine-schema.test.ts`

**Interfaces:**
- Produces: `projects.autoQuarantineEnabled/quarantineThreshold/quarantineMinRuns/quarantineTtlDays`; `flakyTests.muteSource/quarantineExpiresAt/quarantineReleasedAt`; `quarantineEvents` table + `QuarantineEvent`/`NewQuarantineEvent` types.

- [ ] **Step 1: Extend `schema.ts`.** In the `projects` table object, after `retentionDays`, add:

```ts
  // Auto-quarantine (opt-in per project; default off = current behavior).
  // See plan 051 / docs/superpowers/specs/2026-07-22-auto-quarantine-design.md.
  autoQuarantineEnabled: boolean('auto_quarantine_enabled').notNull().default(false),
  // Stricter-than-detection flake rate to auto-quarantine; NULL = default 0.20.
  // Must be >= the resolved flakeThreshold (validated in routes/admin.ts).
  quarantineThreshold: decimal('quarantine_threshold', { precision: 5, scale: 4 }),
  // Min runs before (re-)quarantine; NULL = resolved minRuns.
  quarantineMinRuns: integer('quarantine_min_runs'),
  // Mandatory TTL of an auto-quarantine, in days; NULL = default 7.
  quarantineTtlDays: integer('quarantine_ttl_days'),
```

In the `flakyTests` table object, after `status`, add:

```ts
  // Mute provenance: 'manual' | 'auto' | NULL. Only meaningful while
  // status='ignored'. NULL on a legacy muted row = indefinite manual mute
  // (never auto-released). See plan 051.
  muteSource: varchar('mute_source', { length: 10 }),
  // Auto-quarantine TTL expiry; set for mute_source='auto', NULL otherwise.
  quarantineExpiresAt: timestamp('quarantine_expires_at'),
  // When this test last exited quarantine (auto-release OR manual unmute);
  // anchors the clean-slate rule (fresh runs must post-date it).
  quarantineReleasedAt: timestamp('quarantine_released_at'),
```

Add `boolean` to the `drizzle-orm/pg-core` import at the top of the file (it currently imports `pgTable, uuid, varchar, timestamp, integer, text, decimal, index, uniqueIndex, jsonb` — add `boolean`).

After the `flakyTests` table (before the type-export block), add the audit table:

```ts
// Append-only audit of every quarantine transition (auto + manual) — the
// "traçabilité du mute" (plan 051). No UI in #2; feeds #4's audit view.
export const quarantineEvents = pgTable('quarantine_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }).notNull(),
  testName: varchar('test_name', { length: 500 }).notNull(),
  event: varchar('event', { length: 20 }).notNull(), // entered | released | manual_mute | manual_unmute
  source: varchar('source', { length: 10 }).notNull(), // auto | manual
  flakeRate: decimal('flake_rate', { precision: 5, scale: 4 }),
  threshold: decimal('threshold', { precision: 5, scale: 4 }),
  ttlDays: integer('ttl_days'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  projectCreatedIdx: index('quarantine_events_project_created_idx')
    .on(table.projectId, table.createdAt),
}));
```

In the type-export block, after the `FlakyTest` exports, add:

```ts
export type QuarantineEvent = typeof quarantineEvents.$inferSelect;
export type NewQuarantineEvent = typeof quarantineEvents.$inferInsert;
```

- [ ] **Step 2: Re-export the new table from the db barrel if needed.** Confirm `apps/api/src/db/index.ts` re-exports schema (`export * from './schema'` or a named list). If it uses a named list, add `quarantineEvents` and the new types so `import { quarantineEvents } from '../db'` resolves. Run: `grep -n "quarantineEvents\|export \*\|flakyTests" apps/api/src/db/index.ts`.

- [ ] **Step 3: Generate the migration.**

Run: `rtk proxy pnpm --filter api db:generate`
Expected: a new `apps/api/drizzle/0008_*.sql` plus updated `drizzle/meta/`. Open the generated SQL and confirm it (a) `ALTER TABLE projects ADD COLUMN ... auto_quarantine_enabled boolean not null default false` etc., (b) `ALTER TABLE flaky_tests ADD COLUMN mute_source/quarantine_expires_at/quarantine_released_at`, (c) `CREATE TABLE quarantine_events (...)` with the FK + index. No `DROP`/`ALTER` on existing columns.

- [ ] **Step 4: Write the failing schema test `apps/api/src/db/quarantine-schema.test.ts`** (follow the `describeWithDb` self-skip pattern from `services/flakiness.test.ts`):

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { db, projects, flakyTests, quarantineEvents } from '../db';
import { eq } from 'drizzle-orm';

const hasDb = !!process.env.DATABASE_URL;
const describeWithDb = hasDb ? describe : describe.skip;

describeWithDb('quarantine schema (migration 0008)', () => {
  const createdProjectIds: string[] = [];
  afterAll(async () => {
    for (const id of createdProjectIds) await db.delete(projects).where(eq(projects.id, id));
  });

  it('defaults auto_quarantine_enabled to false and quarantine overrides to null', async () => {
    const [p] = await db.insert(projects).values({ name: `q-schema-${Date.now()}-${Math.random()}`, tokenHash: 'x'.repeat(64) }).returning();
    createdProjectIds.push(p.id);
    expect(p.autoQuarantineEnabled).toBe(false);
    expect(p.quarantineThreshold).toBeNull();
    expect(p.quarantineMinRuns).toBeNull();
    expect(p.quarantineTtlDays).toBeNull();
  });

  it('accepts flaky_tests mute-provenance columns and a quarantine_events audit row', async () => {
    const [p] = await db.insert(projects).values({ name: `q-schema-${Date.now()}-${Math.random()}`, tokenHash: 'y'.repeat(64) }).returning();
    createdProjectIds.push(p.id);
    const expires = new Date(Date.now() + 86_400_000);
    const [ft] = await db.insert(flakyTests).values({
      projectId: p.id, testName: 't', status: 'ignored', muteSource: 'auto', quarantineExpiresAt: expires,
    }).returning();
    expect(ft.muteSource).toBe('auto');
    expect(ft.quarantineExpiresAt?.getTime()).toBe(expires.getTime());

    const [ev] = await db.insert(quarantineEvents).values({
      projectId: p.id, testName: 't', event: 'entered', source: 'auto', flakeRate: '0.5000', threshold: '0.2000', ttlDays: 7,
    }).returning();
    expect(ev.event).toBe('entered');

    // Cascade: deleting the project removes its events.
    await db.delete(projects).where(eq(projects.id, p.id));
    createdProjectIds.pop();
    const remaining = await db.select().from(quarantineEvents).where(eq(quarantineEvents.projectId, p.id));
    expect(remaining).toHaveLength(0);
  });
});
```

- [ ] **Step 5: Run migrate + the test against a disposable Postgres.**

```bash
docker run -d --name pg-051 -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=flackyness -p 55432:5432 postgres:17
# poll: until `docker exec pg-051 psql -U postgres -d flackyness -tAc 'SELECT 1'` succeeds (no blind sleep)
export DATABASE_URL="postgres://postgres:pw@localhost:55432/flackyness"; export ADMIN_TOKEN="test-admin-token"; touch .env
rtk proxy pnpm db:migrate
rtk proxy pnpm --filter api exec vitest run src/db/quarantine-schema.test.ts
docker rm -f pg-051
```
Expected: migrate applies through 0008; both tests pass. Tear down `pg-051` even on failure.

- [ ] **Step 6: Typecheck + lint + commit.**

Run: `rtk proxy pnpm --filter api exec tsc --noEmit && rtk proxy pnpm lint`
```bash
git add apps/api/src/db/schema.ts apps/api/drizzle/ apps/api/src/db/quarantine-schema.test.ts apps/api/src/db/index.ts
git commit -m "feat(quarantine): schema + migration for auto-quarantine config and audit"
```

---

### Task 2: Quarantine config resolution + admin PATCH validation

**Files:**
- Modify: `apps/api/src/services/quarantine.ts` (new — add `resolveQuarantineConfig` + defaults here so the engine task builds on it)
- Modify: `apps/api/src/routes/admin.ts` (extend the PATCH schema + validation + persistence)
- Modify: `docs/API.md` (document the 4 new config fields)
- Test: `apps/api/src/routes/admin.test.ts` (extend), `apps/api/src/services/quarantine.test.ts` (new — config resolution unit tests)

**Interfaces:**
- Consumes: `resolveProjectConfig` (`services/flakiness.ts`) for the `flakeThreshold` floor.
- Produces:
  - `interface QuarantineConfig { enabled: boolean; threshold: number; minRuns: number; ttlDays: number }`
  - `const DEFAULT_QUARANTINE = { threshold: 0.2, ttlDays: 7 }` (minRuns default derives from flakiness minRuns)
  - `function resolveQuarantineConfig(project): QuarantineConfig`

- [ ] **Step 1: Create `apps/api/src/services/quarantine.ts` with config resolution (failing import target for the test).**

```ts
import { resolveProjectConfig, type ProjectFlakinessOverrides } from './flakiness';

export interface QuarantineConfig {
  enabled: boolean;
  threshold: number;
  minRuns: number;
  ttlDays: number;
}

export const DEFAULT_QUARANTINE = { threshold: 0.2, ttlDays: 7 } as const;

/** Fields of a projects row this module reads. */
export interface ProjectQuarantineOverrides extends ProjectFlakinessOverrides {
  autoQuarantineEnabled: boolean;
  quarantineThreshold: string | null; // drizzle decimal -> string
  quarantineMinRuns: number | null;
  quarantineTtlDays: number | null;
}

/** Merge stored overrides (NULL = unset) over defaults. minRuns falls back to
 *  the resolved flakiness minRuns; threshold/ttl to the quarantine defaults. */
export function resolveQuarantineConfig(project: ProjectQuarantineOverrides): QuarantineConfig {
  const flakiness = resolveProjectConfig(project);
  return {
    enabled: project.autoQuarantineEnabled,
    threshold:
      project.quarantineThreshold !== null ? Number(project.quarantineThreshold) : DEFAULT_QUARANTINE.threshold,
    minRuns: project.quarantineMinRuns ?? flakiness.minRuns,
    ttlDays: project.quarantineTtlDays ?? DEFAULT_QUARANTINE.ttlDays,
  };
}
```

- [ ] **Step 2: Write failing unit tests `apps/api/src/services/quarantine.test.ts`** (pure, DB-free):

```ts
import { describe, it, expect } from 'vitest';
import { resolveQuarantineConfig, DEFAULT_QUARANTINE } from './quarantine';

const base = {
  flakeThreshold: null, windowDays: null, minRuns: null,
  autoQuarantineEnabled: false, quarantineThreshold: null, quarantineMinRuns: null, quarantineTtlDays: null,
};

describe('resolveQuarantineConfig', () => {
  it('uses defaults when all overrides are null', () => {
    expect(resolveQuarantineConfig(base)).toEqual({ enabled: false, threshold: DEFAULT_QUARANTINE.threshold, minRuns: 3, ttlDays: DEFAULT_QUARANTINE.ttlDays });
  });
  it('reads stored overrides', () => {
    expect(resolveQuarantineConfig({ ...base, autoQuarantineEnabled: true, quarantineThreshold: '0.3500', quarantineMinRuns: 5, quarantineTtlDays: 14 }))
      .toEqual({ enabled: true, threshold: 0.35, minRuns: 5, ttlDays: 14 });
  });
  it('defaults minRuns to the resolved flakiness minRuns', () => {
    expect(resolveQuarantineConfig({ ...base, minRuns: 8 }).minRuns).toBe(8);
  });
});
```

- [ ] **Step 3: Run — expect PASS** (module + tests are consistent):

Run: `rtk proxy pnpm --filter api exec vitest run src/services/quarantine.test.ts`
Expected: 3 passing.

- [ ] **Step 4: Extend the admin PATCH in `apps/api/src/routes/admin.ts`.** Add the four fields to the update zod schema (near `flakeThreshold`/`windowDays`/`minRuns`, before the `.refine` no-empty check):

```ts
    autoQuarantineEnabled: z.boolean().optional(),
    quarantineThreshold: z.number().min(0).max(1).nullable().optional(),
    quarantineMinRuns: z.number().int().min(1).max(100).nullable().optional(),
    quarantineTtlDays: z.number().int().min(1).max(365).nullable().optional(),
```

After the existing retention/window cross-field validation, add the threshold-floor check (a quarantine bar below the detection bar is nonsensical):

```ts
    // quarantine_threshold must be >= the RESOLVED flakeThreshold (this request's
    // flakeThreshold if it sets one, else the stored/default value).
    if (typeof data.quarantineThreshold === 'number') {
      const effectiveFlakeThreshold =
        'flakeThreshold' in data && data.flakeThreshold != null
          ? data.flakeThreshold
          : resolveProjectConfig(existing).flakeThreshold;
      if (data.quarantineThreshold < effectiveFlakeThreshold) {
        return c.json({
          error: `quarantineThreshold (${data.quarantineThreshold}) must be >= the flakeThreshold (${effectiveFlakeThreshold})`,
        }, 400);
      }
    }
```

In the `updates` assembly (where `flakeThreshold`/`windowDays` are mapped), add the four fields — decimal via `.toFixed(4)`, the rest passed through, `'field' in data` guarding each so an omitted field is untouched and an explicit `null` clears to default:

```ts
    if ('autoQuarantineEnabled' in data) updates.autoQuarantineEnabled = data.autoQuarantineEnabled;
    if ('quarantineThreshold' in data)
      updates.quarantineThreshold =
        data.quarantineThreshold == null ? null : data.quarantineThreshold.toFixed(4);
    if ('quarantineMinRuns' in data) updates.quarantineMinRuns = data.quarantineMinRuns ?? null;
    if ('quarantineTtlDays' in data) updates.quarantineTtlDays = data.quarantineTtlDays ?? null;
```

Also add the four fields to the SELECT and the response mapping (mirroring how `flakeThreshold` etc. are returned) so a GET/PATCH echoes them.

- [ ] **Step 5: Add failing admin route tests** in `apps/api/src/routes/admin.test.ts` (follow the existing config-PATCH describe block; DB-backed, self-skips without env):

```ts
    it('persists auto-quarantine config and echoes it back', async () => {
      const res = await app.request(`/api/v1/admin/projects/${projectId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoQuarantineEnabled: true, quarantineThreshold: 0.25, quarantineMinRuns: 5, quarantineTtlDays: 10 }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.project.autoQuarantineEnabled).toBe(true);
      expect(Number(body.project.quarantineThreshold)).toBeCloseTo(0.25, 4);
      expect(body.project.quarantineMinRuns).toBe(5);
      expect(body.project.quarantineTtlDays).toBe(10);
    });

    it('rejects a quarantineThreshold below the flakeThreshold', async () => {
      const res = await app.request(`/api/v1/admin/projects/${projectId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ flakeThreshold: 0.1, quarantineThreshold: 0.05 }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/must be >= the flakeThreshold/);
    });

    it('rejects an out-of-range quarantineTtlDays', async () => {
      const res = await app.request(`/api/v1/admin/projects/${projectId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ quarantineTtlDays: 0 }),
      });
      expect(res.status).toBe(400);
    });
```

- [ ] **Step 6: Update `docs/API.md`** — in the admin project-config PATCH section, document `autoQuarantineEnabled` (bool, default false), `quarantineThreshold` (0-1, default 0.20, must be ≥ flakeThreshold), `quarantineMinRuns` (int ≥1, default = minRuns), `quarantineTtlDays` (int 1-365, default 7). Match the surrounding field-table style.

- [ ] **Step 7: Verify (disposable Postgres for admin.test.ts) + lint + commit.**

```bash
# with pg-051 up + DATABASE_URL/ADMIN_TOKEN exported + migrated (see Task 1 Step 5):
rtk proxy pnpm --filter api exec vitest run src/services/quarantine.test.ts src/routes/admin.test.ts
rtk proxy pnpm --filter api exec tsc --noEmit && rtk proxy pnpm lint
git add apps/api/src/services/quarantine.ts apps/api/src/services/quarantine.test.ts apps/api/src/routes/admin.ts apps/api/src/routes/admin.test.ts docs/API.md
git commit -m "feat(quarantine): admin config fields + threshold-floor validation"
```

---

### Task 3: The quarantine engine (release + promote)

**Files:**
- Modify: `apps/api/src/services/quarantine.ts` (add `reconcileQuarantine`)
- Test: `apps/api/src/services/quarantine.engine.test.ts` (new, DB-backed)

**Interfaces:**
- Consumes: `db`, `flakyTests`, `testResults`, `testRuns`, `quarantineEvents` (`../db`); `resolveQuarantineConfig`, `QuarantineConfig` (this module).
- Produces:
  - `interface QuarantineTransition { testName: string; event: 'entered' | 'released'; flakeRate: number | null; expiresAt: Date | null }`
  - `async function reconcileQuarantine(projectId: string, project: ProjectQuarantineOverrides): Promise<QuarantineTransition[]>` — runs Release then Promote on the current `flaky_tests` rows, writes `quarantine_events`, returns the transitions (for the caller to notify on). Does NOT send webhooks itself (Task 4 wires notifications) — keeps this unit pure of network I/O and easy to test.

- [ ] **Step 1: Write failing DB-backed tests `apps/api/src/services/quarantine.engine.test.ts`** (follow `flakiness.test.ts`'s `describeWithDb` + module-scope helpers; seed `flaky_tests`/`test_results` directly). Cover every constraint:

```ts
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { db, projects, testRuns, testResults, flakyTests, quarantineEvents } from '../db';
import { eq, and } from 'drizzle-orm';
import { reconcileQuarantine } from './quarantine';

const hasDb = !!process.env.DATABASE_URL;
const describeWithDb = hasDb ? describe : describe.skip;

describeWithDb('reconcileQuarantine', () => {
  let projectId: string;
  const enabled = { autoQuarantineEnabled: true, quarantineThreshold: '0.2000', quarantineMinRuns: 3, quarantineTtlDays: 7, flakeThreshold: null, windowDays: null, minRuns: null };

  const seedFlaky = (over: Partial<typeof flakyTests.$inferInsert>) =>
    db.insert(flakyTests).values({ projectId, testName: 't', status: 'active', flakeRate: '0.5000', totalRuns: 10, ...over }).returning().then(r => r[0]);
  // Insert `n` test_results for `name` at `when` (via a throwaway run).
  const seedRuns = async (name: string, n: number, when: Date) => {
    const [run] = await db.insert(testRuns).values({ projectId, branch: 'main', commitSha: 'a'.repeat(40), createdAt: when }).returning();
    await db.insert(testResults).values(Array.from({ length: n }, () => ({ testRunId: run.id, testName: name, status: 'failed' as const, createdAt: when })));
  };
  const project = (over = {}) => ({ ...enabled, ...over });

  beforeEach(async () => {
    const [p] = await db.insert(projects).values({ name: `q-eng-${Date.now()}-${Math.random()}`, tokenHash: 'z'.repeat(64) }).returning();
    projectId = p.id;
  });
  afterAll(async () => { /* delete all projects created here by name prefix or track ids */ });

  it('promotes an active test at/above the quarantine threshold when enabled', async () => {
    await seedFlaky({ flakeRate: '0.5000', totalRuns: 10 });
    const out = await reconcileQuarantine(projectId, project());
    expect(out).toEqual([expect.objectContaining({ testName: 't', event: 'entered' })]);
    const [row] = await db.select().from(flakyTests).where(eq(flakyTests.projectId, projectId));
    expect(row.status).toBe('ignored');
    expect(row.muteSource).toBe('auto');
    expect(row.quarantineExpiresAt).not.toBeNull();
    const events = await db.select().from(quarantineEvents).where(eq(quarantineEvents.projectId, projectId));
    expect(events.map(e => e.event)).toEqual(['entered']);
  });

  it('does NOT promote when the project is not opted in (default-off)', async () => {
    await seedFlaky({ flakeRate: '0.9000' });
    const out = await reconcileQuarantine(projectId, project({ autoQuarantineEnabled: false }));
    expect(out).toEqual([]);
    const [row] = await db.select().from(flakyTests).where(eq(flakyTests.projectId, projectId));
    expect(row.status).toBe('active');
  });

  it('leaves a test in the reported-only band (flake<quarantineThreshold) active', async () => {
    await seedFlaky({ flakeRate: '0.1000' }); // above 0.05 detect, below 0.20 quarantine
    const out = await reconcileQuarantine(projectId, project());
    expect(out).toEqual([]);
    expect((await db.select().from(flakyTests).where(eq(flakyTests.projectId, projectId)))[0].status).toBe('active');
  });

  it('releases an auto-mute past its TTL, back to active with released_at set', async () => {
    await seedFlaky({ status: 'ignored', muteSource: 'auto', quarantineExpiresAt: new Date(Date.now() - 1000), flakeRate: '0.5000' });
    const out = await reconcileQuarantine(projectId, project());
    expect(out).toEqual([expect.objectContaining({ testName: 't', event: 'released' })]);
    const [row] = await db.select().from(flakyTests).where(eq(flakyTests.projectId, projectId));
    expect(row.status).toBe('active');
    expect(row.muteSource).toBeNull();
    expect(row.quarantineExpiresAt).toBeNull();
    expect(row.quarantineReleasedAt).not.toBeNull();
  });

  it('clean slate: a just-released test is NOT re-quarantined until it has quarantineMinRuns fresh runs', async () => {
    const released = new Date();
    await seedFlaky({ status: 'active', flakeRate: '0.9000', totalRuns: 20, quarantineReleasedAt: released });
    // 2 fresh runs (< minRuns 3) after release
    await seedRuns('t', 2, new Date(released.getTime() + 1000));
    const out = await reconcileQuarantine(projectId, project());
    expect(out).toEqual([]); // still high flakeRate, but not enough fresh runs
    expect((await db.select().from(flakyTests).where(eq(flakyTests.projectId, projectId)))[0].status).toBe('active');

    // one more fresh run -> 3 >= minRuns -> re-quarantines
    await seedRuns('t', 1, new Date(released.getTime() + 2000));
    const out2 = await reconcileQuarantine(projectId, project());
    expect(out2).toEqual([expect.objectContaining({ event: 'entered' })]);
  });

  it('never auto-releases a manual mute (mute_source manual or NULL)', async () => {
    await seedFlaky({ status: 'ignored', muteSource: 'manual', quarantineExpiresAt: new Date(Date.now() - 1000) });
    const legacy = await seedFlaky({ testName: 't2', status: 'ignored', muteSource: null });
    const out = await reconcileQuarantine(projectId, project());
    expect(out).toEqual([]);
    const rows = await db.select().from(flakyTests).where(eq(flakyTests.projectId, projectId));
    expect(rows.every(r => r.status === 'ignored')).toBe(true);
  });
});
```
(Track created project ids in an array and delete them in `afterAll`, mirroring `flakiness.test.ts`. Adjust `seedFlaky` for the multi-row test to use distinct `testName`s.)

- [ ] **Step 2: Run — expect FAIL** (`reconcileQuarantine` not implemented).

Run: `rtk proxy pnpm --filter api exec vitest run src/services/quarantine.engine.test.ts` (with pg-051 + env). Expected: FAIL (not a function / import error).

- [ ] **Step 3: Implement `reconcileQuarantine` in `services/quarantine.ts`:**

```ts
import { and, eq, lt, gt, sql } from 'drizzle-orm';
import { db, flakyTests, testResults, testRuns, quarantineEvents } from '../db';

export interface QuarantineTransition {
  testName: string;
  event: 'entered' | 'released';
  flakeRate: number | null;
  expiresAt: Date | null;
}

/**
 * Release expired auto-mutes, then promote qualifying active tests, operating
 * on the already-reconciled flaky_tests rows. Writes quarantine_events and
 * returns the transitions for the caller to notify on. No network I/O here.
 */
export async function reconcileQuarantine(
  projectId: string,
  project: ProjectQuarantineOverrides
): Promise<QuarantineTransition[]> {
  const cfg = resolveQuarantineConfig(project);
  const now = new Date();
  const transitions: QuarantineTransition[] = [];

  // Phase 1: RELEASE expired auto-mutes (runs even if disabled — nothing stays
  // stuck skipped). Manual/NULL mute_source is never touched.
  const released = await db
    .update(flakyTests)
    .set({ status: 'active', muteSource: null, quarantineExpiresAt: null, quarantineReleasedAt: now })
    .where(and(
      eq(flakyTests.projectId, projectId),
      eq(flakyTests.status, 'ignored'),
      eq(flakyTests.muteSource, 'auto'),
      lt(flakyTests.quarantineExpiresAt, now),
    ))
    .returning({ testName: flakyTests.testName, flakeRate: flakyTests.flakeRate });

  for (const r of released) {
    transitions.push({ testName: r.testName, event: 'released', flakeRate: r.flakeRate ? Number(r.flakeRate) : null, expiresAt: null });
  }

  // Phase 2 (DETECT) already ran in updateFlakyTests before this call.

  // Phase 3: PROMOTE — only when enabled.
  if (cfg.enabled) {
    // Fetch active rows and compare the (numeric) flakeRate in JS — avoids a
    // Postgres `numeric >= text` operator-resolution pitfall and matches the
    // codebase's compute-in-JS idiom. Active flaky rows are bounded per project.
    const activeRows = await db
      .select()
      .from(flakyTests)
      .where(and(
        eq(flakyTests.projectId, projectId),
        eq(flakyTests.status, 'active'),
      ));
    const candidates = activeRows.filter((r) => Number(r.flakeRate ?? 0) >= cfg.threshold);

    for (const cand of candidates) {
      // Clean slate: if released before, require >= minRuns fresh runs after release.
      if (cand.quarantineReleasedAt) {
        const [{ count }] = await db
          .select({ count: sql<number>`count(*)` })
          .from(testResults)
          .innerJoin(testRuns, eq(testResults.testRunId, testRuns.id))
          .where(and(
            eq(testRuns.projectId, projectId),
            eq(testResults.testName, cand.testName),
            gt(testResults.createdAt, cand.quarantineReleasedAt),
          ));
        if (Number(count) < cfg.minRuns) continue;
      } else if ((cand.totalRuns ?? 0) < cfg.minRuns) {
        continue;
      }

      const expiresAt = new Date(now.getTime() + cfg.ttlDays * 86_400_000);
      await db.update(flakyTests)
        .set({ status: 'ignored', muteSource: 'auto', quarantineExpiresAt: expiresAt })
        .where(eq(flakyTests.id, cand.id));
      transitions.push({ testName: cand.testName, event: 'entered', flakeRate: cand.flakeRate ? Number(cand.flakeRate) : null, expiresAt });
    }
  }

  // Audit: one row per transition.
  if (transitions.length > 0) {
    await db.insert(quarantineEvents).values(transitions.map((t) => ({
      projectId,
      testName: t.testName,
      event: t.event,
      source: 'auto' as const,
      flakeRate: t.flakeRate != null ? t.flakeRate.toFixed(4) : null,
      threshold: t.event === 'entered' ? cfg.threshold.toFixed(4) : null,
      ttlDays: t.event === 'entered' ? cfg.ttlDays : null,
    })));
  }

  return transitions;
}
```
(Place the `resolveQuarantineConfig`/`ProjectQuarantineOverrides` from Task 2 above this function; merge the imports at the top of the file.)

- [ ] **Step 4: Run the engine tests — expect PASS.**

Run: `rtk proxy pnpm --filter api exec vitest run src/services/quarantine.engine.test.ts` (pg-051 + env). Expected: all scenarios green.

- [ ] **Step 5: Typecheck + lint + commit.**

```bash
rtk proxy pnpm --filter api exec tsc --noEmit && rtk proxy pnpm lint
git add apps/api/src/services/quarantine.ts apps/api/src/services/quarantine.engine.test.ts
git commit -m "feat(quarantine): release+promote engine over reconciled flaky_tests"
```

---

### Task 4: Wire the engine into ingest + entry/exit notifications

**Files:**
- Modify: `apps/api/src/services/notifications.ts` (add quarantine event payload + sender)
- Modify: `apps/api/src/routes/reports.ts` (call `reconcileQuarantine` after `updateFlakyTests`, fire notifications best-effort)
- Modify: `docs/API.md` (document the quarantine webhook events)
- Test: `apps/api/src/routes/reports.test.ts` (extend — end-to-end ingest → quarantine)

**Interfaces:**
- Consumes: `reconcileQuarantine` (Task 3).
- Produces: `interface QuarantineWebhookPayload { event: 'quarantine_entered' | 'quarantine_released'; project: {id;name}; testName; flakeRate; expiresAt; ... }`, `sendQuarantineWebhook(url, payload)`.

- [ ] **Step 1: Add the notification payload + sender to `notifications.ts`** (mirror `sendFlakyTransitionWebhook` — best-effort, never throws):

```ts
export interface QuarantineWebhookPayload {
  event: 'quarantine_entered' | 'quarantine_released';
  project: { id: string; name: string };
  testName: string;
  flakeRate: number | null;
  expiresAt: string | null; // ISO, only for entered
}

export async function sendQuarantineWebhook(url: string, payload: QuarantineWebhookPayload): Promise<boolean> {
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

- [ ] **Step 2: Wire into `reports.ts`.** Where `updateFlakyTests(project.id, resolveProjectConfig(project))` is invoked (the `reconcilePromise`), chain the quarantine reconcile after it and fire notifications. The quarantine reconcile must run whether or not `?wait=true` (like the existing reconcile). Sketch (adapt to the existing promise/await structure):

```ts
import { reconcileQuarantine } from '../services/quarantine';
import { sendQuarantineWebhook } from '../services/notifications';
// ...after updateFlakyTests resolves (in the same async flow that already
// handles the flaky-transition webhook):
const transitions = await reconcileQuarantine(project.id, project);
if (project.webhookUrl && transitions.length > 0) {
  for (const t of transitions) {
    await sendQuarantineWebhook(project.webhookUrl, {
      event: t.event === 'entered' ? 'quarantine_entered' : 'quarantine_released',
      project: { id: project.id, name: project.name },
      testName: t.testName,
      flakeRate: t.flakeRate,
      expiresAt: t.expiresAt ? t.expiresAt.toISOString() : null,
    });
  }
}
```
Keep it best-effort: wrap in the same log-and-swallow posture as the existing webhook path; a quarantine/notify failure must never fail the ingest (which already returned 201) nor the reconcile. Ensure `project` carries the quarantine columns (the route's project SELECT must include them — verify/extend the select).

- [ ] **Step 3: Add an end-to-end route test** in `reports.test.ts` (DB-backed): create an opted-in project (`autoQuarantineEnabled: true`, low `quarantineMinRuns`), ingest enough runs of a consistently-failing test to cross `quarantineThreshold`, poll (never sleep) until `GET /projects/:id/quarantine` shows the test in `muted` with the `grepInvert` containing it. Also assert a non-opted-in project ingesting the same never quarantines. (Reuse the `?wait=true` synchronous path so the reconcile+quarantine complete before the assertion — see the existing `wait=true` test at reports.test.ts:639.)

- [ ] **Step 4: Update `docs/API.md`** — document the two webhook events (`quarantine_entered`/`quarantine_released`) and their payload, in the notifications/webhook section.

- [ ] **Step 5: Verify (disposable Postgres) + lint + commit.**

```bash
rtk proxy pnpm --filter api exec vitest run src/routes/reports.test.ts
rtk proxy pnpm --filter api exec tsc --noEmit && rtk proxy pnpm lint
git add apps/api/src/services/notifications.ts apps/api/src/routes/reports.ts apps/api/src/routes/reports.test.ts docs/API.md
git commit -m "feat(quarantine): auto-quarantine on ingest + entry/exit webhooks"
```

---

### Task 5: Manual-mute provenance + audit

**Files:**
- Modify: `apps/api/src/routes/tests.ts` (the `PATCH /flaky/:id` handler)
- Modify: `docs/API.md` (note that manual mute/unmute set provenance + are audited)
- Test: `apps/api/src/routes/tests.test.ts` (extend)

**Interfaces:**
- Consumes: `quarantineEvents` (`../db`).

- [ ] **Step 1: Write failing tests** in `tests.test.ts` (extend the mute describe block):

```ts
    it('records mute_source=manual, clears any auto-expiry, and writes an audit event on manual mute', async () => {
      // flakyId is an existing flaky test row for this project (see the block's setup)
      const res = await app.request(`/api/v1/tests/flaky/${flakyId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'ignored' }),
      });
      expect(res.status).toBe(200);
      const [row] = await db.select().from(flakyTests).where(eq(flakyTests.id, flakyId));
      expect(row.status).toBe('ignored');
      expect(row.muteSource).toBe('manual');
      expect(row.quarantineExpiresAt).toBeNull();
      const events = await db.select().from(quarantineEvents).where(and(eq(quarantineEvents.projectId, projectId), eq(quarantineEvents.event, 'manual_mute')));
      expect(events.length).toBeGreaterThanOrEqual(1);
    });

    it('a manually-muted (mute_source=manual) test is immune to auto-release', async () => {
      // mute, force an expiry in the past, run reconcileQuarantine, assert still ignored
      await db.update(flakyTests).set({ status: 'ignored', muteSource: 'manual', quarantineExpiresAt: new Date(Date.now() - 1000) }).where(eq(flakyTests.id, flakyId));
      await reconcileQuarantine(projectId, { autoQuarantineEnabled: true, quarantineThreshold: '0.2000', quarantineMinRuns: 3, quarantineTtlDays: 7, flakeThreshold: null, windowDays: null, minRuns: null });
      const [row] = await db.select().from(flakyTests).where(eq(flakyTests.id, flakyId));
      expect(row.status).toBe('ignored');
    });

    it('sets released_at + mute_source NULL and audits on manual unmute', async () => {
      const res = await app.request(`/api/v1/tests/flaky/${flakyId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'active' }),
      });
      expect(res.status).toBe(200);
      const [row] = await db.select().from(flakyTests).where(eq(flakyTests.id, flakyId));
      expect(row.muteSource).toBeNull();
      expect(row.quarantineReleasedAt).not.toBeNull();
      const events = await db.select().from(quarantineEvents).where(and(eq(quarantineEvents.projectId, projectId), eq(quarantineEvents.event, 'manual_unmute')));
      expect(events.length).toBeGreaterThanOrEqual(1);
    });
```
(Import `reconcileQuarantine`, `quarantineEvents`, `and` as needed.)

- [ ] **Step 2: Run — expect FAIL** (handler doesn't set provenance/audit yet).

- [ ] **Step 3: Update the `PATCH /flaky/:id` handler in `tests.ts`.** Replace the single `update().set({ status })` with status-aware provenance + an audit insert. The handler must first read the row (for `projectId`/`testName` needed by the audit), then update, then insert the event:

```ts
  const now = new Date();
  const [updated] = await db
    .update(flakyTests)
    .set(
      parsedBody.data.status === 'ignored'
        ? { status: 'ignored', muteSource: 'manual', quarantineExpiresAt: null }
        : { status: 'active', muteSource: null, quarantineExpiresAt: null, quarantineReleasedAt: now }
    )
    .where(eq(flakyTests.id, parsed.data))
    .returning();

  if (!updated) {
    return c.json({ error: 'Flaky test not found' }, 404);
  }

  await db.insert(quarantineEvents).values({
    projectId: updated.projectId,
    testName: updated.testName,
    event: parsedBody.data.status === 'ignored' ? 'manual_mute' : 'manual_unmute',
    source: 'manual',
    flakeRate: updated.flakeRate,
  });

  return c.json({ flakyTest: updated });
```
Add `quarantineEvents` to the `../db` import in `tests.ts`.

- [ ] **Step 4: Run tests — expect PASS.**

Run: `rtk proxy pnpm --filter api exec vitest run src/routes/tests.test.ts` (pg-051 + env).

- [ ] **Step 5: Update `docs/API.md`** — note the mute PATCH now records provenance (`manual`) and writes an audit event; manual mutes are indefinite (never auto-released).

- [ ] **Step 6: Full API suite (disposable Postgres) + typecheck + lint + commit.**

```bash
rtk proxy pnpm --filter api exec vitest run   # full suite, DB up
rtk proxy pnpm --filter api exec tsc --noEmit && rtk proxy pnpm lint
git add apps/api/src/routes/tests.ts apps/api/src/routes/tests.test.ts docs/API.md
git commit -m "feat(quarantine): manual mute provenance + audit trail"
```

---

## Self-Review

- **Spec coverage:** schema/migration + audit table (Task 1) ↔ criteria 1,4; config + validation (Task 2) ↔ criterion 5 (config); engine release/promote/clean-slate (Task 3) ↔ criteria 2,3; ingest wiring + notifications (Task 4) ↔ criterion 2; manual provenance/audit (Task 5) ↔ criteria 4, plus the manual-precedence constraint. Default-off proven in Task 3 Step 1 and Task 4 Step 3.
- **Type/name consistency:** `reconcileQuarantine(projectId, project)` returns `QuarantineTransition[]` — used identically in Task 3 (def), Task 4 (route), Task 5 (test). `resolveQuarantineConfig`/`ProjectQuarantineOverrides`/`QuarantineConfig` are defined in Task 2 and consumed unchanged in Task 3. Column names (`muteSource`, `quarantineExpiresAt`, `quarantineReleasedAt`, `autoQuarantineEnabled`, `quarantineThreshold`, `quarantineMinRuns`, `quarantineTtlDays`) match between the schema (Task 1), config (Task 2), engine (Task 3), and handlers (Tasks 4-5).
- **Ordering:** the engine runs *after* `updateFlakyTests` (detect), so the effective sequence is detect → release → promote; detection preserves `ignored` (existing `CASE WHEN ignored` upsert), so a not-yet-expired auto-mute is undisturbed, and a released test's clean-slate gate blocks same-cycle re-promotion — verified by the Task 3 release + clean-slate tests.
- **Placeholder scan:** every code step carries complete code; the only prose steps are the `docs/API.md` edits (documentation) and the test-scaffolding notes that point at the concrete `describeWithDb`/id-tracking pattern in `flakiness.test.ts`.
