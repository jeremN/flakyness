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
});
