import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import TokenReveal from './TokenReveal.svelte';

describe('TokenReveal', () => {
  it('renders the token and the warning verbatim', async () => {
    render(TokenReveal, { props: { token: 'flk_secret_123', warning: 'Save this now.' } });
    await expect.element(page.getByText('flk_secret_123')).toBeInTheDocument();
    await expect.element(page.getByText('Save this now.')).toBeInTheDocument();
  });

  it('exposes a copy control', async () => {
    render(TokenReveal, { props: { token: 't', warning: 'w' } });
    await expect.element(page.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  });

  // findings-r1 M-1: the heading itself was previously unpinned — a one-line
  // change to the `label` prop's default silently retitles both existing
  // call sites (admin/[projectId]'s token rotation, admin/new's project
  // creation), neither of which passes `label` explicitly.
  it('defaults the heading to "API token" when no label is given', async () => {
    render(TokenReveal, { props: { token: 't', warning: 'w' } });
    await expect.element(page.getByRole('heading', { name: 'API token' })).toBeInTheDocument();
  });

  it('renders a custom label when one is given', async () => {
    render(TokenReveal, { props: { token: 't', warning: 'w', label: 'Temporary password' } });
    await expect.element(page.getByRole('heading', { name: 'Temporary password' })).toBeInTheDocument();
    await expect.element(page.getByRole('heading', { name: 'API token' })).not.toBeInTheDocument();
  });
});
