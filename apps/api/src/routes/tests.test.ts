import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { db, flakyTests, testRuns, testResults } from '../db';
import { updateFlakyTests } from '../services/flakiness';
import { buildTrend, type TrendRow } from './tests';

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

// Pure unit tests — must run without a DB. See design decision 4 in
// plans/025-per-test-flake-trend.md: a day with no runs must report
// flakeRate: null, not 0 — that is the defect class this suite guards.
describe('buildTrend', () => {
  const NOW = new Date('2026-07-15T12:00:00.000Z');

  // A Date `n` days before NOW, anchored at noon UTC so it always falls
  // inside the same UTC calendar day regardless of local timezone.
  function onDay(n: number): Date {
    const d = new Date(NOW);
    d.setUTCDate(d.getUTCDate() - n);
    return d;
  }

  function row(status: string, daysAgoCount: number): TrendRow {
    return { status, createdAt: onDay(daysAgoCount) };
  }

  it('a test that runs every day and never fails -> all flakeRate 0, direction stable', () => {
    const days = 6;
    const rows: TrendRow[] = [];
    for (let i = 0; i < days; i++) {
      rows.push(row('passed', i));
    }

    const { trend, direction } = buildTrend(rows, days, NOW);

    expect(trend).toHaveLength(days);
    for (const bucket of trend) {
      expect(bucket.flakeRate).toBe(0);
      expect(bucket.totalRuns).toBe(1);
    }
    expect(direction).toBe('stable');
  });

  it('flake rate climbing across the window -> direction worsening', () => {
    const days = 6;
    const rows: TrendRow[] = [
      // First half (older days): all passed, flakeRate 0.
      row('passed', 5),
      row('passed', 4),
      row('passed', 3),
      // Second half (newer days): all failed, flakeRate 1.
      row('failed', 2),
      row('failed', 1),
      row('failed', 0),
    ];

    const { direction } = buildTrend(rows, days, NOW);
    expect(direction).toBe('worsening');
  });

  it('flake rate dropping across the window -> direction improving', () => {
    const days = 6;
    const rows: TrendRow[] = [
      row('failed', 5),
      row('failed', 4),
      row('failed', 3),
      row('passed', 2),
      row('passed', 1),
      row('passed', 0),
    ];

    const { direction } = buildTrend(rows, days, NOW);
    expect(direction).toBe('improving');
  });

  it('a day with no runs reports flakeRate null and totalRuns 0 — NOT 0', () => {
    const days = 3;
    // Only day offsets 2 and 0 have data; offset 1 (the middle day) has none.
    const rows: TrendRow[] = [row('passed', 2), row('passed', 0)];

    const { trend } = buildTrend(rows, days, NOW);
    expect(trend).toHaveLength(3);

    const emptyDay = trend[1];
    expect(emptyDay.totalRuns).toBe(0);
    // Explicit === null assertion — this is the plan's key defect class.
    expect(emptyDay.flakeRate === null).toBe(true);
    expect(emptyDay.flakeRate).not.toBe(0);
  });

  it('skipped-only results count toward neither numerator nor denominator', () => {
    const days = 1;
    const rows: TrendRow[] = [row('skipped', 0), row('skipped', 0)];

    const { trend } = buildTrend(rows, days, NOW);
    expect(trend).toHaveLength(1);
    expect(trend[0].totalRuns).toBe(0);
    expect(trend[0].flakeRate).toBeNull();
  });

  it('a window where only the second half has runs -> insufficient-data', () => {
    const days = 6;
    // First half (offsets 5,4,3) has nothing; second half (2,1,0) does.
    const rows: TrendRow[] = [row('passed', 2), row('failed', 1), row('flaky', 0)];

    const { direction } = buildTrend(rows, days, NOW);
    expect(direction).toBe('insufficient-data');
  });

  it('returns exactly `days` entries, oldest first', () => {
    const days = 10;
    const { trend } = buildTrend([], days, NOW);

    expect(trend).toHaveLength(days);
    const dates = trend.map((b) => b.date);
    const sorted = [...dates].sort();
    expect(dates).toEqual(sorted);
    expect(dates[dates.length - 1]).toBe(NOW.toISOString().slice(0, 10));
  });
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
      // sample-report.json's test cases carry no tags/annotations -> NULL columns.
      expect(body.history[0].tags).toBeNull();
      expect(body.history[0].annotations).toBeNull();
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

    it('should handle a test name containing a percent sign without double-decoding', async () => {
      // Regression test: the route must not re-decode an already-decoded
      // param, or a name like "loads 100% of items" throws URIError.
      const encodedName = encodeURIComponent('loads 100% of items');
      const res = await app.request(
        `/api/v1/tests/${encodedName}/history?project=${testProjectId}`
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.testName).toBe('loads 100% of items');
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

  describe('PATCH /api/v1/tests/flaky/:id', () => {
    let flakyId: string;

    beforeAll(async () => {
      // Seed a flaky_tests row directly — the PATCH route only cares about
      // an existing row, not how it got flagged flaky.
      const [row] = await db
        .insert(flakyTests)
        .values({
          projectId: testProjectId,
          testName: 'patch-route-flaky-test',
          testFile: 'patch.spec.ts',
          status: 'active',
          flakeCount: 2,
          totalRuns: 10,
          flakeRate: '0.2000',
        })
        .returning({ id: flakyTests.id });
      flakyId = row.id;
    });

    it('should require authentication', async () => {
      const res = await app.request(`/api/v1/tests/flaky/${flakyId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'ignored' }),
      });
      expect(res.status).toBe(401);
    });

    it('should reject an invalid admin token', async () => {
      const res = await app.request(`/api/v1/tests/flaky/${flakyId}`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer not-the-admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: 'ignored' }),
      });
      expect(res.status).toBe(401);
    });

    it('should mute a flaky test (status -> ignored) and persist it', async () => {
      const res = await app.request(`/api/v1/tests/flaky/${flakyId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: 'ignored' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.flakyTest.id).toBe(flakyId);
      expect(body.flakyTest.status).toBe('ignored');

      // Re-fetch to confirm the write was persisted, not just echoed back.
      const getRes = await app.request(`/api/v1/tests/flaky/${flakyId}`);
      expect(getRes.status).toBe(200);
      const getBody = await getRes.json();
      expect(getBody.flakyTest.status).toBe('ignored');
    });

    it('should unmute a flaky test (status -> active)', async () => {
      const res = await app.request(`/api/v1/tests/flaky/${flakyId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: 'active' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.flakyTest.status).toBe('active');
    });

    it('should reject status "resolved" (system-managed, not operator-settable)', async () => {
      const res = await app.request(`/api/v1/tests/flaky/${flakyId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: 'resolved' }),
      });
      expect(res.status).toBe(400);
    });

    it('should reject an unrecognized status value', async () => {
      const res = await app.request(`/api/v1/tests/flaky/${flakyId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: 'bogus' }),
      });
      expect(res.status).toBe(400);
    });

    it('should reject a non-JSON body', async () => {
      const res = await app.request(`/api/v1/tests/flaky/${flakyId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: 'not json',
      });
      expect(res.status).toBe(400);
    });

    it('should return 404 for a valid body but unknown flaky test id', async () => {
      const res = await app.request(`/api/v1/tests/flaky/${randomUUID()}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: 'ignored' }),
      });
      expect(res.status).toBe(404);
    });

    it('should return 400 for a malformed id, even with a valid body', async () => {
      const res = await app.request('/api/v1/tests/flaky/not-a-uuid', {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: 'ignored' }),
      });
      expect(res.status).toBe(400);
    });

    it('should keep an ignored test ignored across a reconcile pass', async () => {
      // Mute it again (previous test left it 'active').
      const muteRes = await app.request(`/api/v1/tests/flaky/${flakyId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: 'ignored' }),
      });
      expect(muteRes.status).toBe(200);

      // Reconcile shouldn't silently un-mute it, whether or not the test
      // still shows up in fresh flakiness analysis.
      await updateFlakyTests(testProjectId);

      const getRes = await app.request(`/api/v1/tests/flaky/${flakyId}`);
      expect(getRes.status).toBe(200);
      const getBody = await getRes.json();
      expect(getBody.flakyTest.status).toBe('ignored');
    });
  });

  describe('GET /api/v1/tests/:testName/trend', () => {
    it('should require project parameter', async () => {
      const res = await app.request('/api/v1/tests/some-test/trend');
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toContain('project');
    });

    it('should reject a non-UUID project parameter', async () => {
      const res = await app.request('/api/v1/tests/some-test/trend?project=not-a-uuid');
      expect(res.status).toBe(400);
    });

    it('should clamp an oversized days parameter to 90', async () => {
      const res = await app.request(
        `/api/v1/tests/some-test/trend?project=${testProjectId}&days=999`
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.days).toBe(90);
      expect(body.trend).toHaveLength(90);
    });

    it('should return a plausible trend + direction for the known ingested test', async () => {
      const encodedName = encodeURIComponent(KNOWN_TEST_NAME);
      const res = await app.request(
        `/api/v1/tests/${encodedName}/trend?project=${testProjectId}&days=7`
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.testName).toBe(KNOWN_TEST_NAME);
      expect(body.projectId).toBe(testProjectId);
      expect(body.days).toBe(7);
      expect(['improving', 'worsening', 'stable', 'insufficient-data']).toContain(body.direction);
      expect(body.trend).toHaveLength(7);

      // Today's bucket should reflect the report ingested in beforeAll.
      const today = body.trend[body.trend.length - 1];
      expect(today.totalRuns).toBeGreaterThanOrEqual(1);
      expect(typeof today.flakeRate).toBe('number');
    });

    it('scopes the trend to the given project — an identically named test in another project must not blend in', async () => {
      const testName = `shared-trend-test-${Date.now()}`;

      // A second, throwaway project carrying an identically named test.
      const createRes = await app.request('/api/v1/admin/projects', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: `tests-route-trend-other-${Date.now()}` }),
      });
      expect(createRes.status).toBe(201);
      const otherProjectBody = await createRes.json();
      const otherProjectId: string = otherProjectBody.project.id;

      try {
        // Project A (testProjectId): one failing result for this test, today.
        const [runA] = await db
          .insert(testRuns)
          .values({ projectId: testProjectId, branch: 'main', commitSha: 'trenda01' })
          .returning({ id: testRuns.id });
        await db.insert(testResults).values({
          testRunId: runA.id,
          testName,
          testFile: 'trend.spec.ts',
          status: 'failed',
        });

        // Project B (otherProjectId): one passing result for the SAME test
        // name, today. Without the project-scoped join, these would blend.
        const [runB] = await db
          .insert(testRuns)
          .values({ projectId: otherProjectId, branch: 'main', commitSha: 'trendb01' })
          .returning({ id: testRuns.id });
        await db.insert(testResults).values({
          testRunId: runB.id,
          testName,
          testFile: 'trend.spec.ts',
          status: 'passed',
        });

        const res = await app.request(
          `/api/v1/tests/${encodeURIComponent(testName)}/trend?project=${testProjectId}&days=1`
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.testName).toBe(testName);
        expect(body.projectId).toBe(testProjectId);
        expect(body.trend).toHaveLength(1);

        // Only project A's single failed result — NOT project B's passed
        // result blended in. If the join scope were missing, totalRuns
        // would be 2 and flakeRate 0.5 instead of 1.
        const todayBucket = body.trend[0];
        expect(todayBucket.totalRuns).toBe(1);
        expect(todayBucket.failed).toBe(1);
        expect(todayBucket.flakeRate).toBe(1);
      } finally {
        const delRes = await app.request(`/api/v1/admin/projects/${otherProjectId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${adminToken}` },
        });
        expect(delRes.status).toBe(200);
      }
    });
  });
});
