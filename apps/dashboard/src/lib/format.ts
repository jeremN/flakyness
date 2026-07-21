export function formatDate(dateString: string | null): string {
  if (!dateString) return '—';
  return new Date(dateString).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function formatDateTime(dateString: string | null): string {
  if (!dateString) return '—';
  return new Date(dateString).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// startedAt/finishedAt are both nullable; only compute a duration when both are
// present rather than showing a number derived from one missing side.
export function runDurationMs(run: {
  startedAt: string | null;
  finishedAt: string | null;
}): number | null {
  if (!run.startedAt || !run.finishedAt) return null;
  return new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
}

export function getPassRate(run: { passed: number; totalTests: number }): number {
  if (run.totalTests === 0) return 0;
  return (run.passed / run.totalTests) * 100;
}

export function getPassRateClass(passRate: number): string {
  if (passRate >= 90) return 'badge-green';
  if (passRate >= 70) return 'badge-orange';
  return 'badge-red';
}

// A gap day (`value: null` — no runs, NOT "0% flaky") must not render as
// "null%"; say so honestly. See plans/028-honest-visible-trends.md.
export function trendTooltipLabel(value: number | null): string {
  return value === null ? 'no runs' : `${value}%`;
}
