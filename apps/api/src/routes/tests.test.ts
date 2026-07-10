import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { db, flakyTests } from '../db';
import { updateFlakyTests } from '../services/flakiness';

const hasDatabase = !!process.env.DATABASE_URL;
const hasAdminToken = !!process.env.ADMIN_TOKEN;
const describeWithDb = hasDatabase && hasAdminToken ? describe : describe.skip;

let app: typeof import('../index').default;
let adminToken: string;
let testProjectId: string;
let testProjectToken: string;

const sampleReport = JSON.parse(
  readFileSync(join(__dirname, '../../fixtures/sample-report.json'), 'utf-8')
);

// A test name present in fixtures/sample-report.json, as the parser stores it
// (suite title path joined with ' › '; file-level suite titles are skipped).
const KNOWN_TEST_NAME = 'Login flow › should login with valid credentials';

beforeAll(async () => {
  if (hasDatabase && hasAdminToken) {
    const module = await import('../index');
    app = module.default;
    adminToken = process.env.ADMIN_TOKEN!;

    // Create a dedicated project and ingest the sample report into it
    const createRes = await app.request('/api/v1/admin/projects', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: `tests-route-test-${Date.now()}` }),
    });
    expect(createRes.status).toBe(201);
    const body = await createRes.json();
    testProjectId = body.project.id;
    testProjectToken = body.token;

    const uploadRes = await app.request('/api/v1/reports?commit=abc123', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${testProjectToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(sampleReport),
    });
    expect(uploadRes.status).toBe(201);
  }
});

