import { Hono } from 'hono';
import { z } from 'zod';
import { eq, desc, and, gte, inArray, sql } from 'drizzle-orm';
import { db, projects, flakyTests, testRuns, testResults } from '../db';
import { getProjectStats, analyzeFlakiness, resolveProjectConfig } from '../services/flakiness';
import { apiRateLimit } from '../middleware/rate-limit';
import { readAuth } from '../middleware/auth';

const projectsRouter = new Hono();

const uuidSchema = z.string().uuid();
const flakyStatusSchema = z.enum(['active', 'resolved', 'ignored', 'all']).default('active');

// Safety cap for the quarantine endpoint — a CI consumer needs the complete
// set (no pagination), but an unbounded query is still a risk. A project
// with more than this many quarantined tests has a bigger problem than
// pagination; `truncated: true` signals the cap was hit.
const QUARANTINE_ROW_CAP = 1000;

// Safety cap for GET /:id/runs/:runId's `results` — the default (failed +
// flaky) scope will essentially never hit this, but `?status=all` on a huge
// suite could otherwise return an unbounded payload. `truncated: true`
// mirrors the quarantine endpoint's cap semantics.
//
// Exported so tests can size a >CAP fixture without hardcoding the number.
export const RUN_RESULTS_CAP = 2000;

const runResultsStatusSchema = z.enum(['all', 'failed', 'flaky', 'passed', 'skipped']);

// Apply rate limiting
projectsRouter.use('*', apiRateLimit);

/**
 * Escape regex metacharacters so a test name is matched literally inside the
 * generated --grep-invert pattern. Test names routinely contain `.`, `(`, `)`
 * and `[` — unescaped, they silently match the wrong tests.
 *
 * Exported for unit testing.
 */
export function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the Playwright `--grep-invert` pattern from muted test names ONLY.
 * `""` (empty string) when there are no muted tests — NOT null, and NOT a
 * regex that matches everything. A CI job doing
 * `playwright test --grep-invert "$(curl …)"` with a bad empty value would
 * skip the entire suite and go green for the wrong reason.
 *
 * Exported for unit testing.
 */
export function buildGrepInvert(mutedTestNames: string[]): string {
  if (mutedTestNames.length === 0) return '';
  return `^(?:${mutedTestNames.map(escapeRegex).join('|')})$`;
}

/**
 * GET /api/v1/projects
 *
 * List all projects
 */
projectsRouter.get('/', readAuth(), async (c) => {
  const allProjects = await db
    .select({
      id: projects.id,
      name: projects.name,
      createdAt: projects.createdAt,
    })
    .from(projects)
    .orderBy(projects.name);

  return c.json({ projects: allProjects });
});

/**
 * GET /api/v1/projects/:id/stats
 *
 * Get project statistics
 */
projectsRouter.get('/:id/stats', readAuth((c) => c.req.param('id')), async (c) => {
  const parsed = uuidSchema.safeParse(c.req.param('id'));
  if (!parsed.success) {
    return c.json({ error: 'Invalid project ID format' }, 400);
  }

  const stats = await getProjectStats(parsed.data);

  if (!stats) {
    return c.json({ error: 'Project not found' }, 404);
  }

  return c.json(stats);
});

/**
 * GET /api/v1/projects/:id/flaky-tests
 *
 * Get flaky tests for a project
 */
projectsRouter.get('/:id/flaky-tests', readAuth((c) => c.req.param('id')), async (c) => {
  const parsed = uuidSchema.safeParse(c.req.param('id'));
  if (!parsed.success) {
    return c.json({ error: 'Invalid project ID format' }, 400);
  }
  const projectId = parsed.data;

  const statusParsed = flakyStatusSchema.safeParse(c.req.query('status'));
  const status = statusParsed.success ? statusParsed.data : 'active';
  const requestedLimit = parseInt(c.req.query('limit') || '50', 10);

  // Clamp limit between 1 and 100
  const limit = Math.min(Math.max(requestedLimit, 1), 100);

  const flakyTestsList = await db
    .select({
      id: flakyTests.id,
      testName: flakyTests.testName,
      testFile: flakyTests.testFile,
      firstDetected: flakyTests.firstDetected,
      lastSeen: flakyTests.lastSeen,
      flakeCount: flakyTests.flakeCount,
      totalRuns: flakyTests.totalRuns,
      flakeRate: flakyTests.flakeRate,
      status: flakyTests.status,
    })
    .from(flakyTests)
    .where(
      and(
        eq(flakyTests.projectId, projectId),
        status !== 'all' ? eq(flakyTests.status, status) : undefined
      )
    )
    .orderBy(desc(flakyTests.flakeRate))
    .limit(limit);

  return c.json({ flakyTests: flakyTestsList });
});

