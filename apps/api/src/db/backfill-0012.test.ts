import { describe, it, expect, beforeAll } from 'vitest';
import { isNull, eq } from 'drizzle-orm';
import { db, projects, teams } from './index';

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb('migration 0012 backfill', () => {
  it('created the Default team', async () => {
    const found = await db.select().from(teams).where(eq(teams.name, 'Default'));
    expect(found).toHaveLength(1);
  });

  it('left no project unassigned — an orphan on a fresh upgrade would go invisible in plan 058', async () => {
    const orphans = await db.select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(isNull(projects.teamId));
    expect(
      orphans,
      `these projects have no team and will be invisible to non-admins after plan 058: ` +
        orphans.map((p) => p.name).join(', ')
    ).toEqual([]);
  });
});

const hasDatabase = !!process.env.DATABASE_URL;
const hasAdminToken = !!process.env.ADMIN_TOKEN;
const describeMachine = hasDatabase && hasAdminToken ? describe : describe.skip;

let app: typeof import('../index').default;
beforeAll(async () => {
  if (hasDatabase) app = (await import('../index')).default;
});

describeMachine('machine credentials survive migration 0012', () => {
  it('a per-project ingest token still ingests', async () => {
    const created = await (
      await app.request('/api/v1/admin/projects', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.ADMIN_TOKEN}`,
        },
        body: JSON.stringify({ name: `machine-${crypto.randomUUID().slice(0, 8)}` }),
      })
    ).json();

    const startTime = new Date().toISOString();
    // The reports endpoint takes branch/commit as query params (not body
    // fields) and expects the raw Playwright report as the body — see
    // routes/reports.ts. The brief's sample nested them under a `report` key
    // in the body, which 400s on the required `commit` query param; this is
    // the shape every other reports.test.ts case actually uses.
    const res = await app.request(`/api/v1/reports?branch=main&commit=${'b'.repeat(40)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${created.token}`,
      },
      body: JSON.stringify({
        config: {},
        suites: [
          {
            title: 'compat.spec.ts',
            file: 'compat.spec.ts',
            specs: [
              {
                title: 'still ingests',
                ok: true,
                tests: [
                  { results: [{ workerIndex: 0, status: 'passed', duration: 5, retry: 0, startTime }] },
                ],
              },
            ],
          },
        ],
      }),
    });

    expect(res.status).toBe(201);
  });
});
