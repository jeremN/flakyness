import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const hasDatabase = !!process.env.DATABASE_URL;
const hasAdminToken = !!process.env.ADMIN_TOKEN;
const describeWithDb = hasDatabase && hasAdminToken ? describe : describe.skip;

let app: typeof import('../index').default;
let adminToken: string;
let testProjectToken: string;
let testProjectId: string;

const sampleReport = JSON.parse(
  readFileSync(join(__dirname, '../../fixtures/sample-report.json'), 'utf-8')
);

beforeAll(async () => {
  if (hasDatabase && hasAdminToken) {
    const module = await import('../index');
    app = module.default;
    adminToken = process.env.ADMIN_TOKEN!;
    
    // Create a test project for reports testing
    const res = await app.request('/api/v1/admin/projects', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: `reports-test-${Date.now()}` }),
    });
    const body = await res.json();
    testProjectToken = body.token;
    testProjectId = body.project.id;
  }
});

describeWithDb('Reports API Integration Tests', () => {
  describe('Authentication', () => {
    it('should reject requests without auth header', async () => {
      const res = await app.request('/api/v1/reports?branch=main&commit=abc123', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sampleReport),
      });
      expect(res.status).toBe(401);
    });

    it('should reject requests with invalid token', async () => {
      const res = await app.request('/api/v1/reports?branch=main&commit=abc123', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer invalid-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(sampleReport),
      });
      expect(res.status).toBe(401);
    });

    it('should accept requests with valid project token', async () => {
      const res = await app.request('/api/v1/reports?branch=main&commit=abc123', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${testProjectToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(sampleReport),
      });
      expect(res.status).toBe(201);
    });
  });

  describe('Input Validation', () => {
    it('should require commit parameter', async () => {
      const res = await app.request('/api/v1/reports?branch=main', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${testProjectToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(sampleReport),
      });
      expect(res.status).toBe(400);
    });

    it('should default branch to main', async () => {
      const res = await app.request('/api/v1/reports?commit=def456', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${testProjectToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(sampleReport),
      });
      expect(res.status).toBe(201);
      
      const body = await res.json();
      expect(body.testRun.branch).toBe('main');
    });

    it('should reject invalid JSON body', async () => {
      const res = await app.request('/api/v1/reports?branch=main&commit=abc123', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${testProjectToken}`,
          'Content-Type': 'application/json',
        },
        body: 'not valid json',
      });
      expect(res.status).toBe(400);
    });

    it('should reject invalid Playwright report structure', async () => {
      const res = await app.request('/api/v1/reports?branch=main&commit=abc123', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${testProjectToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ invalid: 'report' }),
      });
      expect(res.status).toBe(400);
      
      const body = await res.json();
      expect(body.error).toContain('parse');
    });
  });

  describe('Report Processing', () => {
    it('should return test run summary on success', async () => {
      const res = await app.request('/api/v1/reports?branch=feature&commit=xyz789&pipeline=123', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${testProjectToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(sampleReport),
      });
      expect(res.status).toBe(201);
      
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.testRun).toBeDefined();
      expect(body.testRun.id).toBeDefined();
      expect(body.testRun.branch).toBe('feature');
      expect(body.testRun.commit).toBe('xyz789');
      expect(body.testRun.pipeline).toBe('123');
      expect(body.testRun.summary).toBeDefined();
      expect(body.testRun.summary.total).toBe(6);
    });

    it('should count test statuses correctly', async () => {
      const res = await app.request('/api/v1/reports?branch=main&commit=test123', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${testProjectToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(sampleReport),
      });
      expect(res.status).toBe(201);
      
      const body = await res.json();
      const summary = body.testRun.summary;
      
      expect(summary.passed).toBe(4);
      expect(summary.failed).toBe(1);
      expect(summary.flaky).toBe(1);
    });
  });
});
