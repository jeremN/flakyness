import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { db, projects, flakyTests, quarantineEvents } from '../db';
import { reconcileQuarantine } from './quarantine';

const hasDb = !!process.env.DATABASE_URL;
const hasAdminToken = !!process.env.ADMIN_TOKEN;
const describeWithDb = hasDb && hasAdminToken ? describe : describe.skip;

/**
 * Backlog #16: a status transition and its quarantine_events row commit
 * together, or not at all. AGENTS.md requires a complete audit trail for every
 * mute and unmute, auto and manual.
 *
 * The failure is real, not mocked: a trigger makes Postgres reject the audit
 * insert. It fires only for test names with PREFIX, so the other test files
 * that share this database are not affected.
 */
const PREFIX = 'atomic-audit-';

describeWithDb('quarantine status and audit row commit together (backlog #16)', () => {
  const createdProjectIds: string[] = [];
  let app: typeof import('../index').default;

  beforeAll(async () => {
    app = (await import('../index')).default;
    await db.execute(sql.raw(`
      create or replace function fk_test_fail_audit() returns trigger as $$
      begin
        if NEW.test_name like '${PREFIX}%' then
          raise exception 'injected audit failure';
        end if;
        return NEW;
      end $$ language plpgsql;
      drop trigger if exists fk_test_fail_audit on quarantine_events;
      create trigger fk_test_fail_audit before insert on quarantine_events
        for each row execute function fk_test_fail_audit();
    `));
  });

  afterAll(async () => {
    await db.execute(sql.raw(`
      drop trigger if exists fk_test_fail_audit on quarantine_events;
      drop function if exists fk_test_fail_audit();
    `));
    if (createdProjectIds.length) await db.delete(projects).where(inArray(projects.id, createdProjectIds));
  });

  async function seedProject() {
    const [p] = await db
      .insert(projects)
      .values({ name: `atomic-${Date.now()}-${Math.random()}`, tokenHash: 'y'.repeat(64) })
      .returning();
    createdProjectIds.push(p.id);
    return p.id;
  }

  const enabled = {
    autoQuarantineEnabled: true,
    quarantineThreshold: '0.2000',
    quarantineMinRuns: 3,
    quarantineTtlDays: 7,
    flakeThreshold: null,
    windowDays: null,
    minRuns: null,
  };

  it('reconcileQuarantine: a failed audit insert rolls back the release AND the promotion', async () => {
    const projectId = await seedProject();
    // One row to release (expired auto-mute) and one to promote, so both
    // phases write before the audit insert fails.
    await db.insert(flakyTests).values([
      {
        projectId,
        testName: `${PREFIX}release`,
        status: 'ignored',
        muteSource: 'auto',
        quarantineExpiresAt: new Date(Date.now() - 1000),
        flakeRate: '0.5000',
        totalRuns: 10,
      },
      { projectId, testName: `${PREFIX}promote`, status: 'active', flakeRate: '0.5000', totalRuns: 10 },
    ]);

    await expect(reconcileQuarantine(projectId, enabled)).rejects.toThrow();

    const rows = await db.select().from(flakyTests).where(eq(flakyTests.projectId, projectId));
    const byName = Object.fromEntries(rows.map((r) => [r.testName, r]));
    // Both rows are exactly as seeded: nothing changed without an audit row.
    expect(byName[`${PREFIX}release`]).toMatchObject({ status: 'ignored', muteSource: 'auto' });
    expect(byName[`${PREFIX}release`].quarantineReleasedAt).toBeNull();
    expect(byName[`${PREFIX}promote`]).toMatchObject({ status: 'active', muteSource: null });
    expect(await db.select().from(quarantineEvents).where(eq(quarantineEvents.projectId, projectId))).toEqual([]);
  });

  it('PATCH /tests/flaky/:id: a failed audit insert leaves the test unmuted', async () => {
    const projectId = await seedProject();
    const [row] = await db
      .insert(flakyTests)
      .values({ projectId, testName: `${PREFIX}manual`, status: 'active', flakeRate: '0.5000', totalRuns: 10 })
      .returning();

    const res = await app.request(`/api/v1/tests/flaky/${row.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.ADMIN_TOKEN}` },
      body: JSON.stringify({ status: 'ignored' }),
    });
    expect(res.status).toBe(500);

    const [after] = await db.select().from(flakyTests).where(eq(flakyTests.id, row.id));
    expect(after).toMatchObject({ status: 'active', muteSource: null });
    expect(await db.select().from(quarantineEvents).where(eq(quarantineEvents.projectId, projectId))).toEqual([]);
  });

  it('the trigger only bites its own prefix: a normal mute still commits with its audit row', async () => {
    // Control: without it, both tests above would also pass if every PATCH
    // failed for some unrelated reason.
    const projectId = await seedProject();
    const [row] = await db
      .insert(flakyTests)
      .values({ projectId, testName: 'normal-test', status: 'active', flakeRate: '0.5000', totalRuns: 10 })
      .returning();
    const res = await app.request(`/api/v1/tests/flaky/${row.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.ADMIN_TOKEN}` },
      body: JSON.stringify({ status: 'ignored' }),
    });
    expect(res.status).toBe(200);
    const events = await db.select().from(quarantineEvents).where(eq(quarantineEvents.projectId, projectId));
    expect(events.map((e) => e.event)).toEqual(['manual_mute']);
  });
});
