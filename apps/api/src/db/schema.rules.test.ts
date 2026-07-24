import { describe, it, expect, afterAll } from 'vitest';
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
