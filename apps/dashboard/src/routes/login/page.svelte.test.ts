import { describe, it, expect, vi } from 'vitest';
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }));
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import Page from './+page.svelte';

describe('login/+page', () => {
  it('shows the email and password fields and a submit button', async () => {
    render(Page, { props: { form: null } });

    await expect.element(page.getByLabelText('Email')).toBeInTheDocument();
    const password = page.getByLabelText('Password');
    await expect.element(password).toBeInTheDocument();
    // vitest/browser's locator API names this getByLabelText (not
    // Playwright's getByLabel) — matches the admin/new precedent.
    await expect.element(password).toHaveAttribute('type', 'password');
    await expect.element(page.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('shows no alert region when there is no error', async () => {
    render(Page, { props: { form: null } });

    await expect.element(page.getByRole('alert')).not.toBeInTheDocument();
  });

  it('renders the error in a role="alert" region when form.error is set', async () => {
    render(Page, { props: { form: { error: 'Invalid email or password.' } } });

    const alert = page.getByRole('alert');
    await expect.element(alert).toBeInTheDocument();
    await expect.element(alert).toHaveTextContent('Invalid email or password.');
  });

  it('repopulates the email field from form.email after a failed submit', async () => {
    render(Page, { props: { form: { email: 'a@b.com', error: 'Invalid email or password.' } } });

    await expect.element(page.getByLabelText('Email')).toHaveValue('a@b.com');
  });

  it('leaves the password field empty after a failed submit', async () => {
    render(Page, { props: { form: { email: 'a@b.com', error: 'Invalid email or password.' } } });

    await expect.element(page.getByLabelText('Password')).toHaveValue('');
  });

  it('submits via a standard POST form, not GET', async () => {
    // Survives mutation to method="GET" otherwise — a GET form submission
    // would put the password in the URL/query string and browser history.
    // Raw DOM query (no accessible-role query for a plain <form>) — mirrors
    // routes/runs/page.svelte.test.ts's document.querySelector precedent.
    render(Page, { props: { form: null } });

    expect(document.querySelector('form')?.getAttribute('method')).toBe('POST');
  });
});
