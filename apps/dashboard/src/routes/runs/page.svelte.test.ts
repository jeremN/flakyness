import { describe, it, expect, vi } from 'vitest';
vi.mock('$app/navigation', () => ({ goto: vi.fn(), invalidateAll: vi.fn() }));
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import Page from './+page.svelte';

const project = { id: 'p1', name: 'Test Project', createdAt: '2026-01-01T00:00:00Z' };
const base = { currentProject: null, projects: [], selectedProject: project, apiError: null };

describe('runs/+page', () => {
  it('shows the empty state when there are no runs', async () => {
    render(Page, { props: { data: { ...base, runs: [] } } });
    await expect.element(page.getByText('No Test Runs Yet')).toBeInTheDocument();
  });

  it('renders a run row with a green pass-rate at 90%', async () => {
    render(Page, { props: { data: { ...base, currentProject: project, runs: [
      { id: 'r1', branch: 'main', commitSha: 'abcdef1234567', pipelineId: '1',
        startedAt: null, finishedAt: null, skipped: 0,
        passed: 9, failed: 1, flaky: 0, totalTests: 10, createdAt: '2026-03-15T10:00:00Z' },
    ] } } });
    await expect.element(page.getByText('90%')).toBeInTheDocument();
    expect(document.querySelector('.text-green-600')).not.toBeNull();
  });
});
