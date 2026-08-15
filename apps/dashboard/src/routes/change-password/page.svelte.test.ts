import { describe, it, expect, vi } from 'vitest';
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }));
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import Page from './+page.svelte';

// PageData for this route is the root +layout.server.ts's data merged with
// this page's own { forced }, per SvelteKit's load-data merging — matches
// flaky/page.svelte.test.ts's identical `base` precedent (selectedProject is
// inferred non-nullable there too — `Project`, not `Project | null`). None of
// these three fields is read by this page; they're here only so the fixture
// type-checks against the generated PageData.
const project = { id: 'p1', name: 'Proj', createdAt: '2026-01-01T00:00:00Z', teamId: null };
const base = { projects: [], selectedProject: project, apiError: null };

describe('change-password/+page', () => {
  it('shows the forced heading when data.forced is true', async () => {
    render(Page, { props: { data: { ...base, forced: true }, form: null } });

    await expect
      .element(page.getByRole('heading', { name: 'You must change your password before continuing' }))
      .toBeInTheDocument();
  });

  it('shows the voluntary heading when data.forced is false', async () => {
    render(Page, { props: { data: { ...base, forced: false }, form: null } });

    await expect
      .element(page.getByRole('heading', { name: 'Change your password' }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole('heading', { name: 'You must change your password before continuing' }))
      .not.toBeInTheDocument();
  });

  it('shows the current, new, and confirm password fields', async () => {
    render(Page, { props: { data: { ...base, forced: false }, form: null } });

    const current = page.getByLabelText('Current password');
    await expect.element(current).toBeInTheDocument();
    await expect.element(current).toHaveAttribute('type', 'password');

    // exact: true — otherwise 'New password' substring-matches the
    // "Confirm new password" label too and the query is ambiguous.
    const next = page.getByLabelText('New password', { exact: true });
    await expect.element(next).toBeInTheDocument();
    await expect.element(next).toHaveAttribute('type', 'password');

    const confirm = page.getByLabelText('Confirm new password');
    await expect.element(confirm).toBeInTheDocument();
    await expect.element(confirm).toHaveAttribute('type', 'password');

    await expect.element(page.getByRole('button', { name: 'Change password' })).toBeInTheDocument();
  });

  it('shows no alert region when there is no error', async () => {
    render(Page, { props: { data: { ...base, forced: false }, form: null } });

    await expect.element(page.getByRole('alert')).not.toBeInTheDocument();
  });

  it('renders the error in a role="alert" region when form.error is set', async () => {
    render(Page, { props: { data: { ...base, forced: false }, form: { error: 'Current password is incorrect' } } });

    const alert = page.getByRole('alert');
    await expect.element(alert).toBeInTheDocument();
    await expect.element(alert).toHaveTextContent('Current password is incorrect');
  });

  it('leaves all three password fields empty after a failed submit', async () => {
    // No `value` binding on any field — a failed submit must not put a
    // submitted password back in the DOM (matches login/+page.svelte).
    render(Page, { props: { data: { ...base, forced: true }, form: { error: 'New password and confirmation do not match.' } } });

    await expect.element(page.getByLabelText('Current password')).toHaveValue('');
    await expect.element(page.getByLabelText('New password', { exact: true })).toHaveValue('');
    await expect.element(page.getByLabelText('Confirm new password')).toHaveValue('');
  });

  it('submits via a standard POST form, not GET', async () => {
    // Survives mutation to method="GET" otherwise — a GET form submission
    // would put passwords in the URL/query string and browser history.
    render(Page, { props: { data: { ...base, forced: false }, form: null } });

    expect(document.querySelector('form')?.getAttribute('method')).toBe('POST');
  });
});
