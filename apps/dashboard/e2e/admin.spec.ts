import { test, expect } from '@playwright/test';

test.describe('admin console (/admin)', () => {
  test('creates a project, reveals its token once, then deletes it', async ({ page }) => {
    const name = `e2e-admin-${Date.now()}`;

    // Create
    await page.goto('/admin/new');
    await page.getByLabel('Project name').fill(name);
    await page.getByRole('button', { name: 'Create project' }).click();

    // Token is revealed exactly once
    const tokenPanel = page.getByTestId('token-reveal');
    await expect(tokenPanel).toBeVisible();
    const tokenText = await tokenPanel.locator('code').textContent();
    expect(tokenText?.trim().length ?? 0).toBeGreaterThan(0);

    // Reload the create page — the token is gone (never re-fetchable)
    await page.goto('/admin/new');
    await expect(page.getByTestId('token-reveal')).not.toBeVisible();

    // The new project appears in the list
    await page.goto('/admin');
    const row = page.getByRole('row', { name: new RegExp(name) });
    await expect(row).toBeVisible();

    // Open detail, delete with typed confirmation
    await row.getByRole('link', { name: 'Manage' }).click();
    const deleteBtn = page.getByRole('button', { name: 'Delete permanently' });
    await expect(deleteBtn).toBeDisabled();
    await page.getByLabel('Type the project name to confirm').fill(name);
    await expect(deleteBtn).toBeEnabled();
    await deleteBtn.click();

    // Redirected to the list; the project is gone
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole('row', { name: new RegExp(name) })).not.toBeVisible();
  });
});
