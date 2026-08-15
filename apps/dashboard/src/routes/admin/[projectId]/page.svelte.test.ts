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
  teamId: null,
  stats: { totalRuns: 3, totalTests: 9, activeFlakyTests: 1 },
  ...over,
});

// Layout half of PageData (Global Constraint 1). `data` for this route =
// { projects, selectedProject, apiError, user, activeTeam } ∪ { project,
// teams }. Note the name collision (same pattern as admin/teams' own test):
// the layout's `teams` (TeamSummary[], the caller's own memberships) is
// shadowed by this page's own `teams` (AdminTeam[], every team — Task 7b) in
// the merged PageData, so `teams` below is always this page's own shape.
const layout = {
  projects: [],
  selectedProject: { id: 'p1', name: 'Proj One', createdAt: '2026-01-01T00:00:00Z', teamId: null },
  apiError: null,
  user: null,
  teams: [],
  activeTeam: null,
};

const globalAdmin = {
  id: 'admin1',
  email: 'admin@x.test',
  displayName: 'Admin',
  isGlobalAdmin: true,
  mustChangePassword: false,
};
const teamAdmin = {
  id: 'ta1',
  email: 'ta@x.test',
  displayName: 'Team Admin',
  isGlobalAdmin: false,
  mustChangePassword: false,
};
const adminTeams = [
  { id: 't1', name: 'Team One', createdAt: 'x', memberCount: 1, projectCount: 1 },
  { id: 't2', name: 'Team Two', createdAt: 'x', memberCount: 1, projectCount: 1 },
];

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

describe('admin/[projectId]/+page team assignment (Task 7b)', () => {
  it('shows a team select, pre-selected to the project team, for a global admin', async () => {
    render(Page, {
      props: {
        data: { ...layout, project: project({ teamId: 't2' }), teams: adminTeams, user: globalAdmin },
        form: null,
      },
    });
    const select = page.getByLabelText('Team');
    await expect.element(select).toBeInTheDocument();
    await expect.element(select).toHaveValue('t2');
  });

  it('pre-selects "Unassigned" when the project has no team', async () => {
    render(Page, {
      props: {
        data: { ...layout, project: project({ teamId: null }), teams: adminTeams, user: globalAdmin },
        form: null,
      },
    });
    await expect.element(page.getByLabelText('Team')).toHaveValue('');
  });

  it('hides the team select for a team_admin', async () => {
    render(Page, {
      props: {
        data: { ...layout, project: project(), teams: [], user: teamAdmin },
        form: null,
      },
    });
    await expect.element(page.getByLabelText('Team')).not.toBeInTheDocument();
  });

  it('hides the team select for an anonymous/absent user', async () => {
    render(Page, {
      props: {
        data: { ...layout, project: project(), teams: [], user: null },
        form: null,
      },
    });
    await expect.element(page.getByLabelText('Team')).not.toBeInTheDocument();
  });
});
