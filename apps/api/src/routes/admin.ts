import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { eq, and, lt, inArray, sql, desc } from 'drizzle-orm';
import { db, projects, testRuns, testResults, flakyTests } from '../db';
import { adminAuth, hashToken, generateToken } from '../middleware/auth';
import { adminRateLimit } from '../middleware/rate-limit';
import { logger } from '../middleware/logger';
import { resolveProjectConfig } from '../services/flakiness';

const adminRouter = new Hono();

const uuidSchema = z.string().uuid();

// Rate limiting MUST come before auth: a brute-force flood of bad tokens has to
// be throttled here, not waved through to adminAuth (which would 401 each
// attempt and never reach the limiter). Guarded by rate-limit.test.ts.
adminRouter.use('*', adminRateLimit);
adminRouter.use('*', adminAuth());

// Schemas
const createProjectSchema = z.object({
  name: z.string().min(1).max(255),
  gitlabProjectId: z.string().max(100).optional(),
});

const projectConfigPatchSchema = z
  .object({
    flakeThreshold: z.number().min(0).max(1).nullable().optional(),
    windowDays: z.number().int().min(1).max(90).nullable().optional(),
    minRuns: z.number().int().min(1).max(100).nullable().optional(),
    // Admin-set outbound webhook for flaky-test transition notifications.
    // Same trust level as the operator's shell — no IP deny-list in v1
    // (see docs/API.md). Protocol restricted to http(s) to reject obviously
    // wrong values (e.g. ftp://) at the API boundary.
    webhookUrl: z
      .string()
      .url()
      .max(2048)
      .refine(
        (u) => {
          // Zod v4 runs all chained checks regardless of earlier failures,
          // so this can see a string that already failed .url() — guard
          // the URL constructor instead of letting it throw uncaught.
          try {
            return /^https?:$/.test(new URL(u).protocol);
          } catch {
            return false;
          }
        },
        { message: 'webhookUrl must use http or https' }
      )
      .nullable()
      .optional(),
    // Per-project data retention in days; NULL means "keep forever" (see
    // schema.ts). Must never undercut the project's resolved flakiness
    // windowDays — enforced below, after parsing.
    retentionDays: z.number().int().min(1).max(3650).nullable().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'No fields to update' });

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
      flakeThreshold: projects.flakeThreshold,
      windowDays: projects.windowDays,
      minRuns: projects.minRuns,
      webhookUrl: projects.webhookUrl,
      retentionDays: projects.retentionDays,
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
    flakeThreshold: p.flakeThreshold !== null ? Number(p.flakeThreshold) : null,
    windowDays: p.windowDays,
    minRuns: p.minRuns,
    webhookUrl: p.webhookUrl,
    retentionDays: p.retentionDays,
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
 * PATCH /api/v1/admin/projects/:id
 *
 * Update a project's per-project flakiness detection overrides
 * (flakeThreshold, windowDays, minRuns) and/or its data retention
 * (retentionDays). Any field omitted from the body is left unchanged; sending
 * a field as `null` explicitly clears it back to the flakiness service's
 * DEFAULT_CONFIG value (or, for retentionDays, "keep forever").
 */
adminRouter.patch(
  '/projects/:id',
  zValidator('json', projectConfigPatchSchema),
  async (c) => {
    const parsed = uuidSchema.safeParse(c.req.param('id'));
    if (!parsed.success) {
      return c.json({ error: 'Invalid project ID format' }, 400);
    }
    const projectId = parsed.data;
    const data = c.req.valid('json');

    const existing = await db.query.projects.findFirst({
      where: eq(projects.id, projectId),
    });
    if (!existing) {
      return c.json({ error: 'Project not found' }, 404);
    }

    // Retention may never undercut the *resolved* flakiness windowDays, or
    // flake rates would silently drift as history vanishes underneath the
    // analysis. If this same request also sets windowDays, validate against
    // the new value being written, not the stale stored one.
    if (typeof data.retentionDays === 'number') {
      const effectiveWindowDays =
        'windowDays' in data
          ? resolveProjectConfig({ ...existing, windowDays: data.windowDays ?? null }).windowDays
          : resolveProjectConfig(existing).windowDays;
      if (data.retentionDays < effectiveWindowDays) {
        return c.json(
          {
            error: `retentionDays (${data.retentionDays}) must be >= the flakiness windowDays (${effectiveWindowDays})`,
          },
          400
        );
      }
    }

    // Build the .set() object only from keys present in the parsed body, so
    // an omitted field leaves the stored value untouched while an explicit
    // `null` clears it back to the default.
    const updates: Partial<typeof projects.$inferInsert> = {};
    if ('flakeThreshold' in data) {
      updates.flakeThreshold =
        data.flakeThreshold === null || data.flakeThreshold === undefined
          ? null
          : data.flakeThreshold.toFixed(4);
    }
    if ('windowDays' in data) {
      updates.windowDays = data.windowDays ?? null;
    }
    if ('minRuns' in data) {
      updates.minRuns = data.minRuns ?? null;
    }
    if ('webhookUrl' in data) {
      updates.webhookUrl = data.webhookUrl ?? null;
    }
    if ('retentionDays' in data) {
      updates.retentionDays = data.retentionDays ?? null;
    }

    const [project] = await db
      .update(projects)
      .set(updates)
      .where(eq(projects.id, projectId))
      .returning({
        id: projects.id,
        name: projects.name,
        gitlabProjectId: projects.gitlabProjectId,
        createdAt: projects.createdAt,
        flakeThreshold: projects.flakeThreshold,
        windowDays: projects.windowDays,
        minRuns: projects.minRuns,
        webhookUrl: projects.webhookUrl,
        retentionDays: projects.retentionDays,
      });

    if (!project) {
      return c.json({ error: 'Project not found' }, 404);
    }

    logger.info('Project flakiness config updated', { projectId, projectName: project.name });

    return c.json({
      project: {
        ...project,
        flakeThreshold: project.flakeThreshold !== null ? Number(project.flakeThreshold) : null,
      },
    });
  }
);

