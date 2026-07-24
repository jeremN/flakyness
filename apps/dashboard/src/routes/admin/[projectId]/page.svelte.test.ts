import { describe, it, expect, vi } from 'vitest';
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }));
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import Page from './+page.svelte';
import type { AdminProject } from '../../../app.d';

const project = (over: Partial<AdminProject> = {}): AdminProject => ({
  id: 'p1',
  name: 'Proj One',
  gitlabProjectId: null,
  hasToken: true,
  createdAt: '2026-01-01T00:00:00Z',
  flakeThreshold: 0.1,
  windowDays: 14,
  minRuns: 5,
  webhookUrl: null,
  webhookKind: null,
  retentionDays: 30,
  autoQuarantineEnabled: false,
  quarantineThreshold: null,
  quarantineMinRuns: null,
  quarantineTtlDays: null,
  stats: { totalRuns: 3, totalTests: 9, activeFlakyTests: 1 },
  ...over,
});

// Layout half of PageData (Global Constraint 1). `data` for this route =
// { projects, selectedProject, apiError } ∪ { project }.
const layout = {
  projects: [],
  selectedProject: { id: 'p1', name: 'Proj One', createdAt: '2026-01-01T00:00:00Z' },
  apiError: null,
};

describe('admin/[projectId]/+page settings', () => {
  it('pre-fills numeric fields and leaves nulls blank', async () => {
    render(Page, { props: { data: { ...layout, project: project() }, form: null } });
    await expect.element(page.getByLabelText('Window days (1–90)')).toHaveValue('14');
    await expect.element(page.getByLabelText('Quarantine TTL days (1–365)')).toHaveValue('');
  });

  it('renders per-field validation errors from a patch fail', async () => {
    render(Page, {
      props: {
        data: { ...layout, project: project() },
        form: { action: 'patch', errors: { windowDays: 'must be between 1 and 90' } },
      },
    });
    await expect.element(page.getByText('must be between 1 and 90')).toBeInTheDocument();
  });

  it('confirms a successful save', async () => {
    render(Page, {
      props: { data: { ...layout, project: project() }, form: { action: 'patch', success: true } },
    });
    await expect.element(page.getByText('Settings saved.')).toBeInTheDocument();
  });
});

describe('admin/[projectId]/+page lifecycle', () => {
  it('shows the token reveal after a rotate', async () => {
    render(Page, {
      props: {
        data: { ...layout, project: project() },
        form: { action: 'rotate', token: 'rot_tok', warning: 'gone forever' },
      },
    });
    await expect.element(page.getByText('rot_tok')).toBeInTheDocument();
  });

  it('shows prune preview counts and a confirm button on a dry run', async () => {
    render(Page, {
      props: {
        data: { ...layout, project: project() },
        form: {
          action: 'prune',
          prune: { dryRun: true, cutoff: '2026-01-01T00:00:00Z', runsToDelete: 5, resultsToDelete: 20 },
        },
      },
    });
    await expect.element(page.getByText(/will delete 5 runs \/ 20 results/)).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Confirm prune' })).toBeInTheDocument();
  });

  it('keeps Delete disabled until the exact name is typed', async () => {
    render(Page, { props: { data: { ...layout, project: project() }, form: null } });
    const btn = page.getByRole('button', { name: 'Delete permanently' });
    await expect.element(btn).toBeDisabled();
    await page.getByLabelText('Type the project name to confirm').fill('wrong');
    await expect.element(btn).toBeDisabled();
    await page.getByLabelText('Type the project name to confirm').fill('Proj One');
    await expect.element(btn).toBeEnabled();
  });
});
