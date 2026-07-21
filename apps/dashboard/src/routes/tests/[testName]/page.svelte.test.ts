import { describe, it, expect, vi } from 'vitest';
vi.mock('$app/navigation', () => ({ goto: vi.fn(), invalidateAll: vi.fn() }));
vi.mock('$lib/components/Chart.svelte', async () => ({
  default: (await import('$lib/components/Chart.stub.svelte')).default,
}));
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import Page from './+page.svelte';

// PageData for /tests/[testName] = layout `{ projects, selectedProject, apiError }` (selectedProject
// NON-NULL — plan point 7) merged with the page load `{ testHistory, testTrend, trendFailed, projectId }`.
// TestTrend needs `testName` + `projectId` too (not just days/direction/trend).
const project = { id: 'p1', name: 'Proj', createdAt: '2026-01-01T00:00:00Z' };
const base = { projects: [], selectedProject: project, apiError: null };
const history = (over = {}) => ({ testName: 'my-test', flakyInfo: null,
  stats: { totalRuns: 5, passed: 3, failed: 1, flaky: 1, skipped: 0, avgDuration: 1200 },
  history: [], ...over });

describe('tests/[testName]/+page', () => {
  it('labels an insufficient-data trend distinctly from stable', async () => {
    render(Page, { props: { data: { ...base, projectId: 'p1', testHistory: history(),
      testTrend: { testName: 'my-test', projectId: 'p1', days: 30, direction: 'insufficient-data', trend: [] }, trendFailed: false } } });
    await expect.element(page.getByText('Insufficient data')).toBeInTheDocument();
    await expect.element(page.getByText('→ Stable')).not.toBeInTheDocument();
  });

  it('renders the trend-failure ErrorState', async () => {
    render(Page, { props: { data: { ...base, projectId: 'p1', testHistory: history(),
      testTrend: null, trendFailed: true } } });
    await expect.element(page.getByText("Couldn't load the flake-rate trend.")).toBeInTheDocument();
  });
});
