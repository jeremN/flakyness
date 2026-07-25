import { test, expect } from '@playwright/test';

test.describe('quarantine rules console', () => {
  test('adds, reorders, edits, and deletes rules', async ({ page }) => {
    const name = `e2e-rules-${Date.now()}`;

    // Create a project via the admin UI, then open its rules console.
    await page.goto('/admin/new');
    await page.getByLabel('Project name').fill(name);
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByTestId('token-reveal')).toBeVisible();

    await page.goto('/admin');
    await page.getByRole('row', { name: new RegExp(name) }).getByRole('link', { name: 'Manage' }).click();
    await page.getByRole('link', { name: /Manage quarantine rules/ }).click();
    await expect(page).toHaveURL(/\/rules$/);
    await expect(page.getByText(/No rules yet/)).toBeVisible();

    // Add a flake_rate rule.
    await page.getByRole('button', { name: '+ Add rule' }).click();
    await page.getByLabel('Branch glob').fill('main');
    await page.getByLabel('Threshold (0–1)').fill('0.3');
    await page.getByRole('button', { name: 'Create rule' }).click();
    await expect(page.getByText(/main · flake ≥ 0.30/)).toBeVisible();

    // Add an exempt rule (appended below the first).
    await page.getByRole('button', { name: '+ Add rule' }).click();
    await page.getByLabel('Action').selectOption('exempt');
    await page.getByLabel('File glob').fill('release/*');
    await page.getByRole('button', { name: 'Create rule' }).click();
    await expect(page.getByText('exempt · release/*')).toBeVisible();

    // Reorder: move the exempt rule (row 2) up; it should become row 1.
    const items = page.getByRole('listitem');
    await items.nth(1).getByRole('button', { name: 'Move up' }).click();
    await expect(page.getByRole('listitem').first()).toContainText('exempt · release/*');

    // Edit the flake_rate rule's threshold.
    await page.getByRole('listitem').filter({ hasText: 'flake ≥' }).getByRole('button', { name: 'Edit' }).click();
    await page.getByLabel('Threshold (0–1)').fill('0.5');
    await page.getByRole('button', { name: 'Save rule' }).click();
    await expect(page.getByText(/flake ≥ 0.50/)).toBeVisible();

    // Delete the exempt rule via the two-step confirm.
    const exemptRow = page.getByRole('listitem').filter({ hasText: 'exempt · release/*' });
    await exemptRow.getByRole('button', { name: 'Delete' }).click();
    await exemptRow.getByRole('button', { name: 'Yes' }).click();
    await expect(page.getByText('exempt · release/*')).not.toBeVisible();
  });
});
