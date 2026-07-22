import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { and, eq } from 'drizzle-orm';
import { db, testResults, flakyTests } from '../db';
import { updateFlakyTests } from '../services/flakiness';
import { withTimeout } from './reports';

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

// `withTimeout` needs no DB, so this runs unconditionally (not gated behind
// `describeWithDb`) — it proves the bounded-wait semantics that back
// `?wait=true`'s reconcile-error path, since fault-injecting a real DB
// failure through the full HTTP integration tests below isn't practical.
describe('withTimeout (bounds the ?wait=true reconcile)', () => {
  it('resolves with the inner value when the promise settles before the timeout', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 50)).resolves.toBe('ok');
  });

  it('propagates the inner rejection when the promise fails before the timeout', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 50)).rejects.toThrow('boom');
  });

  it('rejects with a timeout error when the promise takes longer than the bound — simulating a pathologically slow reconcile', async () => {
    const neverSettles = new Promise<never>(() => {});
    await expect(withTimeout(neverSettles, 10)).rejects.toThrow(/timed out/i);
  });
});

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

    it('should reject a JSON body with no recognizable report shape (no suites key) with 400 unrecognized', async () => {
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
      expect(body.error).toBe('Unrecognized report format');
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

    it('default path (no wait param) stays byte-for-byte unchanged: 201, no reconcile field', async () => {
      // Deliberately does NOT assert on post-ingest flaky_tests state — the
      // whole point of the default path is that reconciliation is a
      // fire-and-forget background job, so asserting on its result here
      // would just be racing it (see AGENTS.md's "Sharp edges").
      const res = await app.request('/api/v1/reports?branch=main&commit=nowait001&pipeline=nowait-pipeline', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${testProjectToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(sampleReport),
      });
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.reconcile).toBeUndefined();
      expect(Object.keys(body).sort()).toEqual(['success', 'testRun']);
      expect(Object.keys(body.testRun).sort()).toEqual(
        ['branch', 'commit', 'id', 'pipeline', 'project', 'summary'].sort()
      );
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

  describe('Failure detail persistence', () => {
    it('round-trips failureDetail through jsonb intact and stores NULL for a passing result', async () => {
      const reportWithFailureDetail = {
        config: {},
        suites: [
          {
            title: 'failure-detail.spec.ts',
            file: 'failure-detail.spec.ts',
            specs: [
              {
                title: 'fails with rich detail',
                ok: false,
                tags: [],
                file: 'failure-detail.spec.ts',
                tests: [
                  {
                    projectName: 'chromium',
                    results: [
                      {
                        workerIndex: 0,
                        status: 'failed',
                        duration: 100,
                        retry: 0,
                        startTime: '2026-07-01T00:00:00.000Z',
                        error: {
                          message: 'expect(received).toBe(expected)',
                          stack: 'Error: expect(received).toBe(expected)\n    at failure-detail.spec.ts:5:1',
                          snippet: '> 5 | expect(a).toBe(b)',
                        },
                        stdout: ['stdout line\n'],
                        stderr: ['stderr line\n'],
                        attachments: [
                          { name: 'screenshot', contentType: 'image/png', path: 'test-results/failure-detail/screenshot.png' },
                        ],
                      },
                    ],
                  },
                ],
              },
              {
                title: 'passes with no detail',
                ok: true,
                tags: [],
                file: 'failure-detail.spec.ts',
                tests: [
                  {
                    projectName: 'chromium',
                    results: [
                      { workerIndex: 0, status: 'passed', duration: 20, retry: 0, startTime: '2026-07-01T00:00:00.000Z' },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };

      const res = await app.request('/api/v1/reports?branch=main&commit=faildetail123', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${testProjectToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(reportWithFailureDetail),
      });
      expect(res.status).toBe(201);
      const runId = (await res.json()).testRun.id;

      const rows = await db
        .select({
          testName: testResults.testName,
          failureDetail: testResults.failureDetail,
        })
        .from(testResults)
        .where(eq(testResults.testRunId, runId));

      const failed = rows.find((r) => r.testName.includes('fails with rich detail'));
      expect(failed?.failureDetail).toEqual({
        errors: [
          {
            message: 'expect(received).toBe(expected)',
            stack: 'Error: expect(received).toBe(expected)\n    at failure-detail.spec.ts:5:1',
            snippet: '> 5 | expect(a).toBe(b)',
          },
        ],
        stdout: 'stdout line\n',
        stderr: 'stderr line\n',
        attachments: [
          { name: 'screenshot', contentType: 'image/png', path: 'test-results/failure-detail/screenshot.png' },
        ],
      });

      const passed = rows.find((r) => r.testName.includes('passes with no detail'));
      expect(passed?.failureDetail).toBeNull();
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
      expect(body.error).toBe('Unrecognized report format');
    });

    it('should reject a Playwright-shaped body that fails validation with the format-named 400', async () => {
      const res = await app.request('/api/v1/reports?branch=main&commit=badpw', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${testProjectToken}`,
          'Content-Type': 'application/json',
        },
        // Has a `suites` key → detected as Playwright, but `suites` must be an
        // array → parsePlaywrightReport throws → malformed (not unrecognized).
        body: JSON.stringify({ config: {}, suites: 'not-an-array' }),
      });
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toContain('Failed to parse Playwright report');
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

  describe('?wait=true reconciliation', () => {
    // Isolated in its own project, same reasoning as the JUnit flaky describe
    // block above: an exact totalRuns/flakeRate assertion needs a clean
    // flakiness window for this test name.
    let waitProjectId: string;
    let waitProjectToken: string;

    beforeAll(async () => {
      const res = await app.request('/api/v1/admin/projects', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: `reports-wait-${Date.now()}` }),
      });
      const body = await res.json();
      waitProjectId = body.project.id;
      waitProjectToken = body.token;
    });

    afterAll(async () => {
      if (waitProjectId) {
        const res = await app.request(`/api/v1/admin/projects/${waitProjectId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${adminToken}` },
        });
        expect(res.status).toBe(200);
      }
    });

    const waitTestName = 'flakes across executions delivered in one report';

    // ONE Playwright JSON report whose single spec carries THREE `tests[]`
    // entries (2 passed + 1 failed), none tagged with a `projectName`. The
    // real reporter shape nests attempts under `spec.tests[].results[]` —
    // one `tests[]` entry per Playwright project running the spec — and the
    // parser (`getExecutions` in `parsers/playwright.ts`) emits ONE
    // `test_results` row per `tests[]` entry. Three entries in a single
    // upload therefore reach `minRuns` (3) in ONE ingest, without three
    // separate report uploads. The legacy `spec.results[]` shape (attempts
    // nested directly on the spec, no `tests[]`) would instead collapse to a
    // SINGLE row no matter how many attempts it holds — that's the trap the
    // plan calls out, and precisely why this fixture avoids it.
    const singleUploadFlakyReport = {
      config: {},
      suites: [
        {
          title: 'wait.spec.ts',
          file: 'wait.spec.ts',
          specs: [
            {
              title: waitTestName,
              ok: true,
              tests: [
                { results: [{ workerIndex: 0, status: 'passed', duration: 10, retry: 0, startTime: '2026-07-15T10:00:00.000Z' }] },
                { results: [{ workerIndex: 0, status: 'passed', duration: 10, retry: 0, startTime: '2026-07-15T10:00:01.000Z' }] },
                { results: [{ workerIndex: 0, status: 'failed', duration: 10, retry: 0, startTime: '2026-07-15T10:00:02.000Z' }] },
              ],
            },
          ],
        },
      ],
    };

    it('is synchronous: the response carries the reconcile result, and an immediate quarantine read reflects it with no poll', async () => {
      const res = await app.request(
        '/api/v1/reports?branch=main&commit=waitsync001&wait=true',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${waitProjectToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(singleUploadFlakyReport),
        }
      );
      expect(res.status).toBe(201);
      const body = await res.json();

      // Fixture sanity check (per the plan): this single upload genuinely
      // produces 3 executions (2 passed + 1 failed) for the same test name —
      // not a report that merely looks like it should be flaky.
      expect(body.testRun.summary.total).toBe(3);
      expect(body.testRun.summary.passed).toBe(2);
      expect(body.testRun.summary.failed).toBe(1);

      // The whole point of `wait=true`: the reconcile result is already in
      // the response body, naming this test as newly flaky.
      expect(body.reconcile).toBeDefined();
      expect(body.reconcile.newlyFlaky).toContain(waitTestName);
      expect(body.reconcile.newlyResolved).toEqual([]);

      // ...AND an immediately-following read — no waitFor, no poll, no sleep
      // — already reflects it, because `wait=true` only returns after
      // `flaky_tests` has been made consistent with this ingest.
      const quarantineRes = await app.request(`/api/v1/projects/${waitProjectId}/quarantine`);
      expect(quarantineRes.status).toBe(200);
      const quarantine = await quarantineRes.json();
      expect(quarantine.flaky.map((t: { testName: string }) => t.testName)).toContain(waitTestName);
    });
  });
});
