// Badge class for a `test_results.status` value (passed/failed/flaky/skipped
// — the per-test-result domain). Extracted from
// routes/tests/[testName]/+page.svelte so the new per-run detail page can
// share it without duplicating the mapping.
//
// NOT the same domain as `flaky_tests.status` (active/resolved/ignored) used
// on routes/flaky/+page.svelte — that mapping is intentionally left as its
// own local function there, since unifying the two would silently change
// its badge colors (e.g. 'active' falling through to this function's
// default 'badge-gray' instead of its own 'badge-orange').
export function statusBadgeClass(status: string): string {
  switch (status) {
    case 'passed': return 'badge-green';
    case 'failed': return 'badge-red';
    case 'flaky': return 'badge-orange';
    case 'skipped': return 'badge-gray';
    default: return 'badge-gray';
  }
}
