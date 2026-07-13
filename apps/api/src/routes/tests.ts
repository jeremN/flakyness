import { Hono } from 'hono';
import { z } from 'zod';
import { eq, desc, and, gte } from 'drizzle-orm';
import { db, testResults, testRuns, flakyTests } from '../db';
import { apiRateLimit } from '../middleware/rate-limit';
import { adminAuth } from '../middleware/auth';

const testsRouter = new Hono();

const uuidSchema = z.string().uuid();

// Apply rate limiting
testsRouter.use('*', apiRateLimit);

// ---------------------------------------------------------------------------
// Per-test flake-rate trend — pure aggregation (no I/O), so it can be unit
// tested without a database. See plans/025-per-test-flake-trend.md.
// ---------------------------------------------------------------------------

export interface TrendRow {
  status: string;
  createdAt: Date;
}

export interface TrendBucket {
  date: string;
  totalRuns: number;
  failed: number;
  flaky: number;
  flakeRate: number | null;
}

export type TrendDirection = 'improving' | 'worsening' | 'stable' | 'insufficient-data';

// Dead-band for the first-half vs second-half comparison: a swing smaller
// than this absolute flake-rate delta is reported as 'stable' rather than
// noise being labeled a trend.
const DIRECTION_DEAD_BAND = 0.05;

/**
 * Bucket raw test-result rows into zero-filled daily buckets across
 * `[now - days, now]`, and summarize the direction of travel.
 *
 * Flake rate matches `computeFlakiness` in `services/flakiness.ts` exactly:
 * `(failed + flaky) / total`, where `total = passed + failed + flaky` and
 * `skipped` counts toward neither. A day with zero qualifying runs reports
 * `flakeRate: null` — NOT `0` — because "the test didn't run" and "the test
 * ran and never flaked" are different facts; collapsing them would draw a
 * reassuring flat line through a gap in the data.
 *
 * `now` is a parameter (not `new Date()` internally) so tests can pin the
 * window deterministically.
 */
export function buildTrend(
  rows: TrendRow[],
  days: number,
  now: Date
): { trend: TrendBucket[]; direction: TrendDirection } {
  const dailyMap = new Map<string, { totalRuns: number; failed: number; flaky: number }>();

  // Zero-fill every day in the window, oldest to newest, so the series is
  // always exactly `days` long and a quiet day is explicit rather than a
  // hole in the array.
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    dailyMap.set(key, { totalRuns: 0, failed: 0, flaky: 0 });
  }

  for (const row of rows) {
    const key = row.createdAt.toISOString().slice(0, 10);
    const bucket = dailyMap.get(key);
    if (!bucket) continue; // outside the window (shouldn't happen given the query's cutoff, but be defensive)

    switch (row.status) {
      case 'failed':
        bucket.failed += 1;
        bucket.totalRuns += 1;
        break;
      case 'flaky':
        bucket.flaky += 1;
        bucket.totalRuns += 1;
        break;
      case 'passed':
        bucket.totalRuns += 1;
        break;
      // 'skipped' (and anything else unrecognized) counts toward neither
      // the numerator nor the denominator — matches computeFlakiness.
    }
  }

  const trend: TrendBucket[] = [];
  for (const [date, data] of dailyMap) {
    trend.push({
      date,
      totalRuns: data.totalRuns,
      failed: data.failed,
      flaky: data.flaky,
      flakeRate: data.totalRuns > 0 ? (data.failed + data.flaky) / data.totalRuns : null,
    });
  }

  // Direction: compare the mean flake rate of the first half of the window
  // against the second half, over days that actually have runs. This is a
  // deliberately crude heuristic meant to sort a list, not a statistical claim.
  const withData = trend.filter((b) => b.flakeRate !== null);
  const midpoint = Math.floor(trend.length / 2);
  const firstHalfDates = new Set(trend.slice(0, midpoint).map((b) => b.date));
  const firstHalf = withData.filter((b) => firstHalfDates.has(b.date));
  const secondHalf = withData.filter((b) => !firstHalfDates.has(b.date));

  let direction: TrendDirection;
  if (firstHalf.length === 0 || secondHalf.length === 0) {
    direction = 'insufficient-data';
  } else {
    const mean = (bs: TrendBucket[]) => bs.reduce((sum, b) => sum + (b.flakeRate as number), 0) / bs.length;
    const delta = mean(secondHalf) - mean(firstHalf);
    if (Math.abs(delta) <= DIRECTION_DEAD_BAND) {
      direction = 'stable';
    } else if (delta > 0) {
      direction = 'worsening';
    } else {
      direction = 'improving';
    }
  }

  return { trend, direction };
}

/**
 * GET /api/v1/tests/:testName/history
 *
 * Get run history for a specific test (by test name, URL encoded)
 */
