import { test, expect } from '@playwright/test';
import { readSeed } from './seed';

test.describe('analysis page (/analysis)', () => {
  test('renders a real-time flakiness analysis for the seeded project', async ({ page }) => {
    const { projectId } = readSeed();

    await page.goto(`/analysis?project=${projectId}`);
    await expect(page.getByRole('heading', { name: 'Analysis' })).toBeVisible();

    // Default window/threshold summary line (see +page.server.ts defaults:
    // days=14, threshold=0.05).
    await expect(page.getByText(/flaky at ≥5% over 14 days/)).toBeVisible();

    // Same guaranteed-flaky spec as flaky.spec.ts — Playwright's own
    // "flaky" result status on every ingest, no dependence on any other
    // test's classification.
    const row = page.getByRole('row', { name: /should retry after transient failure/ });
    await expect(row).toBeVisible();
    await expect(row.getByText('Flaky', { exact: true })).toBeVisible();
  });
});
