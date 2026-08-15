import { describe, it, expect, vi } from 'vitest';
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }));
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import Page from './+page.svelte';
import type { AdminUser } from '../../../app.d';

// Layout half of PageData (root +layout.server.ts, Global Constraint 1):
// `data` for this route = { projects, selectedProject, apiError, user, teams,
// activeTeam } ∪ { users: AdminUser[] } from this page's own load.
const layoutData = {
  projects: [],
  selectedProject: { id: 'p1', name: 'Proj One', createdAt: '2026-01-01T00:00:00Z', teamId: null },
  apiError: null,
  user: { id: 'admin1', email: 'admin@x.test', displayName: 'Admin', isGlobalAdmin: true, mustChangePassword: false },
  teams: [],
  activeTeam: null,
};

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

describe('admin users page', () => {
  it('shows the empty state when there are no users', async () => {
    render(Page, { props: { data: { ...layoutData, users: [] }, form: null } });
    await expect.element(page.getByText('No users yet')).toBeInTheDocument();
  });

  it('renders a row per user with email, admin flag, teams and last login', async () => {
    render(Page, {
      props: {
        data: {
          ...layoutData,
          users: [
            user({
              email: 'bob@x.test',
              displayName: 'Bob',
              isGlobalAdmin: true,
              teams: [{ id: 't1', name: 'Platform', role: 'member' }],
              lastLoginAt: '2026-08-01T12:00:00Z',
            }),
          ],
        },
        form: null,
      },
    });
    const row = page.getByRole('row', { name: /bob@x.test/ });
    await expect.element(row).toHaveTextContent('Bob');
    await expect.element(row).toHaveTextContent('Yes');
    await expect.element(row).toHaveTextContent('Platform');
    await expect.element(row.getByText('Never')).not.toBeInTheDocument();
  });

  it('renders "Never" for a user who has not logged in', async () => {
    render(Page, {
      props: { data: { ...layoutData, users: [user({ lastLoginAt: null })] }, form: null },
    });
    const row = page.getByRole('row', { name: /alice@x.test/ });
    await expect.element(row).toHaveTextContent('Never');
  });

  // IMPORTANT: create/resetPassword both return a show-once temporaryPassword
  // — this proves it actually reaches the TokenReveal component, not merely
  // that the server action returns it (a server test can't see the render).
  it('shows the temporary password via TokenReveal when the action returns one', async () => {
    render(Page, {
      props: {
        data: { ...layoutData, users: [user()] },
        form: { success: true, temporaryPassword: 'tmp_secret_1', warning: 'Save this now.' },
      },
    });
    await expect.element(page.getByTestId('token-reveal')).toBeInTheDocument();
    await expect.element(page.getByText('tmp_secret_1')).toBeInTheDocument();
    await expect.element(page.getByText('Temporary password')).toBeInTheDocument();
  });

  it('does not show TokenReveal when the action returns no temporary password', async () => {
    render(Page, {
      props: { data: { ...layoutData, users: [user()] }, form: { success: true } },
    });
    await expect.element(page.getByTestId('token-reveal')).not.toBeInTheDocument();
  });

  it('does not show TokenReveal on a fresh page load (no form result)', async () => {
    render(Page, { props: { data: { ...layoutData, users: [user()] }, form: null } });
    await expect.element(page.getByTestId('token-reveal')).not.toBeInTheDocument();
  });

  it('renders a 409 message in the alert region', async () => {
    render(Page, {
      props: {
        data: { ...layoutData, users: [user()] },
        form: { error: 'Cannot delete the last global admin' },
      },
    });
    const alert = page.getByRole('alert');
    await expect.element(alert).toBeInTheDocument();
    await expect.element(alert).toHaveTextContent('Cannot delete the last global admin');
  });
});
