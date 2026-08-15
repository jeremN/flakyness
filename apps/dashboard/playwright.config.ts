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
  // Plan 059, found while writing auth.spec.ts: hooks.server.ts now calls
  // GET /api/v1/auth/me on EVERY server-rendered page view (the session
  // gate), and this suite runs with no TRUSTED_PROXY_IPS configured for the
  // API — there is only one real machine originating all of this traffic (in
  // CI and locally alike), so every request the whole run makes shares ONE
  // apiRateLimit bucket (100/fixed-60s-window). The whole suite's total
  // volume (~130-150 requests across 15 specs) exceeds that ceiling on its
  // own, so GET /api/v1/auth/me 429s intermittently regardless of pacing —
  // hooks.server.ts fail-closes a failed /auth/me by deleting the cookie and
  // redirecting to /login, spuriously "signing out" whichever request lost
  // the race, in specs that never touched auth.spec.ts at all (measured
  // hitting admin.spec.ts, overview.spec.ts, run-detail.spec.ts,
  // runs.spec.ts, and auth.spec.ts's own tests, varying by run — see the
  // Task 8 report for per-run counts). This is the test harness generating
  // enough legitimate traffic to trip a real, correctly-functioning
  // anti-abuse control — exactly the scenario TRUSTED_PROXY_IPS exists to
  // separate for real deployments (see docs/GETTING_STARTED.md) — but E2E
  // has no equivalent knob, since every request genuinely does originate
  // from one address here.
  //
  // `workers: 2` is the least-bad of what was tried (2, 1, and Playwright's
  // own CPU-based default were all measured on this machine): because the
  // window is FIXED, not sliding, cutting workers to 1 only makes the run
  // take longer without reliably lowering peak in-window volume, and raising
  // concurrency compresses the same total into a shorter window, which
  // measured WORSE (more specs caught). None of the three eliminates the
  // risk; this only reduces how often it bites. The real fix is
  // application-level (raise apiRateLimit's ceiling, or stop paying a GET
  // /auth/me on every single page view) and is out of Task 8's authorized
  // scope (apps/dashboard/e2e/** and this file only) — see the follow-up in
  // plans/README.md and the Task 8 report.
  workers: 2,
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
    // Plan 059: every route now sits behind the session gate
    // (hooks.server.ts), so a spec written before this plan would otherwise
    // redirect to /login on its first navigation. global-setup.ts signs in
    // once, through the real dashboard login + forced change-password flow,
    // and persists the resulting cookie here — every spec starts already
    // authenticated as that global admin. Specs that need to exercise the
    // login flow itself (auth.spec.ts) override this per-test with
    // `test.use({ storageState: { cookies: [], origins: [] } })`.
    storageState: 'e2e/.auth/user.json',
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
      // adapter-node's CSRF origin check (SvelteKit core, not app code)
      // rejects same-origin POSTs unless it can resolve the request's real
      // origin. Without ORIGIN (or PROTOCOL_HEADER) set, it *assumes*
      // https — see get_origin() in @sveltejs/adapter-node/files/handler.js
      // — so over this plain-http E2E server every form action 403s with
      // "Cross-site POST form submissions are forbidden" even though
      // browser and server agree on the origin. Discovered by admin.spec.ts
      // (plan 053 Task 7), the first spec to exercise a POST action; no
      // prior spec caught it because every other route is read-only. See
      // the matching docker-compose.yml fix for the same gap in real
      // deployments.
      ORIGIN: BASE_URL,
    },
  },
});
