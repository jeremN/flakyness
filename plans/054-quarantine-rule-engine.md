# Quarantine Rule Engine (Roadmap 4b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace plan 051's single per-project `quarantineThreshold` with an ordered set of scoped `quarantine_rules` (branch/tag/file selectors + a flake-rate **or** consecutive-failure condition) that drive the existing auto-quarantine promote path. Engine + admin API only; the console UI is a deliberate fast-follow.

**Architecture:** A new `quarantine_rules` project-child table → a pure `services/rules.ts` engine (in-house glob matcher + first-match-wins `evaluateRules` over in-memory result slices) → wired into `reconcileQuarantine` as the promote decision when a project has rules, falling back to the legacy single-threshold path per-test when no rule matches. Admin CRUD+reorder over the table. Base flaky measurement and `grepInvert` are untouched.

**Tech Stack:** Hono, Drizzle ORM, Postgres, zod, Vitest. Design spec: `docs/superpowers/specs/2026-07-24-quarantine-rule-engine-design.md`.

## Global Constraints

- **`main` is branch-protected.** Work on `feat/quarantine-rule-engine` (already created; spec committed `c645c4d`). No `Co-Authored-By` trailers; single-line conventional-commit subjects; never `--no-verify`.
- **RTK:** the shell hook garbles `pnpm` stdout — prefix pnpm commands with `rtk proxy`.
- **Disposable Postgres via `docker run`** (never `docker compose`); `docker rm -f` unconditionally on exit. The migrate script needs a root `.env` to exist (`touch .env`); shell-exported `DATABASE_URL`/`ADMIN_TOKEN` override `--env-file`.
- **Poll for the post-ingest reconcile to land; never `sleep`** (foreground sleep is blocked). See the existing `waitFor` pattern in `apps/api/src/routes/admin.test.ts`.
- **Decimal columns store strings:** write via `.toFixed(4)`, compare via `Number(...)`. Never let Postgres do `numeric >= text` — compare in JS.
- **New `projects` child tables need `onDelete: 'cascade'`.** New admin endpoints: zod-validate every input, Drizzle query builder only (no raw SQL with input), apply the admin rate limiter (already mounted on `adminRouter`), update `docs/API.md`, add route tests.
- **Route-count guard:** `apps/api/src/routes-auth-coverage.test.ts` fails CI if a `GET` under `/api/v1` has no `readAuth`. Admin routes are `ADMIN_TOKEN`-gated, not `readAuth`-gated — confirm whether the guard's scan excludes `/admin` GETs; if it counts them, bump its hard-coded count deliberately (Task 4).
- **Any new mute/unmute path must set `flaky_tests.mute_source` and append a `quarantine_events` row** — the audit trail (auto + manual) must stay complete.
- **Structured logger (`middleware/logger.ts`), never `console.log`.**
- **Base flaky measurement (`computeFlakiness`/`flaky_tests` detection) and `buildGrepInvert`/`projects.ts:191-193` are OUT OF SCOPE** — rules add a machine writer of `ignored`, nothing more.

---

## File Structure

- **Create** `apps/api/src/services/rules.ts` — pure engine: `globToRegExp`, `matchesSelectors`, `evaluateFlakeRate`, `evaluateConsecutive`, `evaluateRules`; the `QuarantineRule`/`RuleDecision`/`TestSliceResult` types.
- **Create** `apps/api/src/services/rules.test.ts` — node-env unit tests (mutation-provable).
- **Modify** `apps/api/src/db/schema.ts` — add `quarantineRules` table; add nullable `ruleId` to `quarantineEvents`.
- **Create** `apps/api/drizzle/0010_*.sql` — generated migration (additive).
- **Modify** `apps/api/src/services/quarantine.ts` — wire rule evaluation into `reconcileQuarantine`; extend the audit insert with `ruleId`.
- **Create** `apps/api/src/services/quarantine-rules.engine.test.ts` — DB integration tests for the rule promote path.
- **Modify** `apps/api/src/routes/admin.ts` — rule CRUD + reorder endpoints and their zod schema.
- **Modify** `apps/api/src/routes/admin.test.ts` — route tests for the rule endpoints.
- **Modify** `docs/API.md` — document the rule endpoints.
- **Modify** `apps/api/stryker.conf.mjs` + `scripts/mutation-gate.mjs` — add `services/rules.ts` to the hardened floor set.
- **Modify** `AGENTS.md`, `plans/README.md`, `docs/STRATEGY.md` — sharp-edge note, 054 row, #4b status flip.

---

## Task 1: Schema + migration

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Create: `apps/api/drizzle/0010_*.sql` (generated)
- Test: `apps/api/src/db/schema.rules.test.ts` (new)

**Interfaces:**
- Produces: `quarantineRules` table + `QuarantineRule`/`NewQuarantineRule` types; `quarantineEvents.ruleId` column. Consumed by Tasks 2–4.

- [ ] **Step 1: Add the table + audit column to `schema.ts`**

After the `quarantineEvents` table definition, add:

```ts
// Ordered per-project quarantine policy rules (roadmap 4b). NULL selectors are
// wildcards; lower `position` = higher priority (first-match-wins). When a
// project has >=1 enabled rule, reconcileQuarantine takes the rule path; else
// the legacy single-threshold path (plan 051) runs unchanged.
export const quarantineRules = pgTable('quarantine_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }).notNull(),
  position: integer('position').notNull(),
  name: varchar('name', { length: 255 }),
  enabled: boolean('enabled').notNull().default(true),
  // Glob for branch/file; membership for tag. NULL = any.
  selectorBranch: varchar('selector_branch', { length: 255 }),
  selectorFile: varchar('selector_file', { length: 500 }),
  selectorTag: varchar('selector_tag', { length: 255 }),
  action: varchar('action', { length: 16 }).notNull(), // quarantine | exempt
  conditionType: varchar('condition_type', { length: 16 }), // flake_rate | consecutive | NULL (exempt)
  flakeThreshold: decimal('flake_threshold', { precision: 5, scale: 4 }),
  minRuns: integer('min_runs'),
  windowDays: integer('window_days'),
  consecutiveFailures: integer('consecutive_failures'),
  ttlDays: integer('ttl_days'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  projectPositionIdx: index('quarantine_rules_project_position_idx')
    .on(table.projectId, table.position),
}));
```

In the `quarantineEvents` table, add after `ttlDays`:

