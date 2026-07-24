import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { eq, and, lt, inArray, sql, desc } from 'drizzle-orm';
import { db, projects, testRuns, testResults, flakyTests, quarantineRules } from '../db';
import { adminAuth, hashToken, generateToken } from '../middleware/auth';
import { adminRateLimit } from '../middleware/rate-limit';
import { logger } from '../middleware/logger';
import { resolveProjectConfig } from '../services/flakiness';
import { globToRegExp } from '../services/rules';

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
    webhookKind: z.enum(['slack', 'generic']).nullable().optional(),
    // Per-project data retention in days; NULL means "keep forever" (see
    // schema.ts). Must never undercut the project's resolved flakiness
    // windowDays — enforced below, after parsing.
    retentionDays: z.number().int().min(1).max(3650).nullable().optional(),
    autoQuarantineEnabled: z.boolean().optional(),
    quarantineThreshold: z.number().min(0).max(1).nullable().optional(),
    quarantineMinRuns: z.number().int().min(1).max(100).nullable().optional(),
    quarantineTtlDays: z.number().int().min(1).max(365).nullable().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'No fields to update' });

// Quarantine rules (roadmap 4b) — ordered per-project policy rules consumed
// by services/rules.ts's evaluateRules(). See docs/API.md's "Quarantine
// Rules" section for selector/condition semantics and first-match-wins +
// fallback-to-legacy-threshold behavior.
const globField = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    // globToRegExp (services/rules.ts) escapes every regex metacharacter, so
    // it never throws — every string is a syntactically valid glob. This
    // refine is harmless defense-in-depth, not a reachable failure path.
    .refine(
      (g) => {
        try {
          void globToRegExp(g);
          return true;
        } catch {
          return false;
        }
      },
      { message: 'invalid glob' }
    )
    .nullable()
    .optional();

// Plain shape with no cross-field check, so `.partial()` works for the PATCH
// schema below — zod rejects .partial() on a schema wrapped in .superRefine().
const quarantineRuleShape = z.object({
  name: z.string().max(255).nullable().optional(),
  enabled: z.boolean().optional(),
  position: z.number().int().min(0).optional(),
  selectorBranch: globField(255),
  selectorFile: globField(500),
  selectorTag: z.string().min(1).max(255).nullable().optional(),
  action: z.enum(['quarantine', 'exempt']),
  conditionType: z.enum(['flake_rate', 'consecutive']).nullable().optional(),
  flakeThreshold: z.number().min(0).max(1).nullable().optional(),
  minRuns: z.number().int().min(1).max(100).nullable().optional(),
  windowDays: z.number().int().min(1).max(90).nullable().optional(),
  consecutiveFailures: z.number().int().min(1).max(100).nullable().optional(),
  ttlDays: z.number().int().min(1).max(365).nullable().optional(),
});

// A `quarantine` rule needs exactly one condition (flake_rate ->
// flakeThreshold, consecutive -> consecutiveFailures); an `exempt` rule takes
// none. Applied to POST's full body AND to PATCH's merged (existing + patch)
// row in the handler below, so a partial PATCH can never leave a rule in an
// inconsistent state (e.g. action -> 'exempt' while a condition remains).
function checkRuleConsistency(o: z.infer<typeof quarantineRuleShape>, ctx: z.RefinementCtx): void {
  if (o.action === 'exempt') {
    if (o.conditionType != null || o.flakeThreshold != null || o.consecutiveFailures != null) {
      ctx.addIssue({ code: 'custom', message: 'exempt rules take no condition' });
    }
    return;
  }
  if (o.conditionType == null) {
    ctx.addIssue({ code: 'custom', message: 'quarantine rules need a conditionType' });
    return;
  }
  if (o.conditionType === 'flake_rate' && o.flakeThreshold == null) {
    ctx.addIssue({ code: 'custom', message: 'flake_rate needs flakeThreshold' });
  }
  if (o.conditionType === 'consecutive' && o.consecutiveFailures == null) {
    ctx.addIssue({ code: 'custom', message: 'consecutive needs consecutiveFailures' });
  }
}

const quarantineRuleSchema = quarantineRuleShape.superRefine(checkRuleConsistency);
// PATCH: same shape, every field optional, no cross-field check here — the
// handler re-validates the merged (existing + patch) row against
// quarantineRuleSchema so an invalid combination is still rejected.
const quarantineRulePatchSchema = quarantineRuleShape.partial();

const reorderRulesSchema = z.object({ order: z.array(uuidSchema).min(1) });

/** DB row -> JSON response shape (decimal column surfaced as a number). */
function serializeRule(row: typeof quarantineRules.$inferSelect) {
  return {
    ...row,
    flakeThreshold: row.flakeThreshold !== null ? Number(row.flakeThreshold) : null,
  };
}

