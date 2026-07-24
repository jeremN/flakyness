import { describe, it, expect, vi } from 'vitest';
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }));
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import Page from './+page.svelte';

describe('admin/new/+page', () => {
  it('shows the create form by default', async () => {
    render(Page, { props: { form: null } });
    // vitest/browser's locator API names this getByLabelText (not Playwright's getByLabel).
    await expect.element(page.getByLabelText('Project name')).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Create project' })).toBeInTheDocument();
  });

  it('shows the show-once token panel after a successful create', async () => {
    render(Page, {
      props: {
        form: { created: true, token: 'flk_xyz', warning: 'Shown once.', projectName: 'proj' },
      },
    });
    await expect.element(page.getByText('flk_xyz')).toBeInTheDocument();
    await expect.element(page.getByText('Shown once.')).toBeInTheDocument();
    // the input form is replaced by the reveal, not shown alongside it
    await expect.element(page.getByRole('button', { name: 'Create project' })).not.toBeInTheDocument();
  });

  it('surfaces an error message on the form', async () => {
    render(Page, { props: { form: { message: 'Project with this name already exists' } } });
    await expect
      .element(page.getByText('Project with this name already exists'))
      .toBeInTheDocument();
  });
});
