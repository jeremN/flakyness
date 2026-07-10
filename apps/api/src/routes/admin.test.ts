import { describe, it, expect, beforeAll } from 'vitest';

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

/** Poll `predicate` until it resolves true, or give up after `timeoutMs`. */
async function waitFor(
  predicate: () => Promise<boolean>,
  { timeoutMs = 5000, intervalMs = 100 }: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

/**
 * Build a minimal Playwright JSON report with two tests in a single ingest:
 * - "control test (always flaky)": fails on all 3 executions (100% flake
 *   rate) — flaky under any valid threshold, used as a completion signal for
 *   the fire-and-forget updateFlakyTests() call triggered by ingest.
 * - "mildly flaky test": 1 flaky execution out of 3 (~33% flake rate) — well
 *   above the DEFAULT_CONFIG threshold (5%) but below a 0.9 override.
 */
function buildFlakinessReport() {
  const startTime = new Date().toISOString();
  const execution = (status: 'passed' | 'failed') => ({
    results: [{ workerIndex: 0, status, duration: 10, retry: 0, startTime }],
  });
  const flakyExecution = () => ({
    results: [
      { workerIndex: 0, status: 'failed' as const, duration: 10, retry: 0, startTime },
      { workerIndex: 0, status: 'passed' as const, duration: 10, retry: 1, startTime },
    ],
  });

  return {
    config: { version: '1.40.0' },
    suites: [
      {
        title: 'flakiness-config.spec.ts',
        file: 'flakiness-config.spec.ts',
        specs: [
          {
            title: 'control test (always flaky)',
            ok: false,
            tags: [],
            location: { file: 'flakiness-config.spec.ts', line: 5, column: 5 },
            tests: [execution('failed'), execution('failed'), execution('failed')],
          },
          {
            title: 'mildly flaky test',
            ok: true,
            tags: [],
            location: { file: 'flakiness-config.spec.ts', line: 15, column: 5 },
            tests: [execution('passed'), flakyExecution(), execution('passed')],
          },
        ],
      },
    ],
  };
}

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

  describe('PATCH /api/v1/admin/projects/:id', () => {
    async function createProject(label: string): Promise<string> {
      const res = await app.request('/api/v1/admin/projects', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: `patch-test-${label}-${Date.now()}` }),
      });
      const body = await res.json();
      return body.project.id as string;
    }

    it('sets flakiness overrides, readable back via PATCH response and GET /projects', async () => {
      const projectId = await createProject('happy-path');

      const patchRes = await app.request(`/api/v1/admin/projects/${projectId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ flakeThreshold: 0.2, windowDays: 30, minRuns: 5 }),
      });
      expect(patchRes.status).toBe(200);

      const patchBody = await patchRes.json();
      expect(patchBody.project.flakeThreshold).toBe(0.2);
      expect(patchBody.project.windowDays).toBe(30);
      expect(patchBody.project.minRuns).toBe(5);

      const listRes = await app.request('/api/v1/admin/projects', {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const listBody = await listRes.json();
      const found = listBody.projects.find((p: any) => p.id === projectId);
      expect(found).toBeDefined();
      expect(found.flakeThreshold).toBe(0.2);
      expect(found.windowDays).toBe(30);
      expect(found.minRuns).toBe(5);
      expect(found.tokenHash).toBeUndefined();
    });

    it('clears an override back to default with an explicit null', async () => {
      const projectId = await createProject('clear-null');

      await app.request(`/api/v1/admin/projects/${projectId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ flakeThreshold: 0.3 }),
      });

      const res = await app.request(`/api/v1/admin/projects/${projectId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ flakeThreshold: null }),
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.project.flakeThreshold).toBeNull();
    });

    it('leaves fields omitted from the body unchanged', async () => {
      const projectId = await createProject('partial-update');

      await app.request(`/api/v1/admin/projects/${projectId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ windowDays: 21, minRuns: 8 }),
      });

      const res = await app.request(`/api/v1/admin/projects/${projectId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ minRuns: 12 }),
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.project.windowDays).toBe(21);
      expect(body.project.minRuns).toBe(12);
    });

    it('sets webhookUrl, readable back via PATCH response and GET /projects', async () => {
      const projectId = await createProject('webhook-set');

      const patchRes = await app.request(`/api/v1/admin/projects/${projectId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ webhookUrl: 'https://example.com/hooks/flackyness' }),
      });
      expect(patchRes.status).toBe(200);

      const patchBody = await patchRes.json();
      expect(patchBody.project.webhookUrl).toBe('https://example.com/hooks/flackyness');

      const listRes = await app.request('/api/v1/admin/projects', {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const listBody = await listRes.json();
      const found = listBody.projects.find((p: any) => p.id === projectId);
      expect(found.webhookUrl).toBe('https://example.com/hooks/flackyness');
    });

    it('clears webhookUrl back to null with an explicit null', async () => {
      const projectId = await createProject('webhook-clear');

      await app.request(`/api/v1/admin/projects/${projectId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ webhookUrl: 'https://example.com/hooks/flackyness' }),
      });

      const res = await app.request(`/api/v1/admin/projects/${projectId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ webhookUrl: null }),
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.project.webhookUrl).toBeNull();
    });

    it('rejects a non-http(s) webhookUrl (e.g. ftp://)', async () => {
      const projectId = await createProject('webhook-bad-protocol');
      const res = await app.request(`/api/v1/admin/projects/${projectId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ webhookUrl: 'ftp://example.com/hooks/flackyness' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects a malformed webhookUrl (not a URL at all)', async () => {
      const projectId = await createProject('webhook-not-url');
      const res = await app.request(`/api/v1/admin/projects/${projectId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ webhookUrl: 'not-a-url' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects an out-of-range flakeThreshold', async () => {
      const projectId = await createProject('bad-threshold');
      const res = await app.request(`/api/v1/admin/projects/${projectId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ flakeThreshold: 1.5 }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects an out-of-range windowDays', async () => {
      const projectId = await createProject('bad-window');
      const res = await app.request(`/api/v1/admin/projects/${projectId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ windowDays: 0 }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects an empty body', async () => {
      const projectId = await createProject('empty-body');
      const res = await app.request(`/api/v1/admin/projects/${projectId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it('returns 404 for a non-existent project', async () => {
      const res = await app.request('/api/v1/admin/projects/00000000-0000-0000-0000-000000000000', {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ minRuns: 5 }),
      });
      expect(res.status).toBe(404);
    });

    it('rejects requests without an auth header', async () => {
      const projectId = await createProject('no-auth');
      const res = await app.request(`/api/v1/admin/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ minRuns: 5 }),
      });
      expect(res.status).toBe(401);
    });

    it('rejects requests with an invalid admin token', async () => {
      const projectId = await createProject('bad-auth');
      const res = await app.request(`/api/v1/admin/projects/${projectId}`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer invalid-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ minRuns: 5 }),
      });
      expect(res.status).toBe(401);
    });
  });

  // End-to-end: a project-level flakeThreshold override changes what the
  // fire-and-forget reconciliation triggered by report ingest considers
  // flaky. Reclassification-on-next-ingest is documented, accepted behavior
  // (see docs/API.md), not a bug — this test locks in that the override is
  // actually threaded through, not just stored.
  describe('Per-project flakiness config threading (end-to-end)', () => {
    it('an overridden flakeThreshold suppresses reconciliation for tests below it', async () => {
      const projectName = `flaky-config-e2e-${Date.now()}`;
      const createRes = await app.request('/api/v1/admin/projects', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: projectName }),
      });
      const { project, token } = await createRes.json();

      const patchRes = await app.request(`/api/v1/admin/projects/${project.id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ flakeThreshold: 0.9 }),
      });
      expect(patchRes.status).toBe(200);

      const ingestRes = await app.request(`/api/v1/reports?branch=main&commit=${'c'.repeat(40)}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(buildFlakinessReport()),
      });
      expect(ingestRes.status).toBe(201);

      // updateFlakyTests() runs fire-and-forget after the ingest response is
      // sent. The control test is flaky under any valid threshold and is
      // upserted in the same transaction as the mildly-flaky test, so its
      // arrival signals the background job has committed.
      const controlWentActive = await waitFor(async () => {
        const res = await app.request(`/api/v1/projects/${project.id}/flaky-tests?status=all`);
        const body = await res.json();
        const control = body.flakyTests.find((t: { testName: string }) =>
          t.testName.includes('control test')
        );
        return control?.status === 'active';
      });
      expect(controlWentActive).toBe(true);

      const finalRes = await app.request(`/api/v1/projects/${project.id}/flaky-tests?status=all`);
      const finalBody = await finalRes.json();
      const mildlyFlaky = finalBody.flakyTests.find((t: { testName: string }) =>
        t.testName.includes('mildly flaky test')
      );
      expect(mildlyFlaky).toBeUndefined();

      const deleteRes = await app.request(`/api/v1/admin/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(deleteRes.status).toBe(200);
    });
  });
});
