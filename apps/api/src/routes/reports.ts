import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { parsePlaywrightReport, type ParsedReport } from '../parsers/playwright';
import { parseJUnitReport } from '../parsers/junit';
import { projectAuth } from '../middleware/auth';
import { reportRateLimit } from '../middleware/rate-limit';
import { db, testRuns, testResults, Project } from '../db';
import { updateFlakyTests, resolveProjectConfig } from '../services/flakiness';
import { sendFlakyTransitionWebhook, type FlakyTransitionPayload } from '../services/notifications';
import { logger } from '../middleware/logger';
import { reportsIngestedTotal, reportParseFailuresTotal } from '../metrics';

const BATCH_SIZE = 1000;

const reports = new Hono<{
  Variables: {
    project: Project;
  };
}>();

// Query params schema
const reportQuerySchema = z.object({
  branch: z.string().min(1).max(255).default('main'),
  commit: z.string().min(1).max(40),
  pipeline: z.string().max(100).optional(),
});

// Apply auth and rate limiting to all routes
reports.use('*', projectAuth());
reports.use('*', reportRateLimit);

/**
 * POST /api/v1/reports
 *
 * Ingest a Playwright JSON report or a JUnit XML report. The format is
 * detected from the body content (not Content-Type): a body that starts
 * with '<' is parsed as JUnit XML, everything else as Playwright JSON.
 *
 * Query params:
 *   - branch: Git branch name (default: "main")
 *   - commit: Git commit SHA (required)
 *   - pipeline: CI pipeline ID (optional)
 *
 * Body: Playwright JSON report, or a JUnit XML report
 *
 * Returns: Created test run with summary
 */
reports.post(
  '/',
  zValidator('query', reportQuerySchema),
  async (c) => {
    const project = c.get('project');
    const { branch, commit, pipeline } = c.req.valid('query');

    // Read the body once as text, then dispatch by content — not Content-Type,
    // since CI uploaders can send an inaccurate header. A body that (after
    // leading whitespace) starts with '<' is treated as a JUnit XML report;
    // anything else takes the existing Playwright JSON path.
    const bodyText = await c.req.text();
    let parsed: ParsedReport;

    if (bodyText.trimStart().startsWith('<')) {
      try {
        parsed = parseJUnitReport(bodyText);
      } catch (error) {
        reportParseFailuresTotal.inc();
        const message = error instanceof Error ? error.message : 'Unknown error';
        return c.json({ error: `Failed to parse JUnit report: ${message}` }, 400);
      }
    } else {
      let rawReport: unknown;
      try {
        rawReport = JSON.parse(bodyText);
      } catch {
        reportParseFailuresTotal.inc();
        return c.json({ error: 'Invalid JSON body' }, 400);
      }

      try {
        parsed = parsePlaywrightReport(rawReport);
      } catch (error) {
        reportParseFailuresTotal.inc();
        const message = error instanceof Error ? error.message : 'Unknown error';
        return c.json({ error: `Failed to parse Playwright report: ${message}` }, 400);
      }
    }

    // Insert test run and results in a single transaction for atomicity
    const testRun = await db.transaction(async (tx) => {
      const [run] = await tx
        .insert(testRuns)
        .values({
          projectId: project.id,
          branch,
          commitSha: commit,
          pipelineId: pipeline || null,
          startedAt: parsed.startedAt,
          finishedAt: parsed.finishedAt,
          totalTests: parsed.totalTests,
          passed: parsed.passed,
          failed: parsed.failed,
          skipped: parsed.skipped,
          flaky: parsed.flaky,
        })
        .returning();

      // Insert test results in chunks to avoid exceeding PostgreSQL parameter limit (~65535)
      if (parsed.results.length > 0) {
        const rows = parsed.results.map((result) => ({
          testRunId: run.id,
          testName: result.testName,
          testFile: result.testFile,
          status: result.status,
          durationMs: result.durationMs,
          retryCount: result.retryCount,
          errorMessage: result.errorMessage,
          tags: result.tags.length > 0 ? result.tags : null,
          annotations: result.annotations.length > 0 ? result.annotations : null,
        }));

        for (let i = 0; i < rows.length; i += BATCH_SIZE) {
          await tx.insert(testResults).values(rows.slice(i, i + BATCH_SIZE));
        }
      }

      return run;
    });

    reportsIngestedTotal.inc({ project: project.name });

    // Trigger flakiness detection in background (don't await). If it surfaces
    // a newly-flaky or newly-resolved test and the project has a webhook
    // configured, deliver one best-effort notification for this ingest.
    updateFlakyTests(project.id, resolveProjectConfig(project))
      .then(async ({ newlyFlaky, newlyResolved }) => {
        if (!project.webhookUrl || (newlyFlaky.length === 0 && newlyResolved.length === 0)) {
          return;
        }

        const payload: FlakyTransitionPayload = {
          event: 'flaky_tests_changed',
          project: { id: project.id, name: project.name },
          newlyFlaky,
          newlyResolved,
          run: { branch: testRun.branch, commitSha: testRun.commitSha },
          dashboardUrl: null,
        };

        const delivered = await sendFlakyTransitionWebhook(project.webhookUrl, payload);
        if (!delivered) {
          logger.error('Flaky transition webhook delivery failed', {
            projectId: project.id,
            projectName: project.name,
          });
        }
      })
      .catch((err) => {
        const errorMessage = err instanceof Error ? err.message : 'Unknown error';
        logger.error('Flakiness detection failed', {
          projectId: project.id,
          error: {
            name: err instanceof Error ? err.name : 'Error',
            message: errorMessage,
          },
        });
      });

    return c.json({
      success: true,
      testRun: {
        id: testRun.id,
        project: project.name,
        branch,
        commit,
        pipeline,
        summary: {
          total: parsed.totalTests,
          passed: parsed.passed,
          failed: parsed.failed,
          flaky: parsed.flaky,
          skipped: parsed.skipped,
        },
      },
    }, 201);
  }
);

export default reports;
