import type { TrendDirection } from '../app.d';

// Badge class for a `test_results.status` value (passed/failed/flaky/skipped
// — the per-test-result domain). Shared by the test-detail and per-run detail
// pages.
//
// DISTINCT from `flakyStatusBadgeClass` below (the `flaky_tests.status`
// lifecycle domain): the two are co-located here but deliberately NOT unified —
// unifying would silently change colors (e.g. 'active' falling through to this
// function's 'badge-gray' default instead of its own 'badge-orange').
export function statusBadgeClass(status: string): string {
  switch (status) {
    case 'passed': return 'badge-green';
    case 'failed': return 'badge-red';
    case 'flaky': return 'badge-orange';
    case 'skipped': return 'badge-gray';
    default: return 'badge-gray';
  }
}

// Badge class for a `flaky_tests.status` value (active/resolved/ignored — the
// flaky-test lifecycle domain). Kept separate from statusBadgeClass above:
// 'active' must be orange here, not fall through to that function's gray
// default. Do not unify the two.
export function flakyStatusBadgeClass(status: string): string {
  switch (status) {
    case 'active': return 'badge-orange';
    case 'resolved': return 'badge-green';
    case 'ignored': return 'badge-gray';
    default: return 'badge-gray';
  }
}

// Rendered honestly, including 'insufficient-data' — not the same claim as
// 'stable' (plans/028-honest-visible-trends.md decision 4); never disguise one
// as the other.
export function trendDirectionLabel(direction: TrendDirection): string {
  switch (direction) {
    case 'improving': return '↓ Improving';
    case 'worsening': return '↑ Worsening';
    case 'stable': return '→ Stable';
    case 'insufficient-data': return 'Insufficient data';
  }
}

export function trendDirectionBadgeClass(direction: TrendDirection): string {
  switch (direction) {
    case 'improving': return 'badge-green';
    case 'worsening': return 'badge-red';
    case 'stable': return 'badge-gray';
    case 'insufficient-data': return 'badge-gray';
  }
}
