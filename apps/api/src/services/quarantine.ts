import { and, eq, lt, gt, sql } from 'drizzle-orm';
import { db, flakyTests, testResults, testRuns, quarantineEvents, quarantineRules } from '../db';
import { resolveProjectConfig, type ProjectFlakinessOverrides } from './flakiness';
import { evaluateRules, type EvalRule, type TestSliceResult } from './rules';

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
  ruleId?: string | null; // set when the rule engine drove the promotion
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
    const rules = await db
      .select()
      .from(quarantineRules)
      .where(and(eq(quarantineRules.projectId, projectId), eq(quarantineRules.enabled, true)))
      .orderBy(quarantineRules.position);

    if (rules.length === 0) {
      await promoteLegacy(projectId, cfg, now, transitions); // plan-051 path, unchanged
    } else {
      await promoteWithRules(projectId, project, cfg, rules, now, transitions);
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
      ruleId: t.event === 'entered' ? (t.ruleId ?? null) : null,
    })));
  }

  return transitions;
}

/**
 * The plan-051 single-threshold promotion, unchanged: fetch active rows,
 * apply the (numeric) flakeRate>=threshold filter in JS (avoids a Postgres
 * `numeric >= text` operator-resolution pitfall), then delegate the per-row
 * decision to `legacyThresholdDecision`.
 */
async function promoteLegacy(
  projectId: string,
  cfg: QuarantineConfig,
  now: Date,
  transitions: QuarantineTransition[],
): Promise<void> {
  const activeRows = await db.select().from(flakyTests)
    .where(and(eq(flakyTests.projectId, projectId), eq(flakyTests.status, 'active')));
  for (const active of activeRows) {
    const t = await legacyThresholdDecision(projectId, active, cfg, now);
    if (t) transitions.push(t);
  }
}

const DAY = 86_400_000;

/** Reduce a stored rule row to the engine's numeric shape. */
function toEvalRule(row: typeof quarantineRules.$inferSelect): EvalRule {
  return {
    id: row.id, position: row.position, action: row.action as 'quarantine' | 'exempt',
    conditionType: row.conditionType as EvalRule['conditionType'],
    selectorBranch: row.selectorBranch, selectorFile: row.selectorFile, selectorTag: row.selectorTag,
    flakeThreshold: row.flakeThreshold !== null ? Number(row.flakeThreshold) : null,
    minRuns: row.minRuns, windowDays: row.windowDays,
    consecutiveFailures: row.consecutiveFailures, ttlDays: row.ttlDays,
  };
}