/**
 * GET /api/v1/projects/:id/quarantine
 *
 * Machine-readable quarantine list for CI to consume. Splits flaky-test rows
 * into two sets that must never be conflated:
 *   - `muted`: status = 'ignored' — an operator explicitly muted it. Safe to skip.
 *   - `flaky`: status = 'active'  — auto-detected. Advisory only: retry or
 *     annotate, do NOT skip.
 * `grepInvert` is built from `muted` ONLY. Auto-skipping a machine-detected
 * test without human sign-off would silently hide a real regression.
 * `grepInvert` is `""` (not null, not a match-everything regex) when there
 * are no muted tests — a CI job passing an empty pattern to
 * `--grep-invert` must run the full suite, never zero tests.
 */
projectsRouter.get('/:id/quarantine', readAuth((c) => c.req.param('id')), async (c) => {
  const parsed = uuidSchema.safeParse(c.req.param('id'));
  if (!parsed.success) {
    return c.json({ error: 'Invalid project ID format' }, 400);
  }
  const projectId = parsed.data;

  // Cap at COUNT+1 so overflow can be detected before slicing back to the cap.
  const rows = await db
    .select({
      testName: flakyTests.testName,
      testFile: flakyTests.testFile,
      flakeRate: flakyTests.flakeRate,
      lastSeen: flakyTests.lastSeen,
      status: flakyTests.status,
    })
    .from(flakyTests)
    .where(
      and(
        eq(flakyTests.projectId, projectId),
        inArray(flakyTests.status, ['ignored', 'active'])
      )
    )
    .orderBy(desc(flakyTests.flakeRate))
    .limit(QUARANTINE_ROW_CAP + 1);

  const truncated = rows.length > QUARANTINE_ROW_CAP;
  const capped = truncated ? rows.slice(0, QUARANTINE_ROW_CAP) : rows;

  const toEntry = ({ testName, testFile, flakeRate, lastSeen }: (typeof capped)[number]) => ({
    testName,
    testFile,
    flakeRate,
    lastSeen,
  });
  const muted = capped.filter((r) => r.status === 'ignored').map(toEntry);
  const flaky = capped.filter((r) => r.status === 'active').map(toEntry);

  // Load-bearing: grepInvert is derived from `muted` ONLY. Do not add
  // `flaky` here — see the doc comment above and design decision 3 in
  // plans/020-quarantine-list-for-ci.md.
  const grepInvert = buildGrepInvert(muted.map((t) => t.testName));

  if (c.req.query('format') === 'playwright') {
    c.header('Content-Type', 'text/plain; charset=utf-8');
    return c.body(grepInvert);
  }

  return c.json({ projectId, muted, flaky, grepInvert, truncated });
});

/**
 * GET /api/v1/projects/:id/runs
 *
 * Get recent test runs for a project
 */
projectsRouter.get('/:id/runs', readAuth((c) => c.req.param('id')), async (c) => {
  const parsed = uuidSchema.safeParse(c.req.param('id'));
  if (!parsed.success) {
    return c.json({ error: 'Invalid project ID format' }, 400);
  }
  const projectId = parsed.data;
  const requestedLimit = parseInt(c.req.query('limit') || '20', 10);

  // Clamp limit between 1 and 100
  const limit = Math.min(Math.max(requestedLimit, 1), 100);

  const runs = await db
    .select({
      id: testRuns.id,
      branch: testRuns.branch,
      commitSha: testRuns.commitSha,
      pipelineId: testRuns.pipelineId,
      startedAt: testRuns.startedAt,
      finishedAt: testRuns.finishedAt,
      totalTests: testRuns.totalTests,
      passed: testRuns.passed,
      failed: testRuns.failed,
      skipped: testRuns.skipped,
      flaky: testRuns.flaky,
      createdAt: testRuns.createdAt,
    })
    .from(testRuns)
    .where(eq(testRuns.projectId, projectId))
    .orderBy(desc(testRuns.createdAt))
    .limit(limit);

  return c.json({ runs });
});

/**
 * GET /api/v1/projects/:id/runs/:runId
 *
 * Get a single run's summary plus its per-test results. Scoped by BOTH the
 * project id and the run id — `WHERE test_runs.id = :runId AND
 * test_runs.project_id = :id` — so a well-formed `runId` belonging to a
 * *different* project 404s instead of leaking that project's data (the
 * same confused-deputy shape closed elsewhere in this API; see plan 031).
 *
 * `status` query param:
 *   - absent (default) — only `failed` and `flaky` results ("what needs
 *     attention"); this is the common case and keeps the payload small.
 *   - `all` — every result, no status filter.
 *   - `failed` | `flaky` | `passed` | `skipped` — exactly that one status.
 *   - anything else unparseable — falls back to the default (failed+flaky),
 *     same idiom as `/:id/flaky-tests`'s status handling.
 *
 * Results are ordered failed, then flaky, then skipped, then passed; within
 * a status, alphabetically by `testName` — ordered in SQL *before* the
 * `.limit`, so that truncation (see below) drops the lowest-priority
 * (passed) rows first rather than an arbitrary tail that could contain
 * failures. Capped at RUN_RESULTS_CAP — the default scope will essentially
 * never hit it, but `?status=all` on a huge suite could otherwise return an
 * unbounded payload; `truncated: true` signals the cap was hit (mirrors the
 * quarantine endpoint's flag).
 */
