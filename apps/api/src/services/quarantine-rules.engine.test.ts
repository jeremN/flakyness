import { describe, it, expect, afterAll } from 'vitest';
import { db, projects, testRuns, testResults, flakyTests, quarantineRules, quarantineEvents } from '../db';
import { reconcileQuarantine, type ProjectQuarantineOverrides } from './quarantine';
import { and, eq } from 'drizzle-orm';

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

  // Backlog #16 (mutation gate): pins the VALUES a rule-driven promotion
  // writes, not just its outcome. Mixed statuses so the flake rate counts
  // `failed` and `flaky` only: 3 failed + 1 flaky of 8 results = 0.5. A
  // skipped or passed result counted as bad would give 1.0 or 0.875.
  it('a rule-driven promotion records the slice flake rate, run count and rule provenance', async () => {
    const p = await project();
    const [rule] = await db.insert(quarantineRules).values({ projectId: p.id, position: 0, action: 'quarantine', conditionType: 'consecutive', consecutiveFailures: 3, selectorBranch: 'main' }).returning();
    for (let d = 0; d < 3; d++) await run(p.id, 'M', 'failed', 'main', d, 'e2e/m.spec.ts');
    await run(p.id, 'M', 'flaky', 'main', 3, 'e2e/m.spec.ts');
    for (const d of [4, 5]) await run(p.id, 'M', 'passed', 'main', d, 'e2e/m.spec.ts');
    for (const d of [6, 7]) await run(p.id, 'M', 'skipped', 'main', d, 'e2e/m.spec.ts');

    const transitions = await reconcileQuarantine(p.id, asOverrides(p));
    const entered = transitions.find((t) => t.testName === 'M' && t.event === 'entered');
    expect(entered).toMatchObject({ flakeRate: 0.5, ruleId: rule.id });

    const [row] = await db.select().from(flakyTests).where(eq(flakyTests.projectId, p.id));
    expect(row).toMatchObject({ flakeRate: '0.5000', totalRuns: 8, testFile: 'e2e/m.spec.ts', status: 'ignored', muteSource: 'auto' });

    const [ev] = await db.select().from(quarantineEvents).where(eq(quarantineEvents.projectId, p.id));
    // Rule-driven: rule_id is the provenance; the project threshold and TTL
    // would mislead, so both are null.
    expect(ev).toMatchObject({ event: 'entered', source: 'auto', flakeRate: '0.5000', ruleId: rule.id, threshold: null, ttlDays: null });
  });

  it('does NOT re-enter an already auto-quarantined test on a repeat reconcile (no duplicate webhook/audit; Release owns its TTL)', async () => {
    const p = await project();
    await db.insert(quarantineRules).values({ projectId: p.id, position: 0, action: 'quarantine', conditionType: 'consecutive', consecutiveFailures: 3, selectorBranch: 'main' });
    for (let d = 0; d < 3; d++) await run(p.id, 'RT', 'failed', 'main', d); // fires consecutive:3 now and stays in-window

    const first = await reconcileQuarantine(p.id, asOverrides(p));
    expect(first.filter((t) => t.testName === 'RT' && t.event === 'entered')).toHaveLength(1);

    // Second reconcile: the same 3 failures still fire the rule, but the row is
    // now auto-ignored. An already-quarantined row must be skipped — re-entering
    // would spam a duplicate `entered` webhook + audit row and keep pushing the
    // TTL out so Release never fires.
    const second = await reconcileQuarantine(p.id, asOverrides(p));
    expect(second.filter((t) => t.testName === 'RT' && t.event === 'entered')).toHaveLength(0);

    const enteredRows = await db.select().from(quarantineEvents)
      .where(and(eq(quarantineEvents.projectId, p.id), eq(quarantineEvents.event, 'entered')));
    expect(enteredRows).toHaveLength(1); // exactly one audit row across both reconciles
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

  it('a manually-muted test is immune to a matching quarantine rule (never converted to auto)', async () => {
    const p = await project();
    await db.insert(quarantineRules).values({ projectId: p.id, position: 0, action: 'quarantine', conditionType: 'consecutive', consecutiveFailures: 3, selectorBranch: 'main' });
    for (let d = 0; d < 3; d++) await run(p.id, 'MAN', 'failed', 'main', d); // would fire the consecutive rule
    // Operator manually muted it: indefinite, no expiry.
    await db.insert(flakyTests).values({ projectId: p.id, testName: 'MAN', flakeRate: '0.5000', totalRuns: 3, status: 'ignored', muteSource: 'manual' });
    await reconcileQuarantine(p.id, asOverrides(p));
    const [row] = await db.select().from(flakyTests).where(and(eq(flakyTests.projectId, p.id), eq(flakyTests.testName, 'MAN')));
    expect(row.muteSource).toBe('manual');       // NOT stomped to 'auto'
    expect(row.quarantineExpiresAt).toBeNull();  // no TTL → Release can never touch it
    expect(row.status).toBe('ignored');          // still muted
  });
});
