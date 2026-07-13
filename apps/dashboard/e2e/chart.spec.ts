import { test, expect } from '@playwright/test';
import { readSeed } from './seed';

test.describe('chart rendering (/) ', () => {
  test('renders the flake-rate trend chart without a client-side error', async ({ page }) => {
    const { projectId } = readSeed();

    // This is the exact class of bug plan 008 found: an ECharts chart type
    // not registered in Chart.svelte's `echarts.use([...])` doesn't throw —
    // it silently renders a blank canvas. Failing on any uncaught in-page
    // error is the strongest general-purpose guard against that regression
    // (and any other client-side crash) short of asserting pixel content.
    const pageErrors: Error[] = [];
    page.on('pageerror', (error) => pageErrors.push(error));

    await page.goto(`/?project=${projectId}`);

    await expect(page.getByRole('heading', { name: 'Flake Rate Trend', exact: false })).toBeVisible();

    // ECharts' CanvasRenderer draws into a <canvas> it creates inside the
    // chart container; a registered-but-never-rendered chart type leaves an
    // empty container with no canvas at all.
    const canvas = page.locator('canvas').first();
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(0);
    expect(box?.height ?? 0).toBeGreaterThan(0);

    expect(pageErrors, `Uncaught client-side error(s): ${pageErrors.map((e) => e.message).join('; ')}`).toHaveLength(0);
  });
});