testsRouter.get('/:testName/history', async (c) => {
  const testName = c.req.param('testName');
  const projectId = c.req.query('project');
  const requestedLimit = parseInt(c.req.query('limit') || '50', 10);

  // Clamp limit between 1 and 100
  const limit = Math.min(Math.max(requestedLimit, 1), 100);

  if (!projectId) {
    return c.json({ error: 'project query parameter is required' }, 400);
  }

  const parsedProjectId = uuidSchema.safeParse(projectId);
  if (!parsedProjectId.success) {
    return c.json({ error: 'Invalid project ID format' }, 400);
  }

  // Get test results with run info
  const history = await db
    .select({
      id: testResults.id,
      testName: testResults.testName,
      testFile: testResults.testFile,
      status: testResults.status,
      durationMs: testResults.durationMs,
      retryCount: testResults.retryCount,
      errorMessage: testResults.errorMessage,
      tags: testResults.tags,
      annotations: testResults.annotations,
      createdAt: testResults.createdAt,
      runId: testRuns.id,
      branch: testRuns.branch,
      commitSha: testRuns.commitSha,
      pipelineId: testRuns.pipelineId,
    })
    .from(testResults)
    .innerJoin(testRuns, eq(testResults.testRunId, testRuns.id))
    .where(
      and(
        eq(testResults.testName, testName),
        eq(testRuns.projectId, parsedProjectId.data)
      )
    )
    .orderBy(desc(testResults.createdAt))
    .limit(limit);

  // Get flaky test info if exists
  const [flakyInfo] = await db
    .select()
    .from(flakyTests)
    .where(
      and(
        eq(flakyTests.testName, testName),
        eq(flakyTests.projectId, parsedProjectId.data)
      )
    )
    .limit(1);

  // Calculate stats
  const stats = {
    totalRuns: history.length,
    passed: history.filter((h) => h.status === 'passed').length,
    failed: history.filter((h) => h.status === 'failed').length,
    flaky: history.filter((h) => h.status === 'flaky').length,
    skipped: history.filter((h) => h.status === 'skipped').length,
    avgDuration: history.length > 0
      ? Math.round(history.reduce((sum, h) => sum + (h.durationMs || 0), 0) / history.length)
      : 0,
  };

  return c.json({
    testName,
    flakyInfo: flakyInfo || null,
    stats,
    history,
  });
});

/**
 * GET /api/v1/tests/:testName/trend
 *
 * Per-test daily flake-rate trend, derived on demand from `test_results` —
 * no snapshot table, no migration (see plans/025-per-test-flake-trend.md).
 * The horizon is bounded by however much `test_results` history the
 * project's retention (plan 021) still has on disk.
 */
testsRouter.get('/:testName/trend', async (c) => {
  const testName = c.req.param('testName');
  const projectId = c.req.query('project');

  if (!projectId) {
    return c.json({ error: 'project query parameter is required' }, 400);
  }

  const parsedProjectId = uuidSchema.safeParse(projectId);
  if (!parsedProjectId.success) {
    return c.json({ error: 'Invalid project ID format' }, 400);
  }

  // Clamp days between 1 and 90 (DoS guard, same as /projects/:id/trend),
  // but guard the *parse* first: parseInt('abc') is NaN, and every
  // Math.min/Math.max comparison against NaN is false, so NaN would sail
  // straight through the clamp and produce an empty `trend` with
  // `days: null` — a 200 that says "this test has no history" when the
  // truth is "you typo'd a query param". `days` is display tuning, not a
  // semantic input, so an unparseable value falls back to the default
  // rather than 400ing — it just must never silently render empty.
  // Not `parseInt(...) || 30`: that would swallow days=0 into 30 instead of
  // clamping it to 1.
  const rawDays = parseInt(c.req.query('days') ?? '', 10);
  const days = Number.isNaN(rawDays) ? 30 : Math.min(Math.max(rawDays, 1), 90);

  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - days);

  // A test name is only unique within a project (flaky_tests' unique index
  // is (project_id, test_name)) — the innerJoin + projectId filter is load
  // bearing, not optional, or two projects' identically named tests blend
  // into one bogus trend line.
  const rows = await db
    .select({
      status: testResults.status,
      createdAt: testResults.createdAt,
    })
    .from(testResults)
    .innerJoin(testRuns, eq(testResults.testRunId, testRuns.id))
    .where(
      and(
        eq(testResults.testName, testName),
        eq(testRuns.projectId, parsedProjectId.data),
        gte(testResults.createdAt, cutoff)
      )
    );

  const { trend, direction } = buildTrend(rows, days, now);

  return c.json({
    testName,
    projectId: parsedProjectId.data,
    days,
    direction,
    trend,
  });
});

/**
 * GET /api/v1/tests/flaky/:id
 *
 * Get details for a specific flaky test by ID
 */
testsRouter.get('/flaky/:id', async (c) => {
  const parsed = uuidSchema.safeParse(c.req.param('id'));
  if (!parsed.success) {
    return c.json({ error: 'Invalid flaky test ID format' }, 400);
  }

  const [flakyTest] = await db
    .select()
    .from(flakyTests)
    .where(eq(flakyTests.id, parsed.data))
    .limit(1);

  if (!flakyTest) {
    return c.json({ error: 'Flaky test not found' }, 404);
  }

  return c.json({ flakyTest });
});

const flakyStatusPatchSchema = z.object({
  status: z.enum(['ignored', 'active']),
});

/**
 * PATCH /api/v1/tests/flaky/:id
 *
 * Set a flaky test's status to 'ignored' (mute) or 'active' (unmute).
 * 'resolved' is system-managed and not accepted here.
 */
testsRouter.patch('/flaky/:id', adminAuth(), async (c) => {
  const parsed = uuidSchema.safeParse(c.req.param('id'));
  if (!parsed.success) {
    return c.json({ error: 'Invalid flaky test ID format' }, 400);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const parsedBody = flakyStatusPatchSchema.safeParse(body);
  if (!parsedBody.success) {
    return c.json({ error: "status must be 'ignored' or 'active'" }, 400);
  }

  const [flakyTest] = await db
    .update(flakyTests)
    .set({ status: parsedBody.data.status })
    .where(eq(flakyTests.id, parsed.data))
    .returning();

  if (!flakyTest) {
    return c.json({ error: 'Flaky test not found' }, 404);
  }

  return c.json({ flakyTest });
});

export default testsRouter;