```ts
  // Which rule promoted this test, when the rule engine (4b) drove it; NULL for
  // legacy single-threshold mutes and all manual/release events. ON DELETE SET
  // NULL so deleting a rule preserves the historical audit row.
  ruleId: uuid('rule_id').references(() => quarantineRules.id, { onDelete: 'set null' }),
```

Note: `quarantineRules` is declared **after** `quarantineEvents` in the file, but `quarantineEvents.ruleId` references it via the `() => quarantineRules.id` thunk, so declaration order does not matter (Drizzle resolves references lazily). At the bottom, add type exports:

```ts
export type QuarantineRule = typeof quarantineRules.$inferSelect;
export type NewQuarantineRule = typeof quarantineRules.$inferInsert;
```

- [ ] **Step 2: Generate the migration**

Run: `rtk proxy pnpm --filter api db:generate`
Expected: a new `apps/api/drizzle/0010_*.sql` containing `CREATE TABLE "quarantine_rules"` (with the FK `ON DELETE cascade`) and `ALTER TABLE "quarantine_events" ADD COLUMN "rule_id" uuid` + its FK `ON DELETE set null`. Confirm the meta snapshot chain is consistent (`0010`'s `prevId` == `0009`'s `id`). Do NOT hand-edit the SQL.

- [ ] **Step 3: Write the migration test**

```ts
// apps/api/src/db/schema.rules.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db, projects, quarantineRules, quarantineEvents } from './index';
import { eq } from 'drizzle-orm';

const DB = process.env.DATABASE_URL;
describe.skipIf(!DB)('quarantine_rules schema', () => {
  const ids: string[] = [];
  afterAll(async () => { for (const id of ids) await db.delete(projects).where(eq(projects.id, id)); });

  it('cascades rule deletion when its project is deleted', async () => {
    const [p] = await db.insert(projects).values({ name: `rules-cascade-${Date.now()}`, tokenHash: 'x'.repeat(64) }).returning();
    ids.push(p.id);
    await db.insert(quarantineRules).values({ projectId: p.id, position: 0, action: 'exempt' });
    await db.delete(projects).where(eq(projects.id, p.id));
    ids.pop();
    const rows = await db.select().from(quarantineRules).where(eq(quarantineRules.projectId, p.id));
    expect(rows).toHaveLength(0);
  });

  it('nulls quarantine_events.rule_id when the rule is deleted (history preserved)', async () => {
    const [p] = await db.insert(projects).values({ name: `rules-setnull-${Date.now()}`, tokenHash: 'x'.repeat(64) }).returning();
    ids.push(p.id);
    const [r] = await db.insert(quarantineRules).values({ projectId: p.id, position: 0, action: 'quarantine', conditionType: 'consecutive', consecutiveFailures: 3 }).returning();
    await db.insert(quarantineEvents).values({ projectId: p.id, testName: 't', event: 'entered', source: 'auto', ruleId: r.id });
    await db.delete(quarantineRules).where(eq(quarantineRules.id, r.id));
    const [ev] = await db.select().from(quarantineEvents).where(eq(quarantineEvents.projectId, p.id));
    expect(ev.ruleId).toBeNull();       // history row survives, ruleId nulled
    expect(ev.event).toBe('entered');
  });
});
```

- [ ] **Step 4: Apply + run**

Start a disposable Postgres, migrate, run the suite:
```bash
docker run -d --name pg-054 -e POSTGRES_PASSWORD=t -e POSTGRES_DB=flackyness -p 5433:5432 postgres:16-alpine
# wait: for i in $(seq 1 60); do docker exec pg-054 pg_isready -U postgres -q && break; done
export DATABASE_URL=postgresql://postgres:t@127.0.0.1:5433/flackyness
rtk proxy pnpm db:migrate
rtk proxy pnpm --filter api exec vitest run src/db/schema.rules.test.ts
docker rm -f pg-054
```
Expected: migration applies; 2/2 pass. tsc clean (`rtk proxy pnpm --filter api exec tsc --noEmit`).

- [ ] **Step 5: Commit**
```bash
git add apps/api/src/db/schema.ts apps/api/drizzle apps/api/src/db/schema.rules.test.ts
git commit -m "feat(api): quarantine_rules table + rule_id audit column"
```

---

## Task 2: Pure rule engine (`services/rules.ts`)

**Files:**
- Create: `apps/api/src/services/rules.ts`
- Test: `apps/api/src/services/rules.test.ts`

**Interfaces:**
- Consumes: `QuarantineRule` (Task 1) for column shape.
- Produces: `evaluateRules(rules, slice) → RuleDecision`, `globToRegExp`, and the `TestSliceResult`/`RuleDecision`/`EvalRule` types. Consumed by Task 3.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/rules.test.ts
import { describe, it, expect } from 'vitest';
import { globToRegExp, evaluateRules, type EvalRule, type TestSliceResult } from './rules';

const at = (iso: string) => new Date(iso);
// helper: one result row
const r = (status: string, branch = 'main', file = 'e2e/a.spec.ts', tags: string[] = [], iso = '2026-07-24T00:00:00Z'): TestSliceResult =>
  ({ status, branch, testFile: file, tags, createdAt: at(iso) });

describe('globToRegExp', () => {
  it('* matches within a path segment but not across /', () => {
    expect(globToRegExp('release/*').test('release/1.0')).toBe(true);
    expect(globToRegExp('release/*').test('release/1.0/rc')).toBe(false);
  });
  it('** matches across segments', () => {
    expect(globToRegExp('e2e/**').test('e2e/sub/a.spec.ts')).toBe(true);
  });
  it('is anchored full-string (no partial match)', () => {
    expect(globToRegExp('main').test('maintenance')).toBe(false);
  });
  it('escapes regex metacharacters in the literal parts', () => {
    expect(globToRegExp('a.b').test('a.b')).toBe(true);
    expect(globToRegExp('a.b').test('axb')).toBe(false);
  });
});

// A base rule; individual tests override fields.
const rule = (o: Partial<EvalRule>): EvalRule => ({
  id: 'r1', position: 0, action: 'quarantine', conditionType: 'flake_rate',
  selectorBranch: null, selectorFile: null, selectorTag: null,
  flakeThreshold: 0.5, minRuns: 2, windowDays: 14, consecutiveFailures: null, ttlDays: 7, ...o,
});

