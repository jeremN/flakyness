import { describe, it, expect, vi } from 'vitest';
vi.mock('$app/navigation', () => ({ goto: vi.fn(), invalidateAll: vi.fn() }));
vi.mock('$lib/components/Chart.svelte', async () => ({
  default: (await import('$lib/components/Chart.stub.svelte')).default,
}));
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import Page from './+page.svelte';
import type { FlakyTest } from '../app.d';

// PageData for the overview (root) route = layout `{ projects, selectedProject, apiError }`
// (selectedProject NON-NULL — plan point 7) merged with the page load `{ stats, flakyTests,
// recentRuns, trendData, partialFailure }`. The `Array.from` callback is annotated `: FlakyTest`
// so `status` stays the literal union (a bare object literal widens it to `string`).
const project = { id: 'p1', name: 'Proj', createdAt: '2026-01-01T00:00:00Z' };
const base = { projects: [], selectedProject: project, apiError: null };
const stats = { project: { id: 'p1', name: 'Proj' }, activeFlakyTests: 2, resolvedThisWeek: 1, totalRuns: 10, totalTests: 5 };
const flaky = (n: number): FlakyTest[] => Array.from({ length: n }, (_, i): FlakyTest => ({
  id: `f${i}`, testName: `t${i}`, testFile: 'f.spec.ts', firstDetected: '2026-03-01T00:00:00Z',
  lastSeen: '2026-03-15T10:00:00Z', flakeCount: 2, totalRuns: 10, flakeRate: '0.2', status: 'active' }));

describe('+page (overview)', () => {
  it('shows the no-projects state when stats is null', async () => {
    render(Page, { props: { data: { ...base, stats: null, trendData: null, flakyTests: [], recentRuns: [], partialFailure: false } } });
    await expect.element(page.getByText('No Projects Found')).toBeInTheDocument();
  });

  it('renders the stats section (Active Flaky Tests card) and the chart stub when stats + trendData present', async () => {
    render(Page, { props: { data: { ...base, stats, trendData: { days: ['d'], rates: [1] }, flakyTests: [], recentRuns: [], partialFailure: false } } });
    await expect.element(page.getByText('Active Flaky Tests')).toBeInTheDocument();
    await expect.element(page.getByTestId('chart-stub')).toBeInTheDocument();
  });

  it('caps the flaky preview at 5 rows (slice(0,5))', async () => {
    render(Page, { props: { data: { ...base, stats, trendData: null, partialFailure: true, recentRuns: [], flakyTests: flaky(7) } } });
    await expect.element(page.getByText('t4')).toBeInTheDocument();  // 5th row (index 4) present
    await expect.element(page.getByText('t5')).not.toBeInTheDocument(); // 6th row dropped
  });
});
