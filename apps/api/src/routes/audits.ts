import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { projectAuth } from '../middleware/auth';
import { reportRateLimit } from '../middleware/rate-limit';
import { passwordChangeGate } from '../middleware/password-change';
import { db, auditRuns, auditResults, Project, type AuditPageError } from '../db';
import { auditReportSchema, compareAuditResults, summarizeScores } from '../services/audits';
import { findPreviousAuditRun, loadComparableResults } from '../services/audit-store';

const BATCH_SIZE = 1000;

const auditsRouter = new Hono<{
  Variables: {
    project: Project;
  };
}>();

// Same query contract as POST /reports, except `commit` is OPTIONAL: a
// scheduled audit of production has no commit to attribute it to.
const auditQuerySchema = z.object({
  branch: z.string().min(1).max(255).default('main'),
  commit: z.string().min(1).max(40).optional(),
  pipeline: z.string().max(100).optional(),
});

// Same gate stack, same order, as the reports router: ingest is a CI/cron
// upload authenticated by the project token, so it shares the ingest limiter.
auditsRouter.use('*', projectAuth());
auditsRouter.use('*', reportRateLimit);
auditsRouter.use('*', passwordChangeGate());

/**
 * POST /api/v1/audits
 *
 * Ingest an AuditReport v1 (a11y / SEO / perf checks over a list of URLs, as
 * produced by apps/auditor). The body is JSON, validated by
 * `auditReportSchema`; an oversized report is rejected, never truncated.
 *
 * The response carries `regressions` against the previous audit run on the
 * same branch, computed synchronously (it is two indexed reads over at most a
 * few thousand rows) so a CI job can fail on it without a second request.
 */
auditsRouter.post('/', zValidator('query', auditQuerySchema), async (c) => {
  const project = c.get('project');
  const { branch, commit, pipeline } = c.req.valid('query');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be a JSON AuditReport' }, 400);
  }

  const parsed = auditReportSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return c.json(
      { error: `Invalid audit report: ${first.path.join('.') || '(root)'}: ${first.message}` },
      400
    );
  }
  const report = parsed.data;

  const pageErrors: AuditPageError[] = report.pages
    .filter((p) => p.error !== undefined)
    .map((p) => ({ url: p.url, device: p.device, error: p.error as string }));

  const rows = report.pages.flatMap((p) =>
    p.checks.map((check) => ({
      url: p.url,
      device: p.device,
      category: check.category,
      score: check.score === null ? null : check.score.toFixed(4),
      metrics: check.metrics && Object.keys(check.metrics).length > 0 ? check.metrics : null,
      issues: check.issues,
    }))
  );

  const run = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(auditRuns)
      .values({
        projectId: project.id,
        branch,
        commitSha: commit ?? null,
        pipelineId: pipeline ?? null,
        startedAt: report.startedAt ? new Date(report.startedAt) : null,
        finishedAt: report.finishedAt ? new Date(report.finishedAt) : null,
        pageCount: report.pages.length,
        failedPages: pageErrors.length,
        pageErrors: pageErrors.length > 0 ? pageErrors : null,
        toolName: report.tool?.name ?? null,
        toolVersion: report.tool?.version ?? null,
      })
      .returning();

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      await tx
        .insert(auditResults)
        .values(rows.slice(i, i + BATCH_SIZE).map((r) => ({ ...r, auditRunId: inserted.id })));
    }
    return inserted;
  });

  // Same definition of "previous" as GET /projects/:id/audits/:runId (strictly
  // older createdAt on the same branch), so the response and a later read agree.
  // They can still differ if two uploads on one branch overlap in time: an
  // older run that commits after this lookup is invisible here but visible to
  // the read. Serialize audits per branch in CI if that matters.
  const previousRun = await findPreviousAuditRun(project.id, branch, run.createdAt);
  const regressions = previousRun
    ? compareAuditResults(await loadComparableResults(previousRun.id), rows)
    : [];

  return c.json(
    {
      success: true,
      auditRun: {
        id: run.id,
        project: project.name,
        branch,
        commit: commit ?? null,
        pipeline: pipeline ?? null,
        summary: {
          pages: report.pages.length,
          failedPages: pageErrors.length,
          checks: rows.length,
          scores: summarizeScores(rows),
        },
      },
      previousRunId: previousRun?.id ?? null,
      regressions,
    },
    201
  );
});

export default auditsRouter;
