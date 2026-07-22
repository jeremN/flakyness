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
