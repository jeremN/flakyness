import { defineConfig, devices } from '@playwright/test';

// The dashboard's own dev port is 5173 (see vite.config.ts) — use a
// different port for the E2E build so a stray `pnpm dev` next to a test run
// can't collide with it.
const DASHBOARD_PORT = process.env.E2E_DASHBOARD_PORT ?? '4173';
const BASE_URL = `http://127.0.0.1:${DASHBOARD_PORT}`;

// The API the built dashboard talks to (SSR `load` functions) and the API
// global setup seeds directly. Must already be running before `test:e2e`
// starts — this config does not manage the API process.
const API_URL = process.env.PUBLIC_API_URL ?? 'http://127.0.0.1:8080';

export default defineConfig({
  testDir: './e2e',
  // Seeds one deterministic project (and its runs) via the real API before
  // any spec runs; see e2e/global-setup.ts.
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: true,
  // A test.only left in by accident must fail CI, not silently narrow the run.
  forbidOnly: !!process.env.CI,
  // Non-negotiable: this is a flaky-test tracker. A retry here would hide the
  // exact class of bug the product exists to surface. See AGENTS.md / plan 026.
  retries: 0,
  reporter: [
    ['list'],
    // The JSON report is what gets ingested back into Flackyness (the
    // "dogfood" step) — see .github/workflows/ci.yml's `e2e` job.
    ['json', { outputFile: 'playwright-report/report.json' }],
    // Always generated; CI only uploads this folder as an artifact on
    // failure (see design decision 6 in plan 026).
    ['html', { outputFolder: 'playwright-report/html', open: 'never' }],
  ],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  // Chromium only — no cross-browser matrix, no sharding. Deferred until the
  // suite has been green for a while (see plan 026 maintenance notes).
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Build + serve the REAL production artifact (adapter-node's `build/`,
  // started with plain `node`), not `vite dev` / `vite preview`. Dev-mode SSR
  // has different behavior than what production actually runs, and that gap
  // is exactly what let the SSR crash in plan 008 slip through undetected.
  webServer: {
    command: 'pnpm run build && node build',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      PORT: DASHBOARD_PORT,
      HOST: '127.0.0.1',
      PUBLIC_API_URL: API_URL,
    },
  },
});
