import { describe, it, expect, beforeAll } from 'vitest';

const hasDatabase = !!process.env.DATABASE_URL;
const describeWithDb = hasDatabase ? describe : describe.skip;

let app: typeof import('../index').default;

beforeAll(async () => {
  if (hasDatabase) {
    const module = await import('../index');
    app = module.default;
  }
});

describeWithDb('Projects API Integration Tests', () => {
  let testProjectId: string;

  describe('GET /api/v1/projects', () => {
    it('should return array of projects', async () => {
      const res = await app.request('/api/v1/projects');
      expect(res.status).toBe(200);
      
      const body = await res.json();
      expect(body.projects).toBeDefined();
      expect(Array.isArray(body.projects)).toBe(true);
      
      if (body.projects.length > 0) {
        testProjectId = body.projects[0].id;
        expect(body.projects[0].name).toBeDefined();
        expect(body.projects[0].createdAt).toBeDefined();
      }
    });
  });

  describe('GET /api/v1/projects/:id', () => {
    it('should return project details', async () => {
      if (!testProjectId) return;
      
      const res = await app.request(`/api/v1/projects/${testProjectId}`);
      expect(res.status).toBe(200);
      
      const body = await res.json();
      expect(body.project).toBeDefined();
    });

    it('should return 404 for non-existent project', async () => {
      const res = await app.request('/api/v1/projects/00000000-0000-0000-0000-000000000000');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/v1/projects/:id/stats', () => {
    it('should return project stats', async () => {
      if (!testProjectId) return;
      
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
      if (!testProjectId) return;
      
      const res = await app.request(`/api/v1/projects/${testProjectId}/flaky-tests`);
      expect(res.status).toBe(200);
      
      const body = await res.json();
      expect(body.flakyTests).toBeDefined();
      expect(Array.isArray(body.flakyTests)).toBe(true);
    });

    it('should filter by status', async () => {
      if (!testProjectId) return;
      
      const res = await app.request(`/api/v1/projects/${testProjectId}/flaky-tests?status=resolved`);
      expect(res.status).toBe(200);
      
      const body = await res.json();
      expect(Array.isArray(body.flakyTests)).toBe(true);
    });

    it('should return all when status=all', async () => {
      if (!testProjectId) return;
      
      const res = await app.request(`/api/v1/projects/${testProjectId}/flaky-tests?status=all`);
      expect(res.status).toBe(200);
    });
  });

  describe('GET /api/v1/projects/:id/runs', () => {
    it('should return test runs array', async () => {
      if (!testProjectId) return;
      
      const res = await app.request(`/api/v1/projects/${testProjectId}/runs`);
      expect(res.status).toBe(200);
      
      const body = await res.json();
      expect(body.runs).toBeDefined();
      expect(Array.isArray(body.runs)).toBe(true);
    });

    it('should respect limit parameter', async () => {
      if (!testProjectId) return;
      
      const res = await app.request(`/api/v1/projects/${testProjectId}/runs?limit=5`);
      expect(res.status).toBe(200);
      
      const body = await res.json();
      expect(body.runs.length).toBeLessThanOrEqual(5);
    });

    it('should clamp limit to max 100', async () => {
      if (!testProjectId) return;
      
      const res = await app.request(`/api/v1/projects/${testProjectId}/runs?limit=500`);
      expect(res.status).toBe(200);
      
      // Should work but internally clamped to 100
      const body = await res.json();
      expect(body.runs.length).toBeLessThanOrEqual(100);
    });

    it('should clamp limit to min 1', async () => {
      if (!testProjectId) return;
      
      const res = await app.request(`/api/v1/projects/${testProjectId}/runs?limit=0`);
      expect(res.status).toBe(200);
    });
  });

  describe('GET /api/v1/projects/:id/analysis', () => {
    it('should return real-time flakiness analysis', async () => {
      if (!testProjectId) return;
      
      const res = await app.request(`/api/v1/projects/${testProjectId}/analysis`);
      expect(res.status).toBe(200);
      
      const body = await res.json();
      expect(body.windowDays).toBeDefined();
      expect(body.threshold).toBeDefined();
      expect(body.flakyTests).toBeDefined();
      expect(body.allTests).toBeDefined();
    });

    it('should accept custom window and threshold', async () => {
      if (!testProjectId) return;
      
      const res = await app.request(`/api/v1/projects/${testProjectId}/analysis?days=7&threshold=0.1`);
      expect(res.status).toBe(200);
      
      const body = await res.json();
      expect(body.windowDays).toBe(7);
      expect(body.threshold).toBe(0.1);
    });
  });
});

describeWithDb('Tests API Integration Tests', () => {
  describe('GET /api/v1/tests/:testName/history', () => {
    it('should require project parameter', async () => {
      const res = await app.request('/api/v1/tests/some-test/history');
      expect(res.status).toBe(400);
      
      const body = await res.json();
      expect(body.error).toContain('project');
    });

    it('should return test history with project parameter', async () => {
      const projectsRes = await app.request('/api/v1/projects');
      const { projects } = await projectsRes.json();
      
      if (projects.length === 0) return;
      
      const projectId = projects[0].id;
      const res = await app.request(`/api/v1/tests/test-name/history?project=${projectId}`);
      expect(res.status).toBe(200);
      
      const body = await res.json();
      expect(body.testName).toBe('test-name');
      expect(body.stats).toBeDefined();
      expect(body.history).toBeDefined();
    });

    it('should handle URL-encoded test names', async () => {
      const projectsRes = await app.request('/api/v1/projects');
      const { projects } = await projectsRes.json();
      
      if (projects.length === 0) return;
      
      const projectId = projects[0].id;
      const encodedName = encodeURIComponent('Test Suite › Nested › Test Name');
      const res = await app.request(`/api/v1/tests/${encodedName}/history?project=${projectId}`);
      expect(res.status).toBe(200);
    });
  });

  describe('GET /api/v1/tests/flaky/:id', () => {
    it('should return 404 for non-existent flaky test', async () => {
      const res = await app.request('/api/v1/tests/flaky/00000000-0000-0000-0000-000000000000');
      expect(res.status).toBe(404);
    });
  });
});
