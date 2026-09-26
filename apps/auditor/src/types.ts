/**
 * AuditReport v1 — the body POSTed to /api/v1/audits.
 *
 * The API's zod schema (apps/api/src/services/audits.ts) is the source of
 * truth; these types mirror it. They are kept in contract by the API test that
 * ingests `apps/api/fixtures/audit-report.json`, which is real output of this
 * package (regenerate with `pnpm --filter auditor fixture:api`).
 */

export type Category = 'a11y' | 'seo' | 'perf';
export type Device = 'mobile' | 'desktop';
export type Severity = 'critical' | 'serious' | 'moderate' | 'minor' | 'info';

export interface Issue {
  /** Stable across runs — regressions are detected by id. */
  id: string;
  severity: Severity;
  message: string;
  count?: number;
}

export interface Check {
  category: Category;
  /** 0..1, or null when the check ran but could not produce a score. */
  score: number | null;
  metrics?: Record<string, number>;
  issues: Issue[];
}

export interface PageReport {
  url: string;
  device: Device;
  /** Set when the page never loaded; `checks` is then empty. */
  error?: string;
  checks: Check[];
}

export interface AuditReport {
  version: 1;
  tool: { name: string; version: string };
  startedAt: string;
  finishedAt: string;
  pages: PageReport[];
}

/** Upper bounds mirrored from the API; exceeding them is a 400 there. */
export const MAX_PAGES = 500;
export const MAX_ISSUES_PER_CHECK = 200;
export const MAX_MESSAGE_LENGTH = 1000;
