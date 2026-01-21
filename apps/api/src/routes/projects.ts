import { Hono } from 'hono';
import { eq, desc, and, gte } from 'drizzle-orm';
import { db, projects, flakyTests, testRuns, testResults } from '../db';
import { getProjectStats, analyzeFlakiness } from '../services/flakiness';
import { apiRateLimit } from '../middleware/rate-limit';

const projectsRouter = new Hono();

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
  const projectId = c.req.param('id');
  const stats = await getProjectStats(projectId);

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
  const projectId = c.req.param('id');
  const stats = await getProjectStats(projectId);

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
  const projectId = c.req.param('id');
  const status = c.req.query('status') || 'active';

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
  const projectId = c.req.param('id');
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
  const projectId = c.req.param('id');
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

export default projectsRouter;
