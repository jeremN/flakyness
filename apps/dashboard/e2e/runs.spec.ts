import { test, expect } from '@playwright/test';
import { readSeed } from './seed';

test.describe('test runs page (/runs)', () => {
  test('lists the three ingested runs', async ({ page }) => {
    const { projectId } = readSeed();

    await page.goto(`/runs?project=${projectId}`);
    await expect(page.getByRole('heading', { name: 'Test Runs' })).toBeVisible();

    // The seed project is created fresh by global setup and ingested into
    // exactly 3 times — 1 header row + 3 data rows, no more, no less.
    await expect(page.getByRole('row')).toHaveCount(4);

    // Each of the 3 seeded commits should be represented (7-char prefixes,
    // matching the UI's `commitSha.slice(0, 7)` display).
    await expect(page.getByRole('cell', { name: 'e2e1000' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'e2e2000' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'e2e3000' })).toBeVisible();
  });
});
