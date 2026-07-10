import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { and, eq } from 'drizzle-orm';
import { db, testResults, flakyTests } from '../db';
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

const taggedReport = JSON.parse(
  readFileSync(join(__dirname, '../../fixtures/real-report-with-tags.json'), 'utf-8')
);

const junitBasicReport = readFileSync(join(__dirname, '../../fixtures/junit-basic.xml'), 'utf-8');
const junitBasicPassingReport = readFileSync(
  join(__dirname, '../../fixtures/junit-basic-passing.xml'),
  'utf-8'
);
const junitMalformedReport = readFileSync(join(__dirname, '../../fixtures/junit-malformed.xml'), 'utf-8');

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
    testProjectId = body.project.id;
    testProjectToken = body.token;
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

  describe('Tags and annotations persistence', () => {
    it('round-trips tags/annotations as jsonb arrays and stores NULL when absent', async () => {
      const res = await app.request('/api/v1/reports?branch=main&commit=tags123', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${testProjectToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(taggedReport),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      const runId = body.testRun.id;

      const rows = await db
        .select({
          testName: testResults.testName,
          tags: testResults.tags,
          annotations: testResults.annotations,
        })
        .from(testResults)
        .where(eq(testResults.testRunId, runId));

      const tagged = rows.find((r) => r.testName.includes('login with valid credentials'));
      expect(tagged?.tags).toEqual(['@smoke']);
      expect(tagged?.annotations).toEqual([{ type: 'issue', description: 'JIRA-999' }]);

      const untagged = rows.find((r) => r.testName.includes('retry after transient failure'));
      expect(untagged?.tags).toBeNull();
      expect(untagged?.annotations).toBeNull();
    });
  });

  describe('JUnit XML ingestion', () => {
    it('should accept a JUnit XML report and return correct summary counts', async () => {
      const res = await app.request('/api/v1/reports?branch=main&commit=junit001', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${testProjectToken}`,
          'Content-Type': 'application/xml',
        },
        body: junitBasicReport,
      });
      expect(res.status).toBe(201);

      const body = await res.json();
      const summary = body.testRun.summary;

      expect(summary.total).toBe(4);
      expect(summary.passed).toBe(2);
      expect(summary.failed).toBe(1);
      expect(summary.skipped).toBe(1);
      expect(summary.flaky).toBe(0);
    });

    it('should persist test_results rows with status/duration/error and NULL tags/annotations', async () => {
      const res = await app.request('/api/v1/reports?branch=main&commit=junit002', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${testProjectToken}`,
          'Content-Type': 'application/xml',
        },
        body: junitBasicReport,
      });
      expect(res.status).toBe(201);
      const runId = (await res.json()).testRun.id;

      const rows = await db
        .select({
          testName: testResults.testName,
          status: testResults.status,
          durationMs: testResults.durationMs,
          errorMessage: testResults.errorMessage,
          tags: testResults.tags,
          annotations: testResults.annotations,
        })
        .from(testResults)
        .where(eq(testResults.testRunId, runId));

      const failedTest = rows.find((r) => r.testName.includes('reject invalid credentials'));
      expect(failedTest?.status).toBe('failed');
      expect(failedTest?.durationMs).toBe(812);
      expect(failedTest?.errorMessage).toContain('expect(received).toBe(expected)');

      const skippedTest = rows.find((r) => r.testName.includes('redirect after logout'));
      expect(skippedTest?.status).toBe('skipped');

      for (const row of rows) {
        expect(row.tags).toBeNull();
        expect(row.annotations).toBeNull();
      }
    });

    it('should reject malformed JUnit XML with 400', async () => {
      const res = await app.request('/api/v1/reports?branch=main&commit=junitbad', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${testProjectToken}`,
          'Content-Type': 'application/xml',
        },
        body: junitMalformedReport,
      });
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toContain('JUnit');
    });

    it('should still route JSON with leading whitespace to the JSON path', async () => {
      const res = await app.request('/api/v1/reports?branch=main&commit=junitws', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${testProjectToken}`,
          'Content-Type': 'application/json',
        },
        body: `   ${JSON.stringify(sampleReport)}`,
      });
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.testRun.summary.total).toBe(6);
    });

    it('should reject a whitespace-only body with 400', async () => {
      const res = await app.request('/api/v1/reports?branch=main&commit=junitempty', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${testProjectToken}`,
          'Content-Type': 'application/json',
        },
        body: '   ',
      });
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toBe('Invalid JSON body');
    });
  });

  describe('JUnit reports becoming flaky across runs', () => {
    // Isolated in its own project so the run/fail counts below are exact —
    // sharing testProjectId with the ingestion tests above would pollute the
    // flakiness window with their extra uploads of the same test names.
    let flakyProjectId: string;
    let flakyProjectToken: string;

    beforeAll(async () => {
      const res = await app.request('/api/v1/admin/projects', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: `reports-junit-flaky-${Date.now()}` }),
      });
      const body = await res.json();
      flakyProjectId = body.project.id;
      flakyProjectToken = body.token;
    });

    afterAll(async () => {
      if (flakyProjectId) {
        const res = await app.request(`/api/v1/admin/projects/${flakyProjectId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${adminToken}` },
        });
        expect(res.status).toBe(200);
      }
    });

    it('marks a test flaky via rate-over-runs despite JUnit having no retry semantics', async () => {
      // Same test ("auth.spec.ts › should reject invalid credentials") passes
      // in 2 of 3 uploads and fails in 1 — JUnit itself never reports
      // retryCount > 0, so this proves flakiness for JUnit-sourced tests
      // emerges purely from the existing (failed+flaky)/total rate across
      // runs, not from any per-report retry inference.
      const uploads = [
        { commit: 'junitflaky001', body: junitBasicPassingReport },
        { commit: 'junitflaky002', body: junitBasicPassingReport },
        { commit: 'junitflaky003', body: junitBasicReport },
      ];

      for (const { commit, body } of uploads) {
        const res = await app.request(`/api/v1/reports?branch=main&commit=${commit}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${flakyProjectToken}`,
            'Content-Type': 'application/xml',
          },
          body,
        });
        expect(res.status).toBe(201);
      }

      // Reconcile synchronously instead of relying on the route's
      // fire-and-forget background call, so the assertion below is
      // deterministic (matches the pattern used in flakiness.test.ts).
      await updateFlakyTests(flakyProjectId);

      const [flaky] = await db
        .select()
        .from(flakyTests)
        .where(
          and(
            eq(flakyTests.projectId, flakyProjectId),
            eq(flakyTests.testName, 'auth.spec.ts › should reject invalid credentials')
          )
        );

      expect(flaky).toBeDefined();
      expect(flaky.status).toBe('active');
      expect(flaky.totalRuns).toBe(3);
      expect(Number(flaky.flakeRate)).toBeGreaterThanOrEqual(0.05);
      expect(Number(flaky.flakeRate)).toBeCloseTo(1 / 3, 2);
    });
  });
});
