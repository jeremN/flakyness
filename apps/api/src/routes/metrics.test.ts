import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// GET /metrics is mounted directly on the root app (index.ts), like /health
// and /api/v1 — see routes/api.test.ts for the same convention.
//
// Unlike most other route suites, the *basic* /metrics behavior (404 when
// unconfigured, 401 on bad auth, 200 with counters present) does not require
// a database — the module's db access is lazy and gauge collection swallows
// a DB failure by design (see src/metrics.ts) — so those tests run in both
// DB and no-DB `pnpm --filter api test` modes. Only the full ingest-then-
// scrape end-to-end test is gated behind DATABASE_URL + ADMIN_TOKEN.
const hasDatabase = !!process.env.DATABASE_URL;
const hasAdminToken = !!process.env.ADMIN_TOKEN;
const describeWithDb = hasDatabase && hasAdminToken ? describe : describe.skip;

const METRICS_TOKEN = 'test-metrics-token';

let app: typeof import('../index').default;

beforeAll(async () => {
  const module = await import('../index');
  app = module.default;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /metrics', () => {
  it('returns 404 when METRICS_TOKEN is not configured', async () => {
    vi.stubEnv('METRICS_TOKEN', '');
    const res = await app.request('/metrics');
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toBe('Not found');
  });

  it('returns 401 when no Authorization header is provided', async () => {
    vi.stubEnv('METRICS_TOKEN', METRICS_TOKEN);
    const res = await app.request('/metrics');
    expect(res.status).toBe(401);
  });

  it('returns 401 for a malformed Authorization header', async () => {
    vi.stubEnv('METRICS_TOKEN', METRICS_TOKEN);
    const res = await app.request('/metrics', {
      headers: { Authorization: 'Basic whatever' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 for a wrong token', async () => {
    vi.stubEnv('METRICS_TOKEN', METRICS_TOKEN);
    const res = await app.request('/metrics', {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it('returns 200 text/plain with all four flackyness_* series and default process metrics for a valid token', async () => {
    vi.stubEnv('METRICS_TOKEN', METRICS_TOKEN);
    const res = await app.request('/metrics', {
      headers: { Authorization: `Bearer ${METRICS_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');

    const body = await res.text();
    expect(body).toContain('flackyness_reports_ingested_total');
    expect(body).toContain('flackyness_report_parse_failures_total');
    expect(body).toContain('flackyness_flaky_tests_active');
    expect(body).toContain('flackyness_test_runs_total');
    expect(body).toMatch(/process_cpu/);
  });

  // Only meaningful when the whole test run has no DATABASE_URL configured
  // (the `pnpm --filter api test` "no-DB mode" run) — otherwise the gauge
  // query would actually succeed against the real disposable DB.
  if (!hasDatabase) {
    it('gauge collection failure is swallowed: scrape still 200s with counters intact', async () => {
      vi.stubEnv('METRICS_TOKEN', METRICS_TOKEN);
      const res = await app.request('/metrics', {
        headers: { Authorization: `Bearer ${METRICS_TOKEN}` },
      });
      expect(res.status).toBe(200);

      const body = await res.text();
      // The gauges still declare themselves (HELP/TYPE) but have no value
      // lines, since the underlying DB query threw and collect() caught it.
      expect(body).toContain('# HELP flackyness_flaky_tests_active');
      expect(body).not.toMatch(/flackyness_flaky_tests_active\{/);
      expect(body).toContain('# HELP flackyness_test_runs_total');
      expect(body).not.toMatch(/flackyness_test_runs_total\{/);
      // Counters and default metrics are unaffected by the DB being down.
      expect(body).toContain('flackyness_report_parse_failures_total');
      expect(body).toMatch(/process_cpu/);
    });
  }
});

describeWithDb('GET /metrics (DB-gated end-to-end)', () => {
  const adminToken = process.env.ADMIN_TOKEN!;
  const sampleReport = JSON.parse(
    readFileSync(join(__dirname, '../../fixtures/sample-report.json'), 'utf-8')
  );

  it('reflects an ingested report and a parse failure in the scrape', async () => {
    vi.stubEnv('METRICS_TOKEN', METRICS_TOKEN);

    const projectName = `metrics-e2e-${Date.now()}`;
    const createRes = await app.request('/api/v1/admin/projects', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: projectName }),
    });
    expect(createRes.status).toBe(201);
    const { project, token } = await createRes.json();

    const ingestRes = await app.request(
      `/api/v1/reports?branch=main&commit=${'a'.repeat(40)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(sampleReport),
      }
    );
    expect(ingestRes.status).toBe(201);

    const badRes = await app.request(
      `/api/v1/reports?branch=main&commit=${'a'.repeat(40)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: 'not valid json',
      }
    );
    expect(badRes.status).toBe(400);

    const metricsRes = await app.request('/metrics', {
      headers: { Authorization: `Bearer ${METRICS_TOKEN}` },
    });
    expect(metricsRes.status).toBe(200);
    const body = await metricsRes.text();

    expect(body).toMatch(
      new RegExp(`flackyness_reports_ingested_total\\{project="${projectName}"\\} 1`)
    );
    expect(body).toMatch(
      new RegExp(`flackyness_test_runs_total\\{project="${projectName}"\\} 1`)
    );

    const parseFailureMatch = body.match(/flackyness_report_parse_failures_total (\d+)/);
    expect(parseFailureMatch).not.toBeNull();
    expect(Number(parseFailureMatch![1])).toBeGreaterThanOrEqual(1);

    await app.request(`/api/v1/admin/projects/${project.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
  });
});
