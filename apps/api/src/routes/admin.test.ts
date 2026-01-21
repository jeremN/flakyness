import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

// These tests require the database and ADMIN_TOKEN to be configured
const hasDatabase = !!process.env.DATABASE_URL;
const hasAdminToken = !!process.env.ADMIN_TOKEN;
const describeAdmin = hasDatabase && hasAdminToken ? describe : describe.skip;

let app: typeof import('../index').default;

beforeAll(async () => {
  if (hasDatabase) {
    const module = await import('../index');
    app = module.default;
  }
});

describeAdmin('Admin API Integration Tests', () => {
  const adminToken = process.env.ADMIN_TOKEN!;
  
  describe('Authentication', () => {
    it('should reject requests without auth header', async () => {
      const res = await app.request('/api/v1/admin/projects');
      expect(res.status).toBe(401);
      
      const body = await res.json();
      expect(body.error).toContain('Authorization header required');
    });

    it('should reject requests with invalid token', async () => {
      const res = await app.request('/api/v1/admin/projects', {
        headers: { Authorization: 'Bearer invalid-token' },
      });
      expect(res.status).toBe(401);
      
      const body = await res.json();
      expect(body.error).toContain('Invalid admin token');
    });

    it('should accept requests with valid admin token', async () => {
      const res = await app.request('/api/v1/admin/projects', {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(res.status).toBe(200);
    });
  });

  describe('GET /api/v1/admin/projects', () => {
    it('should return projects array with stats', async () => {
      const res = await app.request('/api/v1/admin/projects', {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(res.status).toBe(200);
      
      const body = await res.json();
      expect(body.projects).toBeDefined();
      expect(Array.isArray(body.projects)).toBe(true);
      
      // Check structure of first project if any exist
      if (body.projects.length > 0) {
        const project = body.projects[0];
        expect(project.id).toBeDefined();
        expect(project.name).toBeDefined();
        expect(typeof project.hasToken).toBe('boolean');
        expect(project.stats).toBeDefined();
        expect(typeof project.stats.totalRuns).toBe('number');
      }
    });
  });

  describe('POST /api/v1/admin/projects', () => {
    it('should create a project and return token', async () => {
      const projectName = `test-project-${Date.now()}`;
      
      const res = await app.request('/api/v1/admin/projects', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: projectName }),
      });
      expect(res.status).toBe(201);
      
      const body = await res.json();
      expect(body.project).toBeDefined();
      expect(body.project.name).toBe(projectName);
      expect(body.token).toBeDefined();
      expect(body.token).toMatch(/^flackyness_/);
      expect(body.warning).toContain('Save this token');
    });

    it('should reject duplicate project names', async () => {
      const projectName = `dup-test-${Date.now()}`;
      
      // Create first project
      await app.request('/api/v1/admin/projects', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: projectName }),
      });
      
      // Try to create duplicate
      const res = await app.request('/api/v1/admin/projects', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: projectName }),
      });
      expect(res.status).toBe(409);
      
      const body = await res.json();
      expect(body.error).toContain('already exists');
    });

    it('should validate required fields', async () => {
      const res = await app.request('/api/v1/admin/projects', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/v1/admin/health', () => {
    it('should return system health metrics', async () => {
      const res = await app.request('/api/v1/admin/health', {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(res.status).toBe(200);
      
      const body = await res.json();
      expect(body.status).toBe('ok');
      expect(body.timestamp).toBeDefined();
      expect(body.database).toBeDefined();
      expect(typeof body.database.projects).toBe('number');
      expect(typeof body.database.testRuns).toBe('number');
      expect(typeof body.database.testResults).toBe('number');
      expect(typeof body.database.flakyTests).toBe('number');
      expect(body.version).toBeDefined();
    });
  });

  describe('POST /api/v1/admin/projects/:id/rotate-token', () => {
    it('should rotate project token', async () => {
      // Create a project first
      const projectName = `rotate-test-${Date.now()}`;
      const createRes = await app.request('/api/v1/admin/projects', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: projectName }),
      });
      const { project, token: oldToken } = await createRes.json();
      
      // Rotate the token
      const res = await app.request(`/api/v1/admin/projects/${project.id}/rotate-token`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(res.status).toBe(200);
      
      const body = await res.json();
      expect(body.token).toBeDefined();
      expect(body.token).not.toBe(oldToken);
      expect(body.warning).toContain('old token is now invalid');
    });

    it('should return 404 for non-existent project', async () => {
      const res = await app.request('/api/v1/admin/projects/00000000-0000-0000-0000-000000000000/rotate-token', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/v1/admin/projects/:id', () => {
    it('should delete a project', async () => {
      // Create a project to delete
      const projectName = `delete-test-${Date.now()}`;
      const createRes = await app.request('/api/v1/admin/projects', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: projectName }),
      });
      const { project } = await createRes.json();
      
      // Delete it
      const res = await app.request(`/api/v1/admin/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(res.status).toBe(200);
      
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.message).toContain(projectName);
      
      // Verify it's gone
      const listRes = await app.request('/api/v1/admin/projects', {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const listBody = await listRes.json();
      const found = listBody.projects.find((p: any) => p.id === project.id);
      expect(found).toBeUndefined();
    });

    it('should return 404 for non-existent project', async () => {
      const res = await app.request('/api/v1/admin/projects/00000000-0000-0000-0000-000000000000', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(res.status).toBe(404);
    });
  });
});
