import { describe, it, expect, beforeAll } from 'vitest';
import { isNull, eq } from 'drizzle-orm';
import { db, projects, teams } from './index';

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb('migration 0012 backfill', () => {
  it('created the Default team', async () => {
    const found = await db.select().from(teams).where(eq(teams.name, 'Default'));
    expect(found).toHaveLength(1);
  });

  it('left no PRE-EXISTING project unassigned — an orphan on upgrade would go invisible in plan 058', async () => {
    // Scoped to rows that predate the Default team, deliberately. The backfill
    // and the Default-team INSERT happen in the same migration, so every
    // project that existed at that instant must now carry a team — that is
    // exactly what this migration promises, and all this test should assert.
    //
    // An unscoped "no project anywhere is orphaned" sweep would be a different
    // claim entirely, and a false one until Task 6 teaches POST /admin/projects
    // to set team_id: other suites in this run create projects concurrently, so
    // the assertion would fail on their rows and stay red for four more tasks,
    // masking real regressions the whole time.
    //
    // Compared in JS rather than SQL on purpose: teams.created_at is
    // timestamptz while projects.created_at is tz-naive (the documented split
    // from plan 056), and letting Postgres coerce one to the other puts a
    // UTC-offset skew right in the middle of the comparison.
    //
    // What makes the JS side safe is NOT that JS Dates are inherently
    // comparable here — it is that drizzle-orm's PgTimestamp
    // .mapFromDriverValue appends "+0000" before parsing whenever
    // `withTimezone` is false. So both values arrive as absolute instants
    // regardless of the process TZ. Read raw through the `postgres` driver
    // instead and a naive column really does skew by the local offset
    // (reproduced: 2h under TZ=Europe/Paris). Keep the reads going through
    // Drizzle, and do not "simplify" this into a SQL-side comparison.
    const [defaultTeam] = await db.select().from(teams).where(eq(teams.name, 'Default'));
    const migratedAt = defaultTeam.createdAt;

    const orphans = (
      await db
        .select({ id: projects.id, name: projects.name, createdAt: projects.createdAt })
        .from(projects)
        .where(isNull(projects.teamId))
    ).filter((p) => p.createdAt < migratedAt);

    expect(
      orphans,
      `these projects predate the 0012 backfill yet have no team, so they will be ` +
        `invisible to non-admins after plan 058: ${orphans.map((p) => p.name).join(', ')}`
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