describe('evaluateRules — matching + first-match-wins', () => {
  it('returns no-match when no rule selector matches the slice', () => {
    const d = evaluateRules([rule({ selectorBranch: 'release/*' })], [r('failed', 'main')]);
    expect(d.kind).toBe('no-match');
  });
  it('a matching exempt rule owns the decision and stops evaluation', () => {
    const rules = [rule({ position: 0, action: 'exempt', conditionType: null, selectorTag: 'critical' }),
                   rule({ position: 1 })];
    const d = evaluateRules(rules, [r('failed', 'main', 'e2e/a.spec.ts', ['critical']), r('failed')]);
    expect(d).toMatchObject({ kind: 'exempt', ruleId: 'r1' });
  });
  it('AND-combines provided selectors; an omitted selector is a wildcard', () => {
    const only = rule({ selectorBranch: 'main', selectorFile: 'e2e/**' });
    expect(evaluateRules([only], [r('failed', 'main', 'e2e/x.spec.ts')]).kind).toBe('quarantine');
    expect(evaluateRules([only], [r('failed', 'main', 'unit/x.spec.ts')]).kind).toBe('no-match');
  });
});

describe('evaluateRules — flake_rate condition (on the matching slice)', () => {
  it('fires when slice flake-rate >= threshold over >= minRuns', () => {
    const d = evaluateRules([rule({ flakeThreshold: 0.5, minRuns: 2 })],
      [r('failed'), r('passed'), r('failed')]); // 2/3 = 0.67
    expect(d).toMatchObject({ kind: 'quarantine', ruleId: 'r1', ttlDays: 7 });
  });
  it('does not fire below minRuns even if rate is high (rule still owns → leave)', () => {
    const d = evaluateRules([rule({ minRuns: 5 })], [r('failed')]);
    expect(d).toMatchObject({ kind: 'leave' }); // matched a quarantine rule, condition did not fire
  });
  it('flaky counts toward the numerator like failed', () => {
    const d = evaluateRules([rule({ flakeThreshold: 0.5, minRuns: 2 })], [r('flaky'), r('passed')]); // 1/2 = 0.5
    expect(d.kind).toBe('quarantine');
  });
});

describe('evaluateRules — consecutive condition', () => {
  const consec = (k: number) => rule({ conditionType: 'consecutive', consecutiveFailures: k, flakeThreshold: null, minRuns: null });
  it('fires on K failed in a row from the newest result', () => {
    const d = evaluateRules([consec(3)], [
      r('failed', 'main', 'e2e/a.spec.ts', [], '2026-07-24T03:00:00Z'),
      r('failed', 'main', 'e2e/a.spec.ts', [], '2026-07-24T02:00:00Z'),
      r('failed', 'main', 'e2e/a.spec.ts', [], '2026-07-24T01:00:00Z'),
      r('passed', 'main', 'e2e/a.spec.ts', [], '2026-07-24T00:00:00Z'),
    ]);
    expect(d.kind).toBe('quarantine');
  });
  it('a passed OR flaky result resets the streak', () => {
    const d = evaluateRules([consec(3)], [
      r('failed', 'main', 'e2e/a.spec.ts', [], '2026-07-24T03:00:00Z'),
      r('flaky',  'main', 'e2e/a.spec.ts', [], '2026-07-24T02:00:00Z'),
      r('failed', 'main', 'e2e/a.spec.ts', [], '2026-07-24T01:00:00Z'),
    ]);
    expect(d.kind).toBe('leave'); // only 1 in a row from newest
  });
  it('skipped is ignored — it neither increments nor resets', () => {
    const d = evaluateRules([consec(2)], [
      r('failed',  'main', 'e2e/a.spec.ts', [], '2026-07-24T03:00:00Z'),
      r('skipped', 'main', 'e2e/a.spec.ts', [], '2026-07-24T02:00:00Z'),
      r('failed',  'main', 'e2e/a.spec.ts', [], '2026-07-24T01:00:00Z'),
    ]);
    expect(d.kind).toBe('quarantine'); // 2 failed with a skipped between
  });
});
```

Run: `rtk proxy pnpm --filter api exec vitest run src/services/rules.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 2: Implement `services/rules.ts`**

```ts
// apps/api/src/services/rules.ts

/** A stored rule reduced to the fields the engine reads (decimals as numbers). */
export interface EvalRule {
  id: string;
  position: number;
  action: 'quarantine' | 'exempt';
  conditionType: 'flake_rate' | 'consecutive' | null;
  selectorBranch: string | null;
  selectorFile: string | null;
  selectorTag: string | null;
  flakeThreshold: number | null;
  minRuns: number | null;
  windowDays: number | null;
  consecutiveFailures: number | null;
  ttlDays: number | null;
}

/** One test result in a test's evaluation window (already fetched, decimals resolved). */
export interface TestSliceResult {
  status: string;            // passed | failed | flaky | skipped
  branch: string;            // from test_runs
  testFile: string | null;
  tags: string[];            // test_results.tags ?? []
  createdAt: Date;
}

export type RuleDecision =
  | { kind: 'quarantine'; ruleId: string; ttlDays: number | null }
  | { kind: 'exempt'; ruleId: string }
  | { kind: 'leave'; ruleId: string }   // a quarantine rule owns it but its condition did not fire
  | { kind: 'no-match' };

/**
 * Translate a glob (`*` within a path segment, `**` across segments, `?` one
 * char; every other char literal) into an anchored full-string RegExp. No
 * dependency — the grammar is tiny and validated at write time.
 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; }   // ** → across segments
      else re += '[^/]*';                              // *  → within a segment
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // escape regex metachars
    }
  }
  return new RegExp(`^${re}$`);
}

/** Does one result fall inside a rule's selector slice? */
function resultMatchesSelectors(rule: EvalRule, res: TestSliceResult): boolean {
  if (rule.selectorBranch !== null && !globToRegExp(rule.selectorBranch).test(res.branch)) return false;
  if (rule.selectorFile !== null && !globToRegExp(rule.selectorFile).test(res.testFile ?? '')) return false;
  if (rule.selectorTag !== null && !res.tags.includes(rule.selectorTag)) return false;
  return true;
}

function flakeRateFires(rule: EvalRule, slice: TestSliceResult[]): boolean {
  const total = slice.length;
  if (total < (rule.minRuns ?? 1)) return false;
  const bad = slice.filter((r) => r.status === 'failed' || r.status === 'flaky').length;
  return bad / total >= (rule.flakeThreshold ?? 1);
}

function consecutiveFires(rule: EvalRule, slice: TestSliceResult[]): boolean {
  const k = rule.consecutiveFailures ?? Infinity;
  // newest first; `failed` increments, `passed`/`flaky` reset, `skipped` ignored
  const ordered = [...slice].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  let streak = 0;
  for (const res of ordered) {
    if (res.status === 'skipped') continue;
    if (res.status === 'failed') { streak++; if (streak >= k) return true; }
    else break; // passed or flaky resets → streak from newest is over
  }
  return streak >= k;
}

/**
 * First-matching-rule wins. A rule matches a test when >=1 of the test's
 * results falls in the rule's selector slice; that rule owns the decision and
 * evaluation stops. Returns `no-match` when no rule's selectors match — the
 * caller then applies the legacy project-threshold decision.
 */
export function evaluateRules(rules: EvalRule[], results: TestSliceResult[]): RuleDecision {
  for (const rule of rules) {
    const slice = results.filter((res) => resultMatchesSelectors(rule, res));
    if (slice.length === 0) continue; // selectors don't match this test → next rule
    if (rule.action === 'exempt') return { kind: 'exempt', ruleId: rule.id };
    const fires = rule.conditionType === 'consecutive'
      ? consecutiveFires(rule, slice)
      : flakeRateFires(rule, slice);
    return fires
      ? { kind: 'quarantine', ruleId: rule.id, ttlDays: rule.ttlDays }
      : { kind: 'leave', ruleId: rule.id };
  }
  return { kind: 'no-match' };
}
```

