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

  it('renders team rows with member and project counts in the correct columns', async () => {
    // Minor #4: `getByRole('cell', { name: '3' })` alone doesn't say WHICH
    // cell — it passed even with the Members/Projects <td>s swapped. Scope by
    // column position within the row instead (Team, Members, Projects,
    // Actions — indices 0-3) so a swap actually fails this.
    render(Page, { props: { data: { ...layoutData, teams: [team()], users: [] }, form: null } });
    const row = page.getByRole('row', { name: /Team One/ });
    await expect.element(row.getByRole('cell').nth(1)).toHaveTextContent('3');
    await expect.element(row.getByRole('cell').nth(2)).toHaveTextContent('7');
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

  // IMPORTANT #3: the server test proves the delete action RETURNS
  // orphanedProjects; nothing proved the operator ever SEES it — deleting the
  // whole banner block passed 90/90 before this test existed.
  it('renders the orphaned-projects count after a successful delete', async () => {
    render(Page, {
      props: {
        data: { ...layoutData, teams: [team()], users: [] },
        form: { success: true, orphanedProjects: 4 },
      },
    });
    const banner = page.getByText('Team deleted.', { exact: false });
    await expect.element(banner).toBeInTheDocument();
    await expect.element(banner).toHaveTextContent('4 projects became unassigned.');
  });

  // Minor #8: "Every user is already a member of this team" is misleading
  // when the instance has zero users at all — distinguish the two empty
  // cases.
  it('distinguishes "no users at all" from "everyone is already a member"', async () => {
    render(Page, { props: { data: { ...layoutData, teams: [team()], users: [] }, form: null } });
    await page.getByRole('button', { name: 'Manage members' }).click();
    await expect.element(page.getByText('No users exist yet.')).toBeInTheDocument();
    await expect.element(page.getByText('Every user is already a member of this team.')).not.toBeInTheDocument();
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
