import { test, expect } from '@playwright/test';
import { readSeed } from './seed';

test.describe('flaky tests page (/flaky)', () => {
  test('lists the flaky test the seed produced', async ({ page }) => {
    const { projectId } = readSeed();

    await page.goto(`/flaky?project=${projectId}`);
    await expect(page.getByRole('heading', { name: 'Flaky Tests' })).toBeVisible();

    // The seed fixture (apps/api/fixtures/real-report.json) records this
    // exact spec with Playwright's own "flaky" result status on every one of
    // the 3 ingests, so after minRuns (3) is reached it is guaranteed to
    // cross the flake threshold and appear here — independent of any other
    // test's classification.
    const flakyRow = page.getByRole('row', { name: /should retry after transient failure/ });
    await expect(flakyRow).toBeVisible();
    // The status badge's DOM text is the lowercase enum value ("active");
    // CSS (`uppercase`) only changes how it's painted, not its text content.
    await expect(flakyRow.getByText(/^active$/i)).toBeVisible();

    // The table is genuinely populated, not the empty state.
    await expect(page.getByText('No active flaky tests!')).not.toBeVisible();
  });
});
