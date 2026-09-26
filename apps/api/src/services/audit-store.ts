import { and, desc, eq, lt } from 'drizzle-orm';
import { db, auditRuns, auditResults } from '../db';
import type { ComparableResult } from './audits';

/**
 * DB reads shared by the audit ingest route (routes/audits.ts) and the audit
 * read routes (routes/projects.ts), so both agree on what "the previous run"
 * means. services/audits.ts stays DB-free on purpose; the I/O lives here.
 */

/** A run's results in the shape `compareAuditResults` consumes. */
export async function loadComparableResults(auditRunId: string): Promise<ComparableResult[]> {
  return db
    .select({
      url: auditResults.url,
      device: auditResults.device,
      category: auditResults.category,
      score: auditResults.score,
      metrics: auditResults.metrics,
      issues: auditResults.issues,
    })
    .from(auditResults)
    .where(eq(auditResults.auditRunId, auditRunId));
}

/**
 * The most recent run on the same project + branch, strictly older than
 * `before` when given (read path), or simply the most recent one (ingest path,
 * called BEFORE the new run is inserted so it can never select itself).
 *
 * Baselines are per-branch: a feature-branch audit is compared with that
 * branch's previous audit, never with production's.
 */
export async function findPreviousAuditRun(
  projectId: string,
  branch: string,
  before?: Date
): Promise<{ id: string } | null> {
  const conditions = [eq(auditRuns.projectId, projectId), eq(auditRuns.branch, branch)];
  if (before) conditions.push(lt(auditRuns.createdAt, before));

  const [prev] = await db
    .select({ id: auditRuns.id })
    .from(auditRuns)
    .where(and(...conditions))
    .orderBy(desc(auditRuns.createdAt))
    .limit(1);
  return prev ?? null;
}
