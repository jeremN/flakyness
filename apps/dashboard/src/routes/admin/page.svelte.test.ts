import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import Page from './+page.svelte';
import type { AdminProject } from '../../app.d';

const proj = (over: Partial<AdminProject> = {}): AdminProject => ({
  id: 'p1',
  name: 'Project One',
  gitlabProjectId: null,
  hasToken: true,
  createdAt: '2026-01-01T00:00:00Z',
  flakeThreshold: null,
  windowDays: null,
  minRuns: null,
  webhookUrl: null,
  webhookKind: null,
  retentionDays: null,
  autoQuarantineEnabled: false,
  quarantineThreshold: null,
  quarantineMinRuns: null,
  quarantineTtlDays: null,
  stats: { totalRuns: 7, totalTests: 42, activeFlakyTests: 2 },
  ...over,
});

// Layout half of PageData (Global Constraint 1): every page's `data` merges the
// layout load's { projects, selectedProject, apiError } with the page-load keys.
const layout = {
  projects: [],
  selectedProject: { id: 'p1', name: 'Project One', createdAt: '2026-01-01T00:00:00Z' },
  apiError: null,
};

describe('admin/+page (list)', () => {
  it('shows the disabled notice when adminEnabled is false', async () => {
    render(Page, { props: { data: { ...layout, adminProjects: [], adminEnabled: false } } });
    await expect.element(page.getByText('Admin actions are disabled')).toBeInTheDocument();
    await expect.element(page.getByRole('link', { name: 'New project' })).not.toBeInTheDocument();
  });

  it('shows the empty state when enabled with no projects', async () => {
    render(Page, { props: { data: { ...layout, adminProjects: [], adminEnabled: true } } });
    await expect.element(page.getByText('No projects yet')).toBeInTheDocument();
    await expect.element(page.getByRole('link', { name: 'New project' })).toBeInTheDocument();
  });

  it('renders a manage link and stats per project', async () => {
    render(Page, { props: { data: { ...layout, adminProjects: [proj()], adminEnabled: true } } });
    await expect.element(page.getByText('Project One')).toBeInTheDocument();
    const manage = page.getByRole('link', { name: 'Manage' });
    await expect.element(manage).toBeInTheDocument();
    await expect.element(manage).toHaveAttribute('href', '/admin/p1');
  });
});
