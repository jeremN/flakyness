import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { eq, sql, desc } from 'drizzle-orm';
import { db, projects, testRuns, testResults, flakyTests } from '../db';
import { adminAuth, hashToken, generateToken } from '../middleware/auth';
import { adminRateLimit } from '../middleware/rate-limit';
import { logger } from '../middleware/logger';

const adminRouter = new Hono();

const uuidSchema = z.string().uuid();

// Apply admin auth and rate limiting to all routes
adminRouter.use('*', adminAuth());
adminRouter.use('*', adminRateLimit);

// Schemas
const createProjectSchema = z.object({
  name: z.string().min(1).max(255),
  gitlabProjectId: z.string().max(100).optional(),
});

/**
 * GET /api/v1/admin/projects
 *
 * List all projects with stats (single query with subqueries, no N+1)
 */
adminRouter.get('/projects', async (c) => {
  const projectsWithStats = await db
    .select({
      id: projects.id,
      name: projects.name,
      gitlabProjectId: projects.gitlabProjectId,
      hasToken: sql<boolean>`${projects.tokenHash} IS NOT NULL`,
      createdAt: projects.createdAt,
      totalRuns: sql<number>`coalesce((
        select count(*)::int from test_runs where test_runs.project_id = ${projects.id}
      ), 0)`,
      totalTests: sql<number>`coalesce((
        select sum(test_runs.total_tests)::int from test_runs where test_runs.project_id = ${projects.id}
      ), 0)`,
      activeFlakyTests: sql<number>`coalesce((
        select count(*)::int from flaky_tests where flaky_tests.project_id = ${projects.id} and flaky_tests.status = 'active'
      ), 0)`,
    })
    .from(projects)
    .orderBy(desc(projects.createdAt));

  const result = projectsWithStats.map((p) => ({
    id: p.id,
    name: p.name,
    gitlabProjectId: p.gitlabProjectId,
    hasToken: p.hasToken,
    createdAt: p.createdAt,
    stats: {
      totalRuns: p.totalRuns,
      totalTests: p.totalTests,
      activeFlakyTests: p.activeFlakyTests,
    },
  }));

  return c.json({ projects: result });
});

/**
 * POST /api/v1/admin/projects
 *
 * Create a new project and generate an API token
 */
adminRouter.post(
  '/projects',
  zValidator('json', createProjectSchema),
  async (c) => {
    const { name, gitlabProjectId } = c.req.valid('json');

    // Check if project name already exists
    const existing = await db.query.projects.findFirst({
      where: eq(projects.name, name),
    });

    if (existing) {
      return c.json({ error: 'Project with this name already exists' }, 409);
    }

    // Generate a new token
    const token = generateToken();
    const tokenHash = hashToken(token);

    // Create project
    const [project] = await db
      .insert(projects)
      .values({
        name,
        gitlabProjectId: gitlabProjectId || null,
        tokenHash,
      })
      .returning({
        id: projects.id,
        name: projects.name,
        gitlabProjectId: projects.gitlabProjectId,
        createdAt: projects.createdAt,
      });

    logger.info('Project created', { projectId: project.id, projectName: name });

    return c.json({
      project,
      token, // Only returned on creation!
      warning: 'Save this token securely. It will not be shown again.',
    }, 201);
  }
);

/**
 * POST /api/v1/admin/projects/:id/rotate-token
 *
 * Rotate a project's API token
 */
adminRouter.post('/projects/:id/rotate-token', async (c) => {
  const parsed = uuidSchema.safeParse(c.req.param('id'));
  if (!parsed.success) {
    return c.json({ error: 'Invalid project ID format' }, 400);
  }
  const projectId = parsed.data;

  // Check project exists
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  });

  if (!project) {
    return c.json({ error: 'Project not found' }, 404);
  }

  // Generate new token
  const token = generateToken();
  const tokenHash = hashToken(token);

  // Update project
  await db
    .update(projects)
    .set({ tokenHash })
    .where(eq(projects.id, projectId));

  logger.info('Project token rotated', { projectId, projectName: project.name });

  return c.json({
    project: {
      id: project.id,
      name: project.name,
    },
    token, // Only returned on rotation!
    warning: 'Save this token securely. The old token is now invalid.',
  });
});

/**
 * DELETE /api/v1/admin/projects/:id
 *
 * Delete a project and all associated data inside a transaction
 */
adminRouter.delete('/projects/:id', async (c) => {
  const parsed = uuidSchema.safeParse(c.req.param('id'));
  if (!parsed.success) {
    return c.json({ error: 'Invalid project ID format' }, 400);
  }
  const projectId = parsed.data;

  // Check project exists
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  });

  if (!project) {
    return c.json({ error: 'Project not found' }, 404);
  }

  // Delete all associated data in a transaction
  await db.transaction(async (tx) => {
    // 1. Get all test run IDs for this project
    const runs = await tx
      .select({ id: testRuns.id })
      .from(testRuns)
      .where(eq(testRuns.projectId, projectId));

    // 2. Delete test results for those runs
    for (const run of runs) {
      await tx.delete(testResults).where(eq(testResults.testRunId, run.id));
    }

    // 3. Delete test runs
    await tx.delete(testRuns).where(eq(testRuns.projectId, projectId));

    // 4. Delete flaky tests
    await tx.delete(flakyTests).where(eq(flakyTests.projectId, projectId));

    // 5. Delete project
    await tx.delete(projects).where(eq(projects.id, projectId));
  });

  logger.info('Project deleted', { projectId, projectName: project.name });

  return c.json({
    success: true,
    message: `Project "${project.name}" and all associated data deleted.`,
  });
});

/**
 * GET /api/v1/admin/health
 *
 * System health metrics
 */
adminRouter.get('/health', async (c) => {
  const [projectCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(projects);

  const [runCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(testRuns);

  const [resultCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(testResults);

  const [flakyCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(flakyTests);

  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    database: {
      projects: projectCount?.count || 0,
      testRuns: runCount?.count || 0,
      testResults: resultCount?.count || 0,
      flakyTests: flakyCount?.count || 0,
    },
    version: '0.0.1',
  });
});

export default adminRouter;
