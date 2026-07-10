import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

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
});
