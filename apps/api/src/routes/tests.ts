import { Hono } from 'hono';
import { z } from 'zod';
import { eq, desc, and } from 'drizzle-orm';
import { db, testResults, testRuns, flakyTests } from '../db';
import { apiRateLimit } from '../middleware/rate-limit';

const testsRouter = new Hono();

const uuidSchema = z.string().uuid();

// Apply rate limiting
testsRouter.use('*', apiRateLimit);

/**
 * GET /api/v1/tests/:testName/history
 *
 * Get run history for a specific test (by test name, URL encoded)
 */
testsRouter.get('/:testName/history', async (c) => {
  const testName = decodeURIComponent(c.req.param('testName'));
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

export default testsRouter;
