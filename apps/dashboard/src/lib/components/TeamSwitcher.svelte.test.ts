import { describe, it, expect, vi } from 'vitest';
import { readable } from 'svelte/store';
vi.mock('$app/stores', () => ({
  page: readable({ url: new URL('http://localhost/flaky?project=p1') }),
}));
import { render } from 'vitest-browser-svelte';
import { page as vitestPage } from 'vitest/browser';
import TeamSwitcher from './TeamSwitcher.svelte';

const teamA = { id: 't1', name: 'Team Alpha', role: 'member' as const };
const teamB = { id: 't2', name: 'Team Beta', role: 'team_admin' as const };

describe('TeamSwitcher', () => {
  it('renders nothing for a user with zero teams', async () => {
    render(TeamSwitcher, { props: { teams: [], activeTeam: null } });
    await expect.element(vitestPage.getByRole('navigation', { name: 'Team filter' })).not.toBeInTheDocument();
  });

  it('renders nothing for a single-team user — no dead control', async () => {
    render(TeamSwitcher, { props: { teams: [teamA], activeTeam: null } });
    await expect.element(vitestPage.getByRole('navigation', { name: 'Team filter' })).not.toBeInTheDocument();
    await expect.element(vitestPage.getByText('All teams')).not.toBeInTheDocument();
  });

  it('renders "All teams" plus one link per team for a multi-team user', async () => {
    render(TeamSwitcher, { props: { teams: [teamA, teamB], activeTeam: null } });

    await expect.element(vitestPage.getByRole('link', { name: 'All teams' })).toBeInTheDocument();
    await expect.element(vitestPage.getByRole('link', { name: 'Team Alpha' })).toBeInTheDocument();
    await expect.element(vitestPage.getByRole('link', { name: 'Team Beta' })).toBeInTheDocument();
  });

  it('preserves the rest of the query string when linking to a team', async () => {
    render(TeamSwitcher, { props: { teams: [teamA, teamB], activeTeam: null } });

    // $app/stores is mocked to /flaky?project=p1 — switching teams must not
    // drop the existing project= param.
    await expect
      .element(vitestPage.getByRole('link', { name: 'Team Alpha' }))
      .toHaveAttribute('href', '/flaky?project=p1&team=t1');
  });

  it('"All teams" removes the team param while preserving the rest of the query string', async () => {
    render(TeamSwitcher, { props: { teams: [teamA, teamB], activeTeam: 't1' } });

    await expect
      .element(vitestPage.getByRole('link', { name: 'All teams' }))
      .toHaveAttribute('href', '/flaky?project=p1');
  });

  it('marks the active team current, not the others', async () => {
    render(TeamSwitcher, { props: { teams: [teamA, teamB], activeTeam: 't2' } });

    await expect.element(vitestPage.getByRole('link', { name: 'Team Beta' })).toHaveAttribute('aria-current', 'page');
    await expect.element(vitestPage.getByRole('link', { name: 'Team Alpha' })).not.toHaveAttribute('aria-current');
  });
});