/**
 * Validated body -> Drizzle column values: flakeThreshold as a fixed(4)
 * string (decimal columns store strings, see AGENTS.md conventions);
 * `position` stripped out since it's only ever set by create (append) or
 * reorder, never a plain create/patch field.
 */
function toRuleColumns(body: Record<string, unknown>): Partial<typeof quarantineRules.$inferInsert> {
  const columns: Record<string, unknown> = { ...body };
  if ('flakeThreshold' in body) {
    columns.flakeThreshold = body.flakeThreshold == null ? null : Number(body.flakeThreshold).toFixed(4);
  }
  delete columns.position;
  return columns as Partial<typeof quarantineRules.$inferInsert>;
}

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
      webhookKind: projects.webhookKind,
      retentionDays: projects.retentionDays,
      autoQuarantineEnabled: projects.autoQuarantineEnabled,
      quarantineThreshold: projects.quarantineThreshold,
      quarantineMinRuns: projects.quarantineMinRuns,
      quarantineTtlDays: projects.quarantineTtlDays,
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
    webhookKind: p.webhookKind,
    retentionDays: p.retentionDays,
    autoQuarantineEnabled: p.autoQuarantineEnabled,
    quarantineThreshold: p.quarantineThreshold !== null ? Number(p.quarantineThreshold) : null,
    quarantineMinRuns: p.quarantineMinRuns,
    quarantineTtlDays: p.quarantineTtlDays,
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

    // quarantine_threshold must be >= the RESOLVED flakeThreshold. If this same
    // request also sets flakeThreshold (including an explicit null reset),
    // validate against the value being written, not the stale stored one.
    if (typeof data.quarantineThreshold === 'number') {
      const effectiveFlakeThreshold =
        'flakeThreshold' in data
          ? resolveProjectConfig({
              ...existing,
              flakeThreshold: data.flakeThreshold == null ? null : data.flakeThreshold.toFixed(4),
            }).flakeThreshold
          : resolveProjectConfig(existing).flakeThreshold;
      if (data.quarantineThreshold < effectiveFlakeThreshold) {
        return c.json({
          error: `quarantineThreshold (${data.quarantineThreshold}) must be >= the flakeThreshold (${effectiveFlakeThreshold})`,
        }, 400);
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
    if ('webhookKind' in data) {
      updates.webhookKind = data.webhookKind ?? null;
    }
    if ('retentionDays' in data) {
      updates.retentionDays = data.retentionDays ?? null;
    }
    if ('autoQuarantineEnabled' in data) updates.autoQuarantineEnabled = data.autoQuarantineEnabled;
    if ('quarantineThreshold' in data)
      updates.quarantineThreshold =
        data.quarantineThreshold == null ? null : data.quarantineThreshold.toFixed(4);
    if ('quarantineMinRuns' in data) updates.quarantineMinRuns = data.quarantineMinRuns ?? null;
    if ('quarantineTtlDays' in data) updates.quarantineTtlDays = data.quarantineTtlDays ?? null;

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
        webhookKind: projects.webhookKind,
        retentionDays: projects.retentionDays,
        autoQuarantineEnabled: projects.autoQuarantineEnabled,
        quarantineThreshold: projects.quarantineThreshold,
        quarantineMinRuns: projects.quarantineMinRuns,
        quarantineTtlDays: projects.quarantineTtlDays,
      });

    if (!project) {
      return c.json({ error: 'Project not found' }, 404);
    }

    logger.info('Project flakiness config updated', { projectId, projectName: project.name });

    return c.json({
      project: {
        ...project,
        flakeThreshold: project.flakeThreshold !== null ? Number(project.flakeThreshold) : null,
        quarantineThreshold:
          project.quarantineThreshold !== null ? Number(project.quarantineThreshold) : null,
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
 * GET /api/v1/admin/projects/:id/rules
 *
 * List a project's quarantine rules in evaluation order (ascending
 * `position` — first match wins; see docs/API.md).
 */
adminRouter.get('/projects/:id/rules', async (c) => {
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

  const rows = await db
    .select()
    .from(quarantineRules)
    .where(eq(quarantineRules.projectId, projectId))
    .orderBy(quarantineRules.position);

  return c.json({ rules: rows.map(serializeRule) });
});

/**
 * POST /api/v1/admin/projects/:id/rules
 *
 * Append a new quarantine rule. Without an explicit `position`, the rule is
 * appended after the current highest position (evaluated last / lowest
 * priority).
 */
adminRouter.post('/projects/:id/rules', zValidator('json', quarantineRuleSchema), async (c) => {
  const parsed = uuidSchema.safeParse(c.req.param('id'));
  if (!parsed.success) {
    return c.json({ error: 'Invalid project ID format' }, 400);
  }
  const projectId = parsed.data;
  const body = c.req.valid('json');

  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  });
  if (!project) {
    return c.json({ error: 'Project not found' }, 404);
  }

  const [{ max }] = await db
    .select({ max: sql<number>`coalesce(max(${quarantineRules.position}), -1)::int` })
    .from(quarantineRules)
    .where(eq(quarantineRules.projectId, projectId));

  const [row] = await db
    .insert(quarantineRules)
    .values({
      projectId,
      position: body.position ?? max + 1,
      ...toRuleColumns(body),
      // `action` is required (NOT NULL) and always present at runtime — the
      // schema enforces it — but toRuleColumns()'s Partial<> return type
      // loosens it to optional, which confuses Drizzle's overload
      // resolution. Assert the merged object back to a full insert row.
    } as typeof quarantineRules.$inferInsert)
    .returning();

  return c.json({ rule: serializeRule(row) }, 201);
});