async function promoteWithRules(
  projectId: string,
  project: ProjectQuarantineOverrides,
  cfg: QuarantineConfig,
  ruleRows: (typeof quarantineRules.$inferSelect)[],
  now: Date,
  transitions: QuarantineTransition[],
): Promise<void> {
  const flakiness = resolveProjectConfig(project);
  const rules = ruleRows.map(toEvalRule);
  // Evaluation window = widest effective rule window (null → project → global 14), capped 90.
  const windowDays = Math.min(90, Math.max(...rules.map((r) => r.windowDays ?? flakiness.windowDays)));
  const cutoff = new Date(now.getTime() - windowDays * DAY);

  // One fetch of the whole window; the engine slices per rule in memory (no N+1).
  const rows = await db.select({
      testName: testResults.testName, testFile: testResults.testFile, status: testResults.status,
      tags: testResults.tags, branch: testRuns.branch, createdAt: testResults.createdAt,
    })
    .from(testResults).innerJoin(testRuns, eq(testResults.testRunId, testRuns.id))
    .where(and(eq(testRuns.projectId, projectId), gt(testResults.createdAt, cutoff)));

  const byTest = new Map<string, { file: string | null; results: TestSliceResult[] }>();
  for (const row of rows) {
    const entry = byTest.get(row.testName) ?? { file: row.testFile, results: [] };
    entry.results.push({ status: row.status, branch: row.branch, testFile: row.testFile, tags: row.tags ?? [], createdAt: row.createdAt });
    byTest.set(row.testName, entry);
  }

  // ALL flaky_tests rows for the project: active rows drive the no-match legacy
  // fallback; ignored rows let us leave MANUAL mutes untouched — they are
  // indefinite and must never become an auto mute (which the Release phase would
  // later auto-release).
  const allRows = await db.select().from(flakyTests).where(eq(flakyTests.projectId, projectId));
  const rowByName = new Map(allRows.map((r) => [r.testName, r]));
  const candidateNames = new Set<string>([...byTest.keys(), ...allRows.filter((r) => r.status === 'active').map((r) => r.testName)]);

  for (const testName of candidateNames) {
    const entry = byTest.get(testName);
    const existing = rowByName.get(testName);
    const decision = evaluateRules(rules, entry?.results ?? []);

    if (decision.kind === 'quarantine') {
      // Manual/indefinite mutes (muteSource !== 'auto') are immune to auto-quarantine.
      if (existing?.status === 'ignored' && existing.muteSource !== 'auto') continue;
      const active = existing?.status === 'active' ? existing : undefined;
      const ttlDays = decision.ttlDays ?? cfg.ttlDays;
      // Clean slate only applies to a previously-released row.
      if (active?.quarantineReleasedAt && !(await hasFreshRuns(projectId, testName, active.quarantineReleasedAt, cfg.minRuns))) continue;
      const expiresAt = new Date(now.getTime() + ttlDays * DAY);
      const flakeRate = sliceFlakeRate(entry?.results ?? []);
      await db.insert(flakyTests).values({
          projectId, testName, testFile: entry?.file ?? active?.testFile ?? null,
          firstDetected: active?.firstDetected ?? now, lastSeen: now,
          flakeCount: 0, totalRuns: entry?.results.length ?? active?.totalRuns ?? 0,
          flakeRate: flakeRate.toFixed(4), status: 'ignored', muteSource: 'auto', quarantineExpiresAt: expiresAt,
        })
        .onConflictDoUpdate({
          target: [flakyTests.projectId, flakyTests.testName],
          set: { status: 'ignored', muteSource: 'auto', quarantineExpiresAt: expiresAt, lastSeen: now },
        });
      transitions.push({ testName, event: 'entered', flakeRate, expiresAt, ruleId: decision.ruleId });
    } else if (decision.kind === 'no-match') {
      // No rule owns this test → the exact plan-051 project-threshold decision,
      // via the same helper promoteLegacy uses (single source of truth).
      const active = existing?.status === 'active' ? existing : undefined;
      if (!active) continue;
      const t = await legacyThresholdDecision(projectId, active, cfg, now);
      if (t) transitions.push(t);
    }
    // exempt / leave → no promotion.
  }
}

/**
 * The plan-051 single-threshold decision for ONE active flaky_tests row.
 * Returns the transition (and applies the mute) if the row crosses the project
 * threshold and clears the clean-slate guard, else null. Shared by the legacy
 * path and the rule path's no-match fallback so the two never diverge.
 */
async function legacyThresholdDecision(
  projectId: string,
  active: typeof flakyTests.$inferSelect,
  cfg: QuarantineConfig,
  now: Date,
): Promise<QuarantineTransition | null> {
  if (Number(active.flakeRate ?? 0) < cfg.threshold) return null;
  if (active.quarantineReleasedAt) {
    if (!(await hasFreshRuns(projectId, active.testName, active.quarantineReleasedAt, cfg.minRuns))) return null;
  } else if ((active.totalRuns ?? 0) < cfg.minRuns) {
    return null;
  }
  const expiresAt = new Date(now.getTime() + cfg.ttlDays * DAY);
  await db.update(flakyTests)
    .set({ status: 'ignored', muteSource: 'auto', quarantineExpiresAt: expiresAt })
    .where(eq(flakyTests.id, active.id));
  return { testName: active.testName, event: 'entered', flakeRate: active.flakeRate ? Number(active.flakeRate) : null, expiresAt, ruleId: null };
}

function sliceFlakeRate(results: TestSliceResult[]): number {
  if (results.length === 0) return 0;
  const bad = results.filter((r) => r.status === 'failed' || r.status === 'flaky').length;
  return bad / results.length;
}

async function hasFreshRuns(projectId: string, testName: string, since: Date, minRuns: number): Promise<boolean> {
  const [{ count }] = await db.select({ count: sql<number>`count(*)` })
    .from(testResults).innerJoin(testRuns, eq(testResults.testRunId, testRuns.id))
    .where(and(eq(testRuns.projectId, projectId), eq(testResults.testName, testName), gt(testResults.createdAt, since)));
  return Number(count) >= minRuns;
}