- [ ] **Step 3: Run the tests** — `rtk proxy pnpm --filter api exec vitest run src/services/rules.test.ts` → all pass. tsc clean.

- [ ] **Step 4: Mutation-probe the load-bearing assertions** (repo standard). Manually verify each bites, then revert: (a) flip `>=` to `>` in `flakeRateFires` → the "0.5 == threshold fires" test reds; (b) drop the `res.status === 'skipped'` continue → the skipped test reds; (c) change `break` to `continue` in `consecutiveFires` → the "flaky resets" test reds; (d) change `[^/]*` to `.*` for single `*` → the "`*` not across `/`" glob test reds. Restore after each; `git diff` shows no residual change.

- [ ] **Step 5: Commit**
```bash
git add apps/api/src/services/rules.ts apps/api/src/services/rules.test.ts
git commit -m "feat(api): pure quarantine rule engine (glob + first-match evaluation)"
```

---

## Task 3: Integrate rules into `reconcileQuarantine`

**Files:**
- Modify: `apps/api/src/services/quarantine.ts`
- Test: `apps/api/src/services/quarantine-rules.engine.test.ts` (new)

**Interfaces:**
- Consumes: `evaluateRules`/`EvalRule`/`TestSliceResult` (Task 2), `quarantineRules` (Task 1).
- Produces: rule-aware `reconcileQuarantine` (same signature + return type). `QuarantineTransition` gains an optional `ruleId`.

- [ ] **Step 1: Write the failing integration tests**

```ts
// apps/api/src/services/quarantine-rules.engine.test.ts
import { describe, it, expect, afterAll } from 'vitest';
import { db, projects, testRuns, testResults, flakyTests, quarantineRules, quarantineEvents } from '../db';
import { reconcileQuarantine, type ProjectQuarantineOverrides } from './quarantine';
import { eq } from 'drizzle-orm';

const DB = process.env.DATABASE_URL;
const created: string[] = [];
async function project(overrides: Partial<typeof projects.$inferInsert> = {}) {
  const [p] = await db.insert(projects).values({ name: `rules-eng-${Date.now()}-${Math.random()}`, tokenHash: 'x'.repeat(64), autoQuarantineEnabled: true, ...overrides }).returning();
  created.push(p.id); return p;
}
// Insert a run at `daysAgo` with one result for `testName`.
async function run(projectId: string, testName: string, status: string, branch: string, daysAgo: number, file = 'e2e/a.spec.ts', tags: string[] = []) {
  const created_at = new Date(Date.now() - daysAgo * 86_400_000);
  const [r] = await db.insert(testRuns).values({ projectId, branch, commitSha: 'a'.repeat(40), createdAt: created_at }).returning();
  await db.insert(testResults).values({ testRunId: r.id, testName, status, testFile: file, tags, createdAt: created_at });
}
const asOverrides = (p: typeof projects.$inferSelect): ProjectQuarantineOverrides => p;

describe.skipIf(!DB)('reconcileQuarantine — rule path', () => {
  afterAll(async () => { for (const id of created) await db.delete(projects).where(eq(projects.id, id)); });

  it('consecutive rule quarantines a NOT-globally-flaky test (upserts an ignored row)', async () => {
    const p = await project();
    await db.insert(quarantineRules).values({ projectId: p.id, position: 0, action: 'quarantine', conditionType: 'consecutive', consecutiveFailures: 3, selectorBranch: 'main' });
    // 3 recent failures on main + lots of old passes → global rate low, but 3-in-a-row now.
    for (let d = 0; d < 3; d++) await run(p.id, 'T', 'failed', 'main', d);
    for (let d = 5; d < 20; d++) await run(p.id, 'T', 'passed', 'main', d);
    // NB: no flaky_tests row exists for T yet.
    const transitions = await reconcileQuarantine(p.id, asOverrides(p));
    expect(transitions.find((t) => t.testName === 'T' && t.event === 'entered')).toBeTruthy();
    const [row] = await db.select().from(flakyTests).where(eq(flakyTests.projectId, p.id));
    expect(row).toMatchObject({ testName: 'T', status: 'ignored', muteSource: 'auto' });
    const [ev] = await db.select().from(quarantineEvents).where(eq(quarantineEvents.projectId, p.id));
    expect(ev.ruleId).toBeTruthy();      // provenance: which rule fired
  });

  it('exempt rule shields a test the fallback threshold would have quarantined', async () => {
    const p = await project({ quarantineThreshold: '0.10' });
    await db.insert(quarantineRules).values({ projectId: p.id, position: 0, action: 'exempt', selectorTag: 'critical' });
    // A test failing every run, tagged critical, with an existing active flaky row.
    for (let d = 0; d < 5; d++) await run(p.id, 'C', 'failed', 'main', d, 'e2e/a.spec.ts', ['critical']);
    await db.insert(flakyTests).values({ projectId: p.id, testName: 'C', flakeRate: '1.0000', totalRuns: 5, status: 'active' });
    await reconcileQuarantine(p.id, asOverrides(p));
    const [row] = await db.select().from(flakyTests).where(eq(flakyTests.projectId, p.id));
    expect(row.status).toBe('active'); // exempt owns it → never quarantined
  });

  it('a no-match test still gets the legacy single-threshold decision', async () => {
    const p = await project({ quarantineThreshold: '0.10' });
    await db.insert(quarantineRules).values({ projectId: p.id, position: 0, action: 'quarantine', conditionType: 'flake_rate', flakeThreshold: '0.50', minRuns: 2, selectorBranch: 'release/*' });
    // Active flaky test on main (rule targets release/* only → no rule matches).
    for (let d = 0; d < 3; d++) await run(p.id, 'M', 'failed', 'main', d);
    await db.insert(flakyTests).values({ projectId: p.id, testName: 'M', flakeRate: '0.9000', totalRuns: 3, status: 'active' });
    await reconcileQuarantine(p.id, asOverrides(p));
    const [row] = await db.select().from(flakyTests).where(eq(flakyTests.projectId, p.id));
    expect(row.status).toBe('ignored'); // fell through to project threshold 0.10 → quarantined
    const [ev] = await db.select().from(quarantineEvents).where(eq(quarantineEvents.projectId, p.id));
    expect(ev.ruleId).toBeNull(); // legacy path → no rule id
  });

  it('rule-less project is byte-for-byte the legacy behavior (regression guard)', async () => {
    const p = await project({ quarantineThreshold: '0.10' });
    for (let d = 0; d < 3; d++) await run(p.id, 'L', 'failed', 'main', d);
    await db.insert(flakyTests).values({ projectId: p.id, testName: 'L', flakeRate: '0.9000', totalRuns: 3, status: 'active' });
    await reconcileQuarantine(p.id, asOverrides(p));
    const [row] = await db.select().from(flakyTests).where(eq(flakyTests.projectId, p.id));
    expect(row.status).toBe('ignored');
  });
});
```

