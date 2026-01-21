import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { eq, sql, desc } from 'drizzle-orm';
import { db, projects, testRuns, testResults, flakyTests } from '../db';
import { adminAuth, hashToken, generateToken } from '../middleware/auth';
import { adminRateLimit } from '../middleware/rate-limit';
import { logger } from '../middleware/logger';

const adminRouter = new Hono();

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
 * List all projects with stats
 */
adminRouter.get('/projects', async (c) => {
  const allProjects = await db
    .select({
      id: projects.id,
      name: projects.name,
      gitlabProjectId: projects.gitlabProjectId,
      hasToken: sql<boolean>`${projects.tokenHash} IS NOT NULL`,
      createdAt: projects.createdAt,
    })
    .from(projects)
    .orderBy(desc(projects.createdAt));

  // Get stats for each project
  const projectsWithStats = await Promise.all(
    allProjects.map(async (project) => {
      const [runStats] = await db
        .select({
          totalRuns: sql<number>`count(*)::int`,
          totalTests: sql<number>`coalesce(sum(${testRuns.totalTests}), 0)::int`,
        })
        .from(testRuns)
        .where(eq(testRuns.projectId, project.id));

      const [flakyStats] = await db
        .select({
          activeFlakyTests: sql<number>`count(*)::int`,
        })
        .from(flakyTests)
        .where(eq(flakyTests.projectId, project.id));

      return {
        ...project,
        stats: {
          totalRuns: runStats?.totalRuns || 0,
          totalTests: runStats?.totalTests || 0,
          activeFlakyTests: flakyStats?.activeFlakyTests || 0,
        },
      };
    })
  );

  return c.json({ projects: projectsWithStats });
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
  const projectId = c.req.param('id');

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
 * Delete a project and all associated data
 */
adminRouter.delete('/projects/:id', async (c) => {
  const projectId = c.req.param('id');

  // Check project exists
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  });

  if (!project) {
    return c.json({ error: 'Project not found' }, 404);
  }

  // Delete in order (respecting foreign key constraints)
  // 1. Get all test run IDs for this project
  const runs = await db
    .select({ id: testRuns.id })
    .from(testRuns)
    .where(eq(testRuns.projectId, projectId));

  const runIds = runs.map((r) => r.id);

  // 2. Delete test results for those runs
  if (runIds.length > 0) {
    for (const runId of runIds) {
      await db.delete(testResults).where(eq(testResults.testRunId, runId));
    }
  }

  // 3. Delete test runs
  await db.delete(testRuns).where(eq(testRuns.projectId, projectId));

  // 4. Delete flaky tests
  await db.delete(flakyTests).where(eq(flakyTests.projectId, projectId));

  // 5. Delete project
  await db.delete(projects).where(eq(projects.id, projectId));

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