projectsRouter.get('/:id/runs/:runId', readAuth((c) => c.req.param('id')), async (c) => {
  const parsedProjectId = uuidSchema.safeParse(c.req.param('id'));
  if (!parsedProjectId.success) {
    return c.json({ error: 'Invalid project ID format' }, 400);
  }
  const parsedRunId = uuidSchema.safeParse(c.req.param('runId'));
  if (!parsedRunId.success) {
    return c.json({ error: 'Invalid run ID format' }, 400);
  }
  const projectId = parsedProjectId.data;
  const runId = parsedRunId.data;

  const [run] = await db
    .select({
      id: testRuns.id,
      branch: testRuns.branch,
      commitSha: testRuns.commitSha,
      pipelineId: testRuns.pipelineId,
      startedAt: testRuns.startedAt,
      finishedAt: testRuns.finishedAt,
      createdAt: testRuns.createdAt,
      totalTests: testRuns.totalTests,
      passed: testRuns.passed,
      failed: testRuns.failed,
      skipped: testRuns.skipped,
      flaky: testRuns.flaky,
    })
    .from(testRuns)
    // Ownership check: both predicates in the same WHERE, not a separate
    // "does this project exist" lookup followed by an unscoped run lookup.
    .where(and(eq(testRuns.id, runId), eq(testRuns.projectId, projectId)))
    .limit(1);

  if (!run) {
    return c.json({ error: 'Run not found' }, 404);
  }

  // The absent case ("failed+flaky") can't be expressed as a single zod
  // enum `.default(...)` (it's two values, not one), so it's handled
  // explicitly here rather than folded into `runResultsStatusSchema`.
  const rawStatus = c.req.query('status');
  let statusFilter: ReturnType<typeof eq> | ReturnType<typeof inArray> | undefined;
  if (rawStatus === undefined) {
    statusFilter = inArray(testResults.status, ['failed', 'flaky']);
  } else {
    const parsedStatus = runResultsStatusSchema.safeParse(rawStatus);
    const status = parsedStatus.success ? parsedStatus.data : undefined;
    if (status === 'all') {
      statusFilter = undefined;
    } else if (status === undefined) {
      // Unparseable value — fall back to the default scope rather than 400,
      // same idiom as `/:id/flaky-tests`.
      statusFilter = inArray(testResults.status, ['failed', 'flaky']);
    } else {
      statusFilter = eq(testResults.status, status);
    }
  }

  const rows = await db
    .select({
      testName: testResults.testName,
      testFile: testResults.testFile,
      status: testResults.status,
      durationMs: testResults.durationMs,
      retryCount: testResults.retryCount,
      errorMessage: testResults.errorMessage,
      tags: testResults.tags,
      annotations: testResults.annotations,
      failureDetail: testResults.failureDetail,
    })
    .from(testResults)
    .where(and(eq(testResults.testRunId, runId), statusFilter))
    // Order BEFORE the cap: failed, then flaky, then skipped, then passed
    // (else last), then alphabetically by testName. Ordering must happen in
    // SQL, not after the `.limit`, so that when a run has more than
    // RUN_RESULTS_CAP results the rows dropped by truncation are the
    // lowest-priority (passed) ones — not an arbitrary insertion-order tail
    // that could otherwise discard real failures. See plan
    // 036-run-detail-order-before-cap.
    .orderBy(
      sql`CASE ${testResults.status} WHEN 'failed' THEN 0 WHEN 'flaky' THEN 1 WHEN 'skipped' THEN 2 WHEN 'passed' THEN 3 ELSE 4 END`,
      testResults.testName
    )
    // Cap at COUNT+1 so overflow can be detected before slicing back to the cap.
    .limit(RUN_RESULTS_CAP + 1);

  const truncated = rows.length > RUN_RESULTS_CAP;
  const results = truncated ? rows.slice(0, RUN_RESULTS_CAP) : rows;

  return c.json({ run, results, truncated });
});

/**
 * GET /api/v1/projects/:id/analysis
 *
 * Get real-time flakiness analysis (not cached)
 */