Run against disposable Postgres (as in Task 1 Step 4). Expected: FAIL (rule path not implemented — currently rules are ignored, so the consecutive/exempt/no-match cases fail).

- [ ] **Step 2: Implement the rule path in `quarantine.ts`**

Add ONE new import at the top:
```ts
import { evaluateRules, type EvalRule, type TestSliceResult } from './rules';
```
Do **not** add a `resolveProjectConfig` import — line 3 already has `import { resolveProjectConfig, type ProjectFlakinessOverrides } from './flakiness';`; reuse it. Add `quarantineRules` to the existing `import { db, flakyTests, testResults, testRuns, quarantineEvents } from '../db';` line.

Add `ruleId` to the transition type:
```ts
export interface QuarantineTransition {
  testName: string;
  event: 'entered' | 'released';
  flakeRate: number | null;
  expiresAt: Date | null;
  ruleId?: string | null; // set when the rule engine drove the promotion
}
```

Replace **Phase 3 (PROMOTE)** (the `if (cfg.enabled) { ... }` block) with a branch on whether the project has enabled rules:

```ts
  // Phase 3: PROMOTE — only when enabled.
  if (cfg.enabled) {
    const rules = (await db
      .select()
      .from(quarantineRules)
      .where(and(eq(quarantineRules.projectId, projectId), eq(quarantineRules.enabled, true)))
      .orderBy(quarantineRules.position)) as (typeof quarantineRules.$inferSelect)[];

    if (rules.length === 0) {
      await promoteLegacy(projectId, cfg, now, transitions); // plan-051 path, unchanged
    } else {
      await promoteWithRules(projectId, project, cfg, rules, now, transitions);
    }
  }
```

Refactor the existing single-threshold body into `promoteLegacy`, which delegates the per-row decision to a shared `legacyThresholdDecision` helper (defined below). This is a behavior-preserving refactor of the code that was inside `if (cfg.enabled)` — the `flakeRate < threshold` filter, the clean-slate guard, and the update/transition are all preserved, just moved into the shared helper so the rule path's no-match branch reuses the exact same logic:

```ts
async function promoteLegacy(
  projectId: string,
  cfg: QuarantineConfig,
  now: Date,
  transitions: QuarantineTransition[],
): Promise<void> {
  const activeRows = await db.select().from(flakyTests)
    .where(and(eq(flakyTests.projectId, projectId), eq(flakyTests.status, 'active')));
  for (const active of activeRows) {
    const t = await legacyThresholdDecision(projectId, active, cfg, now);
    if (t) transitions.push(t);
  }
}
```

Add the rule path:

