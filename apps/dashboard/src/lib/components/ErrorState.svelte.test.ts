import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import ErrorState from './ErrorState.svelte';

describe('ErrorState', () => {
  it('renders the default message when none is given', async () => {
    render(ErrorState, { props: {} });
    await expect.element(page.getByText('Something went wrong')).toBeInTheDocument();
  });

  it('renders a custom message and not the default', async () => {
    render(ErrorState, { props: { message: 'API is down' } });
    await expect.element(page.getByText('API is down')).toBeInTheDocument();
    await expect.element(page.getByText('Something went wrong')).not.toBeInTheDocument();
  });

  it('shows the retry button only when onRetry is provided', async () => {
    render(ErrorState, { props: { message: 'x', onRetry: () => {} } });
    await expect.element(page.getByRole('button', { name: 'Try Again' })).toBeInTheDocument();
  });

  it('hides the retry button when onRetry is absent', async () => {
    render(ErrorState, { props: { message: 'x' } });
    await expect.element(page.getByRole('button', { name: 'Try Again' })).not.toBeInTheDocument();
  });
});