// Postgres bind-param limit forces chunking multi-row deletes; matches the
// chunking style in services/flakiness.ts (BATCH_SIZE there is 1000 for
// multi-column upserts — this route only binds one id per row, so it can
// afford a larger batch).
const PRUNE_BATCH_SIZE = 5000;

/**
 * POST /api/v1/admin/projects/:id/prune
 *
 * Delete test_runs (and, via FK cascade, their test_results) older than the
 * project's configured `retentionDays`. Dry-run by default: without
 * `?confirm=true` this reports the counts it would delete and deletes
 * nothing. `flaky_tests` is never touched by this route — it is the
 * product's memory of past flakiness and has no FK to test_runs, so it
 * survives automatically (see schema.ts).
 */
adminRouter.post('/projects/:id/prune', async (c) => {
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

  // Pruning without a configured retention is always a mistake — NULL means
  // "keep forever" and there is no global default (see schema.ts).
  if (project.retentionDays == null) {
    return c.json({ error: 'No retention configured for this project' }, 400);
  }

  // Re-check the window guard against the *stored* config: windowDays may
  // have been raised after retentionDays was set, leaving a stale pair that
  // is now invalid. A prune that ran anyway would corrupt flake rates by
  // deleting history the flakiness window still depends on.
  const { windowDays } = resolveProjectConfig(project);
  if (project.retentionDays < windowDays) {
    return c.json(
      {
        error: `retentionDays (${project.retentionDays}) must be >= the flakiness windowDays (${windowDays})`,
      },
      400
    );
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - project.retentionDays);
  const staleRunsFilter = and(eq(testRuns.projectId, projectId), lt(testRuns.createdAt, cutoff));

  const [{ count: runsCount } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(testRuns)
    .where(staleRunsFilter);

  const [{ count: resultsCount } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(testResults)
    .innerJoin(testRuns, eq(testResults.testRunId, testRuns.id))
    .where(staleRunsFilter);

  const confirmed = c.req.query('confirm') === 'true';

  if (!confirmed) {
    logger.info('Prune dry-run', {
      projectId,
      projectName: project.name,
      cutoff: cutoff.toISOString(),
      runsToDelete: runsCount,
      resultsToDelete: resultsCount,
    });
    return c.json({
      dryRun: true,
      cutoff: cutoff.toISOString(),
      runsToDelete: runsCount,
      resultsToDelete: resultsCount,
    });
  }

  // Delete test_runs only, in batches — test_results cascade via the FK
  // (onDelete: 'cascade'); never hand-delete them. Re-select each iteration
  // (rather than loading every stale id up front) so a first prune of a
  // year-old database doesn't hold one enormous row set in memory or one
  // giant lock.
  let runsDeleted = 0;
  for (;;) {
    const batch = await db
      .select({ id: testRuns.id })
      .from(testRuns)
      .where(staleRunsFilter)
      .limit(PRUNE_BATCH_SIZE);

    if (batch.length === 0) break;

    await db.delete(testRuns).where(inArray(testRuns.id, batch.map((r) => r.id)));
    runsDeleted += batch.length;
  }

  logger.warn('Project data pruned', {
    projectId,
    projectName: project.name,
    cutoff: cutoff.toISOString(),
    runsDeleted,
    resultsDeleted: resultsCount,
  });

  return c.json({
    dryRun: false,
    cutoff: cutoff.toISOString(),
    runsDeleted,
    resultsDeleted: resultsCount,
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

  // Deleting the project cascades to test_runs, test_results, and
  // flaky_tests via the FK ON DELETE CASCADE constraints declared in the
  // schema — no need to manually delete children first.
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
