import { test, expect } from '@playwright/test';
import { readSeed } from './seed';

// What this spec IS: a general client-side crash guard for the one page that
// mounts an ECharts chart. It catches uncaught in-page exceptions and a chart
// container that fails to produce a canvas at all.
//
// What this spec is NOT — and this matters, because the obvious assumption is
// wrong: it does NOT catch an unregistered ECharts series type (the plan-008
// bug, the one AGENTS.md warns about). That failure mode is completely silent.
// ECharts treats an unknown series type as a no-op: it does not throw, and its
// dev-mode warning is compiled out by `__DEV__` guards in the production build
// this suite (correctly) exercises. `GridComponent` stays registered, so the
// axes still paint — the canvas is present, sized, and non-blank while the data
// line has quietly vanished. Every assertion below passes with that bug present.
// Verified empirically by dropping `LineChart` from `echarts.use([...])`.
//
// The guard that actually holds that invariant is the static registration test:
// src/lib/components/chart-registration.test.ts. Do not weaken it, and do not
// re-add a claim here that this spec covers it.
test.describe('chart rendering (/) ', () => {
  test('renders the flake-rate trend chart without a client-side error', async ({ page }) => {
    const { projectId } = readSeed();

    const pageErrors: Error[] = [];
    page.on('pageerror', (error) => pageErrors.push(error));

    await page.goto(`/?project=${projectId}`);

    await expect(page.getByRole('heading', { name: 'Flake Rate Trend', exact: false })).toBeVisible();

    // ECharts' CanvasRenderer draws into a <canvas> it creates inside the chart
    // container. A container that never initialises at all (e.g. an SSR/mount
    // crash) leaves no canvas — that this one exists and is sized is a real,
    // if narrow, signal.
    const canvas = page.locator('canvas').first();
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(0);
    expect(box?.height ?? 0).toBeGreaterThan(0);

    expect(pageErrors, `Uncaught client-side error(s): ${pageErrors.map((e) => e.message).join('; ')}`).toHaveLength(0);
  });
});