```ts
const DAY = 86_400_000;

/** Reduce a stored rule row to the engine's numeric shape. */
function toEvalRule(row: typeof quarantineRules.$inferSelect): EvalRule {
  return {
    id: row.id, position: row.position, action: row.action as 'quarantine' | 'exempt',
    conditionType: row.conditionType as EvalRule['conditionType'],
    selectorBranch: row.selectorBranch, selectorFile: row.selectorFile, selectorTag: row.selectorTag,
    flakeThreshold: row.flakeThreshold !== null ? Number(row.flakeThreshold) : null,
    minRuns: row.minRuns, windowDays: row.windowDays,
    consecutiveFailures: row.consecutiveFailures, ttlDays: row.ttlDays,
  };
}

async function promoteWithRules(
  projectId: string,
  project: ProjectQuarantineOverrides,
  cfg: QuarantineConfig,
  ruleRows: (typeof quarantineRules.$inferSelect)[],
  now: Date,
  transitions: QuarantineTransition[],
): Promise<void> {
  const flakiness = resolveProjectConfig(project);
  const rules = ruleRows.map(toEvalRule);
  // Evaluation window = widest effective rule window (null → project → global 14), capped 90.
  const windowDays = Math.min(90, Math.max(...rules.map((r) => r.windowDays ?? flakiness.windowDays)));
  const cutoff = new Date(now.getTime() - windowDays * DAY);

  // One fetch of the whole window; the engine slices per rule in memory (no N+1).
  const rows = await db.select({
      testName: testResults.testName, testFile: testResults.testFile, status: testResults.status,
      tags: testResults.tags, branch: testRuns.branch, createdAt: testResults.createdAt,
    })
    .from(testResults).innerJoin(testRuns, eq(testResults.testRunId, testRuns.id))
    .where(and(eq(testRuns.projectId, projectId), gt(testResults.createdAt, cutoff)));

  const byTest = new Map<string, { file: string | null; results: TestSliceResult[] }>();
  for (const row of rows) {
    const entry = byTest.get(row.testName) ?? { file: row.testFile, results: [] };
    entry.results.push({ status: row.status, branch: row.branch, testFile: row.testFile, tags: row.tags ?? [], createdAt: row.createdAt });
    byTest.set(row.testName, entry);
  }

  // Active flaky rows drive the legacy fallback for no-match tests, and are the
  // set that can be quarantined at the project threshold even without runs in
  // the (possibly narrower) rule window.
  const activeRows = await db.select().from(flakyTests)
    .where(and(eq(flakyTests.projectId, projectId), eq(flakyTests.status, 'active')));
  const activeByName = new Map(activeRows.map((r) => [r.testName, r]));

  // Candidate universe: every test seen in the window PLUS every active flaky row.
  const candidateNames = new Set<string>([...byTest.keys(), ...activeByName.keys()]);

  for (const testName of candidateNames) {
    const entry = byTest.get(testName);
    const decision = evaluateRules(rules, entry?.results ?? []);

    if (decision.kind === 'quarantine') {
      const ttlDays = decision.ttlDays ?? cfg.ttlDays;
      const active = activeByName.get(testName);
      // Clean slate only applies to a previously-released row.
      if (active?.quarantineReleasedAt && !(await hasFreshRuns(projectId, testName, active.quarantineReleasedAt, cfg.minRuns))) continue;
      const expiresAt = new Date(now.getTime() + ttlDays * DAY);
      const flakeRate = sliceFlakeRate(entry?.results ?? []);
      await db.insert(flakyTests).values({
          projectId, testName, testFile: entry?.file ?? active?.testFile ?? null,
          firstDetected: active?.firstDetected ?? now, lastSeen: now,
          flakeCount: 0, totalRuns: entry?.results.length ?? active?.totalRuns ?? 0,
          flakeRate: flakeRate.toFixed(4), status: 'ignored', muteSource: 'auto', quarantineExpiresAt: expiresAt,
        })
        .onConflictDoUpdate({
          target: [flakyTests.projectId, flakyTests.testName],
          set: { status: 'ignored', muteSource: 'auto', quarantineExpiresAt: expiresAt, lastSeen: now },
        });
      transitions.push({ testName, event: 'entered', flakeRate, expiresAt, ruleId: decision.ruleId });
    } else if (decision.kind === 'no-match') {
      // No rule owns this test → the exact plan-051 project-threshold decision,
      // via the same helper promoteLegacy uses (single source of truth).
      const active = activeByName.get(testName);
      if (!active) continue;
      const t = await legacyThresholdDecision(projectId, active, cfg, now);
      if (t) transitions.push(t);
    }
    // exempt / leave → no promotion.
  }
}

/**
 * The plan-051 single-threshold decision for ONE active flaky_tests row.
 * Returns the transition (and applies the mute) if the row crosses the project
 * threshold and clears the clean-slate guard, else null. Shared by the legacy
 * path and the rule path's no-match fallback so the two never diverge.
 */
async function legacyThresholdDecision(
  projectId: string,
  active: typeof flakyTests.$inferSelect,
  cfg: QuarantineConfig,
  now: Date,
): Promise<QuarantineTransition | null> {
  if (Number(active.flakeRate ?? 0) < cfg.threshold) return null;
  if (active.quarantineReleasedAt) {
    if (!(await hasFreshRuns(projectId, active.testName, active.quarantineReleasedAt, cfg.minRuns))) return null;
  } else if ((active.totalRuns ?? 0) < cfg.minRuns) {
    return null;
  }
  const expiresAt = new Date(now.getTime() + cfg.ttlDays * DAY);
  await db.update(flakyTests)
    .set({ status: 'ignored', muteSource: 'auto', quarantineExpiresAt: expiresAt })
    .where(eq(flakyTests.id, active.id));
  return { testName: active.testName, event: 'entered', flakeRate: active.flakeRate ? Number(active.flakeRate) : null, expiresAt, ruleId: null };
}

function sliceFlakeRate(results: TestSliceResult[]): number {
  if (results.length === 0) return 0;
  const bad = results.filter((r) => r.status === 'failed' || r.status === 'flaky').length;
  return bad / results.length;
}

async function hasFreshRuns(projectId: string, testName: string, since: Date, minRuns: number): Promise<boolean> {
  const [{ count }] = await db.select({ count: sql<number>`count(*)` })
    .from(testResults).innerJoin(testRuns, eq(testResults.testRunId, testRuns.id))
    .where(and(eq(testRuns.projectId, projectId), eq(testResults.testName, testName), gt(testResults.createdAt, since)));
  return Number(count) >= minRuns;
}
```

Extend the **audit insert** at the end of `reconcileQuarantine` to carry `ruleId`:
```ts
    await db.insert(quarantineEvents).values(transitions.map((t) => ({
      projectId,
      testName: t.testName,
      event: t.event,
      source: 'auto' as const,
      flakeRate: t.flakeRate != null ? t.flakeRate.toFixed(4) : null,
      threshold: t.event === 'entered' ? cfg.threshold.toFixed(4) : null,
      ttlDays: t.event === 'entered' ? cfg.ttlDays : null,
      ruleId: t.event === 'entered' ? (t.ruleId ?? null) : null,
    })));
```
Note: for a rule-driven mute the `threshold`/`ttlDays` audit columns intentionally stay project-level (`cfg.*`) — a `consecutive` rule has no flake threshold, and `rule_id` is the precise provenance the spec requires. Do not thread per-rule threshold/ttl into the audit columns (YAGNI; `rule_id` → the rule row already carries them).

- [ ] **Step 3: Run the integration tests** (disposable Postgres) → 4/4 pass. Then run the **existing** quarantine engine suite to prove the legacy path is untouched: `rtk proxy pnpm --filter api exec vitest run src/services/quarantine.engine.test.ts` → still green. Then the full API suite with Postgres up → green. tsc + `rtk proxy pnpm lint` clean. `docker rm -f pg-054`.

- [ ] **Step 4: Commit**
```bash
git add apps/api/src/services/quarantine.ts apps/api/src/services/quarantine-rules.engine.test.ts
git commit -m "feat(api): drive auto-quarantine promotion from the rule engine"
```

---

## Task 4: Admin CRUD + reorder API

**Files:**
- Modify: `apps/api/src/routes/admin.ts`
- Modify: `apps/api/src/routes/admin.test.ts`
- Modify: `docs/API.md`
- Modify (if the guard counts admin GETs): `apps/api/src/routes-auth-coverage.test.ts`

