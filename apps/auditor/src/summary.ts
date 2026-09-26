import type { AuditReport, Category } from './types';
import type { Regression } from './upload';

const CATEGORIES: Category[] = ['a11y', 'seo', 'perf'];

function pct(score: number | null | undefined): string {
  return score === null || score === undefined ? '  —' : String(Math.round(score * 100)).padStart(3);
}

/** Plain-text table for CI logs: one line per page, scores out of 100. */
export function formatReport(report: AuditReport): string {
  const lines = [`${'a11y'.padStart(4)} ${' seo'} ${'perf'}  device   url`];
  for (const page of report.pages) {
    if (page.error) {
      lines.push(`  ✗ page failed      ${page.device.padEnd(8)} ${page.url} — ${page.error}`);
      continue;
    }
    const score = (c: Category) => page.checks.find((x) => x.category === c)?.score;
    lines.push(
      ` ${CATEGORIES.map((c) => pct(score(c))).join('  ')}  ${page.device.padEnd(8)} ${page.url}`
    );
  }
  const failed = report.pages.filter((p) => p.error).length;
  lines.push(`${report.pages.length} page(s) audited${failed ? `, ${failed} failed to load` : ''}.`);
  return lines.join('\n');
}

export function formatRegression(r: Regression): string {
  const where = `[${r.category}] ${r.url} (${r.device})`;
  switch (r.kind) {
    case 'new_issue':
      return `${where}: new ${r.severity} issue "${r.issueId}" — ${r.message}`;
    case 'score':
      return `${where}: score ${Math.round(r.previous * 100)} → ${Math.round(r.current * 100)}`;
    case 'metric': {
      const fmt = (v: number) => (r.metric === 'cls' ? v.toFixed(3) : `${Math.round(v)}ms`);
      return `${where}: ${r.metric} ${fmt(r.previous)} → ${fmt(r.current)}`;
    }
  }
}

export function formatRegressions(regressions: Regression[], previousRunId: string | null): string {
  if (previousRunId === null) return 'No previous audit on this branch — this run is the baseline.';
  if (regressions.length === 0) return 'No regressions against the previous audit.';
  return [`${regressions.length} regression(s) against the previous audit:`, ...regressions.map((r) => `  - ${formatRegression(r)}`)].join('\n');
}
