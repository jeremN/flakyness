import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import app from '../index';

/**
 * Behavioural counterpart to routes-auth-coverage.test.ts: that file asserts
 * readAuth is MOUNTED, this one asserts it WORKS. Neither subsumes the other
 * — a mounted middleware with inverted logic passes the coverage guard.
 *
 * Most of the block below needs no database: READ_TOKEN's own comparison is
 * constant-time and in-memory, so the "no token" / "correct token" cases
 * short-circuit before any query. Two assertions do not, and are gated
 * accordingly via `it.skipIf`:
 *   - "401 avec un mauvais token" sends a non-matching Bearer token to a
 *     project-scoped route, which falls through readAuth to its
 *     project-token fallback and calls db.query.projects.findFirst. Without
 *     DATABASE_URL, the lazy `db` Proxy (db/index.ts) throws synchronously
 *     and the request 500s instead of 401ing — skipped unless `hasDatabase`.
 *   - "le PATCH admin reste gouverné par ADMIN_TOKEN" hits adminAuth(),
 *     which itself 500s when ADMIN_TOKEN is unset, before ever comparing
 *     tokens — skipped unless `hasAdminToken`.
 * Both stay in this describe (rather than moving to describeWithDb below)
 * because they only need the bare env var, not the fixture projects that
 * block creates.
 *
 * The project-token fallback's remaining behaviour — including the
 * cross-project rejection, which is the security property this whole plan
 * exists to establish — is DB-backed and lives in the describeWithDb block
 * at the bottom of this file.
 */

const PROBE = '/api/v1/projects/00000000-0000-0000-0000-000000000000/stats';

// Declared here, not just below describeWithDb, because two assertions in
// the block immediately below use `it.skipIf` against these same flags.
const hasDatabase = !!process.env.DATABASE_URL;
const hasAdminToken = !!process.env.ADMIN_TOKEN;

