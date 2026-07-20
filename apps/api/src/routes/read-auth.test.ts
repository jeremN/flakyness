import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import app from '../index';

/**
 * Behavioural counterpart to routes-auth-coverage.test.ts: that file asserts
 * readAuth is MOUNTED, this one asserts it WORKS. Neither subsumes the other
 * — a mounted middleware with inverted logic passes the coverage guard.
 *
 * The blocks below need no database: every assertion is about the 401 path,
 * which READ_TOKEN short-circuits before any query. The project-token
 * fallback — including the cross-project rejection, which is the security
 * property this whole plan exists to establish — is DB-backed and lives in
 * the describeWithDb block at the bottom of this file.
 */

const PROBE = '/api/v1/projects/00000000-0000-0000-0000-000000000000/stats';

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

  it('401 avec un mauvais token', async () => {
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

  it('le PATCH admin reste gouverné par ADMIN_TOKEN, pas par READ_TOKEN', async () => {
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
const hasDatabase = !!process.env.DATABASE_URL;
const hasAdminToken = !!process.env.ADMIN_TOKEN;
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
});