**Interfaces:**
- Consumes: `quarantineRules` (Task 1). Produces: `GET/POST/PATCH/DELETE /admin/projects/:id/rules(/:ruleId)` + `POST .../rules/reorder`.

- [ ] **Step 1: Add the zod schema** to `admin.ts` (after `projectConfigPatchSchema`)

```ts
const globField = (max: number) => z.string().min(1).max(max)
  .refine((g) => { try { void globToRegExp(g); return true; } catch { return false; } }, { message: 'invalid glob' })
  .nullable().optional();

const quarantineRuleSchema = z.object({
  name: z.string().max(255).nullable().optional(),
  enabled: z.boolean().optional(),
  position: z.number().int().min(0).optional(),
  selectorBranch: globField(255),
  selectorFile: globField(500),
  selectorTag: z.string().min(1).max(255).nullable().optional(),
  action: z.enum(['quarantine', 'exempt']),
  conditionType: z.enum(['flake_rate', 'consecutive']).nullable().optional(),
  flakeThreshold: z.number().min(0).max(1).nullable().optional(),
  minRuns: z.number().int().min(1).max(100).nullable().optional(),
  windowDays: z.number().int().min(1).max(90).nullable().optional(),
  consecutiveFailures: z.number().int().min(1).max(100).nullable().optional(),
  ttlDays: z.number().int().min(1).max(365).nullable().optional(),
}).superRefine((o, ctx) => {
  if (o.action === 'exempt') {
    if (o.conditionType != null || o.flakeThreshold != null || o.consecutiveFailures != null)
      ctx.addIssue({ code: 'custom', message: 'exempt rules take no condition' });
    return;
  }
  if (o.conditionType == null) { ctx.addIssue({ code: 'custom', message: 'quarantine rules need a conditionType' }); return; }
  if (o.conditionType === 'flake_rate' && o.flakeThreshold == null)
    ctx.addIssue({ code: 'custom', message: 'flake_rate needs flakeThreshold' });
  if (o.conditionType === 'consecutive' && o.consecutiveFailures == null)
    ctx.addIssue({ code: 'custom', message: 'consecutive needs consecutiveFailures' });
});

// PATCH: same shape, all optional; the merged row is re-validated in the handler.
const quarantineRulePatchSchema = quarantineRuleSchema.partial();
```
Import `globToRegExp` from `../services/rules` and `quarantineRules` from `../db` at the top.

- [ ] **Step 2: Add the endpoints** (place after the project lifecycle routes; all under the already-authed `adminRouter`)

```ts
// GET /admin/projects/:id/rules — ordered list
adminRouter.get('/projects/:id/rules', zValidator('param', z.object({ id: uuidSchema }), badParam), async (c) => {
  const { id } = c.req.valid('param');
  const rows = await db.select().from(quarantineRules)
    .where(eq(quarantineRules.projectId, id)).orderBy(quarantineRules.position);
  return c.json({ rules: rows.map(serializeRule) });
});

// POST /admin/projects/:id/rules — append (position = current max + 1)
adminRouter.post('/projects/:id/rules',
  zValidator('param', z.object({ id: uuidSchema }), badParam),
  zValidator('json', quarantineRuleSchema, badJson),
  async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const [{ max }] = await db.select({ max: sql<number>`coalesce(max(${quarantineRules.position}), -1)::int` })
      .from(quarantineRules).where(eq(quarantineRules.projectId, id));
    const [row] = await db.insert(quarantineRules)
      .values({ projectId: id, position: body.position ?? max + 1, ...toRuleColumns(body) }).returning();
    return c.json({ rule: serializeRule(row) }, 201);
  });

// PATCH /admin/projects/:id/rules/:ruleId
adminRouter.patch('/projects/:id/rules/:ruleId',
  zValidator('param', z.object({ id: uuidSchema, ruleId: uuidSchema }), badParam),
  zValidator('json', quarantineRulePatchSchema, badJson),
  async (c) => {
    const { id, ruleId } = c.req.valid('param');
    const patch = c.req.valid('json');
    const [existing] = await db.select().from(quarantineRules)
      .where(and(eq(quarantineRules.id, ruleId), eq(quarantineRules.projectId, id)));
    if (!existing) return c.json({ error: 'Rule not found' }, 404);
    // Re-validate the merged row so a partial patch can't create an invalid combination.
    const merged = { ...serializeRule(existing), ...patch };
    const check = quarantineRuleSchema.safeParse(merged);
    if (!check.success) return c.json({ error: check.error.issues[0]?.message ?? 'invalid rule' }, 400);
    const [row] = await db.update(quarantineRules)
      .set({ ...toRuleColumns(patch), updatedAt: new Date() })
      .where(eq(quarantineRules.id, ruleId)).returning();
    return c.json({ rule: serializeRule(row) });
  });

// DELETE /admin/projects/:id/rules/:ruleId
adminRouter.delete('/projects/:id/rules/:ruleId',
  zValidator('param', z.object({ id: uuidSchema, ruleId: uuidSchema }), badParam),
  async (c) => {
    const { id, ruleId } = c.req.valid('param');
    const deleted = await db.delete(quarantineRules)
      .where(and(eq(quarantineRules.id, ruleId), eq(quarantineRules.projectId, id))).returning();
    if (deleted.length === 0) return c.json({ error: 'Rule not found' }, 404);
    return c.json({ success: true });
  });

// POST /admin/projects/:id/rules/reorder — body is the full ordered id list
adminRouter.post('/projects/:id/rules/reorder',
  zValidator('param', z.object({ id: uuidSchema }), badParam),
  zValidator('json', z.object({ order: z.array(uuidSchema).min(1) }), badJson),
  async (c) => {
    const { id } = c.req.valid('param');
    const { order } = c.req.valid('json');
    const current = await db.select({ id: quarantineRules.id }).from(quarantineRules).where(eq(quarantineRules.projectId, id));
    const currentSet = new Set(current.map((r) => r.id));
    if (order.length !== currentSet.size || !order.every((rid) => currentSet.has(rid)))
      return c.json({ error: 'order must be exactly the project\'s current rule ids' }, 400);
    await db.transaction(async (tx) => {
      for (let i = 0; i < order.length; i++)
        await tx.update(quarantineRules).set({ position: i, updatedAt: new Date() }).where(eq(quarantineRules.id, order[i]));
    });
    return c.json({ success: true });
  });
```

