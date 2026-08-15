import { describe, it, expect, vi } from 'vitest';
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }));
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import Page from './+page.svelte';
import type { AdminTeam, AdminUser } from '../../../app.d';

// Layout half of PageData (root +layout.server.ts, Global Constraint 1):
// `data` for this route = { projects, selectedProject, apiError, user, teams,
// activeTeam } ∪ { teams: AdminTeam[], users: AdminUser[] } from this page's
// own load. Note the name collision: the layout's `teams` (TeamSummary[], the
// signed-in user's own memberships) is shadowed by this page's `teams`
// (AdminTeam[], every team) in the merged PageData — this page only ever
// reads its own.
const layoutData = {
  projects: [],
  selectedProject: { id: 'p1', name: 'Proj One', createdAt: '2026-01-01T00:00:00Z', teamId: null },
  apiError: null,
  user: { id: 'admin1', email: 'admin@x.test', displayName: 'Admin', isGlobalAdmin: true, mustChangePassword: false },
  activeTeam: null,
};

function team(overrides: Partial<AdminTeam> = {}): AdminTeam {
  return { id: 't1', name: 'Team One', createdAt: '2026-01-01T00:00:00Z', memberCount: 3, projectCount: 7, ...overrides };
}

function user(overrides: Partial<AdminUser> = {}): AdminUser {
  return {
    id: 'u1',
    email: 'alice@x.test',
    displayName: 'Alice',
    isGlobalAdmin: false,
    mustChangePassword: false,
    createdAt: '2026-01-01T00:00:00Z',
    lastLoginAt: null,
    teams: [],
    ...overrides,
  };
}

describe('admin teams page', () => {
  it('shows the empty state when there are no teams', async () => {
    render(Page, { props: { data: { ...layoutData, teams: [], users: [] }, form: null } });
    await expect.element(page.getByText('No teams yet')).toBeInTheDocument();
  });

  it('renders team rows with member and project counts', async () => {
    render(Page, { props: { data: { ...layoutData, teams: [team()], users: [] }, form: null } });
    await expect.element(page.getByText('Team One')).toBeInTheDocument();
    await expect.element(page.getByRole('cell', { name: '3', exact: true })).toBeInTheDocument();
    await expect.element(page.getByRole('cell', { name: '7', exact: true })).toBeInTheDocument();
  });

  it('renders the member list for a team once expanded', async () => {
    const alice = user({
      id: 'u1',
      displayName: 'Alice',
      teams: [{ id: 't1', name: 'Team One', role: 'member' }],
    });
    render(Page, { props: { data: { ...layoutData, teams: [team()], users: [alice] }, form: null } });

    await expect.element(page.getByText('Alice')).not.toBeInTheDocument();
    await page.getByRole('button', { name: 'Manage members' }).click();
    await expect.element(page.getByText('Alice')).toBeInTheDocument();
  });

  it('keeps the delete button disabled until the exact team name is typed', async () => {
    render(Page, { props: { data: { ...layoutData, teams: [team({ name: 'Team One' })], users: [] }, form: null } });

    await page.getByRole('button', { name: 'Manage members' }).click();
    await page.getByRole('button', { name: 'Delete team' }).click();

    const btn = page.getByRole('button', { name: 'Delete permanently' });
    await expect.element(btn).toBeDisabled();

    await page.getByLabelText('Type the team name to confirm').fill('wrong');
    await expect.element(btn).toBeDisabled();

    await page.getByLabelText('Type the team name to confirm').fill('Team One');
    await expect.element(btn).toBeEnabled();
  });

  it('states the unassignment consequence with the team’s own project count', async () => {
    render(Page, { props: { data: { ...layoutData, teams: [team({ name: 'Team One', projectCount: 5 })], users: [] }, form: null } });
    await page.getByRole('button', { name: 'Manage members' }).click();
    await page.getByRole('button', { name: 'Delete team' }).click();
    await expect
      .element(page.getByText('Its 5 projects will become unassigned, not deleted.'))
      .toBeInTheDocument();
  });

  it('renders a 409 message in the alert region', async () => {
    render(Page, {
      props: {
        data: { ...layoutData, teams: [team()], users: [] },
        form: { error: 'A team with this name already exists' },
      },
    });
    const alert = page.getByRole('alert');
    await expect.element(alert).toBeInTheDocument();
    await expect.element(alert).toHaveTextContent('A team with this name already exists');
  });
});
