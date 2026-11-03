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
    await expect.element(row).toMatchTextContent('Bob');
    await expect.element(row).toMatchTextContent('Yes');
    await expect.element(row).toMatchTextContent('Platform');
    await expect.element(row.getByText('Never')).not.toBeInTheDocument();
  });

  it('renders "Never" for a user who has not logged in', async () => {
    render(Page, {
      props: { data: { ...layoutData, users: [user({ lastLoginAt: null })] }, form: null },
    });
    const row = page.getByRole('row', { name: /alice@x.test/ });
    await expect.element(row).toMatchTextContent('Never');
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
    // findings-r1 I-4: the mandated warning copy (Step 2 — "shown once" for
    // create, "all sessions revoked" for resetPassword) was previously
    // unguarded — `warning={''}` passed the whole suite. This is the render
    // half; the two distinct API-sourced strings are pinned below too.
    await expect.element(page.getByText('Save this now.')).toBeInTheDocument();
  });

  // findings-r1 I-4: pin BOTH of the brief's mandated warning strings by
  // their actual distinct wording (not a placeholder), one per action, so a
  // regression that clears the copy for only one action is still caught.
  it("shows create's show-once warning copy verbatim", async () => {
    render(Page, {
      props: {
        data: { ...layoutData, users: [user()] },
        form: {
          success: true,
          temporaryPassword: 'tmp_new_user',
          warning: 'Save this password securely. It will not be shown again. The user must change it on first sign-in.',
        },
      },
    });
    await expect
      .element(page.getByText('It will not be shown again.', { exact: false }))
      .toBeInTheDocument();
  });

  it("shows resetPassword's sessions-revoked warning copy verbatim", async () => {
    render(Page, {
      props: {
        data: { ...layoutData, users: [user()] },
        form: {
          success: true,
          temporaryPassword: 'tmp_reset',
          warning: "Save this password securely. It will not be shown again. All of this user's sessions have been revoked.",
        },
      },
    });
    await expect
      .element(page.getByText("All of this user's sessions have been revoked.", { exact: false }))
      .toBeInTheDocument();
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

describe('admin users page — toggle-admin hidden field polarity (findings-r1 I-2)', () => {
  // `value={(!u.isGlobalAdmin).toString()}` carries the TARGET state the
  // action will PATCH to. Dropping the `!` makes every click a silent no-op
  // (PATCHes the user to the state they're already in) — this reads the raw
  // hidden input's `value` attribute directly, since it isn't exposed via any
  // ARIA role and a submit was never simulated by any test in this file.
  it("a non-admin row's hidden field targets 'true' (promote)", async () => {
    render(Page, {
      props: { data: { ...layoutData, users: [user({ isGlobalAdmin: false })] }, form: null },
    });
    const row = page.getByRole('row', { name: /alice@x.test/ });
    const hidden = row.element().querySelector('input[name="isGlobalAdmin"]') as HTMLInputElement | null;
    expect(hidden?.value).toBe('true');
  });

  it("an admin row's hidden field targets 'false' (demote)", async () => {
    render(Page, {
      props: { data: { ...layoutData, users: [user({ isGlobalAdmin: true })] }, form: null },
    });
    const row = page.getByRole('row', { name: /alice@x.test/ });
    const hidden = row.element().querySelector('input[name="isGlobalAdmin"]') as HTMLInputElement | null;
    expect(hidden?.value).toBe('false');
  });
});

describe('admin users page — delete confirm state machine (findings-r1 I-3)', () => {
  it('reveals a typed-email confirm step and hides the Delete button', async () => {
    render(Page, { props: { data: { ...layoutData, users: [user()] }, form: null } });
    await expect.element(page.getByRole('button', { name: 'Confirm delete' })).not.toBeInTheDocument();

    await page.getByRole('button', { name: 'Delete', exact: true }).click();

    await expect.element(page.getByRole('button', { name: 'Delete', exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Confirm delete' })).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('keeps Confirm delete disabled until the exact email is typed', async () => {
    render(Page, { props: { data: { ...layoutData, users: [user({ email: 'alice@x.test' })] }, form: null } });
    await page.getByRole('button', { name: 'Delete', exact: true }).click();

    const btn = page.getByRole('button', { name: 'Confirm delete' });
    await expect.element(btn).toBeDisabled();

    await page.getByLabelText('Type the email to confirm').fill('wrong@x.test');
    await expect.element(btn).toBeDisabled();

    await page.getByLabelText('Type the email to confirm').fill('alice@x.test');
    await expect.element(btn).toBeEnabled();
  });

  it('Cancel returns to the Delete button and clears the typed value', async () => {
    render(Page, { props: { data: { ...layoutData, users: [user({ email: 'alice@x.test' })] }, form: null } });
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByLabelText('Type the email to confirm').fill('alice@x.test');

    await page.getByRole('button', { name: 'Cancel' }).click();

    await expect.element(page.getByRole('button', { name: 'Delete', exact: true })).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Confirm delete' })).not.toBeInTheDocument();

    // Re-opening must not remember the previous (matching) typed value — a
    // stale `confirmEmail` that survived Cancel would leave Confirm delete
    // enabled the instant the row reopens, before anything was typed again.
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect.element(page.getByRole('button', { name: 'Confirm delete' })).toBeDisabled();
  });
});

// Backlog #37: several resets in a row used to yield identical, unlabelled
// panels. The label names the account, looked up in the reloaded user list.
describe('admin users page — attributed temporary password (backlog #37)', () => {
  it('names the user the temporary password belongs to', async () => {
    render(Page, {
      props: {
        data: { ...layoutData, users: [user(), user({ id: 'u2', email: 'bob@x.test' })] },
        form: { success: true, temporaryPassword: 'tmp_reset', warning: 'w', forUserId: 'u2' },
      },
    });
    await expect.element(page.getByText('Temporary password for bob@x.test')).toBeInTheDocument();
    await expect.element(page.getByText('Temporary password for alice@x.test')).not.toBeInTheDocument();
  });

  it('falls back to the plain label when the user is not in the list', async () => {
    render(Page, {
      props: {
        data: { ...layoutData, users: [user()] },
        form: { success: true, temporaryPassword: 'tmp_reset', warning: 'w', forUserId: 'gone' },
      },
    });
    await expect.element(page.getByText('Temporary password', { exact: true })).toBeInTheDocument();
  });
});

// Backlog #37: a reset revokes every session of the user, so it takes a
// confirmation that says so, like delete.
describe('admin users page — reset password confirmation (backlog #37)', () => {
  it('asks for confirmation and states the consequence before resetting', async () => {
    render(Page, { props: { data: { ...layoutData, users: [user({ email: 'alice@x.test' })] }, form: null } });
    await expect.element(page.getByRole('button', { name: 'Confirm reset' })).not.toBeInTheDocument();

    await page.getByRole('button', { name: 'Reset password' }).click();

    await expect.element(page.getByRole('button', { name: 'Reset password' })).not.toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Confirm reset' })).toBeInTheDocument();
    await expect.element(page.getByText('out everywhere and sets a new temporary password.', { exact: false })).toBeInTheDocument();
  });

  it('Cancel returns to the Reset password button', async () => {
    render(Page, { props: { data: { ...layoutData, users: [user()] }, form: null } });
    await page.getByRole('button', { name: 'Reset password' }).click();
    await page.getByRole('button', { name: 'Cancel' }).click();

    await expect.element(page.getByRole('button', { name: 'Reset password' })).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Confirm reset' })).not.toBeInTheDocument();
  });

  it('opens the confirmation for one row only', async () => {
    render(Page, {
      props: { data: { ...layoutData, users: [user(), user({ id: 'u2', email: 'bob@x.test' })] }, form: null },
    });
    await page.getByRole('button', { name: 'Reset password' }).first().click();

    await expect.element(page.getByRole('button', { name: 'Confirm reset' })).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Reset password' })).toBeInTheDocument();
  });
});

// Backlog #37: the signed-in admin's own row offers no self-demotion, no
// self-deletion and no self-reset. Another user's row keeps all three. One
// render holds both rows, so each assertion has its own control.
describe('admin users page: your own row', () => {
  const me = user({ id: 'admin1', email: 'admin@x.test', isGlobalAdmin: true });
  const other = user({ id: 'u2', email: 'bob@x.test', isGlobalAdmin: true });

  it('marks your row and hides the self-destructive actions there only', async () => {
    render(Page, { props: { data: { ...layoutData, users: [me, other] }, form: null } });
    await expect.element(page.getByText('(you)')).toBeInTheDocument();
    // One of each button: the other admin's row.
    expect(page.getByRole('button', { name: 'Remove global admin' }).elements()).toHaveLength(1);
    expect(page.getByRole('button', { name: 'Delete' }).elements()).toHaveLength(1);
    expect(page.getByRole('button', { name: 'Reset password' }).elements()).toHaveLength(1);
    await expect.element(page.getByRole('link', { name: 'Change password' })).toHaveAttribute('href', '/change-password');
  });

  it('still lets a non-admin you be promoted: the server only refuses demotion', async () => {
    // Not reachable in practice (this page 404s for a non-admin), but the
    // hide rule is "self AND admin", so pin it.
    render(Page, {
      props: { data: { ...layoutData, users: [{ ...me, isGlobalAdmin: false }] }, form: null },
    });
    await expect.element(page.getByRole('button', { name: 'Make global admin' })).toBeInTheDocument();
  });
});
