import { and, eq, lt, gt, sql } from 'drizzle-orm';
import { db, flakyTests, testResults, testRuns, quarantineEvents } from '../db';
import { resolveProjectConfig, type ProjectFlakinessOverrides } from './flakiness';

export interface QuarantineConfig {
  enabled: boolean;
  threshold: number;
  minRuns: number;
  ttlDays: number;
}

export const DEFAULT_QUARANTINE = { threshold: 0.2, ttlDays: 7 } as const;

/** Fields of a projects row this module reads. */
export interface ProjectQuarantineOverrides extends ProjectFlakinessOverrides {
  autoQuarantineEnabled: boolean;
  quarantineThreshold: string | null; // drizzle decimal -> string
  quarantineMinRuns: number | null;
  quarantineTtlDays: number | null;
}

/** Merge stored overrides (NULL = unset) over defaults. minRuns falls back to
 *  the resolved flakiness minRuns; threshold/ttl to the quarantine defaults. */
export function resolveQuarantineConfig(project: ProjectQuarantineOverrides): QuarantineConfig {
  const flakiness = resolveProjectConfig(project);
  return {
    enabled: project.autoQuarantineEnabled,
    threshold:
      project.quarantineThreshold !== null ? Number(project.quarantineThreshold) : DEFAULT_QUARANTINE.threshold,
    minRuns: project.quarantineMinRuns ?? flakiness.minRuns,
    ttlDays: project.quarantineTtlDays ?? DEFAULT_QUARANTINE.ttlDays,
  };
}

export interface QuarantineTransition {
  testName: string;
  event: 'entered' | 'released';
  flakeRate: number | null;
  expiresAt: Date | null;
}

/**
 * Release expired auto-mutes, then promote qualifying active tests, operating
 * on the already-reconciled flaky_tests rows. Writes quarantine_events and
 * returns the transitions for the caller to notify on. No network I/O here.
 */
export async function reconcileQuarantine(
  projectId: string,
  project: ProjectQuarantineOverrides
): Promise<QuarantineTransition[]> {
  const cfg = resolveQuarantineConfig(project);
  const now = new Date();
  const transitions: QuarantineTransition[] = [];

  // Phase 1: RELEASE expired auto-mutes (runs even if disabled — nothing stays
  // stuck skipped). Manual/NULL mute_source is never touched.
  const released = await db
    .update(flakyTests)
    .set({ status: 'active', muteSource: null, quarantineExpiresAt: null, quarantineReleasedAt: now })
    .where(and(
      eq(flakyTests.projectId, projectId),
      eq(flakyTests.status, 'ignored'),
      eq(flakyTests.muteSource, 'auto'),
      lt(flakyTests.quarantineExpiresAt, now),
    ))
    .returning({ testName: flakyTests.testName, flakeRate: flakyTests.flakeRate });

  for (const r of released) {
    transitions.push({ testName: r.testName, event: 'released', flakeRate: r.flakeRate ? Number(r.flakeRate) : null, expiresAt: null });
  }

  // Phase 2 (DETECT) already ran in updateFlakyTests before this call.

  // Phase 3: PROMOTE — only when enabled.
  if (cfg.enabled) {
    // Fetch active rows and compare the (numeric) flakeRate in JS — avoids a
    // Postgres `numeric >= text` operator-resolution pitfall and matches the
    // codebase's compute-in-JS idiom. Active flaky rows are bounded per project.
    const activeRows = await db
      .select()
      .from(flakyTests)
      .where(and(
        eq(flakyTests.projectId, projectId),
        eq(flakyTests.status, 'active'),
      ));
    const candidates = activeRows.filter((r) => Number(r.flakeRate ?? 0) >= cfg.threshold);

    for (const cand of candidates) {
      // Clean slate: if released before, require >= minRuns fresh runs after release.
      if (cand.quarantineReleasedAt) {
        const [{ count }] = await db
          .select({ count: sql<number>`count(*)` })
          .from(testResults)
          .innerJoin(testRuns, eq(testResults.testRunId, testRuns.id))
          .where(and(
            eq(testRuns.projectId, projectId),
            eq(testResults.testName, cand.testName),
            gt(testResults.createdAt, cand.quarantineReleasedAt),
          ));
        if (Number(count) < cfg.minRuns) continue;
      } else if ((cand.totalRuns ?? 0) < cfg.minRuns) {
        continue;
      }

      const expiresAt = new Date(now.getTime() + cfg.ttlDays * 86_400_000);
      await db.update(flakyTests)
        .set({ status: 'ignored', muteSource: 'auto', quarantineExpiresAt: expiresAt })
        .where(eq(flakyTests.id, cand.id));
      transitions.push({ testName: cand.testName, event: 'entered', flakeRate: cand.flakeRate ? Number(cand.flakeRate) : null, expiresAt });
    }
  }

  // Audit: one row per transition.
  if (transitions.length > 0) {
    await db.insert(quarantineEvents).values(transitions.map((t) => ({
      projectId,
      testName: t.testName,
      event: t.event,
      source: 'auto' as const,
      flakeRate: t.flakeRate != null ? t.flakeRate.toFixed(4) : null,
      threshold: t.event === 'entered' ? cfg.threshold.toFixed(4) : null,
      ttlDays: t.event === 'entered' ? cfg.ttlDays : null,
    })));
  }

  return transitions;
}
