import { test, expect } from '@playwright/test';
import { readSeed } from './seed';

test.describe('overview page (/)', () => {
  test('renders the seeded project stats, including via SSR', async ({ request, page }) => {
    const { projectId, projectName } = readSeed();

    // SSR check: the seeded stats must be present in the raw HTML response —
    // before any browser JS runs. A component that only renders correctly
    // after client-side hydration would pass a `page.goto()` assertion but
    // fail this one (this is the class of bug plan 008 found).
    const ssrResponse = await request.get(`/?project=${projectId}`);
    expect(ssrResponse.status()).toBe(200);
    const html = await ssrResponse.text();
    expect(html).toContain(projectName);
    expect(html).toContain('Total Test Runs');

    await page.goto(`/?project=${projectId}`);
    await expect(page.getByRole('heading', { name: 'Dashboard Overview' })).toBeVisible();
    await expect(page.getByText(`Project: ${projectName}`)).toBeVisible();

    // Exactly 3 runs were seeded for this project, and this project is
    // freshly created per test run — no other spec or run can add to it.
    const runsLabel = page.getByText('Total Test Runs', { exact: true });
    await expect(runsLabel).toBeVisible();
    await expect(runsLabel.locator('xpath=..').getByText('3', { exact: true })).toBeVisible();

    // Recent Runs table on the overview page should list at least one of
    // the seeded runs.
    await expect(page.getByRole('cell', { name: 'main' }).first()).toBeVisible();
  });
});
