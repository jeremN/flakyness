import { z } from 'zod';
import type { AuditIssue } from '../db/schema';

/**
 * Quality audits (plan 060) — the wire format and the pure regression logic.
 *
 * Kept DB-free on purpose: everything here is unit-tested in the node env
 * without Postgres, and is a candidate for the mutation gate once a baseline
 * exists. Route handlers in routes/audits.ts and routes/projects.ts do the I/O.
 */

// ---------------------------------------------------------------------------
// Wire format (AuditReport v1) — what apps/auditor uploads.
// ---------------------------------------------------------------------------

export const AUDIT_CATEGORIES = ['a11y', 'seo', 'perf'] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

export const AUDIT_DEVICES = ['mobile', 'desktop'] as const;

export const AUDIT_SEVERITIES = ['critical', 'serious', 'moderate', 'minor', 'info'] as const;

/** Upper bounds on an ingested report. A payload over these is rejected (400), never truncated. */
export const MAX_AUDIT_PAGES = 500;
export const MAX_ISSUES_PER_CHECK = 200;
export const MAX_METRICS_PER_CHECK = 20;

const issueSchema = z.object({
  id: z.string().min(1).max(128),
  severity: z.enum(AUDIT_SEVERITIES),
  message: z.string().max(1000),
  count: z.number().int().min(0).optional(),
});

const checkSchema = z.object({
  category: z.enum(AUDIT_CATEGORIES),
  score: z.number().min(0).max(1).nullable(),
  metrics: z
    .record(z.string().min(1).max(32), z.number().finite())
    .refine((m) => Object.keys(m).length <= MAX_METRICS_PER_CHECK, {
      message: `at most ${MAX_METRICS_PER_CHECK} metrics per check`,
    })
    .optional(),
  issues: z.array(issueSchema).max(MAX_ISSUES_PER_CHECK),
});

const pageSchema = z
  .object({
    url: z.string().url().max(2048),
    device: z.enum(AUDIT_DEVICES),
    // Set when the page never loaded; `checks` is then expected to be empty.
    error: z.string().max(1000).optional(),
    checks: z.array(checkSchema).max(AUDIT_CATEGORIES.length),
  })
  .refine(
    (p) => new Set(p.checks.map((c) => c.category)).size === p.checks.length,
    { message: 'each category may appear at most once per page' }
  )
  .refine((p) => p.error === undefined || p.checks.length === 0, {
    message: 'a page with an error must have no checks',
  });

export const auditReportSchema = z.object({
  version: z.literal(1),
  tool: z
    .object({
      name: z.string().min(1).max(100),
      version: z.string().min(1).max(50),
    })
    .optional(),
  startedAt: z.iso.datetime({ offset: true }).optional(),
  finishedAt: z.iso.datetime({ offset: true }).optional(),
  pages: z
    .array(pageSchema)
    .min(1)
    .max(MAX_AUDIT_PAGES)
    // A duplicated (url, device) would be counted twice in the category means
    // and could emit the same regression twice.
    .refine((pages) => new Set(pages.map((p) => `${p.url}\u0000${p.device}`)).size === pages.length, {
      message: 'each (url, device) pair may appear at most once',
    }),
});

export type AuditReport = z.infer<typeof auditReportSchema>;

// ---------------------------------------------------------------------------
// Regression detection: compare one run's results against the previous run's.
// ---------------------------------------------------------------------------

/** The subset of an audit_results row the comparison needs. `score` is the DB decimal string. */
export interface ComparableResult {
  url: string;
  device: string;
  category: string;
  score: string | null;
  metrics: Record<string, number> | null;
  issues: AuditIssue[];
}

export type Regression =
  | {
      kind: 'score';
      url: string;
      device: string;
      category: string;
      previous: number;
      current: number;
    }
  | {
      kind: 'new_issue';
      url: string;
      device: string;
      category: string;
      issueId: string;
      severity: AuditIssue['severity'];
      message: string;
    }
  | {
      kind: 'metric';
      url: string;
      device: string;
      category: string;
      metric: string;
      previous: number;
      current: number;
    };

/**
 * A score drop smaller than this is noise, not a regression. Scores are 0–1,
 * so 0.05 is "5 points" on the familiar 0–100 scale.
 */
export const SCORE_DROP_THRESHOLD = 0.05;

/**
 * A timing metric regresses only when it BOTH grows by `ratio` AND by at least
 * `minDelta` in absolute terms — ratio alone flags 20ms→30ms TTFB jitter,
 * delta alone flags a 250ms wobble on a 9s LCP. CLS is unitless and small, so
 * it uses an absolute delta only (ratio: 1 disables the ratio arm).
 */
