import { test, expect } from '@playwright/test';
import { readSeed } from './seed';

const API_URL = process.env.PUBLIC_API_URL ?? 'http://127.0.0.1:8080';

test.describe('run detail page (/runs/[runId])', () => {
  test('renders the failures table with the seeded failing/flaky test names and an error message', async ({ page, request }) => {
    const { projectId } = readSeed();

    const runsRes = await request.get(`${API_URL}/api/v1/projects/${projectId}/runs?limit=1`);
    expect(runsRes.ok()).toBe(true);
    const { runs } = await runsRes.json();
    expect(runs.length).toBeGreaterThan(0);
    const runId = runs[0].id;

    await page.goto(`/runs/${runId}?project=${projectId}`);
    await expect(page.getByText('Back to Test Runs')).toBeVisible();

    // apps/api/fixtures/real-report.json (ingested 3x by global setup) always
    // produces a 'failed' result ("should handle flaky network response",
    // both attempts fail) and a 'flaky' one ("should retry after transient
    // failure", fails then passes on retry) — see determineStatus in
    // apps/api/src/parsers/playwright.ts. Report mixes chromium+firefox
    // projects, so real test names carry a `[chromium]`/`[firefox]` suffix —
    // substring text matching (Playwright's default for a string) still
    // finds them.
    await expect(page.getByText('should handle flaky network response')).toBeVisible();
    await expect(page.getByText('should retry after transient failure')).toBeVisible();

    // Default scope is failed+flaky only — a passed result must be absent.
    await expect(page.getByText('should login with valid credentials')).not.toBeVisible();

    // The updated storage-scope note (OQ3) is present.
    await expect(page.getByText(/CI job's artifacts/i)).toBeVisible();

    // "should retry after transient failure" fails its first attempt with a
    // stack ("Error: Expected X\n    at auth.spec.ts:20:5" — see
    // apps/api/fixtures/real-report.json), so the new failure-detail panel
    // must render a collapsed "Stack trace" disclosure for it.
    await expect(page.locator('summary', { hasText: 'Stack trace' }).first()).toBeVisible();

    // "should handle flaky network response"'s second attempt carries a bare
    // `{ message: 'real message' }` error (no stack/snippet) — its headline
    // message must still render directly (no snippet assertion: this
    // fixture has none).
    await expect(page.getByText('real message')).toBeVisible();
  });

  test('a /runs row links to its run detail page', async ({ page }) => {
    const { projectId } = readSeed();

    await page.goto(`/runs?project=${projectId}`);
    await expect(page.getByRole('heading', { name: 'Test Runs' })).toBeVisible();

    // Commit prefixes are fixed by global-setup.ts's seed shas (same ones
    // apps/dashboard/e2e/runs.spec.ts already asserts on directly).
    await page.getByRole('link', { name: 'e2e1000' }).click();

    await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}\?project=/);
    await expect(page.getByText('Back to Test Runs')).toBeVisible();
  });

  test('the "show all results" toggle reveals passed results, and toggling back hides them again', async ({ page, request }) => {
    const { projectId } = readSeed();

    const runsRes = await request.get(`${API_URL}/api/v1/projects/${projectId}/runs?limit=1`);
    const { runs } = await runsRes.json();
    const runId = runs[0].id;

    await page.goto(`/runs/${runId}?project=${projectId}`);
    await expect(page.getByText('should login with valid credentials')).not.toBeVisible();

    await page.getByRole('link', { name: 'Show all results' }).click();
    await expect(page).toHaveURL(/status=all/);
    await expect(page.getByText('should login with valid credentials')).toBeVisible();

    await page.getByRole('link', { name: 'Show failures only' }).click();
    await expect(page.getByText('should login with valid credentials')).not.toBeVisible();
  });
});
