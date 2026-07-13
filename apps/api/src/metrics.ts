import { Registry, Counter, Gauge, collectDefaultMetrics } from 'prom-client';
import { eq, sql } from 'drizzle-orm';
import { db, projects, testRuns, flakyTests } from './db';
import { logger } from './middleware/logger';

/**
 * Dedicated registry (not prom-client's global default `register`) so this
 * module owns its own metric state — no double-registration errors if it
 * were ever imported more than once (e.g. across test files), and a clean
 * surface for tests to scrape directly.
 */
export const register = new Registry();

collectDefaultMetrics({ register });

export const reportsIngestedTotal = new Counter({
  name: 'flackyness_reports_ingested_total',
  help: 'Total number of test reports successfully ingested, labeled by project name.',
  labelNames: ['project'],
  registers: [register],
});

export const reportParseFailuresTotal = new Counter({
  name: 'flackyness_report_parse_failures_total',
  help: 'Total number of report ingest requests that failed to parse (Playwright JSON or JUnit XML). Not labeled by project to keep cardinality flat.',
  registers: [register],
});

/**
 * Log (not throw) a scrape-time collection failure. A dead DB must not turn
 * /metrics into a 500 — operators lose visibility exactly when they need it
 * most. The counters and default process metrics are still served either way.
 */
function logCollectFailure(metric: string, err: unknown): void {
  logger.error('Failed to collect metric at scrape time', {
    metric,
    error: {
      name: err instanceof Error ? err.name : 'Error',
      message: err instanceof Error ? err.message : 'Unknown error',
    },
  });
}

export const flakyTestsActive = new Gauge({
  name: 'flackyness_flaky_tests_active',
  help: 'Number of currently active flaky tests, labeled by project name.',
  labelNames: ['project'],
  registers: [register],
  async collect() {
    try {
      const rows = await db
        .select({ project: projects.name, count: sql<number>`count(*)::int` })
        .from(flakyTests)
        .innerJoin(projects, eq(flakyTests.projectId, projects.id))
        .where(eq(flakyTests.status, 'active'))
        .groupBy(projects.name);

      // Recompute from scratch each scrape so a project whose flaky count
      // just dropped to zero doesn't keep reporting its last nonzero value.
      this.reset();
      for (const row of rows) {
        this.set({ project: row.project }, row.count);
      }
    } catch (err) {
      logCollectFailure('flackyness_flaky_tests_active', err);
    }
  },
});

export const testRunsTotal = new Gauge({
  name: 'flackyness_test_runs_total',
  help: 'Total number of ingested test runs, labeled by project name.',
  labelNames: ['project'],
  registers: [register],
  async collect() {
    try {
      const rows = await db
        .select({ project: projects.name, count: sql<number>`count(*)::int` })
        .from(testRuns)
        .innerJoin(projects, eq(testRuns.projectId, projects.id))
        .groupBy(projects.name);

      this.reset();
      for (const row of rows) {
        this.set({ project: row.project }, row.count);
      }
    } catch (err) {
      logCollectFailure('flackyness_test_runs_total', err);
    }
  },
});

/** Render the current registry snapshot in Prometheus text exposition format. */
export async function renderMetrics(): Promise<string> {
  return register.metrics();
}