export const METRIC_REGRESSION_RULES: Readonly<Record<string, { ratio: number; minDelta: number }>> = {
  lcp: { ratio: 1.2, minDelta: 250 },
  fcp: { ratio: 1.2, minDelta: 250 },
  ttfb: { ratio: 1.2, minDelta: 100 },
  tbt: { ratio: 1.2, minDelta: 100 },
  cls: { ratio: 1, minDelta: 0.05 },
};

function resultKey(r: Pick<ComparableResult, 'url' | 'device' | 'category'>): string {
  // \u0000 cannot occur in a URL, a device or a category, so keys cannot collide.
  return `${r.url}\u0000${r.device}\u0000${r.category}`;
}

const SEVERITY_RANK: Record<AuditIssue['severity'], number> = {
  critical: 0,
  serious: 1,
  moderate: 2,
  minor: 3,
  info: 4,
};

const KIND_RANK: Record<Regression['kind'], number> = { new_issue: 0, score: 1, metric: 2 };

/**
 * Everything that got worse between `previous` and `current`.
 *
 * Rules:
 *  - Only (url, device, category) triples present in BOTH runs are compared.
 *    A page with no baseline has nothing to regress from — it is new, not worse.
 *  - `info` issues never count: they are observations (e.g. "canonical points
 *    elsewhere"), not defects.
 *  - A NULL score on either side skips the score comparison (unmeasured is
 *    not zero — same principle as the trend endpoint's `null` buckets).
 *
 * Ordering is deterministic (new issues by severity, then score drops, then
 * metrics; ties broken by url/device/category) so API responses and CI logs
 * are stable across identical inputs.
 */
export function compareAuditResults(
  previous: readonly ComparableResult[],
  current: readonly ComparableResult[]
): Regression[] {
  const baseline = new Map(previous.map((r) => [resultKey(r), r]));
  const regressions: Regression[] = [];

  for (const cur of current) {
    const prev = baseline.get(resultKey(cur));
    if (!prev) continue;
    const where = { url: cur.url, device: cur.device, category: cur.category };

    // 1. New issues (by stable id).
    const previousIds = new Set(prev.issues.map((i) => i.id));
    for (const issue of cur.issues) {
      if (issue.severity === 'info' || previousIds.has(issue.id)) continue;
      regressions.push({
        kind: 'new_issue',
        ...where,
        issueId: issue.id,
        severity: issue.severity,
        message: issue.message,
      });
    }

    // 2. Score drop.
    if (prev.score !== null && cur.score !== null) {
      const before = Number(prev.score);
      const after = Number(cur.score);
      // Rounded to 4dp (the column's scale) so float subtraction noise such as
      // 0.9 - 0.85 = 0.05000000000000004 cannot decide a boundary case.
      const drop = Number((before - after).toFixed(4));
      if (drop >= SCORE_DROP_THRESHOLD) {
        regressions.push({ kind: 'score', ...where, previous: before, current: after });
      }
    }

    // 3. Metric regressions.
    if (prev.metrics && cur.metrics) {
      for (const [metric, rule] of Object.entries(METRIC_REGRESSION_RULES)) {
        const before = prev.metrics[metric];
        const after = cur.metrics[metric];
        if (typeof before !== 'number' || typeof after !== 'number') continue;
        const delta = Number((after - before).toFixed(4));
        if (delta >= rule.minDelta && after >= before * rule.ratio) {
          regressions.push({ kind: 'metric', ...where, metric, previous: before, current: after });
        }
      }
    }
  }

  return regressions.sort((a, b) => {
    if (a.kind !== b.kind) return KIND_RANK[a.kind] - KIND_RANK[b.kind];
    if (a.kind === 'new_issue' && b.kind === 'new_issue' && a.severity !== b.severity) {
      return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    }
    return (
      a.url.localeCompare(b.url) ||
      a.device.localeCompare(b.device) ||
      a.category.localeCompare(b.category) ||
      detailOf(a).localeCompare(detailOf(b))
    );
  });
}

function detailOf(r: Regression): string {
  if (r.kind === 'new_issue') return r.issueId;
  if (r.kind === 'metric') return r.metric;
  return '';
}

/**
 * Mean score per category over a run's results, or `null` for a category with
 * no scored result (never 0 — "not measured" and "scored zero" are different
 * facts). Rounded to 4dp to match the stored precision.
 */
export function summarizeScores(
  results: readonly Pick<ComparableResult, 'category' | 'score'>[]
): Record<AuditCategory, number | null> {
  const summary = {} as Record<AuditCategory, number | null>;
  for (const category of AUDIT_CATEGORIES) {
    const scores = results
      .filter((r) => r.category === category && r.score !== null)
      .map((r) => Number(r.score));
    summary[category] =
      scores.length === 0 ? null : Number((scores.reduce((s, x) => s + x, 0) / scores.length).toFixed(4));
  }
  return summary;
}
