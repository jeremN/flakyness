import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { db, flakyTests, testRuns } from '../db';
import { escapeRegex, buildGrepInvert, RUN_RESULTS_CAP } from './projects';

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

// Pure unit tests — must run without a DB.
describe('escapeRegex', () => {
  it('escapes every regex metacharacter class so the name matches literally', () => {
    const name = 'should handle a.b(c) [x] $y';
    const escaped = escapeRegex(name);

    const re = new RegExp(`^${escaped}$`);
    expect(re.test(name)).toBe(true);

    // The unescaped metacharacters must not be interpreted: a name that
    // merely resembles the pattern structurally should NOT match.
    expect(re.test('should handle axbc x $y')).toBe(false);
  });

  it('escapes the full metacharacter set from the plan', () => {
    const name = '.*+?^${}()|[]\\';
    const escaped = escapeRegex(name);
    const re = new RegExp(`^${escaped}$`);
    expect(re.test(name)).toBe(true);
  });
});

describe('buildGrepInvert', () => {
  it('is exactly the empty string ("") for an empty muted set', () => {
    const grepInvert = buildGrepInvert([]);
    // Explicit === '' assertion, not a falsy check — an empty pattern that
    // isn't exactly '' would tell a CI job to skip the entire suite.
    expect(grepInvert === '').toBe(true);
  });

  it('joins escaped names into an anchored alternation', () => {
    const grepInvert = buildGrepInvert(['foo.bar', 'a(b)']);
    expect(grepInvert).toBe('^(?:foo\\.bar|a\\(b\\))$');
  });
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

  describe('malformed project id → 400 (shared uuid guard)', () => {
    it('rejects a non-UUID id with 400 and the standard error on every id-guarded endpoint', async () => {
      // The guard exists on every endpoint but is only asserted on /quarantine
      // and /runs/:runId today. These five share the identical guard, untested.
      for (const path of ['stats', 'flaky-tests', 'runs', 'analysis', 'trend']) {
        const res = await app.request(`/api/v1/projects/not-a-uuid/${path}`);
        expect(res.status, `${path} must 400 on a malformed id`).toBe(400);
        expect((await res.json()).error).toBe('Invalid project ID format');
      }
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

  describe('GET /api/v1/projects/:id/flaky-tests — status filter & limit (seeded)', () => {
    let ftProjectId: string;

    beforeAll(async () => {
      if (!(hasDatabase && hasAdminToken)) return;
      const createRes = await app.request('/api/v1/admin/projects', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `flaky-filter-${randomUUID()}` }),
      });
      ftProjectId = (await createRes.json()).project.id;

      // Direct seed — this route reads flaky_tests rows only; it does not race
      // the un-awaited reconcile (nothing is ingested here).
      await db.insert(flakyTests).values([
        { projectId: ftProjectId, testName: 'ft-active-1', testFile: 'f.spec.ts', status: 'active', flakeCount: 5, totalRuns: 10, flakeRate: '0.5000' },
        { projectId: ftProjectId, testName: 'ft-active-2', testFile: 'f.spec.ts', status: 'active', flakeCount: 3, totalRuns: 10, flakeRate: '0.3000' },
        { projectId: ftProjectId, testName: 'ft-resolved', testFile: 'f.spec.ts', status: 'resolved', flakeCount: 0, totalRuns: 10, flakeRate: '0.0000' },
        { projectId: ftProjectId, testName: 'ft-ignored', testFile: 'f.spec.ts', status: 'ignored', flakeCount: 4, totalRuns: 10, flakeRate: '0.4000' },
      ]);
    });

    afterAll(async () => {
      if (ftProjectId) {
        await app.request(`/api/v1/admin/projects/${ftProjectId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${adminToken}` },
        });
      }
    });

    const names = (body: { flakyTests: { testName: string }[] }) =>
      body.flakyTests.map((t) => t.testName);

    it('status=active returns only the active rows (default status)', async () => {
      const res = await app.request(`/api/v1/projects/${ftProjectId}/flaky-tests`);
      const got = names(await res.json());
      expect(got.sort()).toEqual(['ft-active-1', 'ft-active-2']);
    });

    it('status=ignored returns only the ignored row', async () => {
      const res = await app.request(`/api/v1/projects/${ftProjectId}/flaky-tests?status=ignored`);
      expect(names(await res.json())).toEqual(['ft-ignored']);
    });

    it('status=resolved returns only the resolved row', async () => {
      // Task-1 finding: the `'resolved'` enum value (projects.ts:12) had no
      // content-asserting test old or new; this pins it.
      const res = await app.request(`/api/v1/projects/${ftProjectId}/flaky-tests?status=resolved`);
      expect(names(await res.json())).toEqual(['ft-resolved']);
    });

    it('an unparseable status falls back to active (the default)', async () => {
      // Task-1 finding: /flaky-tests's `: 'active'` unparseable fallback
      // (projects.ts:109) was untested (the /runs/:runId sibling gets this via
      // Task 2, /flaky-tests did not). safeParse fails → 'active'.
      const res = await app.request(`/api/v1/projects/${ftProjectId}/flaky-tests?status=bogus`);
      const got = names(await res.json());
      expect(got.sort()).toEqual(['ft-active-1', 'ft-active-2']);
    });

    it('status=all returns every row regardless of status', async () => {
      const res = await app.request(`/api/v1/projects/${ftProjectId}/flaky-tests?status=all`);
      const got = names(await res.json());
      expect(got.sort()).toEqual(['ft-active-1', 'ft-active-2', 'ft-ignored', 'ft-resolved']);
    });

    it('limit is applied and clamped up to a minimum of 1', async () => {
      // 4 rows exist under status=all; limit=1 must return exactly 1.
      const one = await app.request(`/api/v1/projects/${ftProjectId}/flaky-tests?status=all&limit=1`);
      expect((await one.json()).flakyTests.length).toBe(1);

      // limit=0 → Math.max(0,1) → 1, NOT 0 rows.
      const zero = await app.request(`/api/v1/projects/${ftProjectId}/flaky-tests?status=all&limit=0`);
      expect((await zero.json()).flakyTests.length).toBe(1);
    });
  });

  describe('GET /api/v1/projects/:id/quarantine', () => {
    const mutedTestName = 'quarantine-test-ignored';
    const activeTestName = 'quarantine-test-active';
    const resolvedTestName = 'quarantine-test-resolved';

    beforeAll(async () => {
      // Seed one row per status directly — this route only cares about
      // existing flaky_tests rows, not how they got there.
      await db.insert(flakyTests).values([
        {
          projectId: testProjectId,
          testName: mutedTestName,
          testFile: 'quarantine.spec.ts',
          status: 'ignored',
          flakeCount: 4,
          totalRuns: 10,
          flakeRate: '0.4000',
        },
        {
          projectId: testProjectId,
          testName: activeTestName,
          testFile: 'quarantine.spec.ts',
          status: 'active',
          flakeCount: 1,
          totalRuns: 10,
          flakeRate: '0.1000',
        },
        {
          projectId: testProjectId,
          testName: resolvedTestName,
          testFile: 'quarantine.spec.ts',
          status: 'resolved',
          flakeCount: 0,
          totalRuns: 10,
          flakeRate: '0.0000',
        },
      ]);
    });

    it('partitions rows into muted (ignored) and flaky (active), excluding resolved', async () => {
      const res = await app.request(`/api/v1/projects/${testProjectId}/quarantine`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.projectId).toBe(testProjectId);

      const mutedNames = body.muted.map((t: { testName: string }) => t.testName);
      const flakyNames = body.flaky.map((t: { testName: string }) => t.testName);

      expect(mutedNames).toContain(mutedTestName);
      expect(mutedNames).not.toContain(activeTestName);
      expect(mutedNames).not.toContain(resolvedTestName);

      expect(flakyNames).toContain(activeTestName);
      expect(flakyNames).not.toContain(mutedTestName);
      expect(flakyNames).not.toContain(resolvedTestName);
    });

    it('builds grepInvert from the muted test only, never the active one', async () => {
      const res = await app.request(`/api/v1/projects/${testProjectId}/quarantine`);
      const body = await res.json();

      expect(body.grepInvert).toContain(mutedTestName);
      expect(body.grepInvert).not.toContain(activeTestName);
    });

    it('?format=playwright returns text/plain whose body equals grepInvert exactly', async () => {
      const jsonRes = await app.request(`/api/v1/projects/${testProjectId}/quarantine`);
      const jsonBody = await jsonRes.json();

      const plainRes = await app.request(`/api/v1/projects/${testProjectId}/quarantine?format=playwright`);
      expect(plainRes.status).toBe(200);
      expect(plainRes.headers.get('content-type')).toContain('text/plain');

      const plainBody = await plainRes.text();
      expect(plainBody).toBe(jsonBody.grepInvert);
    });

    it('returns 200 with empty arrays and grepInvert === "" for a project with no quarantine rows', async () => {
      // A well-formed uuid with no rows is a valid, empty answer — not a 404.
      const res = await app.request(`/api/v1/projects/${randomUUID()}/quarantine`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.muted).toEqual([]);
      expect(body.flaky).toEqual([]);
      expect(body.grepInvert === '').toBe(true);
      expect(body.truncated).toBe(false);
    });

    it('returns 400 for a malformed project id', async () => {
      const res = await app.request('/api/v1/projects/not-a-uuid/quarantine');
      expect(res.status).toBe(400);
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

  describe('GET /api/v1/projects/:id/runs/:runId', () => {
    let runDetailProjectId: string;
    let runDetailToken: string;
    let runId: string;

    // A single ingest whose results deliberately cross every status this
    // endpoint cares about: one passed, one failed, one flaky (fails then
    // passes on retry) — exercises the default scope, `?status=all`,
    // `?status=passed`, and the failed/flaky-before-passed ordering all
    // from one seeded run.
    const mixedReport = {
      config: { version: '1.48.0' },
      suites: [
        {
          title: 'run-detail.spec.ts',
          file: 'run-detail.spec.ts',
          specs: [
            {
              title: 'passes reliably',
              ok: true,
              tags: [],
              tests: [
                {
                  projectName: 'chromium',
                  results: [
                    { workerIndex: 0, status: 'passed', duration: 100, retry: 0, startTime: '2026-07-01T10:00:00.000Z', errors: [] },
                  ],
                  status: 'expected',
                },
              ],
              id: 'run-detail-spec1',
              file: 'run-detail.spec.ts',
              line: 1,
              column: 1,
            },
            {
              title: 'fails consistently',
              ok: false,
              tags: [],
              tests: [
                {
                  projectName: 'chromium',
                  results: [
                    { workerIndex: 0, status: 'failed', duration: 50, retry: 0, startTime: '2026-07-01T10:00:01.000Z', errors: [{ message: 'boom' }] },
                  ],
                  status: 'unexpected',
                },
              ],
              id: 'run-detail-spec2',
              file: 'run-detail.spec.ts',
              line: 2,
              column: 1,
            },
            {
              title: 'flakes on retry',
              ok: true,
              tags: [],
              tests: [
                {
                  projectName: 'chromium',
                  results: [
                    { workerIndex: 0, status: 'failed', duration: 40, retry: 0, startTime: '2026-07-01T10:00:02.000Z', errors: [{ message: 'transient' }] },
                    { workerIndex: 0, status: 'passed', duration: 45, retry: 1, startTime: '2026-07-01T10:00:03.000Z', errors: [] },
                  ],
                  status: 'flaky',
                },
              ],
              id: 'run-detail-spec3',
              file: 'run-detail.spec.ts',
              line: 3,
              column: 1,
            },
          ],
        },
      ],
      errors: [],
      stats: { startTime: '2026-07-01T10:00:00.000Z', duration: 200, expected: 2, unexpected: 1, flaky: 1, skipped: 0 },
    };

    beforeAll(async () => {
      const createRes = await app.request('/api/v1/admin/projects', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: `run-detail-test-${Date.now()}` }),
      });
      expect(createRes.status).toBe(201);
      const createBody = await createRes.json();
      runDetailProjectId = createBody.project.id;
      runDetailToken = createBody.token;

      const ingestRes = await app.request(
        '/api/v1/reports?branch=main&commit=rundetailsha123&pipeline=1',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${runDetailToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(mixedReport),
        }
      );
      expect(ingestRes.status).toBe(201);
      const ingestBody = await ingestRes.json();
      runId = ingestBody.testRun.id;
    });

    afterAll(async () => {
      if (runDetailProjectId) {
        const res = await app.request(`/api/v1/admin/projects/${runDetailProjectId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${adminToken}` },
        });
        expect(res.status).toBe(200);
      }
    });

    it('defaults to failed+flaky only, with the run summary and truncated:false', async () => {
      const res = await app.request(`/api/v1/projects/${runDetailProjectId}/runs/${runId}`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.run).toBeDefined();
      expect(body.run.id).toBe(runId);
      expect(body.run.branch).toBe('main');
      expect(body.run.commitSha).toBe('rundetailsha123');
      expect(body.truncated).toBe(false);

      const names = body.results.map((r: { testName: string }) => r.testName);
      expect(names).toContain('fails consistently');
      expect(names).toContain('flakes on retry');
      expect(names).not.toContain('passes reliably');
      expect(body.results.length).toBe(2);
    });

    it('?status=all includes the passed result too', async () => {
      const res = await app.request(`/api/v1/projects/${runDetailProjectId}/runs/${runId}?status=all`);
      expect(res.status).toBe(200);

      const body = await res.json();
      const names = body.results.map((r: { testName: string }) => r.testName);
      expect(names).toContain('passes reliably');
      expect(names).toContain('fails consistently');
      expect(names).toContain('flakes on retry');
      expect(body.results.length).toBe(3);
    });

    it('?status=passed returns only the passed result', async () => {
      const res = await app.request(`/api/v1/projects/${runDetailProjectId}/runs/${runId}?status=passed`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.results.length).toBe(1);
      expect(body.results[0].testName).toBe('passes reliably');
      expect(body.results[0].status).toBe('passed');
    });

    it('?status=flaky returns only the flaky result', async () => {
      const res = await app.request(`/api/v1/projects/${runDetailProjectId}/runs/${runId}?status=flaky`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.results.length).toBe(1);
      expect(body.results[0].testName).toBe('flakes on retry');
      expect(body.results[0].status).toBe('flaky');
    });

    it('?status=failed returns only the failed result', async () => {
      const res = await app.request(`/api/v1/projects/${runDetailProjectId}/runs/${runId}?status=failed`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.results.length).toBe(1);
      expect(body.results[0].testName).toBe('fails consistently');
      expect(body.results[0].status).toBe('failed');
    });

    it('an unparseable ?status falls back to the default failed+flaky scope', async () => {
      // projects.ts:315-322: safeParse fails → status === undefined → the
      // `inArray(['failed','flaky'])` fallback, NOT a 400 and NOT `all`.
      const res = await app.request(`/api/v1/projects/${runDetailProjectId}/runs/${runId}?status=bogus`);
      expect(res.status).toBe(200);

      const body = await res.json();
      const names = body.results.map((r: { testName: string }) => r.testName);
      expect(body.results.length).toBe(2);
      expect(names).toContain('fails consistently');
      expect(names).toContain('flakes on retry');
      expect(names).not.toContain('passes reliably');
    });

    it('includes failureDetail on a failed row and null on a passed row under ?status=all', async () => {
      const res = await app.request(`/api/v1/projects/${runDetailProjectId}/runs/${runId}?status=all`);
      expect(res.status).toBe(200);

      const body = await res.json();
      const failed = body.results.find((r: { testName: string }) => r.testName === 'fails consistently');
      const passed = body.results.find((r: { testName: string }) => r.testName === 'passes reliably');

      expect(failed?.failureDetail).toEqual({ errors: [{ message: 'boom' }] });
      expect(passed?.failureDetail).toBeNull();
    });

    it('orders failed and flaky results before passed under ?status=all', async () => {
      const res = await app.request(`/api/v1/projects/${runDetailProjectId}/runs/${runId}?status=all`);
      const body = await res.json();

      const statuses = body.results.map((r: { status: string }) => r.status);
      const passedIndex = statuses.indexOf('passed');
      const failedIndex = statuses.indexOf('failed');
      const flakyIndex = statuses.indexOf('flaky');

      expect(failedIndex).toBeLessThan(passedIndex);
      expect(flakyIndex).toBeLessThan(passedIndex);
    });

    it('keeps failures ahead of passed when truncation drops the excess, even when the failures sort last alphabetically', async () => {
      // RUN_RESULTS_CAP passing specs, then 2 failing specs — deliberately
      // named to sort LAST alphabetically ("zzz-..."), so the only way they
      // can appear ahead of passed rows in a truncated response is via
      // status priority ordering happening in SQL before the `.limit`, not
      // via name and not via lucky insertion order.
      const passingSpecs = Array.from({ length: RUN_RESULTS_CAP }, (_, i) => ({
        title: `cap passing spec ${i}`,
        ok: true,
        tags: [],
        tests: [
          {
            projectName: 'chromium',
            results: [
              { workerIndex: 0, status: 'passed', duration: 1, retry: 0, startTime: '2026-07-02T10:00:00.000Z', errors: [] },
            ],
            status: 'expected',
          },
        ],
        id: `cap-pass-${i}`,
        file: 'cap.spec.ts',
        line: i + 1,
        column: 1,
      }));

      const failingSpecNames = ['zzz-cap-failure-1', 'zzz-cap-failure-2'];
      const failingSpecs = failingSpecNames.map((title, i) => ({
        title,
        ok: false,
        tags: [],
        tests: [
          {
            projectName: 'chromium',
            results: [
              { workerIndex: 0, status: 'failed', duration: 1, retry: 0, startTime: '2026-07-02T10:00:01.000Z', errors: [{ message: 'boom' }] },
            ],
            status: 'unexpected',
          },
        ],
        id: `cap-fail-${i}`,
        file: 'cap.spec.ts',
        line: RUN_RESULTS_CAP + i + 1,
        column: 1,
      }));

      const capReport = {
        config: { version: '1.48.0' },
        suites: [
          {
            title: 'cap.spec.ts',
            file: 'cap.spec.ts',
            specs: [...passingSpecs, ...failingSpecs],
          },
        ],
        errors: [],
        stats: {
          startTime: '2026-07-02T10:00:00.000Z',
          duration: 1000,
          expected: RUN_RESULTS_CAP,
          unexpected: failingSpecNames.length,
          flaky: 0,
          skipped: 0,
        },
      };

      const ingestRes = await app.request(
        '/api/v1/reports?branch=main&commit=capordertest01&pipeline=1',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${runDetailToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(capReport),
        }
      );
      expect(ingestRes.status).toBe(201);
      const ingestBody = await ingestRes.json();
      const capRunId = ingestBody.testRun.id;

      const res = await app.request(`/api/v1/projects/${runDetailProjectId}/runs/${capRunId}?status=all`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.truncated).toBe(true);

      const names = body.results.map((r: { testName: string }) => r.testName);
      expect(names).toContain(failingSpecNames[0]);
      expect(names).toContain(failingSpecNames[1]);

      const firstPassedIndex = body.results.findIndex((r: { status: string }) => r.status === 'passed');
      expect(names.indexOf(failingSpecNames[0])).toBeLessThan(firstPassedIndex);
      expect(names.indexOf(failingSpecNames[1])).toBeLessThan(firstPassedIndex);
    });

    it('returns 404 when the runId belongs to a different project', async () => {
      // testProjectId is a wholly different project created in this file's
      // top-level beforeAll — `runId` was never ingested into it.
      const res = await app.request(`/api/v1/projects/${testProjectId}/runs/${runId}`);
      expect(res.status).toBe(404);
    });

    it('returns 400 for a malformed runId', async () => {
      const res = await app.request(`/api/v1/projects/${runDetailProjectId}/runs/not-a-uuid`);
      expect(res.status).toBe(400);
    });

    it('returns 400 for a malformed project id', async () => {
      const res = await app.request(`/api/v1/projects/not-a-uuid/runs/${runId}`);
      expect(res.status).toBe(400);
    });

    it('returns 404 for a well-formed but non-existent runId', async () => {
      const res = await app.request(`/api/v1/projects/${runDetailProjectId}/runs/${randomUUID()}`);
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/v1/projects/:id/analysis', () => {
    // `testProjectId` never ingests a report, so its analysis is empty. That is
    // a real case worth pinning (an empty project is a valid, empty answer —
    // not a 404), but it CANNOT prove the endpoint's subset invariant
    // (`flakyTests === allTests.filter(t => t.isFlaky)`): on an empty array
    // `every(...)` is vacuously true, so such an assertion would pass even with
    // the filter deleted. Asserting emptiness outright is what IS provable here.
    //
    // No fixture in this describe's shared projects can prove that invariant
    // either: `analyzeFlakiness` drops any test with fewer than
    // `minRuns` runs (flakiness.ts:16 sets minRuns=3; the filter is at
    // flakiness.ts:119). The only pre-existing populated project, `runDetailProjectId`,
    // ingests two reports (:379 and :535) — two runs per test, still under the
    // threshold — so its analysis is empty too; probed live, 0 entries.
    // Proving the invariant needs a project carrying >= minRuns runs of both a
    // flaky and a non-flaky test; that is the dedicated sibling describe below
    // (plan 044), not this empty case.
    it('returns a well-formed, empty analysis for a project with no runs', async () => {
      const res = await app.request(`/api/v1/projects/${testProjectId}/analysis`);
      expect(res.status).toBe(200);

      const body = await res.json();

      // These pin the RANGE of the returned values, not the clamp that produces
      // it. This request sends no `days` or `threshold`, so it reads the
      // resolved defaults (14 / 0.05) — comfortably mid-range. Deleting both
      // clamps in projects.ts leaves this test green (verified). The clamp
      // itself is proven by the out-of-range sibling test below (plan 044).
      expect(typeof body.windowDays).toBe('number');
      expect(body.windowDays).toBeGreaterThanOrEqual(1);
      expect(body.windowDays).toBeLessThanOrEqual(90);

      expect(typeof body.threshold).toBe('number');
      expect(body.threshold).toBeGreaterThanOrEqual(0);
      expect(body.threshold).toBeLessThanOrEqual(1);

      // Explicitly empty, not merely "an array". If this project ever starts
      // carrying runs, this assertion fails loudly and points at the comment
      // above rather than silently turning the sibling test vacuous.
      expect(body.allTests).toEqual([]);
      expect(body.flakyTests).toEqual([]);
    });

    it('should accept custom window and threshold', async () => {
      const res = await app.request(`/api/v1/projects/${testProjectId}/analysis?days=7&threshold=0.1`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.windowDays).toBe(7);
      expect(body.threshold).toBe(0.1);
    });

    it('clamps out-of-range window and threshold', async () => {
      const res = await app.request(`/api/v1/projects/${testProjectId}/analysis?days=999&threshold=5`);
      expect(res.status).toBe(200);

      const body = await res.json();
      // days clamped to the 90 cap, threshold to the 1.0 ceiling
      // (projects.ts:387-397). The in-range sibling test (7 / 0.1) passes those
      // through unclamped, so only out-of-range values catch a deleted clamp.
      expect(body.windowDays).toBe(90);
      expect(body.threshold).toBe(1);
    });

    it('clamps the lower bound and falls back on non-numeric window/threshold', async () => {
      // The sibling test above only covers the UPPER clamps (999→90, 5→1).
      // These cover the lower clamp and the non-numeric fallbacks, which are
      // distinct branches (projects.ts:387-397). testProjectId ingests nothing,
      // so analysis is empty — but windowDays/threshold still echo the resolved
      // values. Defaults are 14 / 0.05 (flakiness.ts DEFAULT_CONFIG; this
      // project sets no overrides).

      // days=-5 reaches Math.max(...,1) → 1. (days=0 would NOT: parseInt('0')||14
      // swallows the 0 into 14 before the clamp — hence a negative here.)
      const neg = await app.request(`/api/v1/projects/${testProjectId}/analysis?days=-5`);
      expect((await neg.json()).windowDays).toBe(1);

      // days=abc → parseInt NaN → `|| resolvedConfig.windowDays` → 14.
      const nanDays = await app.request(`/api/v1/projects/${testProjectId}/analysis?days=abc`);
      expect((await nanDays.json()).windowDays).toBe(14);

      // threshold=-1 → Math.max(rawThreshold,0) → 0.
      const negT = await app.request(`/api/v1/projects/${testProjectId}/analysis?threshold=-1`);
      expect((await negT.json()).threshold).toBe(0);

      // threshold=abc → parseFloat NaN → !Number.isFinite → resolvedConfig → 0.05.
      const nanT = await app.request(`/api/v1/projects/${testProjectId}/analysis?threshold=abc`);
      expect((await nanT.json()).threshold).toBe(0.05);
    });
  });

  describe('GET /api/v1/projects/:id/analysis — flaky-subset invariant (populated)', () => {
    let subsetProjectId: string;

    beforeAll(async () => {
      if (!(hasDatabase && hasAdminToken)) return;
      const createRes = await app.request('/api/v1/admin/projects', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `subset-invariant-${randomUUID()}` }),
      });
      const createBody = await createRes.json();
      subsetProjectId = createBody.project.id;
      const token = createBody.token;

      // One upload, two specs, each with THREE `tests[]` entries so both reach
      // minRuns=3 in a single ingest (the shape reports.test.ts documents; three
      // results[] in ONE tests[] entry would collapse to one row). Probed:
      // A-flaky -> isFlaky true (2 passed, 1 failed), B-stable -> isFlaky false.
      const exec = (status: string, sec: string) => ({
        results: [{ workerIndex: 0, status, duration: 1, retry: 0, startTime: `2026-07-15T10:00:0${sec}.000Z` }],
      });
      const report = {
        config: {},
        suites: [{
          title: 's',
          file: 's.spec.ts',
          specs: [
            { title: 'A-flaky', ok: false, tests: [exec('passed', '0'), exec('passed', '1'), exec('failed', '2')] },
            { title: 'B-stable', ok: true, tests: [exec('passed', '0'), exec('passed', '1'), exec('passed', '2')] },
          ],
        }],
      };
      const ingest = await app.request('/api/v1/reports?branch=main&commit=subset001', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(report),
      });
      expect(ingest.status).toBe(201);
    });

    afterAll(async () => {
      if (subsetProjectId) {
        await app.request(`/api/v1/admin/projects/${subsetProjectId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${adminToken}` },
        });
      }
    });

    it('flakyTests is exactly the flaky subset of allTests', async () => {
      const res = await app.request(`/api/v1/projects/${subsetProjectId}/analysis`);
      expect(res.status).toBe(200);

      const body = await res.json();
      // analyzeFlakiness reads test_results (written synchronously during
      // ingest), not flaky_tests, so this does not race the un-awaited
      // updateFlakyTests() reconcile described in AGENTS.md.

      // Anti-vacuity: BOTH a flaky and a non-flaky test must be present, or the
      // every()/subset checks below are trivially true on a degenerate set (the
      // trap A1 fell into with an empty analysis).
      expect(body.allTests.length).toBeGreaterThanOrEqual(2);
      expect(body.allTests.some((t: { isFlaky: boolean }) => t.isFlaky === false)).toBe(true);
      expect(body.flakyTests.length).toBeGreaterThanOrEqual(1);

      // The endpoint defines flakyTests as allTests.filter(t => t.isFlaky).
      expect(body.flakyTests.every((t: { isFlaky: boolean }) => t.isFlaky)).toBe(true);
      const allNames = new Set(body.allTests.map((t: { testName: string }) => t.testName));
      expect(body.flakyTests.every((t: { testName: string }) => allNames.has(t.testName))).toBe(true);
    });
  });

  describe('GET /api/v1/projects/:id/trend', () => {
    // testProjectId (from the top-level beforeAll) never has any testRuns
    // rows inserted anywhere in this suite — the quarantine block seeds
    // flakyTests directly, and nothing else touches testRuns. So every
    // bucket in its trend is guaranteed to be a genuine no-run day.

    it('falls back to the default 7-entry series when days is not a number ("abc")', async () => {
      const res = await app.request(`/api/v1/projects/${testProjectId}/trend?days=abc`);
      expect(res.status).toBe(200);

      const body = await res.json();
      // Not empty: a NaN that slipped through the clamp would produce a
      // zero-length series (see plan 028 problem 2).
      expect(body.days.length).toBe(7);
      expect(body.rates.length).toBe(7);
    });

    it('clamps days=999 down to the 90-entry cap, not an unbounded series', async () => {
      const res = await app.request(`/api/v1/projects/${testProjectId}/trend?days=999`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.days.length).toBe(90);
      expect(body.rates.length).toBe(90);
    });

    it('clamps days=0 up to a 1-entry series (lower bound)', async () => {
      // trend uses Number.isNaN(rawDays) ? 7 : Math.max(rawDays,1) — unlike
      // /analysis, there is no `|| default` to swallow 0, so days=0 DOES reach
      // the Math.max(...,1) lower clamp (projects.ts:439).
      const res = await app.request(`/api/v1/projects/${testProjectId}/trend?days=0`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.days.length).toBe(1);
      expect(body.rates.length).toBe(1);
    });

    it('reports null — not 0 — for every day, since this project has zero runs', async () => {
      const res = await app.request(`/api/v1/projects/${testProjectId}/trend?days=7`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.rates.length).toBe(7);
      for (const rate of body.rates) {
        // Explicit === null, not a falsy/toBeNull()-only check on the whole
        // array — the point is distinguishing "no data" (null) from
        // "0% flake rate" (0), and those are both falsy-adjacent in loose
        // comparisons. This assertion fails if the endpoint reverts to `0`.
        expect(rate === null).toBe(true);
        expect(rate).not.toBe(0);
      }
    });
  });

  describe('GET /api/v1/projects/:id/trend — populated day (seeded)', () => {
    let trendProjectId: string;

    beforeAll(async () => {
      if (!(hasDatabase && hasAdminToken)) return;
      const createRes = await app.request('/api/v1/admin/projects', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `trend-populated-${randomUUID()}` }),
      });
      trendProjectId = (await createRes.json()).project.id;

      // Direct testRuns insert — /trend aggregates test_runs, never flaky_tests,
      // so this is race-free. createdAt defaults to now() → today's bucket.
      // rate = round(((flaky + failed) / total) * 1000) / 10 = round(3/10*1000)/10 = 30.0
      await db.insert(testRuns).values({
        projectId: trendProjectId,
        branch: 'main',
        commitSha: 'trendpopulated01',
        totalTests: 10,
        passed: 7,
        failed: 1,
        skipped: 0,
        flaky: 2,
      });
    });

    afterAll(async () => {
      if (trendProjectId) {
        await app.request(`/api/v1/admin/projects/${trendProjectId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${adminToken}` },
        });
      }
    });

    it('computes the flake rate for the day that has runs (non-null, exact)', async () => {
      const res = await app.request(`/api/v1/projects/${trendProjectId}/trend?days=7`);
      expect(res.status).toBe(200);

      const body = await res.json();
      // Buckets run oldest→today; the seeded run is today, so it lands in the
      // LAST bucket. rate = (2 flaky + 1 failed) / 10 total = 30.0%.
      const today = body.rates[body.rates.length - 1];
      expect(today).toBe(30);
      expect(today).not.toBeNull();
    });
  });
});