/**
 * PATCH /api/v1/admin/projects/:id/rules/:ruleId
 *
 * Partial update. The merged (existing + patch) row is re-validated against
 * the full rule schema so a patch can't leave the rule in an inconsistent
 * state (e.g. action -> 'exempt' while a condition remains).
 */
adminRouter.patch(
  '/projects/:id/rules/:ruleId',
  zValidator('json', quarantineRulePatchSchema),
  async (c) => {
    const idParsed = uuidSchema.safeParse(c.req.param('id'));
    if (!idParsed.success) {
      return c.json({ error: 'Invalid project ID format' }, 400);
    }
    const ruleIdParsed = uuidSchema.safeParse(c.req.param('ruleId'));
    if (!ruleIdParsed.success) {
      return c.json({ error: 'Invalid rule ID format' }, 400);
    }
    const projectId = idParsed.data;
    const ruleId = ruleIdParsed.data;
    const patch = c.req.valid('json');

    const [existing] = await db
      .select()
      .from(quarantineRules)
      .where(and(eq(quarantineRules.id, ruleId), eq(quarantineRules.projectId, projectId)));
    if (!existing) {
      return c.json({ error: 'Rule not found' }, 404);
    }

    const merged = { ...serializeRule(existing), ...patch };
    const check = quarantineRuleSchema.safeParse(merged);
    if (!check.success) {
      return c.json({ error: check.error.issues[0]?.message ?? 'Invalid rule' }, 400);
    }

    const [row] = await db
      .update(quarantineRules)
      .set({ ...toRuleColumns(patch), updatedAt: new Date() })
      .where(eq(quarantineRules.id, ruleId))
      .returning();

    return c.json({ rule: serializeRule(row) });
  }
);

/**
 * DELETE /api/v1/admin/projects/:id/rules/:ruleId
 */
adminRouter.delete('/projects/:id/rules/:ruleId', async (c) => {
  const idParsed = uuidSchema.safeParse(c.req.param('id'));
  if (!idParsed.success) {
    return c.json({ error: 'Invalid project ID format' }, 400);
  }
  const ruleIdParsed = uuidSchema.safeParse(c.req.param('ruleId'));
  if (!ruleIdParsed.success) {
    return c.json({ error: 'Invalid rule ID format' }, 400);
  }
  const projectId = idParsed.data;
  const ruleId = ruleIdParsed.data;

  const deleted = await db
    .delete(quarantineRules)
    .where(and(eq(quarantineRules.id, ruleId), eq(quarantineRules.projectId, projectId)))
    .returning();

  if (deleted.length === 0) {
    return c.json({ error: 'Rule not found' }, 404);
  }
  return c.json({ success: true });
});

/**
 * POST /api/v1/admin/projects/:id/rules/reorder
 *
 * Body's `order` must be exactly the project's current rule ids (in any
 * order); each id's index in the array becomes its new `position`.
 */
adminRouter.post(
  '/projects/:id/rules/reorder',
  zValidator('json', reorderRulesSchema),
  async (c) => {
    const parsed = uuidSchema.safeParse(c.req.param('id'));
    if (!parsed.success) {
      return c.json({ error: 'Invalid project ID format' }, 400);
    }
    const projectId = parsed.data;
    const { order } = c.req.valid('json');

    const current = await db
      .select({ id: quarantineRules.id })
      .from(quarantineRules)
      .where(eq(quarantineRules.projectId, projectId));
    const currentSet = new Set(current.map((r) => r.id));

    if (
      order.length !== currentSet.size ||
      new Set(order).size !== order.length ||
      !order.every((ruleId) => currentSet.has(ruleId))
    ) {
      return c.json({ error: "order must be exactly the project's current rule ids" }, 400);
    }

    await db.transaction(async (tx) => {
      for (let i = 0; i < order.length; i++) {
        await tx
          .update(quarantineRules)
          .set({ position: i, updatedAt: new Date() })
          .where(eq(quarantineRules.id, order[i]));
      }
    });

    return c.json({ success: true });
  }
);

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