Add the shared helpers (near the top of `admin.ts`):
```ts
const badParam = (r: { success: boolean }, c: Context) => (!r.success ? c.json({ error: 'Invalid project or rule id' }, 400) : undefined);
const badJson = (r: { success: boolean; error?: z.ZodError }, c: Context) => (!r.success ? c.json({ error: r.error?.issues[0]?.message ?? 'Invalid body' }, 400) : undefined);

/** DB row → JSON (decimals as numbers). */
function serializeRule(row: typeof quarantineRules.$inferSelect) {
  return { ...row, flakeThreshold: row.flakeThreshold !== null ? Number(row.flakeThreshold) : null };
}
/** Validated body → column values (flakeThreshold as a fixed(4) string). */
function toRuleColumns(b: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...b };
  if ('flakeThreshold' in b) out.flakeThreshold = b.flakeThreshold == null ? null : Number(b.flakeThreshold).toFixed(4);
  delete out.position; // position is managed by create/reorder, never a plain patch field here
  return out;
}
```
(If `badParam`/`badJson` helper signatures clash with the existing inline `zValidator` error style in `admin.ts`, match whatever that file already does — the existing routes show the exact hook shape; reuse it verbatim rather than inventing a new one. Import `Context` from `hono` if you add the typed helpers.)

- [ ] **Step 3: Write route tests** in `admin.test.ts` (mirror the existing project-route test style — real `app.request` with the `ADMIN_TOKEN` bearer, `describe.skipIf(!DATABASE_URL)`):
  - create → `201`, body has the rule with a numeric `flakeThreshold`;
  - create with `action:'exempt'` + a `conditionType` → `400`;
  - create with `conditionType:'consecutive'` but no `consecutiveFailures` → `400`;
  - create with an invalid glob (`selectorBranch: '['`)? — globs rarely fail to compile, so instead assert a valid glob round-trips; drop this case if `globToRegExp` never throws (it doesn't — document that in the test);
  - list returns rules ordered by `position`;
  - patch a threshold → reflected; patch that would invalidate the row (`action`→`exempt` while a condition remains) → `400`;
  - reorder with the exact id set → `200` and positions swapped; reorder with a wrong id set → `400`;
  - delete → `200`, then `404` on a second delete;
  - cross-project: a `ruleId` from project A under project B's path → `404`.

  Each assertion must be mutation-provable — e.g. the ordering test must fail if `.orderBy(position)` is dropped (seed rules out of insertion order).

- [ ] **Step 4: Docs + route-count guard**
  - Add a "Quarantine rules" section to `docs/API.md` documenting the five endpoints, the rule shape, selector/condition semantics, and first-match-wins + fallback.
  - Run `rtk proxy pnpm --filter api exec vitest run src/routes-auth-coverage.test.ts`. If it reds on the new `GET .../rules`, read the guard: admin routes are `ADMIN_TOKEN`-gated (not `readAuth`) — if the guard's scan is scoped to non-admin `/api/v1` GETs, no change is needed; if it counts admin GETs, bump its hard-coded count by 1 with a comment naming this route. Do **not** mount `readAuth` on an admin route.

- [ ] **Step 5: Run + commit**

Full API suite (Postgres up) green, tsc + lint clean, then:
```bash
git add apps/api/src/routes/admin.ts apps/api/src/routes/admin.test.ts docs/API.md apps/api/src/routes-auth-coverage.test.ts
git commit -m "feat(api): admin CRUD + reorder for quarantine rules"
```

---

## Task 5: Stryker floor + docs + wrap-up

**Files:**
- Modify: `apps/api/stryker.conf.mjs`, `scripts/mutation-gate.mjs`
- Modify: `AGENTS.md`, `plans/README.md`, `docs/STRATEGY.md`

- [ ] **Step 1: Add `services/rules.ts` to the mutation gate**
  Measure a baseline for `services/rules.ts` (scoped Stryker run against a disposable Postgres is unnecessary — `rules.ts` is pure, so a `--mutate src/services/rules.ts` run needs no DB). Set a per-file floor = `floor(reliableLow) − 5` in `scripts/mutation-gate.mjs`, matching the existing entries' calibration. Confirm the broad `apps/api` glob already includes `services/rules.ts` (it does — `src/**/*.ts` minus tests). Regenerate the report and prove the gate is green-on-clean.

- [ ] **Step 2: AGENTS.md sharp-edge note**
  Add a bullet: quarantine promotion is rule-driven when a project has ≥1 enabled `quarantine_rules` row (ordered, first-match-wins, `exempt` action, fallback to the project `quarantineThreshold`); rules can quarantine a **not-yet-globally-flaky** test (a `consecutive` rule), so the promote path **upserts** a `flaky_tests` `ignored` row; `mute_source='auto'` + a `quarantine_events` row (with `rule_id`) are still written; `buildGrepInvert`/base measurement unchanged; the console UI is a deferred fast-follow.

- [ ] **Step 3: Roadmap + backlog**
  - `plans/README.md`: add the 054 row (OPEN, PR pending) and a follow-up entry for the **console UI** (4b's fast-follow) and the **candidate-set N+1 → batched query** optimization.
  - `docs/STRATEGY.md`: flip #4 — 4b engine+API delivered on this branch, rules-UI the fast-follow — via a status callout (preserve the historical audit table per the doc convention).

- [ ] **Step 4: Full local gate**
  API suite (Postgres up) green, dashboard suite green (untouched, but run it), `tsc` clean both packages, `rtk proxy pnpm lint` clean, mutation gate green-on-clean. Tear down Postgres.

- [ ] **Step 5: Commit**
```bash
git add apps/api/stryker.conf.mjs scripts/mutation-gate.mjs AGENTS.md plans/README.md docs/STRATEGY.md
git commit -m "docs(api): document quarantine rule engine + gate services/rules.ts"
```

---

## Notes for the executor

- **Backward-compatibility is the crux.** A project with zero enabled rules must behave byte-for-byte like plan 051 — the `promoteLegacy` extraction is a pure refactor; the existing `quarantine.engine.test.ts` is your regression guard and must stay green untouched.
- **The broadened candidate set is deliberate** (design §3): a `consecutive` rule can quarantine a test that is *not* in `flaky_tests` as active, which is why `promoteWithRules` upserts. Do not "optimize" this back to active-rows-only — that silently drops the feature.
- **Poll, never sleep** for the post-ingest reconcile in any route/E2E-level test; the pure engine and CRUD tests are synchronous.
- **Decimals:** `flake_threshold` writes `.toFixed(4)`, reads `Number(...)`; never compare `numeric >= text` in SQL.
