import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { db, flakyTests } from '../db';
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
    it('should return real-time flakiness analysis', async () => {
      const res = await app.request(`/api/v1/projects/${testProjectId}/analysis`);
      expect(res.status).toBe(200);

      const body = await res.json();

      // windowDays and threshold are clamped by the handler (projects.ts:387-399).
      expect(typeof body.windowDays).toBe('number');
      expect(body.windowDays).toBeGreaterThanOrEqual(1);
      expect(body.windowDays).toBeLessThanOrEqual(90);

      expect(typeof body.threshold).toBe('number');
      expect(body.threshold).toBeGreaterThanOrEqual(0);
      expect(body.threshold).toBeLessThanOrEqual(1);

      expect(Array.isArray(body.flakyTests)).toBe(true);
      expect(Array.isArray(body.allTests)).toBe(true);

      // The endpoint defines flakyTests as allTests.filter(t => t.isFlaky),
      // so both of these hold by construction — and break if that filter does.
      expect(body.flakyTests.every((t: { isFlaky: boolean }) => t.isFlaky)).toBe(true);
      const allNames = new Set(body.allTests.map((t: { testName: string }) => t.testName));
      expect(
        body.flakyTests.every((t: { testName: string }) => allNames.has(t.testName))
      ).toBe(true);
    });

    it('should accept custom window and threshold', async () => {
      const res = await app.request(`/api/v1/projects/${testProjectId}/analysis?days=7&threshold=0.1`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.windowDays).toBe(7);
      expect(body.threshold).toBe(0.1);
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
});
