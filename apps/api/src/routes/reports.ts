import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { parsePlaywrightReport } from '../parsers/playwright';
import type { ParsedReport } from '../parsers/types';
import { parseJUnitReport } from '../parsers/junit';
import { projectAuth } from '../middleware/auth';
import { reportRateLimit } from '../middleware/rate-limit';
import { db, testRuns, testResults, Project } from '../db';
import { updateFlakyTests, resolveProjectConfig } from '../services/flakiness';
import { sendFlakyTransitionWebhook, type FlakyTransitionPayload } from '../services/notifications';
import { logger } from '../middleware/logger';
import { reportsIngestedTotal, reportParseFailuresTotal } from '../metrics';

const BATCH_SIZE = 1000;

// Bound for the `?wait=true` reconcile below. `updateFlakyTests` is DB-bound
// and normally fast, but a pathologically slow DB must not hang the request
// forever — past this many ms, the response's `reconcile` field reports a
// timeout error instead of blocking. The reconcile itself keeps running in
// the background regardless of which side of the race wins (same fate as
// the default, un-awaited path).
const RECONCILE_WAIT_TIMEOUT_MS = 10_000;

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

/**
 * Race `promise` against a timeout without cancelling `promise` itself — any
 * other consumer already attached to it (the fire-and-forget webhook chain)
 * keeps observing its eventual outcome regardless of which side wins here.
 *
 * Exported (only) so `reports.test.ts` can unit-test the bounded-wait
 * semantics directly, without needing to fault-inject a real DB failure.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Reconcile timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

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
 *   - wait: "true" to await flakiness reconciliation before responding (see below)
 *
 * Body: Playwright JSON report, or a JUnit XML report
 *
 * Returns: Created test run with summary. By default, flakiness
 * reconciliation runs in the background and the response is sent before it
 * completes — `flaky_tests` is NOT guaranteed consistent yet when the
 * response arrives. Pass `?wait=true` to await it instead: the response is
 * only sent after `flaky_tests` reflects this ingest, and the response body
 * gains a `reconcile: { newlyFlaky, newlyResolved }` field reporting what
 * changed (or `reconcile: { error }` if the reconcile failed/timed out —
 * the ingest itself still succeeds and still returns 201).
 */
reports.post(
  '/',
  zValidator('query', reportQuerySchema),
  async (c) => {
    const project = c.get('project');
    const { branch, commit, pipeline } = c.req.valid('query');
    // Strict `=== 'true'` match, same idiom as the codebase's other boolean
    // query params — anything else (absent, "1", "yes") takes the default,
    // un-awaited path.
    const wait = c.req.query('wait') === 'true';

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
          failureDetail: result.failureDetail,
        }));

        for (let i = 0; i < rows.length; i += BATCH_SIZE) {
          await tx.insert(testResults).values(rows.slice(i, i + BATCH_SIZE));
        }
      }

      return run;
    });

    reportsIngestedTotal.inc({ project: project.name });

    // Trigger flakiness detection exactly ONCE per ingest — this single
    // promise is the source of truth for both the fire-and-forget webhook
    // branch below and the optional `?wait=true` await further down. Do not
    // call updateFlakyTests a second time for the waited path: that would
    // double every ingest's DB work.
    const reconcilePromise = updateFlakyTests(project.id, resolveProjectConfig(project));

    // Deliver a best-effort webhook notification off the same result, in
    // BOTH modes, always fire-and-forget: awaiting a network POST here (which
    // can hang on a slow/unreachable receiver) would turn `?wait=true` into
    // an unbounded-latency request. `wait=true` only waits for the reconcile
    // itself (below), never for webhook delivery.
    reconcilePromise
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

    // `reconcile` is present in the response ONLY when `?wait=true` — the
    // default (fire-and-forget) response shape below is otherwise unchanged.
    let reconcile: { newlyFlaky: string[]; newlyResolved: string[] } | { error: string } | undefined;
    if (wait) {
      try {
        const { newlyFlaky, newlyResolved } = await withTimeout(
          reconcilePromise,
          RECONCILE_WAIT_TIMEOUT_MS
        );
        reconcile = { newlyFlaky, newlyResolved };
      } catch (err) {
        // The ingest itself already committed successfully — a reconcile
        // failure or timeout under `wait=true` is reported in the body, it
        // never turns a successful upload into a 500.
        const message = err instanceof Error ? err.message : 'Unknown error';
        reconcile = { error: message };
      }
    }

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
      ...(reconcile !== undefined ? { reconcile } : {}),
    }, 201);
  }
);

export default reports;