afterAll(async () => {
  if (hasDatabase && hasAdminToken && testProjectId) {
    const res = await app.request(`/api/v1/admin/projects/${testProjectId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    // Assert so cleanup failures are visible instead of silently leaking rows
    expect(res.status).toBe(200);
  }
});

describeWithDb('Tests API Integration Tests', () => {
  describe('GET /api/v1/tests/:testName/history', () => {
    it('should return history for a test present in the ingested report', async () => {
      const encodedName = encodeURIComponent(KNOWN_TEST_NAME);
      const res = await app.request(
        `/api/v1/tests/${encodedName}/history?project=${testProjectId}`
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.testName).toBe(KNOWN_TEST_NAME);
      expect(body.stats).toBeDefined();
      expect(body.stats.totalRuns).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(body.history)).toBe(true);
      expect(body.history.length).toBeGreaterThanOrEqual(1);
      expect(body.history[0].branch).toBe('main');
      expect(body.history[0].commitSha).toBe('abc123');
      // sample-report.json's test cases carry no tags/annotations -> NULL columns.
      expect(body.history[0].tags).toBeNull();
      expect(body.history[0].annotations).toBeNull();
    });

    it('should require project parameter', async () => {
      const res = await app.request('/api/v1/tests/some-test/history');
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toContain('project');
    });

    it('should reject a non-UUID project parameter', async () => {
      const res = await app.request('/api/v1/tests/some-test/history?project=not-a-uuid');
      expect(res.status).toBe(400);
    });

    it('should return empty history and zero stats for an unknown test name', async () => {
      // Current behavior: unknown test names are not a 404, they return an
      // empty result set — assert it.
      const res = await app.request(
        `/api/v1/tests/totally-unknown-test/history?project=${testProjectId}`
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.history).toEqual([]);
      expect(body.stats.totalRuns).toBe(0);
    });

    it('should handle a test name containing a percent sign without double-decoding', async () => {
      // Regression test: the route must not re-decode an already-decoded
      // param, or a name like "loads 100% of items" throws URIError.
      const encodedName = encodeURIComponent('loads 100% of items');
      const res = await app.request(
        `/api/v1/tests/${encodedName}/history?project=${testProjectId}`
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.testName).toBe('loads 100% of items');
    });
  });

  describe('GET /api/v1/tests/flaky/:id', () => {
    it('should return 404 for a non-existent flaky test id', async () => {
      const res = await app.request(`/api/v1/tests/flaky/${randomUUID()}`);
      expect(res.status).toBe(404);
    });

    it('should return 400 for a malformed flaky test id', async () => {
      const res = await app.request('/api/v1/tests/flaky/not-a-uuid');
      expect(res.status).toBe(400);
    });
  });

  describe('PATCH /api/v1/tests/flaky/:id', () => {
    let flakyId: string;

    beforeAll(async () => {
      // Seed a flaky_tests row directly — the PATCH route only cares about
      // an existing row, not how it got flagged flaky.
      const [row] = await db
        .insert(flakyTests)
        .values({
          projectId: testProjectId,
          testName: 'patch-route-flaky-test',
          testFile: 'patch.spec.ts',
          status: 'active',
          flakeCount: 2,
          totalRuns: 10,
          flakeRate: '0.2000',
        })
        .returning({ id: flakyTests.id });
      flakyId = row.id;
    });

    it('should require authentication', async () => {
      const res = await app.request(`/api/v1/tests/flaky/${flakyId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'ignored' }),
      });
      expect(res.status).toBe(401);
    });

    it('should reject an invalid admin token', async () => {
      const res = await app.request(`/api/v1/tests/flaky/${flakyId}`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer not-the-admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: 'ignored' }),
      });
      expect(res.status).toBe(401);
    });

    it('should mute a flaky test (status -> ignored) and persist it', async () => {
      const res = await app.request(`/api/v1/tests/flaky/${flakyId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: 'ignored' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.flakyTest.id).toBe(flakyId);
      expect(body.flakyTest.status).toBe('ignored');

      // Re-fetch to confirm the write was persisted, not just echoed back.
      const getRes = await app.request(`/api/v1/tests/flaky/${flakyId}`);
      expect(getRes.status).toBe(200);
      const getBody = await getRes.json();
      expect(getBody.flakyTest.status).toBe('ignored');
    });

    it('should unmute a flaky test (status -> active)', async () => {
      const res = await app.request(`/api/v1/tests/flaky/${flakyId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: 'active' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.flakyTest.status).toBe('active');
    });

    it('should reject status "resolved" (system-managed, not operator-settable)', async () => {
      const res = await app.request(`/api/v1/tests/flaky/${flakyId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: 'resolved' }),
      });
      expect(res.status).toBe(400);
    });

    it('should reject an unrecognized status value', async () => {
      const res = await app.request(`/api/v1/tests/flaky/${flakyId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: 'bogus' }),
      });
      expect(res.status).toBe(400);
    });

    it('should reject a non-JSON body', async () => {
      const res = await app.request(`/api/v1/tests/flaky/${flakyId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: 'not json',
      });
      expect(res.status).toBe(400);
    });

    it('should return 404 for a valid body but unknown flaky test id', async () => {
      const res = await app.request(`/api/v1/tests/flaky/${randomUUID()}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: 'ignored' }),
      });
      expect(res.status).toBe(404);
    });

    it('should return 400 for a malformed id, even with a valid body', async () => {
      const res = await app.request('/api/v1/tests/flaky/not-a-uuid', {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: 'ignored' }),
      });
      expect(res.status).toBe(400);
    });

    it('should keep an ignored test ignored across a reconcile pass', async () => {
      // Mute it again (previous test left it 'active').
      const muteRes = await app.request(`/api/v1/tests/flaky/${flakyId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: 'ignored' }),
      });
      expect(muteRes.status).toBe(200);

      // Reconcile shouldn't silently un-mute it, whether or not the test
      // still shows up in fresh flakiness analysis.
      await updateFlakyTests(testProjectId);

      const getRes = await app.request(`/api/v1/tests/flaky/${flakyId}`);
      expect(getRes.status).toBe(200);
      const getBody = await getRes.json();
      expect(getBody.flakyTest.status).toBe('ignored');
    });
  });
});