projectsRouter.get('/:id/analysis', readAuth((c) => c.req.param('id')), async (c) => {
  const parsed = uuidSchema.safeParse(c.req.param('id'));
  if (!parsed.success) {
    return c.json({ error: 'Invalid project ID format' }, 400);
  }
  const projectId = parsed.data;

  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  });
  if (!project) {
    return c.json({ error: 'Project not found' }, 404);
  }

  // Project-level overrides (NULL = unset) replace the hardcoded defaults;
  // explicit query params still take precedence over both.
  const resolvedConfig = resolveProjectConfig(project);

  // Clamp/validate the window so an attacker can't force an unbounded
  // in-memory aggregation (analyzeFlakiness loads matching rows into memory).
  const windowDays = Math.min(
    Math.max(
      parseInt(c.req.query('days') || String(resolvedConfig.windowDays), 10) || resolvedConfig.windowDays,
      1
    ),
    90
  );
  const rawThreshold = parseFloat(c.req.query('threshold') || String(resolvedConfig.flakeThreshold));
  const threshold = Number.isFinite(rawThreshold)
    ? Math.min(Math.max(rawThreshold, 0), 1)
    : resolvedConfig.flakeThreshold;

  const analysis = await analyzeFlakiness(projectId, {
    windowDays,
    flakeThreshold: threshold,
    minRuns: resolvedConfig.minRuns,
  });

  return c.json({
    windowDays,
    threshold,
    flakyTests: analysis.filter((t) => t.isFlaky),
    allTests: analysis,
  });
});

/**
 * GET /api/v1/projects/:id/trend
 *
 * Get flake rate trend data for the last N days (daily aggregation). A day
 * with zero runs reports `null` in `rates`, never `0` — see the comment
 * below where `rates` is built for why.
 */
projectsRouter.get('/:id/trend', readAuth((c) => c.req.param('id')), async (c) => {
  const parsed = uuidSchema.safeParse(c.req.param('id'));
  if (!parsed.success) {
    return c.json({ error: 'Invalid project ID format' }, 400);
  }
  const projectId = parsed.data;

  // Guard the *parse* before the clamp: parseInt('abc') is NaN, and every
  // Math.min/Math.max comparison against NaN is false, so NaN would sail
  // straight through a clamp that looks airtight — the zero-fill loop below
  // (`for (let i = days - 1; ...)`) would then never execute, turning a
  // typo'd query param into a silently empty chart. `days` is display
  // tuning, not a semantic input, so an unparseable value falls back to this
  // endpoint's default (7 — the sibling per-test trend in tests.ts defaults
  // to 30; both are correct for their own contract) rather than 400ing. Not
  // `parseInt(...) || 7`: that would also swallow `days=0` into 7 instead of
  // clamping it to 1. Mirrors the identical guard in tests.ts's
  // `/:testName/trend` (see plans/025 and plans/028).
  const rawDays = parseInt(c.req.query('days') ?? '', 10);
  const days = Number.isNaN(rawDays) ? 7 : Math.min(Math.max(rawDays, 1), 90);

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const runs = await db
    .select({
      createdAt: testRuns.createdAt,
      totalTests: testRuns.totalTests,
      flaky: testRuns.flaky,
      failed: testRuns.failed,
    })
    .from(testRuns)
    .where(
      and(
        eq(testRuns.projectId, projectId),
        gte(testRuns.createdAt, cutoff)
      )
    )
    .orderBy(testRuns.createdAt);

  // Aggregate by day
  const dailyMap = new Map<string, { total: number; flaky: number }>();

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    dailyMap.set(key, { total: 0, flaky: 0 });
  }

  for (const run of runs) {
    if (!run.createdAt || run.createdAt < cutoff) continue;
    const key = run.createdAt.toISOString().slice(0, 10);
    const existing = dailyMap.get(key);
    if (existing) {
      existing.total += run.totalTests || 0;
      existing.flaky += (run.flaky || 0) + (run.failed || 0);
    }
  }

  const trendDays: string[] = [];
  // `null`, not `0`, when a day had zero runs. "The pipeline never ran" and
  // "the pipeline ran and nothing flaked" are different facts — collapsing
  // them draws a confident flat 0% line straight through a hole in the data
  // (a weekend, an outage, a paused pipeline), which is precisely the
  // situation where the tool actually knows nothing. Do not "simplify" this
  // back to 0; see plans/028-honest-visible-trends.md and the identical
  // rule in tests.ts's `buildTrend`.
  const rates: (number | null)[] = [];

  for (const [day, data] of dailyMap) {
    const date = new Date(`${day}T00:00:00Z`);
    trendDays.push(date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }));
    rates.push(data.total > 0 ? Math.round((data.flaky / data.total) * 1000) / 10 : null);
  }

  return c.json({ days: trendDays, rates });
});

export default projectsRouter;
