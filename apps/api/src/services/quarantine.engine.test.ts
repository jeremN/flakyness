import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { db, projects, testRuns, testResults, flakyTests, quarantineEvents } from '../db';
import { eq, inArray } from 'drizzle-orm';
import { reconcileQuarantine } from './quarantine';

const hasDb = !!process.env.DATABASE_URL;
const describeWithDb = hasDb ? describe : describe.skip;

const createdProjectIds: string[] = [];

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
    createdProjectIds.push(projectId);
  });
  afterAll(async () => {
    if (createdProjectIds.length > 0) {
      await db.delete(projects).where(inArray(projects.id, createdProjectIds));
    }
  });

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
    await seedFlaky({ testName: 't2', status: 'ignored', muteSource: null });
    const out = await reconcileQuarantine(projectId, project());
    expect(out).toEqual([]);
    const rows = await db.select().from(flakyTests).where(eq(flakyTests.projectId, projectId));
    expect(rows.every(r => r.status === 'ignored')).toBe(true);
  });
});
