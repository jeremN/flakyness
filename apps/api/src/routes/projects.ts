import { Hono } from 'hono';
import { z } from 'zod';
import { eq, desc, and, gte } from 'drizzle-orm';
import { db, projects, flakyTests, testRuns } from '../db';
import { getProjectStats, analyzeFlakiness } from '../services/flakiness';
import { apiRateLimit } from '../middleware/rate-limit';

const projectsRouter = new Hono();

const uuidSchema = z.string().uuid();
const flakyStatusSchema = z.enum(['active', 'resolved', 'ignored', 'all']).default('active');

// Apply rate limiting
projectsRouter.use('*', apiRateLimit);

/**
 * GET /api/v1/projects
 *
 * List all projects
 */
projectsRouter.get('/', async (c) => {
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
 * GET /api/v1/projects/:id
 *
 * Get project details with stats
 */
projectsRouter.get('/:id', async (c) => {
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
 * GET /api/v1/projects/:id/stats
 *
 * Get project statistics
 */
projectsRouter.get('/:id/stats', async (c) => {
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
projectsRouter.get('/:id/flaky-tests', async (c) => {
  const parsed = uuidSchema.safeParse(c.req.param('id'));
  if (!parsed.success) {
    return c.json({ error: 'Invalid project ID format' }, 400);
  }
  const projectId = parsed.data;

  const statusParsed = flakyStatusSchema.safeParse(c.req.query('status'));
  const status = statusParsed.success ? statusParsed.data : 'active';

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
    .orderBy(desc(flakyTests.flakeRate));

  return c.json({ flakyTests: flakyTestsList });
});

/**
 * GET /api/v1/projects/:id/runs
 *
 * Get recent test runs for a project
 */
projectsRouter.get('/:id/runs', async (c) => {
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
 * GET /api/v1/projects/:id/analysis
 *
 * Get real-time flakiness analysis (not cached)
 */
projectsRouter.get('/:id/analysis', async (c) => {
  const parsed = uuidSchema.safeParse(c.req.param('id'));
  if (!parsed.success) {
    return c.json({ error: 'Invalid project ID format' }, 400);
  }
  const projectId = parsed.data;
  const windowDays = parseInt(c.req.query('days') || '14', 10);
  const threshold = parseFloat(c.req.query('threshold') || '0.05');

  const analysis = await analyzeFlakiness(projectId, {
    windowDays,
    flakeThreshold: threshold,
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
 * Get flake rate trend data for the last N days (daily aggregation)
 */
projectsRouter.get('/:id/trend', async (c) => {
  const parsed = uuidSchema.safeParse(c.req.param('id'));
  if (!parsed.success) {
    return c.json({ error: 'Invalid project ID format' }, 400);
  }
  const projectId = parsed.data;
  const days = Math.min(Math.max(parseInt(c.req.query('days') || '7', 10), 1), 90);

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
  const rates: number[] = [];

  for (const [day, data] of dailyMap) {
    const date = new Date(day);
    trendDays.push(date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
    rates.push(data.total > 0 ? Math.round((data.flaky / data.total) * 1000) / 10 : 0);
  }

  return c.json({ days: trendDays, rates });
});

export default projectsRouter;
