import { describe, it, expect, vi } from 'vitest';
vi.mock('$app/navigation', () => ({ goto: vi.fn(), invalidateAll: vi.fn() }));
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import type { RunDetail } from '../../../app.d';
import Page from './+page.svelte';

// PageData for /runs/[runId] = layout `{ projects, selectedProject, apiError }` (selectedProject is a
// NON-NULL Project — plan point 7) merged with the page load union `{ runDetail, projectId, statusFilter,
// loadFailed }`. Branch 1 (projectId null) forces `statusFilter: null`. Every fixture spreads `base` for
// the layout half. RunDetail is `{ run: TestRun, results: RunResult[], truncated }` — NOT id/branch at the
// top level. RunResult needs `testFile`; failureDetail's stdout/stderr/snippet/stack are optional STRINGS
// (omit them, don't set null).
const project = { id: 'p1', name: 'Proj', createdAt: '2026-01-01T00:00:00Z' };
const base = { projects: [], selectedProject: project, apiError: null };
const run = { id: 'r1', branch: 'main', commitSha: 'abcdef1234567', pipelineId: null,
  startedAt: null, finishedAt: null, totalTests: 1, passed: 0, failed: 1, skipped: 0, flaky: 0,
  createdAt: '2026-03-15T10:00:00Z' };
const detail = (over: Partial<RunDetail> = {}): RunDetail => ({ run, results: [], truncated: false, ...over });

describe('runs/[runId]/+page', () => {
  it('shows the missing-project branch when projectId is falsy', async () => {
    render(Page, { props: { data: { ...base, projectId: null, loadFailed: false, runDetail: null, statusFilter: null } } });
    await expect.element(page.getByText('No Project Selected')).toBeInTheDocument();
  });

  it('renders ErrorState when loadFailed', async () => {
    render(Page, { props: { data: { ...base, projectId: 'p1', loadFailed: true, runDetail: null, statusFilter: 'failures' } } });
    await expect.element(page.getByText("Couldn't load this run.")).toBeInTheDocument();
  });

  it('shows the empty-results branch', async () => {
    render(Page, { props: { data: { ...base, projectId: 'p1', loadFailed: false, runDetail: detail({ results: [] }), statusFilter: 'failures' } } });
    await expect.element(page.getByText('No failures on this run')).toBeInTheDocument();
  });

  it('renders a failed result error message', async () => {
    render(Page, { props: { data: { ...base, projectId: 'p1', loadFailed: false, statusFilter: 'all',
      runDetail: detail({ results: [
        { testName: 'boom', testFile: null, status: 'failed', durationMs: 12, retryCount: 0,
          errorMessage: null, tags: [], annotations: [],
          failureDetail: { errors: [{ message: 'AssertionError: nope' }] } },
      ] }) } } });
    await expect.element(page.getByText('AssertionError: nope')).toBeInTheDocument();
  });

  it('shows the truncated notice when runDetail.truncated', async () => {
    render(Page, { props: { data: { ...base, projectId: 'p1', loadFailed: false, statusFilter: 'all',
      runDetail: detail({ results: [], truncated: true }) } } });
    await expect.element(page.getByText('Showing a capped subset of results — this run has more than the display limit.')).toBeInTheDocument();
  });
});
