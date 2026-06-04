import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { parsePlaywrightReport } from '../parsers/playwright';
import { projectAuth } from '../middleware/auth';
import { reportRateLimit } from '../middleware/rate-limit';
import { db, testRuns, testResults, Project } from '../db';
import { updateFlakyTests } from '../services/flakiness';
import { logger } from '../middleware/logger';

const BATCH_SIZE = 1000;

const reports = new Hono<{
  Variables: {
    project: Project;
  };
}>();

// Query params schema
const reportQuerySchema = z.object({
  branch: z.string().min(1).default('main'),
  commit: z.string().min(1).max(40),
  pipeline: z.string().optional(),
});

// Apply auth and rate limiting to all routes
reports.use('*', projectAuth());
reports.use('*', reportRateLimit);

/**
 * POST /api/v1/reports
 *
 * Ingest a Playwright JSON report.
 *
 * Query params:
 *   - branch: Git branch name (default: "main")
 *   - commit: Git commit SHA (required)
 *   - pipeline: CI pipeline ID (optional)
 *
 * Body: Playwright JSON report
 *
 * Returns: Created test run with summary
 */
reports.post(
  '/',
  zValidator('query', reportQuerySchema),
  async (c) => {
    const project = c.get('project');
    const { branch, commit, pipeline } = c.req.valid('query');

    // Parse request body as JSON
    let rawReport: unknown;
    try {
      rawReport = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    // Parse the Playwright report
    let parsed;
    try {
      parsed = parsePlaywrightReport(rawReport);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return c.json({ error: `Failed to parse Playwright report: ${message}` }, 400);
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
        }));

        for (let i = 0; i < rows.length; i += BATCH_SIZE) {
          await tx.insert(testResults).values(rows.slice(i, i + BATCH_SIZE));
        }
      }

      return run;
    });

    // Trigger flakiness detection in background (don't await)
    updateFlakyTests(project.id).catch((err) => {
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
