import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const hasDatabase = !!process.env.DATABASE_URL;
const hasAdminToken = !!process.env.ADMIN_TOKEN;
const describeWithDb = hasDatabase && hasAdminToken ? describe : describe.skip;

let app: typeof import('../index').default;
let adminToken: string;
let testProjectId: string;

beforeAll(async () => {
  if (hasDatabase && hasAdminToken) {
    const module = await import('../index');
    app = module.default;
    adminToken = process.env.ADMIN_TOKEN!;

    // Create a dedicated project so the suite never depends on pre-existing data
    const res = await app.request('/api/v1/admin/projects', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: `projects-test-${Date.now()}` }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    testProjectId = body.project.id;
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

describeWithDb('Projects API Integration Tests', () => {
  describe('GET /api/v1/projects', () => {
    it('should return array of projects including the fixture project', async () => {
      const res = await app.request('/api/v1/projects');
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.projects).toBeDefined();
      expect(Array.isArray(body.projects)).toBe(true);
      expect(body.projects.length).toBeGreaterThanOrEqual(1);

      for (const project of body.projects) {
        expect(project.id).toBeDefined();
        expect(project.name).toBeDefined();
        expect(project.createdAt).toBeDefined();
      }

      const ids = body.projects.map((p: { id: string }) => p.id);
      expect(ids).toContain(testProjectId);
    });
  });

  describe('GET /api/v1/projects/:id', () => {
    it('should return 404 — the bare route was removed as a duplicate of /stats', async () => {
      const res = await app.request(`/api/v1/projects/${testProjectId}`);
      expect(res.status).toBe(404);
    });

    it('should return 404 for non-existent project', async () => {
      const res = await app.request('/api/v1/projects/00000000-0000-0000-0000-000000000000');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/v1/projects/:id/stats', () => {
    it('should return project stats', async () => {
      const res = await app.request(`/api/v1/projects/${testProjectId}/stats`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.project).toBeDefined();
      expect(typeof body.activeFlakyTests).toBe('number');
      expect(typeof body.totalRuns).toBe('number');
    });
  });

  describe('GET /api/v1/projects/:id/flaky-tests', () => {
    it('should return flaky tests array', async () => {
      const res = await app.request(`/api/v1/projects/${testProjectId}/flaky-tests`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.flakyTests).toBeDefined();
      expect(Array.isArray(body.flakyTests)).toBe(true);
    });

    it('should filter by status', async () => {
      const res = await app.request(`/api/v1/projects/${testProjectId}/flaky-tests?status=resolved`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(Array.isArray(body.flakyTests)).toBe(true);
    });

    it('should return all when status=all', async () => {
      const res = await app.request(`/api/v1/projects/${testProjectId}/flaky-tests?status=all`);
      expect(res.status).toBe(200);
    });
  });

  describe('GET /api/v1/projects/:id/runs', () => {
    it('should return test runs array', async () => {
      const res = await app.request(`/api/v1/projects/${testProjectId}/runs`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.runs).toBeDefined();
      expect(Array.isArray(body.runs)).toBe(true);
    });

    it('should respect limit parameter', async () => {
      const res = await app.request(`/api/v1/projects/${testProjectId}/runs?limit=5`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.runs.length).toBeLessThanOrEqual(5);
    });

    it('should clamp limit to max 100', async () => {
      const res = await app.request(`/api/v1/projects/${testProjectId}/runs?limit=500`);
      expect(res.status).toBe(200);

      // Should work but internally clamped to 100
      const body = await res.json();
      expect(body.runs.length).toBeLessThanOrEqual(100);
    });

    it('should clamp limit to min 1', async () => {
      const res = await app.request(`/api/v1/projects/${testProjectId}/runs?limit=0`);
      expect(res.status).toBe(200);
    });
  });

  describe('GET /api/v1/projects/:id/analysis', () => {
    it('should return real-time flakiness analysis', async () => {
      const res = await app.request(`/api/v1/projects/${testProjectId}/analysis`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.windowDays).toBeDefined();
      expect(body.threshold).toBeDefined();
      expect(body.flakyTests).toBeDefined();
      expect(body.allTests).toBeDefined();
    });

    it('should accept custom window and threshold', async () => {
      const res = await app.request(`/api/v1/projects/${testProjectId}/analysis?days=7&threshold=0.1`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.windowDays).toBe(7);
      expect(body.threshold).toBe(0.1);
    });
  });
});
