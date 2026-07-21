import { describe, it, expect, vi } from 'vitest';
import { readable } from 'svelte/store';
vi.mock('$app/stores', () => ({
  page: readable({ status: 404, error: { message: 'nope' }, url: new URL('http://localhost/x') }),
}));
import { render } from 'vitest-browser-svelte';
import { page as vitestPage } from 'vitest/browser';
import ErrorPage from './+error.svelte';

describe('+error', () => {
  it('renders the title, icon, and message for the status', async () => {
    render(ErrorPage, { props: {} });
    await expect.element(vitestPage.getByText('Page Not Found')).toBeInTheDocument(); // 404 → errorTitle
    await expect.element(vitestPage.getByText('🔍')).toBeInTheDocument();              // 404 → errorIcon
    await expect.element(vitestPage.getByText('nope')).toBeInTheDocument();            // page.error.message
  });
});