describe('read endpoint gating', () => {
  afterEach(() => {
    delete process.env.READ_TOKEN;
  });

  it('mode ouvert : pas de 401 quand READ_TOKEN est absent', async () => {
    delete process.env.READ_TOKEN;
    const res = await app.request(PROBE);
    expect(res.status).not.toBe(401);
  });

  it('401 sans credential quand READ_TOKEN est défini', async () => {
    process.env.READ_TOKEN = 'read-secret';
    const res = await app.request(PROBE);
    expect(res.status).toBe(401);
  });

  it.skipIf(!hasDatabase)('401 avec un mauvais token', async () => {
    process.env.READ_TOKEN = 'read-secret';
    const res = await app.request(PROBE, {
      headers: { Authorization: 'Bearer nope' },
    });
    expect(res.status).toBe(401);
  });

  it('pas de 401 avec le bon READ_TOKEN', async () => {
    process.env.READ_TOKEN = 'read-secret';
    const res = await app.request(PROBE, {
      headers: { Authorization: 'Bearer read-secret' },
    });
    expect(res.status).not.toBe(401);
  });

  it('l’énumération des projets est fermée quand READ_TOKEN est défini', async () => {
    process.env.READ_TOKEN = 'read-secret';
    const res = await app.request('/api/v1/projects');
    expect(res.status).toBe(401);
  });

  it.skipIf(!hasAdminToken)('le PATCH admin reste gouverné par ADMIN_TOKEN, pas par READ_TOKEN', async () => {
    process.env.READ_TOKEN = 'read-secret';
    const res = await app.request('/api/v1/tests/flaky/00000000-0000-0000-0000-000000000000', {
      method: 'PATCH',
      headers: { Authorization: 'Bearer read-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'ignored' }),
    });
    // READ_TOKEN must NOT grant an admin write. Anything but 2xx is correct
    // here; 401 is the expected value.
    expect(res.status).toBe(401);
  });
});

// The admin API returns a project's token exactly once, at creation
// (admin.ts:155) — that is why both projects are created here rather than
// reusing a fixture.
const describeWithDb = hasDatabase && hasAdminToken ? describe : describe.skip;

describeWithDb('read endpoint gating — project-token fallback', () => {
  let adminToken: string;
  let projectA: { id: string; token: string };
  let projectB: { id: string; token: string };

  async function createProject(name: string) {
    const res = await app.request('/api/v1/admin/projects', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    // POST /api/v1/admin/projects returns `token` at the top level, not
    // nested under `project` (admin.ts:153-157) — matches the idiom already
    // used by admin.test.ts.
    return { id: body.project.id, token: body.token };
  }

  beforeAll(async () => {
    adminToken = process.env.ADMIN_TOKEN!;
    projectA = await createProject(`read-auth-a-${Date.now()}`);
    projectB = await createProject(`read-auth-b-${Date.now()}`);
  });

  afterAll(async () => {
    for (const p of [projectA, projectB]) {
      if (!p?.id) continue;
      const res = await app.request(`/api/v1/admin/projects/${p.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      // Assert so cleanup failures are visible instead of leaking rows.
      expect(res.status).toBe(200);
    }
  });

  afterEach(() => {
    delete process.env.READ_TOKEN;
  });

  it('accepte le token du projet visé', async () => {
    process.env.READ_TOKEN = 'read-secret';
    const res = await app.request(`/api/v1/projects/${projectA.id}/stats`, {
      headers: { Authorization: `Bearer ${projectA.token}` },
    });
    expect(res.status).toBe(200);
  });

  it('REJETTE le token d’un autre projet (propriété centrale du plan)', async () => {
    process.env.READ_TOKEN = 'read-secret';
    const res = await app.request(`/api/v1/projects/${projectA.id}/stats`, {
      headers: { Authorization: `Bearer ${projectB.token}` },
    });
    expect(res.status).toBe(401);
  });

  it('refuse un token projet sur l’énumération (READ_TOKEN seul, D6)', async () => {
    process.env.READ_TOKEN = 'read-secret';
    const res = await app.request('/api/v1/projects', {
      headers: { Authorization: `Bearer ${projectA.token}` },
    });
    expect(res.status).toBe(401);
  });

  it('scope par la query ?project= sur les routes /tests/*', async () => {
    process.env.READ_TOKEN = 'read-secret';
    const ok = await app.request(
      `/api/v1/tests/some-test/history?project=${projectA.id}`,
      { headers: { Authorization: `Bearer ${projectA.token}` } }
    );
    expect(ok.status).toBe(200);

    const denied = await app.request(
      `/api/v1/tests/some-test/history?project=${projectA.id}`,
      { headers: { Authorization: `Bearer ${projectB.token}` } }
    );
    expect(denied.status).toBe(401);
  });

  // Matrix over ALL 9 project-scoped read routes (the two above only cover
  // /stats and /tests/*/history). The coverage guard in
  // routes-auth-coverage.test.ts proves readAuth is MOUNTED on every read
  // route; it does not — cannot — prove the resolver passed to it is wired
  // to the right field. A route written as
  // `readAuth((c) => c.req.query('project'))` on a `/projects/:id/*` path
  // would pass that guard AND pass a naive cross-project test that never
  // sends `?project=` — the wrong resolver reads `undefined`, which falls
  // through readAuth's project-fallback branch entirely and lands on the
  // generic 401, indistinguishable from a correctly-wired route.
  //
  // So every `/projects/:id/*` row below deliberately appends
  // `?project=<projectB.id>` — i.e. the attacker's OWN project — on top of
  // the URL's `:id` (projectA's). Against the correct resolver
  // (`c.req.param('id')`), that query string is inert: it's still 401. But
  // it is exactly the shape of the real attack this guard exists to catch
  // (`/projects/<A>/stats?project=<B>`): a resolver that reads
  // `query('project')` instead of `param('id')` would see `wanted = B`,
  // find that project B's token DOES belong to project B, and grant access
  // — serving project A's data. Confirmed empirically: mutating one route
  // to `readAuth((c) => c.req.query('project'))` without this query
  // parameter left the matrix green; adding it is what makes the matrix
  // catch that exact mutation (see the commit history / PR description for
  // the before/after run).
  //
  // A failure names the offending route via `$name`.
  //
  // The /runs/:runId row uses a syntactically valid but non-existent UUID:
  // readAuth's resolver here only reads `c.req.param('id')` (the project),
  // so the 401 must fire before the handler ever looks up the run row.
  const FAKE_RUN_ID = '11111111-1111-4111-8111-111111111111';
  const CROSS_PROJECT_ROUTES: Array<{ name: string; path: (idA: string, idB: string) => string }> = [
    { name: '/projects/:id/stats', path: (a, b) => `/api/v1/projects/${a}/stats?project=${b}` },
    {
      name: '/projects/:id/flaky-tests',
      path: (a, b) => `/api/v1/projects/${a}/flaky-tests?project=${b}`,
    },
    {
      name: '/projects/:id/quarantine',
      path: (a, b) => `/api/v1/projects/${a}/quarantine?project=${b}`,
    },
    { name: '/projects/:id/runs', path: (a, b) => `/api/v1/projects/${a}/runs?project=${b}` },
    {
      name: '/projects/:id/runs/:runId',
      path: (a, b) => `/api/v1/projects/${a}/runs/${FAKE_RUN_ID}?project=${b}`,
    },
    { name: '/projects/:id/analysis', path: (a, b) => `/api/v1/projects/${a}/analysis?project=${b}` },
    { name: '/projects/:id/trend', path: (a, b) => `/api/v1/projects/${a}/trend?project=${b}` },
    {
      name: '/tests/:testName/history?project=',
      path: (a) => `/api/v1/tests/some-test/history?project=${a}`,
    },
    {
      name: '/tests/:testName/trend?project=',
      path: (a) => `/api/v1/tests/some-test/trend?project=${a}`,
    },
  ];

  it.each(CROSS_PROJECT_ROUTES)(
    'REJETTE le token du projet B sur $name (matrice des 9 routes scoped)',
    async ({ path }) => {
      process.env.READ_TOKEN = 'read-secret';
      const res = await app.request(path(projectA.id, projectB.id), {
        headers: { Authorization: `Bearer ${projectB.token}` },
      });
      expect(res.status).toBe(401);
    }
  );
});
